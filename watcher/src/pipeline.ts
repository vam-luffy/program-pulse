import type { Aggregator } from './metrics.js';
import type { NormalizedTx, TxSink } from './types.js';

/** Bounded set of recently seen signatures: dedupes gRPC slot replay overlaps and source switches. */
export class SeenSet {
  private set = new Set<string>();
  private queue: string[] = [];
  constructor(private readonly max = 200_000) {}

  /** Returns true if newly added. */
  add(sig: string): boolean {
    if (this.set.has(sig)) return false;
    this.set.add(sig);
    this.queue.push(sig);
    if (this.queue.length > this.max) {
      const drop = this.queue.splice(0, this.queue.length - this.max);
      for (const d of drop) this.set.delete(d);
    }
    return true;
  }
}

export interface PipelineStats {
  received: number;
  duplicates: number;
  details: number;
  lastEventAt: number | null;
  streamSlot: number;
}

export class Pipeline implements TxSink {
  readonly stats: PipelineStats = { received: 0, duplicates: 0, details: 0, lastEventAt: null, streamSlot: 0 };
  private seen = new SeenSet();

  constructor(
    private readonly agg: Aggregator,
    private readonly dedupe = true,
  ) {}

  tx(tx: NormalizedTx): void {
    if (this.dedupe && !this.seen.add(tx.signature)) {
      this.stats.duplicates++;
      return;
    }
    this.stats.received++;
    this.stats.lastEventAt = Date.now();
    if (tx.slot > this.stats.streamSlot) this.stats.streamSlot = tx.slot;
    this.agg.ingest(tx);
  }

  detail(tx: NormalizedTx): void {
    this.stats.details++;
    this.agg.enrich(tx);
  }

  slot(slot: number): void {
    if (slot > this.stats.streamSlot) this.stats.streamSlot = slot;
  }
}
