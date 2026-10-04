import type { IdlRegistry } from '../idl.js';
import { logger } from '../log.js';
import { describeError, fromRpcTx, type RpcTx, type SlotClock } from '../normalize.js';
import { RpcError, type RpcClient } from '../rpc.js';
import { SourceUnavailableError, type Source, type TxSink } from '../types.js';

const log = logger('rpc-poll');

interface SigInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime?: number | null;
}

export interface RpcPollOptions {
  rpc: RpcClient;
  programIds: string[];
  commitment: string;
  pollIntervalMs: number;
  sampleIntervalMs: number;
  sampleSize: number;
  idl: IdlRegistry;
  clock: SlotClock;
}

/**
 * Fallback for keys without streaming access (e.g. Solami Free tier):
 *  - getSignaturesForAddress with an `until` cursor gives every signature, slot and error,
 *    so tx/min, success/failed and error rate stay exact and gapless (up to 1000 per poll);
 *  - Solami's getTransactionsForAddress (transactionDetails: "full") returns the newest N full
 *    transactions in ONE call, which we use as a rolling sample for signers, instructions,
 *    compute units and fees. Falls back to getTransaction on non-Solami RPCs.
 * All calls share the RpcClient token bucket (RPC_MAX_RPS).
 */
export class RpcPollSource implements Source {
  readonly name = 'rpc' as const;
  readonly label = 'Solami RPC polling (Free-tier fallback)';
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private cursor = new Map<string, string>();
  private watched: Set<string>;
  private gtfaSupported = true;
  gaps = 0;

  constructor(private readonly o: RpcPollOptions) {
    this.watched = new Set(o.programIds);
  }

  async start(sink: TxSink): Promise<void> {
    this.stopped = false;
    // First poll of each program must succeed, otherwise the source is unusable.
    try {
      for (const pid of this.o.programIds) await this.pollSignatures(pid, sink, true);
    } catch (e) {
      throw new SourceUnavailableError('rpc', (e as Error).message);
    }
    log.info(
      `polling ${this.o.programIds.length} program(s) via ${this.o.rpc.host} every ${this.o.pollIntervalMs}ms; ` +
        `sampling ${this.o.sampleSize} full txs every ${this.o.sampleIntervalMs}ms for signer/ix/CU/fee detail`,
    );
    this.o.programIds.forEach((pid, i) => {
      // Stagger programs so requests spread evenly across the rate budget.
      const offset = (i * this.o.pollIntervalMs) / this.o.programIds.length;
      this.loop(() => this.pollSignatures(pid, sink, false), this.o.pollIntervalMs, offset);
      this.loop(() => this.sample(pid, sink), this.o.sampleIntervalMs, offset + this.o.sampleIntervalMs / 2);
    });
  }

  private loop(fn: () => Promise<void>, every: number, delay: number) {
    const tick = async () => {
      if (this.stopped) return;
      const t0 = Date.now();
      try {
        await fn();
      } catch (e) {
        log.warn((e as Error).message);
      }
      if (!this.stopped) this.timers.push(setTimeout(tick, Math.max(50, every - (Date.now() - t0))));
    };
    this.timers.push(setTimeout(tick, delay));
  }

  private async pollSignatures(pid: string, sink: TxSink, first: boolean): Promise<void> {
    const until = this.cursor.get(pid);
    const opts: Record<string, unknown> = { commitment: this.o.commitment, limit: first ? 200 : 1000 };
    if (until) opts.until = until;
    const sigs = await this.o.rpc.call<SigInfo[]>('getSignaturesForAddress', [pid, opts]);
    if (!sigs.length) return;
    // Busy programs (Pump.fun peaks >150 tx/s) can exceed 1000 per interval: page back with
    // `before` until we reach the cursor so counts stay gapless.
    let page = sigs;
    for (let i = 0; until && page.length >= 1000 && i < 3; i++) {
      page = await this.o.rpc.call<SigInfo[]>('getSignaturesForAddress', [pid, { ...opts, before: page[page.length - 1].signature }]);
      sigs.push(...page);
    }
    if (until && page.length >= 1000) {
      this.gaps++;
      log.warn(`${pid.slice(0, 6)}: >4000 new signatures in one poll interval; some were skipped (lower POLL_INTERVAL_MS or use gRPC)`);
    }
    this.cursor.set(pid, sigs[0].signature);
    const newest = sigs[0].slot;
    this.o.clock.observe(newest);
    sink.slot(newest);
    // Oldest first so the live feed scrolls naturally.
    for (let i = sigs.length - 1; i >= 0; i--) {
      const s = sigs[i];
      sink.tx({
        signature: s.signature,
        slot: s.slot,
        ts: this.o.clock.timeOf(s.slot, s.blockTime),
        success: !s.err,
        error: describeError(s.err),
        programIds: [pid],
        detailed: false,
      });
    }
  }

  private async sample(pid: string, sink: TxSink): Promise<void> {
    let txs: RpcTx[] = [];
    if (this.gtfaSupported) {
      try {
        const res = await this.o.rpc.call<{ data: RpcTx[] }>('getTransactionsForAddress', [
          pid,
          { transactionDetails: 'full', limit: this.o.sampleSize, sortOrder: 'desc', encoding: 'json', maxSupportedTransactionVersion: 1, commitment: this.o.commitment },
        ], 1);
        txs = res?.data ?? [];
      } catch (e) {
        if (e instanceof RpcError && (e.code === -32601 || /not found|not supported/i.test(e.message))) {
          this.gtfaSupported = false;
          log.info('getTransactionsForAddress unavailable on this RPC; sampling with getTransaction instead');
        } else throw e;
      }
    }
    if (!this.gtfaSupported) {
      const sigs = await this.o.rpc.call<SigInfo[]>('getSignaturesForAddress', [pid, { limit: Math.min(3, this.o.sampleSize), commitment: this.o.commitment }]);
      for (const s of sigs) {
        const tx = await this.o.rpc.call<RpcTx | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: this.o.commitment }]);
        if (tx) txs.push({ ...tx, signature: s.signature });
      }
    }
    // Oldest first, so the newest sampled tx ends up on top of the live feed.
    for (const raw of txs.slice().reverse()) {
      const tx = fromRpcTx(raw, this.watched, this.o.idl, this.o.clock);
      if (tx && tx.programIds.length) sink.detail(tx);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}
