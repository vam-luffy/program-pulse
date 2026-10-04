import type { NormalizedTx } from './types.js';

const HOUR_S = 3600;
const SERIES_BINS = 60; // sparkline points
const SERIES_BIN_S = 10; // 60 x 10s = last 10 minutes

interface SecBucket {
  sec: number;
  tx: number;
  fail: number;
  detailed: number;
  cu: number;
  cuN: number;
  fee: number;
  feeN: number;
}

interface MinBucket {
  min: number;
  ix: Map<string, number>;
}

export interface WindowStats {
  tx: number;
  fail: number;
  detailed: number;
  cu: number;
  cuN: number;
  fee: number;
  feeN: number;
}

export interface RecentTx {
  signature: string;
  slot: number;
  ts: number;
  success: boolean;
  error?: string;
  programIds: string[];
  signer?: string;
  feeLamports?: number;
  computeUnits?: number;
  /** Most informative instruction name for this tx. */
  ix?: string;
}

export interface ProgramSnapshot {
  programId: string;
  label: string;
  txPerMin: number;
  errorRate5m: number | null;
  errorRate1h: number | null;
  window5m: { tx: number; fail: number };
  window1h: { tx: number; fail: number; ok: number };
  uniqueSigners1h: number;
  avgComputeUnits: number | null;
  avgFeeLamports: number | null;
  feeLamports1h: number;
  computeUnits1h: number;
  /** Share of counted txs (1h) for which we saw full detail. 1 for gRPC/replay, <1 when sampling. */
  detailCoverage: number | null;
  topInstructions: { name: string; count: number; pct: number }[];
  lastSeenSlot: number;
  lastSeenAt: number | null;
  firstSeenAt: number | null;
  totals: { tx: number; fail: number };
  series: { txPerMin: number[]; errorRate: (number | null)[]; binSeconds: number };
}

function emptyWindow(): WindowStats {
  return { tx: 0, fail: 0, detailed: 0, cu: 0, cuN: 0, fee: 0, feeN: 0 };
}

export class ProgramStats {
  private secs: SecBucket[] = [];
  private mins: MinBucket[] = [];
  private signers = new Map<string, number>();
  totals = { tx: 0, fail: 0 };
  lastSeenSlot = 0;
  lastSeenAt: number | null = null;
  firstSeenAt: number | null = null;

  constructor(
    public readonly programId: string,
    public readonly label: string,
  ) {}

  private sec(s: number): SecBucket {
    const i = s % HOUR_S;
    let b = this.secs[i];
    if (!b || b.sec !== s) {
      b = { sec: s, tx: 0, fail: 0, detailed: 0, cu: 0, cuN: 0, fee: 0, feeN: 0 };
      this.secs[i] = b;
    }
    return b;
  }

  private min(m: number): MinBucket {
    const i = m % 60;
    let b = this.mins[i];
    if (!b || b.min !== m) {
      b = { min: m, ix: new Map() };
      this.mins[i] = b;
    }
    return b;
  }

  count(tx: NormalizedTx, now: number): void {
    this.totals.tx++;
    if (!tx.success) this.totals.fail++;
    const ts = clampTs(tx.ts, now);
    if (ts !== null) {
      const b = this.sec(Math.floor(ts / 1000));
      b.tx++;
      if (!tx.success) b.fail++;
    }
    if (tx.slot > this.lastSeenSlot) this.lastSeenSlot = tx.slot;
    // "last seen" tracks when we observed activity, which is what silence alerts care about.
    this.lastSeenAt = now;
    this.firstSeenAt ??= now;
  }

  addDetail(tx: NormalizedTx, now: number): void {
    const ts = clampTs(tx.ts, now) ?? now;
    const b = this.sec(Math.floor(ts / 1000));
    if (tx.detailed) b.detailed++;
    if (tx.computeUnits !== undefined) {
      b.cu += tx.computeUnits;
      b.cuN++;
    }
    if (tx.feeLamports !== undefined) {
      b.fee += tx.feeLamports;
      b.feeN++;
    }
    if (tx.signer) this.signers.set(tx.signer, ts);
    // Anchor event self-CPIs are bookkeeping, not user intent: leave them out of the ranking.
    const ixs = tx.instructions?.filter((i) => i.programId === this.programId && i.name !== '(anchor event)') ?? [];
    if (ixs.length) {
      const mb = this.min(Math.floor(ts / 60_000));
      for (const ix of ixs) mb.ix.set(ix.name, (mb.ix.get(ix.name) ?? 0) + 1);
    }
  }

