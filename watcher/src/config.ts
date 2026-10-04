import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import YAML from 'yaml';
import type { AlertRule } from './alerts.js';

/** Repo root: watcher/src/config.ts and watcher/dist/config.js are both two levels below it. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: resolve(ROOT, '.env'), quiet: true });

export const DEFAULT_PROGRAMS = [
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
];

/** Friendly labels for well-known programs. Override with PROGRAM_LABELS=id:Label,... */
const KNOWN_LABELS: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter v6',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
};

export type SourceMode = 'auto' | 'grpc' | 'mirage' | 'ws' | 'rpc' | 'replay';

export interface Config {
  apiKey: string;
  grpcEndpoint: string;
  grpcToken: string;
  rpcUrl: string;
  wsUrl: string;
  apiUrl: string;
  mirageSubscriptionId: string;
  programIds: string[];
  labels: Record<string, string>;
  source: SourceMode;
  commitment: 'processed' | 'confirmed' | 'finalized';
  backfillSlots: number;
  grpcUpgradeIntervalMs: number;
  rpcMaxRps: number;
  pollIntervalMs: number;
  sampleIntervalMs: number;
  sampleSize: number;
  slotPollMs: number;
  port: number;
  host: string;
  snapshotIntervalMs: number;
  telegramBotToken: string;
  telegramChatId: string;
  alertsFile: string;
  alertRules: AlertRule[];
  alertCooldownMs: number;
  replay: { files: string[]; speed: number; chaos: boolean };
  idlDir: string;
}

const env = (k: string, d = ''): string => (process.env[k] ?? '').trim() || d;
const num = (k: string, d: number): number => {
  const v = Number(env(k));
  return Number.isFinite(v) && env(k) !== '' ? v : d;
};

