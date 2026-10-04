import { logger } from './log.js';
import type { PipelineStats } from './pipeline.js';
import type { RpcClient } from './rpc.js';

const log = logger('health');
const SLOT_MS = 400;

export interface HealthSnapshot {
  /** Estimated current chain tip (RPC getSlot + elapsed time since the call). */
  chainSlot: number | null;
  /** Newest slot the stream has delivered. */
  streamSlot: number;
  lagSlots: number | null;
  lagMs: number | null;
  lastEventAgeMs: number | null;
  rpc: { host: string; ok: boolean; calls: number; errors: number; rateLimited: number; lastError?: string } | null;
  received: number;
  duplicates: number;
  details: number;
}

/** Stream lag = chain tip from Solami RPC `getSlot` minus the newest slot seen on the stream. */
export class HealthTracker {
  private chainSlot: number | null = null;
  private chainSlotAt = 0;
  private rpcOk = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly stats: PipelineStats,
    private readonly rpc: RpcClient | null,
    private readonly commitment: string,
    /** Replay mode supplies its simulated tip instead of polling RPC. */
    private readonly tipProvider?: () => number,
  ) {}

  start(intervalMs: number): void {
    if (!this.rpc || this.tipProvider) return;
    const poll = async () => {
      try {
        const s = await this.rpc!.getSlot(this.commitment);
        this.chainSlot = s;
        this.chainSlotAt = Date.now();
        this.rpcOk = true;
      } catch (e) {
        this.rpcOk = false;
        log.debug('getSlot failed', e);
      }
    };
    void poll();
    this.timer = setInterval(poll, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot(): HealthSnapshot {
    const now = Date.now();
    let tip: number | null = null;
    if (this.tipProvider) tip = this.tipProvider() || null;
    else if (this.chainSlot) tip = this.chainSlot + Math.floor((now - this.chainSlotAt) / SLOT_MS);
    const stream = this.stats.streamSlot;
    const lag = tip && stream ? Math.max(0, tip - stream) : null;
    return {
      chainSlot: tip,
      streamSlot: stream,
      lagSlots: lag,
      lagMs: lag === null ? null : lag * SLOT_MS,
      lastEventAgeMs: this.stats.lastEventAt ? now - this.stats.lastEventAt : null,
      rpc: this.rpc
        ? { host: this.rpc.host, ok: this.rpcOk, calls: this.rpc.stats.calls, errors: this.rpc.stats.errors, rateLimited: this.rpc.stats.rateLimited, lastError: this.rpc.stats.lastError }
        : null,
      received: this.stats.received,
      duplicates: this.stats.duplicates,
      details: this.stats.details,
    };
  }
}
