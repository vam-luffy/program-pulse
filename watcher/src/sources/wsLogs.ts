import WebSocket from 'ws';
import { toSnake } from '../idl.js';
import { logger } from '../log.js';
import { describeError, type SlotClock } from '../normalize.js';
import { SourceUnavailableError, type IxHit, type NormalizedTx, type Source, type TxSink } from '../types.js';

const log = logger('ws');

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const RESULT = /^Program (\w+) (success|failed)/;
const CONSUMED = /^Program (\w+) consumed (\d+) of \d+ compute units$/;
const ANCHOR_IX = /^Program log: Instruction: (\w+)$/;

/**
 * Extract watched-program instruction names (from Anchor's "Instruction: X" log line)
 * and total compute units (sum of top-level "consumed" lines) from transaction logs.
 */
export function parseLogs(logs: string[], watched: Set<string>): { instructions: IxHit[]; computeUnits?: number } {
  const stack: string[] = [];
  const instructions: IxHit[] = [];
  let cu = 0;
  let sawCu = false;
  for (const line of logs) {
    let m = INVOKE.exec(line);
    if (m) {
      stack.push(m[1]);
      continue;
    }
    m = ANCHOR_IX.exec(line);
    if (m) {
      const pid = stack[stack.length - 1];
      if (pid && watched.has(pid)) instructions.push({ programId: pid, name: toSnake(m[1]), inner: stack.length > 1 });
      continue;
    }
    m = CONSUMED.exec(line);
    if (m && stack.length === 1) {
      cu += Number(m[2]);
      sawCu = true;
      continue;
    }
    m = RESULT.exec(line);
    if (m) stack.pop();
  }
  return { instructions, computeUnits: sawCu ? cu : undefined };
}

export interface WsOptions {
  url: string;
  programIds: string[];
  commitment: string;
  clock: SlotClock;
  startTimeoutMs?: number;
}

/** Standard Solana pub/sub on Solami's WebSocket: logsSubscribe(mentions) + slotSubscribe. */
export class WsLogsSource implements Source {
  readonly name = 'ws' as const;
  readonly label = 'Solami WebSocket (logsSubscribe)';
  private ws: WebSocket | null = null;
  private stopped = false;
  private subToProgram = new Map<number, string>();
  private reqToProgram = new Map<number, string>();
  private backoff = 1000;
  private watched: Set<string>;

  constructor(private readonly o: WsOptions) {
    this.watched = new Set(o.programIds);
  }

  start(sink: TxSink): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => done(new Error('no subscription ack within 10s')), this.o.startTimeoutMs ?? 10_000);
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.ws?.terminate();
          reject(new SourceUnavailableError('ws', err.message));
        } else resolve();
      };
      this.open(sink, done);
    });
  }

  private open(sink: TxSink, onReady?: (err?: Error) => void): void {
    const ws = new WebSocket(this.o.url);
    this.ws = ws;
    this.subToProgram.clear();
    this.reqToProgram.clear();
    let ready = false;

    ws.on('open', () => {
      this.o.programIds.forEach((pid, i) => {
        this.reqToProgram.set(i + 1, pid);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [pid] }, { commitment: this.o.commitment }] }));
      });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'slotSubscribe' }));
    });

    ws.on('message', (raw) => {
      let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: { subscription: number; result: unknown } };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        if (msg.error) return onReady?.(new Error(`subscribe error: ${msg.error.message}`));
        const pid = this.reqToProgram.get(msg.id);
        if (pid) this.subToProgram.set(msg.result as number, pid);
        if (!ready && this.subToProgram.size === this.o.programIds.length) {
          ready = true;
          this.backoff = 1000;
          log.info(`logsSubscribe active for ${this.o.programIds.length} program(s)`);
          onReady?.();
        }
        return;
      }
      if (msg.method === 'slotNotification') {
        const s = (msg.params?.result as { slot: number }).slot;
        this.o.clock.observe(s);
        sink.slot(s);
        return;
      }
      if (msg.method === 'logsNotification' && msg.params) {
        const pid = this.subToProgram.get(msg.params.subscription);
        const r = msg.params.result as { context: { slot: number }; value: { signature: string; err: unknown; logs: string[] } };
        if (!pid || !r?.value) return;
        const { instructions, computeUnits } = parseLogs(r.value.logs ?? [], this.watched);
        const tx: NormalizedTx = {
          signature: r.value.signature,
          slot: r.context.slot,
          ts: this.o.clock.timeOf(r.context.slot),
          success: !r.value.err,
          error: describeError(r.value.err),
          programIds: [pid],
          computeUnits,
          instructions,
          // logs give instructions + CU but not the fee payer or fee
          detailed: false,
        };
        sink.tx(tx);
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => onReady?.(new Error(`HTTP ${res.statusCode} ${body.slice(0, 200)}`)));
    });
    ws.on('error', (e) => log.debug('socket error', e));
    ws.on('close', (code) => {
      if (this.stopped || !ready) return;
      const delay = this.backoff;
      this.backoff = Math.min(30_000, this.backoff * 2);
      log.warn(`socket closed (${code}); resubscribing in ${delay}ms`);
      setTimeout(() => !this.stopped && this.open(sink), delay);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }
}