  /** Sum of 1-second buckets for seconds in (fromMs, toMs], i.e. the current second is included. */
  window(fromMs: number, toMs: number): WindowStats {
    const out = emptyWindow();
    const to = Math.floor(toMs / 1000);
    const from = Math.max(Math.floor(fromMs / 1000), to - HOUR_S);
    for (let s = from + 1; s <= to; s++) {
      const b = this.secs[s % HOUR_S];
      if (!b || b.sec !== s) continue;
      out.tx += b.tx;
      out.fail += b.fail;
      out.detailed += b.detailed;
      out.cu += b.cu;
      out.cuN += b.cuN;
      out.fee += b.fee;
      out.feeN += b.feeN;
    }
    return out;
  }

  uniqueSigners(now: number, windowMs = HOUR_S * 1000): number {
    const cutoff = now - windowMs;
    let n = 0;
    for (const [k, t] of this.signers) {
      if (t < cutoff) this.signers.delete(k);
      else n++;
    }
    return n;
  }

  topInstructions(now: number, minutes = 60, limit = 6): { name: string; count: number; pct: number }[] {
    const nowMin = Math.floor(now / 60_000);
    const agg = new Map<string, number>();
    for (const b of this.mins) {
      if (!b || b.min <= nowMin - minutes || b.min > nowMin) continue;
      for (const [k, v] of b.ix) agg.set(k, (agg.get(k) ?? 0) + v);
    }
    const total = [...agg.values()].reduce((a, b) => a + b, 0);
    return [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count, pct: total ? count / total : 0 }));
  }

  snapshot(now: number): ProgramSnapshot {
    const w1m = this.window(now - 60_000, now);
    const w5 = this.window(now - 5 * 60_000, now);
    const w1h = this.window(now - HOUR_S * 1000, now);
    const txPerMin: number[] = [];
    const errorRate: (number | null)[] = [];
    // Align bins to wall-clock so the sparkline doesn't jitter between snapshots.
    const end = Math.floor(now / 1000 / SERIES_BIN_S) * SERIES_BIN_S * 1000;
    for (let i = SERIES_BINS - 1; i >= 0; i--) {
      const to = end - i * SERIES_BIN_S * 1000;
      const w = this.window(to - SERIES_BIN_S * 1000, to);
      txPerMin.push(w.tx * (60 / SERIES_BIN_S));
      errorRate.push(w.tx ? w.fail / w.tx : null);
    }
    return {
      programId: this.programId,
      label: this.label,
      txPerMin: w1m.tx,
      errorRate5m: w5.tx ? w5.fail / w5.tx : null,
      errorRate1h: w1h.tx ? w1h.fail / w1h.tx : null,
      window5m: { tx: w5.tx, fail: w5.fail },
      window1h: { tx: w1h.tx, fail: w1h.fail, ok: w1h.tx - w1h.fail },
      uniqueSigners1h: this.uniqueSigners(now),
      avgComputeUnits: w1h.cuN ? Math.round(w1h.cu / w1h.cuN) : null,
      avgFeeLamports: w1h.feeN ? Math.round(w1h.fee / w1h.feeN) : null,
      feeLamports1h: w1h.fee,
      computeUnits1h: w1h.cu,
      detailCoverage: w1h.tx ? Math.min(1, w1h.detailed / w1h.tx) : null,
      topInstructions: this.topInstructions(now),
      lastSeenSlot: this.lastSeenSlot,
      lastSeenAt: this.lastSeenAt,
      firstSeenAt: this.firstSeenAt,
      totals: { ...this.totals },
      series: { txPerMin, errorRate, binSeconds: SERIES_BIN_S },
    };
  }
}

