import { describe, expect, it, vi } from 'vitest';
import { AlertEngine, evaluateRule, type AlertEvent, type AlertRule } from '../src/alerts.js';
import { parseAlertsYaml } from '../src/config.js';
import { Aggregator } from '../src/metrics.js';
import { TelegramNotifier } from '../src/notify.js';
import type { NormalizedTx } from '../src/types.js';

const P = 'Prog1111111111111111111111111111111111111111';
let n = 0;
const mk = (ts: number, success = true): NormalizedTx => ({ signature: `s${n++}`, slot: n, ts, success, programIds: [P], detailed: false });

function setup(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  const agg = new Aggregator([P], { [P]: 'Prog' }, now);
  return { agg, now, advance: (ms: number) => (t += ms) };
}

/** Feed `perMin` tx/min for `minutes`, advancing time as we go. */
function feed(s: ReturnType<typeof setup>, perMin: number, minutes: number, failRatio = 0) {
  for (let m = 0; m < minutes * 6; m++) {
    const per10s = Math.round(perMin / 6);
    for (let i = 0; i < per10s; i++) s.agg.ingest(mk(s.now(), i >= per10s * failRatio));
    s.advance(10_000);
  }
}

describe('error_rate rule', () => {
  const rule: AlertRule = { type: 'error_rate', thresholdPct: 50, windowMinutes: 5, minTx: 20 };

  it('fires above threshold', () => {
    const s = setup();
    feed(s, 60, 3, 0.7);
    const c = evaluateRule(rule, s.agg, P, s.now())!;
    expect(c.breached).toBe(true);
    expect(c.value).toBeCloseTo(70, 0);
    expect(c.message).toMatch(/error rate 70\.0%/);
  });

  it('does not fire below threshold', () => {
    const s = setup();
    feed(s, 60, 3, 0.3);
    expect(evaluateRule(rule, s.agg, P, s.now())!.breached).toBe(false);
  });

  it('needs min_tx before judging', () => {
    const s = setup();
    for (let i = 0; i < 5; i++) s.agg.ingest(mk(s.now(), false));
    expect(evaluateRule(rule, s.agg, P, s.now())!.breached).toBe(false);
  });
});

describe('silence rule', () => {
  const rule: AlertRule = { type: 'silence', minutes: 2 };

  it('fires when no tx for N minutes, resolves on traffic', () => {
    const s = setup();
    s.agg.ingest(mk(s.now()));
    s.advance(60_000);
    expect(evaluateRule(rule, s.agg, P, s.now())!.breached).toBe(false);
    s.advance(61_001);
    const c = evaluateRule(rule, s.agg, P, s.now())!;
    expect(c.breached).toBe(true);
    expect(c.message).toMatch(/no transactions for 2\.0m/);
    s.agg.ingest(mk(s.now()));
    expect(evaluateRule(rule, s.agg, P, s.now())!.breached).toBe(false);
  });

  it('fires when a program never shows up after start', () => {
    const s = setup();
    s.advance(3 * 60_000);
    expect(evaluateRule(rule, s.agg, P, s.now())!.message).toMatch(/since watcher start/);
  });
});

describe('spike rule', () => {
  const rule: AlertRule = { type: 'spike', multiplier: 3, windowMinutes: 1, baselineMinutes: 5, minTxPerMin: 20 };

  it('fires when tx/min jumps above multiplier x trailing average', () => {
    const s = setup();
    feed(s, 30, 6);
    expect(evaluateRule(rule, s.agg, P, s.now())!.breached).toBe(false);
    feed(s, 120, 1);
    const c = evaluateRule(rule, s.agg, P, s.now())!;
    expect(c.breached).toBe(true);
    expect(c.value).toBeGreaterThanOrEqual(3);
  });

  it('does not fire during warm-up (no full baseline yet)', () => {
    const s = setup();
    feed(s, 300, 1);
    expect(evaluateRule(rule, s.agg, P, s.now())!.breached).toBe(false);
  });

  it('respects min_tx_per_min for tiny programs', () => {
    const s = setup();
    feed(s, 1, 6);
    feed(s, 12, 1); // 12x but only 12/min
    expect(evaluateRule(rule, s.agg, P, s.now())!.breached).toBe(false);
  });
});

describe('AlertEngine lifecycle', () => {
  it('notifies once on fire, honours cooldown, then resolves', () => {
    const s = setup();
    const events: AlertEvent[] = [];
    const engine = new AlertEngine(s.agg, [{ type: 'silence', minutes: 1 }], [{ notify: (e) => void events.push(e) }], 5 * 60_000, s.now);
    s.agg.ingest(mk(s.now()));
    s.advance(2 * 60_000);
    expect(engine.evaluate().map((e) => e.state)).toEqual(['firing']);
    s.advance(60_000);
    expect(engine.evaluate()).toEqual([]); // still firing, inside cooldown
    s.advance(5 * 60_000);
    expect(engine.evaluate().map((e) => e.state)).toEqual(['firing']); // re-notify after cooldown
    s.agg.ingest(mk(s.now()));
    expect(engine.evaluate().map((e) => e.state)).toEqual(['resolved']);
    expect(events).toHaveLength(3);
    expect(engine.recent()[0].state).toBe('resolved');
    expect(engine.active()).toEqual([]);
  });

  it('scopes rules to listed programs', () => {
    const s = setup();
    const engine = new AlertEngine(s.agg, [{ type: 'silence', minutes: 1, programs: ['SomeoneElse'] }], [], 60_000, s.now);
    s.advance(10 * 60_000);
    expect(engine.evaluate()).toEqual([]);
  });
});

describe('alerts.yaml parsing', () => {
  it('maps snake_case YAML to rules', () => {
    const { rules, cooldownMinutes } = parseAlertsYaml(`
cooldown_minutes: 4
rules:
  - type: error_rate
    threshold_pct: 40
    window_minutes: 2
    min_tx: 10
  - type: silence
    minutes: 0.5
    programs: [abc]
  - type: spike
    multiplier: 2
`);
    expect(cooldownMinutes).toBe(4);
    expect(rules[0]).toEqual({ type: 'error_rate', programs: undefined, thresholdPct: 40, windowMinutes: 2, minTx: 10 });
    expect(rules[1]).toEqual({ type: 'silence', programs: ['abc'], minutes: 0.5 });
    expect(rules[2]).toMatchObject({ type: 'spike', multiplier: 2, windowMinutes: 1, baselineMinutes: 15 });
  });

  it('rejects unknown rule types', () => {
    expect(() => parseAlertsYaml('rules:\n  - type: nope\n')).toThrow(/unknown rule type/);
  });
});

describe('TelegramNotifier', () => {
  it('posts an HTML message to the Bot API', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const t = new TelegramNotifier('123:abc', '-10042', fetchMock as unknown as typeof fetch);
    t.notify({ id: 'a1', rule: 'error_rate', programId: P, label: 'Prog <x>', state: 'firing', message: 'Prog <x>: error rate 90%', value: 90, threshold: 50, at: 0 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe('-10042');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('FIRING');
    expect(body.text).toContain('&lt;x&gt;');
  });
});