export function withKey(url: string, key: string): string {
  if (!key || /[?&]api_key=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`;
}

/** Replace any occurrence of secrets in a string before logging it. */
export function redact(s: string, cfg?: Pick<Config, 'apiKey' | 'grpcToken' | 'telegramBotToken'>): string {
  let out = s.replace(/api_key=[^&\s"']+/g, 'api_key=<redacted>');
  for (const secret of [cfg?.apiKey, cfg?.grpcToken, cfg?.telegramBotToken]) {
    if (secret && secret.length > 6) out = out.split(secret).join('<redacted>');
  }
  return out;
}

export const DEFAULT_RULES: AlertRule[] = [
  { type: 'error_rate', thresholdPct: 85, windowMinutes: 5, minTx: 30 },
  { type: 'silence', minutes: 3 },
  { type: 'spike', multiplier: 3, windowMinutes: 1, baselineMinutes: 15, minTxPerMin: 20 },
];

interface RawRule {
  type?: string;
  programs?: string[];
  threshold_pct?: number;
  window_minutes?: number;
  min_tx?: number;
  minutes?: number;
  multiplier?: number;
  baseline_minutes?: number;
  min_tx_per_min?: number;
}

export function parseAlertsYaml(text: string): { rules: AlertRule[]; cooldownMinutes?: number } {
  const doc = (YAML.parse(text) ?? {}) as { rules?: RawRule[]; cooldown_minutes?: number };
  const rules: AlertRule[] = [];
  for (const r of doc.rules ?? []) {
    const programs = r.programs?.length ? r.programs : undefined;
    if (r.type === 'error_rate') {
      rules.push({ type: 'error_rate', programs, thresholdPct: r.threshold_pct ?? 85, windowMinutes: r.window_minutes ?? 5, minTx: r.min_tx ?? 30 });
    } else if (r.type === 'silence') {
      rules.push({ type: 'silence', programs, minutes: r.minutes ?? 3 });
    } else if (r.type === 'spike') {
      rules.push({
        type: 'spike', programs, multiplier: r.multiplier ?? 3, windowMinutes: r.window_minutes ?? 1,
        baselineMinutes: r.baseline_minutes ?? 15, minTxPerMin: r.min_tx_per_min ?? 20,
      });
    } else {
      throw new Error(`alerts: unknown rule type "${r.type}"`);
    }
  }
  return { rules, cooldownMinutes: doc.cooldown_minutes };
}

/** Env overrides win over alerts.yaml, which wins over defaults. */
function applyEnvOverrides(rules: AlertRule[]): AlertRule[] {
  return rules.map((r) => {
    if (r.type === 'error_rate') {
      return { ...r, thresholdPct: num('ALERT_ERROR_RATE_PCT', r.thresholdPct), windowMinutes: num('ALERT_ERROR_RATE_WINDOW_MIN', r.windowMinutes) };
    }
    if (r.type === 'silence') return { ...r, minutes: num('ALERT_SILENCE_MIN', r.minutes) };
    return { ...r, multiplier: num('ALERT_SPIKE_MULTIPLIER', r.multiplier), baselineMinutes: num('ALERT_SPIKE_BASELINE_MIN', r.baselineMinutes) };
  });
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const arg = (name: string) => argv.includes(`--${name}`);
  const argVal = (name: string) => {
    const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0) return undefined;
    const a = argv[i];
    if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : undefined;
  };

  const apiKey = env('SOLAMI_API_KEY');
  const programIds = (argVal('programs') ?? env('PROGRAM_IDS', DEFAULT_PROGRAMS.join(',')))
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  const labels: Record<string, string> = {};
  for (const id of programIds) labels[id] = KNOWN_LABELS[id] ?? `${id.slice(0, 4)}…${id.slice(-4)}`;
  for (const pair of env('PROGRAM_LABELS').split(',').filter(Boolean)) {
    const [id, ...rest] = pair.split(':');
    if (id && rest.length) labels[id.trim()] = rest.join(':').trim();
  }

  const replayFlag = arg('replay') || env('SOURCE') === 'replay';
  const source = (replayFlag ? 'replay' : env('SOURCE', 'auto')) as SourceMode;

  const alertsFile = resolve(ROOT, argVal('alerts') ?? env('ALERTS_FILE', 'alerts.yaml'));
  let rules = DEFAULT_RULES;
  let cooldownMinutes = num('ALERT_COOLDOWN_MIN', 10);
  if (existsSync(alertsFile)) {
    const parsed = parseAlertsYaml(readFileSync(alertsFile, 'utf8'));
    rules = parsed.rules;
    if (parsed.cooldownMinutes !== undefined && !process.env.ALERT_COOLDOWN_MIN) cooldownMinutes = parsed.cooldownMinutes;
  }

  const replayArg = argVal('replay');
  const replayFiles = (replayArg ?? env('REPLAY_FILES', 'fixtures/jupiter.json,fixtures/pumpfun.json'))
    .split(',').map((f) => resolve(ROOT, f.trim())).filter((f) => existsSync(f));

  return {
    apiKey,
    grpcEndpoint: env('SOLAMI_GRPC_ENDPOINT', 'https://grpc.solami.dev'),
    grpcToken: env('SOLAMI_GRPC_TOKEN', apiKey),
    rpcUrl: withKey(env('SOLAMI_RPC_URL', apiKey ? 'https://rpc.solami.dev/sol' : 'https://api.mainnet-beta.solana.com'), apiKey),
    wsUrl: withKey(env('SOLAMI_WS_URL', 'wss://ws.solami.dev/ws/sol'), apiKey),
    apiUrl: env('SOLAMI_API_URL', 'https://api.solami.dev'),
    mirageSubscriptionId: env('MIRAGE_SUBSCRIPTION_ID'),
    programIds,
    labels,
    source,
    commitment: env('COMMITMENT', 'confirmed') as Config['commitment'],
    backfillSlots: Math.min(3500, num('BACKFILL_SLOTS', 150)),
    grpcUpgradeIntervalMs: num('GRPC_UPGRADE_INTERVAL_MIN', 5) * 60_000,
    rpcMaxRps: num('RPC_MAX_RPS', 4),
    pollIntervalMs: num('POLL_INTERVAL_MS', 2000),
    sampleIntervalMs: num('SAMPLE_INTERVAL_MS', 4000),
    sampleSize: num('SAMPLE_SIZE', 10),
    slotPollMs: num('SLOT_POLL_MS', 2000),
    port: num('PORT', 8787),
    host: env('HOST', '0.0.0.0'),
    snapshotIntervalMs: num('SNAPSHOT_INTERVAL_MS', 750),
    telegramBotToken: env('TELEGRAM_BOT_TOKEN'),
    telegramChatId: env('TELEGRAM_CHAT_ID'),
    alertsFile,
    alertRules: applyEnvOverrides(rules),
    alertCooldownMs: cooldownMinutes * 60_000,
    replay: {
      files: replayFiles,
      speed: Number(argVal('speed') ?? env('REPLAY_SPEED', '1')) || 1,
      chaos: arg('chaos') || env('REPLAY_CHAOS') === 'true',
    },
    idlDir: resolve(ROOT, env('IDL_DIR', 'idls')),
  };
}