/** Keep timestamps inside the 1h ring; slightly-future stamps (clock skew) land on "now". */
function clampTs(ts: number, now: number): number | null {
  if (!Number.isFinite(ts)) return now;
  if (ts > now) return now;
  if (ts <= now - HOUR_S * 1000) return null;
  return ts;
}

const hasDetail = (tx: NormalizedTx) => tx.detailed || !!tx.instructions?.length || tx.computeUnits !== undefined;

function pickIx(tx: NormalizedTx): string | undefined {
  const ixs = tx.instructions ?? [];
  const useful = ixs.find((i) => !i.inner && i.name !== '(anchor event)') ?? ixs.find((i) => i.name !== '(anchor event)') ?? ixs[0];
  return useful?.name;
}

export class Aggregator {
  readonly programs = new Map<string, ProgramStats>();
  private recent: RecentTx[] = [];
  private recentIndex = new Map<string, RecentTx>();
  readonly startedAt: number;
  /**
   * When the source only samples detail (RPC polling), the live feed shows the decoded sample
   * instead of signature-only rows. Counts and rates still include every transaction.
   */
  feedDetailedOnly = false;

  constructor(
    programIds: string[],
    labels: Record<string, string> = {},
    private readonly now: () => number = Date.now,
    private readonly recentLimit = 25,
  ) {
    for (const id of programIds) this.programs.set(id, new ProgramStats(id, labels[id] ?? id));
    this.startedAt = now();
  }

  /** Count a newly observed transaction (and its detail, if present). */
  ingest(tx: NormalizedTx): void {
    const now = this.now();
    const hits = tx.programIds.map((p) => this.programs.get(p)).filter((p): p is ProgramStats => !!p);
    if (!hits.length) return;
    for (const p of hits) {
      p.count(tx, now);
      if (hasDetail(tx)) p.addDetail(tx, now);
    }
    if (this.feedDetailedOnly && !tx.detailed) return;
    this.pushRecent(tx, hits.map((h) => h.programId));
  }

  private pushRecent(tx: NormalizedTx, programIds: string[]): void {
    if (this.recentIndex.has(tx.signature)) return;
    const r: RecentTx = {
      signature: tx.signature,
      slot: tx.slot,
      ts: tx.ts,
      success: tx.success,
      error: tx.error,
      programIds,
      signer: tx.signer,
      feeLamports: tx.feeLamports,
      computeUnits: tx.computeUnits,
      ix: pickIx(tx),
    };
    this.recent.unshift(r);
    this.recentIndex.set(r.signature, r);
    while (this.recent.length > this.recentLimit) {
      const old = this.recent.pop()!;
      this.recentIndex.delete(old.signature);
    }
  }

  /** Add detail for a transaction already counted (or sampled) without double-counting rates. */
  enrich(tx: NormalizedTx): void {
    if (!hasDetail(tx)) return;
    const now = this.now();
    for (const id of tx.programIds) this.programs.get(id)?.addDetail(tx, now);
    const r = this.recentIndex.get(tx.signature);
    if (!r && this.feedDetailedOnly) {
      const ids = tx.programIds.filter((p) => this.programs.has(p));
      if (ids.length) this.pushRecent(tx, ids);
      return;
    }
    if (r) {
      r.signer = tx.signer;
      r.feeLamports = tx.feeLamports;
      r.computeUnits = tx.computeUnits;
      r.ix = pickIx(tx) ?? r.ix;
      r.error = tx.error ?? r.error;
    }
  }

  window(programId: string, fromMs: number, toMs: number): WindowStats {
    return this.programs.get(programId)?.window(fromMs, toMs) ?? emptyWindow();
  }

  get(programId: string): ProgramStats | undefined {
    return this.programs.get(programId);
  }

  recentTxs(): RecentTx[] {
    return this.recent.map((r) => ({ ...r }));
  }

  snapshot(): ProgramSnapshot[] {
    const now = this.now();
    return [...this.programs.values()].map((p) => p.snapshot(now));
  }
}
