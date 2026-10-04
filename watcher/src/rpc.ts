import { logger } from './log.js';

const log = logger('rpc');

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
  get isAuth(): boolean {
    return this.httpStatus === 401 || this.httpStatus === 403;
  }
  get isRateLimit(): boolean {
    return this.httpStatus === 429 || this.code === -32005;
  }
}

/** Simple token bucket so every RPC call in the process shares one requests-per-second budget. */
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private waiters: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly rps: number) {
    this.tokens = rps;
  }

  take(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.pump();
    });
  }

  private pump() {
    const now = Date.now();
    this.tokens = Math.min(this.rps, this.tokens + ((now - this.last) / 1000) * this.rps);
    this.last = now;
    while (this.waiters.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.waiters.shift()!();
    }
    if (this.waiters.length && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.ceil(1000 / this.rps));
    }
  }
}

export interface RpcStats {
  calls: number;
  errors: number;
  rateLimited: number;
  lastError?: string;
}

export class RpcClient {
  private bucket: TokenBucket;
  private id = 0;
  readonly stats: RpcStats = { calls: 0, errors: 0, rateLimited: 0 };

  constructor(
    readonly url: string,
    maxRps = 4,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.bucket = new TokenBucket(Math.max(0.2, maxRps));
  }

  get host(): string {
    try {
      return new URL(this.url).host;
    } catch {
      return 'rpc';
    }
  }

  async call<T>(method: string, params: unknown[] = [], retries = 3): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.bucket.take();
      this.stats.calls++;
      try {
        const r = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await r.text();
        let body: { result?: T; error?: { code: number; message: string } } = {};
        try {
          body = JSON.parse(text);
        } catch {
          throw new RpcError(`${method}: HTTP ${r.status} ${text.slice(0, 120)}`, undefined, r.status);
        }
        if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code, r.status);
        if (!r.ok) throw new RpcError(`${method}: HTTP ${r.status}`, undefined, r.status);
        return body.result as T;
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError(`${method}: ${(e as Error).message}`);
        this.stats.errors++;
        this.stats.lastError = err.message;
        if (err.isRateLimit) this.stats.rateLimited++;
        const retryable = err.isRateLimit || err.httpStatus === undefined || err.httpStatus >= 500 || err.code === -32603;
        if (!retryable || err.isAuth || attempt >= retries) throw err;
        const wait = Math.min(8000, 400 * 2 ** attempt) + Math.random() * 200;
        log.debug(`${err.message} - retry in ${Math.round(wait)}ms`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  }

  getSlot(commitment = 'confirmed'): Promise<number> {
    return this.call<number>('getSlot', [{ commitment }]);
  }
}
