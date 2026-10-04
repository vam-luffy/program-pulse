import { describe, expect, it } from 'vitest';
import { Aggregator } from '../src/metrics.js';
import type { NormalizedTx } from '../src/types.js';

const P = 'Prog1111111111111111111111111111111111111111';
const Q = 'Prog2222222222222222222222222222222222222222';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (v: number) => (t = v) };
}

let n = 0;
function tx(over: Partial<NormalizedTx> & { ts: number }): NormalizedTx {
  n++;
  return {
    signature: `sig${n}`,
    slot: 1000 + n,
    success: true,
    programIds: [P],
    detailed: true,
    signer: `signer${n % 3}`,
    feeLamports: 5000,
    computeUnits: 100_000,
    instructions: [{ programId: P, name: 'swap', inner: false }],
    ...over,
  };
}

describe('Aggregator', () => {
  it('counts tx/min over the trailing 60s only', () => {
    const c = clock();
    const agg = new Aggregator([P], { [P]: 'P' }, c.now);
    for (let i = 0; i < 10; i++) agg.ingest(tx({ ts: c.now() - 90_000 })); // 90s ago: outside 1m
    for (let i = 0; i < 7; i++) agg.ingest(tx({ ts: c.now() - 5_000 }));
    const [s] = agg.snapshot();
    expect(s.txPerMin).toBe(7);
    expect(s.window5m.tx).toBe(17);
    expect(s.totals.tx).toBe(17);
  });

  it('computes success/failed counts and error rate', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    for (let i = 0; i < 6; i++) agg.ingest(tx({ ts: c.now() - 1000 }));
    for (let i = 0; i < 4; i++) agg.ingest(tx({ ts: c.now() - 1000, success: false, error: 'ix 0: custom 0x1771' }));
    const [s] = agg.snapshot();
    expect(s.window1h).toEqual({ tx: 10, fail: 4, ok: 6 });
    expect(s.errorRate5m).toBeCloseTo(0.4);
    expect(s.errorRate1h).toBeCloseTo(0.4);
  });

  it('error rate is null with no traffic', () => {
    const agg = new Aggregator([P]);
    expect(agg.snapshot()[0].errorRate5m).toBeNull();
  });

  it('tracks unique signers over a rolling hour and expires old ones', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    agg.ingest(tx({ ts: c.now(), signer: 'alice' }));
    agg.ingest(tx({ ts: c.now(), signer: 'bob' }));
    agg.ingest(tx({ ts: c.now(), signer: 'alice' }));
    expect(agg.snapshot()[0].uniqueSigners1h).toBe(2);
    c.advance(30 * 60_000);
    agg.ingest(tx({ ts: c.now(), signer: 'carol' }));
    expect(agg.snapshot()[0].uniqueSigners1h).toBe(3);
    c.advance(31 * 60_000); // alice and bob now > 1h old
    expect(agg.snapshot()[0].uniqueSigners1h).toBe(1);
  });

  it('ranks top instructions with percentages', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    for (let i = 0; i < 6; i++) agg.ingest(tx({ ts: c.now(), instructions: [{ programId: P, name: 'buy', inner: false }] }));
    for (let i = 0; i < 3; i++) agg.ingest(tx({ ts: c.now(), instructions: [{ programId: P, name: 'sell', inner: false }] }));
    agg.ingest(tx({ ts: c.now(), instructions: [{ programId: P, name: '0xdeadbeefcafebabe', inner: true }, { programId: Q, name: 'other', inner: false }] }));
    const top = agg.snapshot()[0].topInstructions;
    expect(top.map((t) => t.name)).toEqual(['buy', 'sell', '0xdeadbeefcafebabe']);
    expect(top[0].pct).toBeCloseTo(0.6);
  });

  it('sums compute units and fees and averages them', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    agg.ingest(tx({ ts: c.now(), computeUnits: 100, feeLamports: 5000 }));
    agg.ingest(tx({ ts: c.now(), computeUnits: 300, feeLamports: 15000 }));
    const [s] = agg.snapshot();
    expect(s.computeUnits1h).toBe(400);
    expect(s.feeLamports1h).toBe(20000);
    expect(s.avgComputeUnits).toBe(200);
    expect(s.avgFeeLamports).toBe(10000);
    expect(s.detailCoverage).toBe(1);
  });

  it('enrich() adds detail without double-counting rates (RPC sampling mode)', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    const summary = tx({ ts: c.now(), detailed: false, signer: undefined, feeLamports: undefined, computeUnits: undefined, instructions: undefined });
    agg.ingest(summary);
    agg.ingest(tx({ ts: c.now(), detailed: false, signer: undefined, feeLamports: undefined, computeUnits: undefined, instructions: undefined }));
    agg.enrich({ ...summary, detailed: true, signer: 'whale', feeLamports: 7000, computeUnits: 42, instructions: [{ programId: P, name: 'route', inner: false }] });
    const [s] = agg.snapshot();
    expect(s.window1h.tx).toBe(2);
    expect(s.uniqueSigners1h).toBe(1);
    expect(s.detailCoverage).toBeCloseTo(0.5);
    expect(s.topInstructions[0].name).toBe('route');
    const recent = agg.recentTxs().find((r) => r.signature === summary.signature)!;
    expect(recent.signer).toBe('whale');
    expect(recent.ix).toBe('route');
  });

  it('ignores transactions for programs it does not watch and attributes multi-program txs to each', () => {
    const c = clock();
    const agg = new Aggregator([P, Q], {}, c.now);
    agg.ingest(tx({ ts: c.now(), programIds: ['Other'] }));
    agg.ingest(tx({ ts: c.now(), programIds: [P, Q] }));
    const [a, b] = agg.snapshot();
    expect(a.window1h.tx).toBe(1);
    expect(b.window1h.tx).toBe(1);
    expect(agg.recentTxs()).toHaveLength(1);
  });

  it('keeps only the last N recent transactions, newest first', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now, 25);
    for (let i = 0; i < 40; i++) agg.ingest(tx({ ts: c.now(), signature: `s${i}` }));
    const r = agg.recentTxs();
    expect(r).toHaveLength(25);
    expect(r[0].signature).toBe('s39');
  });

  it('tracks last seen slot and produces 60-point sparkline series', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    agg.ingest(tx({ ts: c.now() - 15_000, slot: 500 }));
    agg.ingest(tx({ ts: c.now() - 15_000, slot: 900, success: false }));
    agg.ingest(tx({ ts: c.now() - 15_000, slot: 700 }));
    const [s] = agg.snapshot();
    expect(s.lastSeenSlot).toBe(900);
    expect(s.series.txPerMin).toHaveLength(60);
    expect(s.series.txPerMin.reduce((a, b) => a + b, 0)).toBe(3 * 6); // 3 tx in one 10s bin, scaled to /min
    expect(s.series.errorRate.filter((x) => x !== null)).toEqual([1 / 3]);
  });

  it('in sampled feed mode shows decoded samples, not signature-only rows', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    agg.feedDetailedOnly = true;
    agg.ingest(tx({ ts: c.now(), signature: 'summary', detailed: false, signer: undefined, instructions: undefined }));
    expect(agg.recentTxs()).toHaveLength(0);
    agg.enrich(tx({ ts: c.now(), signature: 'sampled' }));
    expect(agg.recentTxs().map((r) => r.signature)).toEqual(['sampled']);
    expect(agg.snapshot()[0].window1h.tx).toBe(1); // the sample enriches, it is not counted again
  });

  it('leaves Anchor event self-CPIs out of the instruction ranking', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    agg.ingest(tx({ ts: c.now(), instructions: [{ programId: P, name: 'buy', inner: false }, { programId: P, name: '(anchor event)', inner: true }] }));
    expect(agg.snapshot()[0].topInstructions.map((t) => t.name)).toEqual(['buy']);
    expect(agg.recentTxs()[0].ix).toBe('buy');
  });

  it('drops events older than the 1h window from buckets but still counts totals', () => {
    const c = clock();
    const agg = new Aggregator([P], {}, c.now);
    agg.ingest(tx({ ts: c.now() - 2 * 3600_000 }));
    const [s] = agg.snapshot();
    expect(s.window1h.tx).toBe(0);
    expect(s.totals.tx).toBe(1);
  });
});
