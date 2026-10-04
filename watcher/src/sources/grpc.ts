import type { ClientDuplexStream } from '@grpc/grpc-js';
import type { IdlRegistry } from '../idl.js';
import { logger } from '../log.js';
import type { SlotClock } from '../normalize.js';
import type { RpcClient } from '../rpc.js';
import { SourceUnavailableError, type Source, type TxSink } from '../types.js';
import { buildSubscribeRequest, handleGeyserUpdate, yellowstone, type GeyserContext, type GeyserUpdate } from './geyser.js';

const log = logger('grpc');

/** Solami keeps ~3,500 slots for `from_slot` replay; stay a bit inside that. */
export const MAX_REPLAY_SLOTS = 3400;

export interface GrpcOptions {
  endpoint: string;
  token: string;
  programIds: string[];
  commitment: 'processed' | 'confirmed' | 'finalized';
  backfillSlots: number;
  idl: IdlRegistry;
  clock: SlotClock;
  rpc: RpcClient;
  startTimeoutMs?: number;
}

/**
 * Pick the replay start slot for a (re)connect:
 * - reconnect: resume at lastSlot + 1 if still inside the replay window,
 * - first connect: optionally backfill N slots so the dashboard warms up immediately.
 */
export function pickFromSlot(lastSlot: number, chainSlot: number | null, backfillSlots: number): number | undefined {
  if (lastSlot > 0) {
    if (chainSlot && chainSlot - lastSlot > MAX_REPLAY_SLOTS) return chainSlot - MAX_REPLAY_SLOTS;
    return lastSlot + 1;
  }
  if (backfillSlots > 0 && chainSlot) return chainSlot - backfillSlots;
  return undefined;
}

export class GrpcSource implements Source {
  readonly name = 'grpc' as const;
  readonly label = 'Solami Yellowstone gRPC';
  private stream: ClientDuplexStream<unknown, unknown> | null = null;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempts: number[] = [];
  private ctx: GeyserContext;
  reconnects = 0;
  lastReplayFrom: number | null = null;

  constructor(private readonly o: GrpcOptions) {
    this.ctx = { watched: new Set(o.programIds), idl: o.idl, clock: o.clock, lastSlot: 0 };
  }

  start(sink: TxSink): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.teardown();
        reject(new SourceUnavailableError('grpc', `no data within ${(this.o.startTimeoutMs ?? 15000) / 1000}s`));
      }, this.o.startTimeoutMs ?? 15000);
      const onFirstData = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const onEarlyError = (e: Error & { code?: number; details?: string }) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        this.teardown();
        const hint = e.code === 1 ? ' (stream cancelled by server: gRPC streaming is likely not enabled on this Solami plan)' : '';
        reject(new SourceUnavailableError('grpc', `${e.details || e.message}${hint}`));
        return true;
      };
      void this.connect(sink, onFirstData, onEarlyError);
    });
  }

  private async connect(sink: TxSink, onData?: () => void, onEarlyError?: (e: Error & { code?: number }) => boolean): Promise<void> {
    if (this.stopped) return;
    let chainSlot: number | null = null;
    try {
      chainSlot = await this.o.rpc.getSlot(this.o.commitment);
      this.o.clock.observe(chainSlot);
    } catch (e) {
      log.warn('getSlot failed before subscribe; connecting without replay anchor', e);
    }
    const fromSlot = pickFromSlot(this.ctx.lastSlot, chainSlot, this.o.backfillSlots);
    this.lastReplayFrom = fromSlot ?? null;

    try {
      const client = new yellowstone.default(this.o.endpoint, this.o.token, {
        'grpc.max_receive_message_length': 64 * 1024 * 1024,
        'grpc.keepalive_time_ms': 20_000,
        'grpc.keepalive_timeout_ms': 10_000,
        'grpc.keepalive_permit_without_calls': 1,
      });
      const stream = (await client.subscribe()) as unknown as ClientDuplexStream<unknown, unknown>;
      this.stream = stream;

      stream.on('data', (u: GeyserUpdate) => {
        onData?.();
        onData = undefined;
        handleGeyserUpdate(u, sink, this.ctx);
      });
      stream.on('error', (e: Error & { code?: number; details?: string }) => {
        if (onEarlyError?.(e)) return;
        if (this.stopped) return;
        log.warn(`stream error: ${e.details || e.message} (code ${e.code}); reconnecting with from_slot replay`);
        this.scheduleReconnect(sink);
      });
      stream.on('end', () => {
        if (!this.stopped && !onData) {
          log.warn('stream ended; reconnecting');
          this.scheduleReconnect(sink);
        }
      });

      const req = buildSubscribeRequest(this.o.programIds, this.o.commitment, fromSlot);
      await new Promise<void>((res, rej) => stream.write(req, (err: Error | null | undefined) => (err ? rej(err) : res())));
      log.info(
        `subscribed to ${this.o.programIds.length} program(s) at ${this.o.endpoint} (commitment ${this.o.commitment}` +
          (fromSlot ? `, from_slot ${fromSlot}${this.ctx.lastSlot ? ' replaying the gap' : ` backfilling ${this.o.backfillSlots} slots`})` : ')'),
      );

      if (this.pingTimer) clearInterval(this.pingTimer);
      let pingId = 0;
      this.pingTimer = setInterval(() => {
        try {
          this.stream?.write({ ...buildSubscribeRequest(this.o.programIds, this.o.commitment), ping: { id: ++pingId } });
        } catch {
          /* reconnect logic handles broken streams */
        }
      }, 15_000);
    } catch (e) {
      const err = e as Error & { code?: number };
      if (onEarlyError?.(err)) return;
      log.warn(`connect failed: ${err.message}`);
      this.scheduleReconnect(sink);
    }
  }

  private scheduleReconnect(sink: TxSink): void {
    if (this.stopped || this.reconnectTimer) return;
    this.teardown();
    // Solami rejects >10 reconnects/minute from one IP, so back off exponentially.
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => now - t < 60_000);
    this.attempts.push(now);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(5, this.attempts.length - 1));
    this.reconnects++;
    log.info(`reconnect #${this.reconnects} in ${delay}ms (last slot ${this.ctx.lastSlot})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(sink);
    }, delay);
  }

  private teardown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const stream = this.stream;
    // Cancelling emits a CANCELLED error; detach handlers first so it doesn't trigger a reconnect.
    this.stream?.removeAllListeners('data');
    this.stream?.removeAllListeners('error');
    this.stream?.removeAllListeners('end');
    this.stream?.on('error', () => undefined);
    this.stream = null;
    try {
      stream?.cancel();
    } catch {
      /* ignore */
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown();
  }

  /** Exposed for health reporting. */
  get lastSlot(): number {
    return this.ctx.lastSlot;
  }
}
