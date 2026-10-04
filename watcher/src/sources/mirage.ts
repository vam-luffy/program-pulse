import WebSocket from 'ws';
import type { IdlRegistry } from '../idl.js';
import { logger } from '../log.js';
import type { SlotClock } from '../normalize.js';
import { SourceUnavailableError, type Source, type TxSink } from '../types.js';
import { handleGeyserUpdate, yellowstone, type GeyserContext, type GeyserUpdate } from './geyser.js';

const log = logger('mirage');

export interface MirageOptions {
  apiKey: string;
  apiUrl: string;
  /** Existing subscription id. When empty, one is created via POST /mirage/create. */
  subscriptionId: string;
  wsBase?: string;
  programIds: string[];
  commitment: 'processed' | 'confirmed' | 'finalized';
  idl: IdlRegistry;
  clock: SlotClock;
  startTimeoutMs?: number;
}

/**
 * Mirage = Yellowstone SubscribeUpdate frames over a plain WebSocket. The filter is stored
 * server-side as a "subscription"; we connect to wss://ws.solami.dev/mirage/stream/{id}.
 */
export class MirageSource implements Source {
  readonly name = 'mirage' as const;
  readonly label = 'Solami Mirage (Yellowstone over WebSocket)';
  private ws: WebSocket | null = null;
  private stopped = false;
  private ctx: GeyserContext;
  private subscriptionId: string;
  private backoff = 1000;

  constructor(private readonly o: MirageOptions) {
    this.ctx = { watched: new Set(o.programIds), idl: o.idl, clock: o.clock, lastSlot: 0 };
    this.subscriptionId = o.subscriptionId;
  }

  private async ensureSubscription(): Promise<string> {
    if (this.subscriptionId) return this.subscriptionId;
    const r = await fetch(`${this.o.apiUrl}/mirage/create?api_key=${encodeURIComponent(this.o.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: 'program-pulse',
        filter: { account_include: this.o.programIds, vote: false, failed: true, slots: true, commitment: this.o.commitment },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await r.text();
    if (!r.ok) {
      throw new SourceUnavailableError('mirage', `POST /mirage/create -> HTTP ${r.status} ${text.slice(0, 120)} (needs a standard key with MirageManage, or set MIRAGE_SUBSCRIPTION_ID)`);
    }
    const id = (JSON.parse(text) as { id?: string }).id;
    if (!id) throw new SourceUnavailableError('mirage', 'POST /mirage/create returned no id');
    log.info(`created Mirage subscription ${id}; set MIRAGE_SUBSCRIPTION_ID=${id} to reuse it`);
    this.subscriptionId = id;
    return id;
  }

  async start(sink: TxSink): Promise<void> {
    this.stopped = false;
    const id = await this.ensureSubscription();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        this.ws?.terminate();
        reject(new SourceUnavailableError('mirage', msg));
      };
      const timer = setTimeout(() => fail(`no data within ${(this.o.startTimeoutMs ?? 15000) / 1000}s`), this.o.startTimeoutMs ?? 15000);
      this.open(id, sink, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }, (msg) => {
        clearTimeout(timer);
        fail(msg);
      });
    });
  }

  private open(id: string, sink: TxSink, onFirst?: () => void, onFatal?: (msg: string) => void): void {
    const base = this.o.wsBase ?? 'wss://ws.solami.dev';
    const ws = new WebSocket(`${base}/mirage/stream/${id}?api_key=${encodeURIComponent(this.o.apiKey)}`);
    ws.binaryType = 'nodebuffer';
    this.ws = ws;
    let gotData = false;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        const u = yellowstone.SubscribeUpdate.decode(new Uint8Array(data)) as unknown as GeyserUpdate;
        if (!gotData) {
          gotData = true;
          this.backoff = 1000;
          onFirst?.();
        }
        handleGeyserUpdate(u, sink, this.ctx);
      } catch (e) {
        log.debug('frame decode failed', e);
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => onFatal?.(`HTTP ${res.statusCode} ${body.slice(0, 160)}`));
    });
    ws.on('close', (code, reason) => {
      if (this.stopped) return;
      // 4029 = concurrent stream limit, 4002 = bandwidth and balance exhausted.
      if (!gotData && onFatal) return onFatal(`closed ${code} ${reason.toString()}`);
      if (code === 4002 || code === 4029) log.error(`Mirage closed with ${code} (${code === 4002 ? 'bandwidth exhausted' : 'stream limit'}); retrying slowly`);
      const delay = code === 4002 || code === 4029 ? 60_000 : this.backoff;
      this.backoff = Math.min(30_000, this.backoff * 2);
      log.warn(`socket closed (${code}); reconnecting in ${delay}ms`);
      setTimeout(() => !this.stopped && this.open(id, sink), delay);
    });
    ws.on('error', (e) => log.debug('socket error', e));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }
}
