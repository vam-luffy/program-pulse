import type { Aggregator } from './metrics.js';

export type AlertRule =
  | { type: 'error_rate'; programs?: string[]; thresholdPct: number; windowMinutes: number; minTx: number }
  | { type: 'silence'; programs?: string[]; minutes: number }
  | { type: 'spike'; programs?: string[]; multiplier: number; windowMinutes: number; baselineMinutes: number; minTxPerMin: number };

export interface AlertEvent {
  id: string;
  rule: AlertRule['type'];
  programId: string;
  label: string;
  state: 'firing' | 'resolved';
  message: string;
  value: number;
  threshold: number;
  at: number;
}

export interface Notifier {
  notify(e: AlertEvent): Promise<void> | void;
}

interface Check {
  breached: boolean;
  value: number;
  threshold: number;
  message: string;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** Evaluate a single rule for a single program. Pure, so it is easy to unit-test. */
export function evaluateRule(rule: AlertRule, agg: Aggregator, programId: string, now: number): Check | null {
  const p = agg.get(programId);
  if (!p) return null;
  const label = p.label;

  if (rule.type === 'error_rate') {
    const w = agg.window(programId, now - rule.windowMinutes * 60_000, now);
    if (w.tx < rule.minTx) return { breached: false, value: 0, threshold: rule.thresholdPct, message: '' };
    const rate = w.fail / w.tx;
    return {
      breached: rate * 100 > rule.thresholdPct,
      value: rate * 100,
      threshold: rule.thresholdPct,
      message: `${label}: error rate ${pct(rate)} over last ${rule.windowMinutes}m (${w.fail}/${w.tx} failed) > ${rule.thresholdPct}%`,
    };
  }

  if (rule.type === 'silence') {
    const limitMs = rule.minutes * 60_000;
    const since = p.lastSeenAt ?? agg.startedAt;
    const quietMs = now - since;
    return {
      breached: quietMs > limitMs,
      value: quietMs / 60_000,
      threshold: rule.minutes,
      message: p.lastSeenAt
        ? `${label}: no transactions for ${(quietMs / 60_000).toFixed(1)}m (limit ${rule.minutes}m), last slot ${p.lastSeenSlot}`
        : `${label}: no transactions since watcher start ${(quietMs / 60_000).toFixed(1)}m ago`,
    };
  }

  // spike: current rate vs trailing baseline average (excluding the current window)
  const winMs = rule.windowMinutes * 60_000;
  const baseMs = rule.baselineMinutes * 60_000;
  // Need a full baseline of observation before judging, otherwise startup looks like a spike.
  if (!p.firstSeenAt || now - p.firstSeenAt < winMs + baseMs) {
    return { breached: false, value: 0, threshold: rule.multiplier, message: '' };
  }
  const cur = agg.window(programId, now - winMs, now).tx / rule.windowMinutes;
  const base = agg.window(programId, now - winMs - baseMs, now - winMs).tx / rule.baselineMinutes;
  const ratio = base > 0 ? cur / base : cur > 0 ? Infinity : 0;
  return {
    breached: cur >= rule.minTxPerMin && ratio >= rule.multiplier,
    value: Number.isFinite(ratio) ? ratio : 999,
    threshold: rule.multiplier,
    message: `${label}: tx/min spike ${cur.toFixed(0)}/min vs trailing ${rule.baselineMinutes}m avg ${base.toFixed(0)}/min (${Number.isFinite(ratio) ? ratio.toFixed(1) : '∞'}x >= ${rule.multiplier}x)`,
  };
}

/**
 * Tracks firing/resolved state per (rule, program). A firing alert notifies once,
 * re-notifies at most every `cooldownMs` while still breached, and sends a resolve.
 */
export class AlertEngine {
  private state = new Map<string, { firing: boolean; lastNotified: number }>();
  private history: AlertEvent[] = [];
  private seq = 0;

  constructor(
    private readonly agg: Aggregator,
    private readonly rules: AlertRule[],
    private readonly notifiers: Notifier[],
    private readonly cooldownMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly historyLimit = 50,
  ) {}

  evaluate(): AlertEvent[] {
    const now = this.now();
    const out: AlertEvent[] = [];
    this.rules.forEach((rule, ri) => {
      const targets = rule.programs ?? [...this.agg.programs.keys()];
      for (const programId of targets) {
        const check = evaluateRule(rule, this.agg, programId, now);
        if (!check) continue;
        const key = `${ri}:${rule.type}:${programId}`;
        const st = this.state.get(key) ?? { firing: false, lastNotified: 0 };
        const label = this.agg.get(programId)?.label ?? programId;
        if (check.breached && (!st.firing || now - st.lastNotified >= this.cooldownMs)) {
          st.firing = true;
          st.lastNotified = now;
          out.push(this.event(rule.type, programId, label, 'firing', check, now));
        } else if (!check.breached && st.firing) {
          st.firing = false;
          out.push(this.event(rule.type, programId, label, 'resolved', { ...check, message: `${label}: ${rule.type.replace('_', ' ')} back to normal` }, now));
        }
        this.state.set(key, st);
      }
    });
    for (const e of out) {
      this.history.unshift(e);
      for (const n of this.notifiers) {
        Promise.resolve(n.notify(e)).catch(() => undefined);
      }
    }
    this.history.length = Math.min(this.history.length, this.historyLimit);
    return out;
  }

  active(): string[] {
    return [...this.state.entries()].filter(([, s]) => s.firing).map(([k]) => k);
  }

  recent(): AlertEvent[] {
    return [...this.history];
  }

  private event(rule: AlertRule['type'], programId: string, label: string, state: AlertEvent['state'], c: Check, at: number): AlertEvent {
    return { id: `a${++this.seq}`, rule, programId, label, state, message: c.message, value: Math.round(c.value * 100) / 100, threshold: c.threshold, at };
  }
}
