// Mirrors the watcher's /api/state payload.
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
  detailCoverage: number | null;
  topInstructions: { name: string; count: number; pct: number }[];
  lastSeenSlot: number;
  lastSeenAt: number | null;
  firstSeenAt: number | null;
  totals: { tx: number; fail: number };
  series: { txPerMin: number[]; errorRate: (number | null)[]; binSeconds: number };
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
  ix?: string;
}

export interface AlertEvent {
  id: string;
  rule: 'error_rate' | 'silence' | 'spike';
  programId: string;
  label: string;
  state: 'firing' | 'resolved';
  message: string;
  value: number;
  threshold: number;
  at: number;
}

export interface SourceAttempt {
  name: string;
  label: string;
  ok: boolean;
  reason?: string;
  at: number;
}

export interface Snapshot {
  generatedAt: number;
  startedAt: number;
  mode: 'live' | 'replay';
  cluster: string;
  source: {
    name: string | null;
    label: string;
    since: number | null;
    attempts: SourceAttempt[];
    replay: { speed: number; chaos: boolean } | null;
  };
  health: {
    chainSlot: number | null;
    streamSlot: number;
    lagSlots: number | null;
    lagMs: number | null;
    lastEventAgeMs: number | null;
    rpc: { host: string; ok: boolean; calls: number; errors: number; rateLimited: number; lastError?: string } | null;
    received: number;
    duplicates: number;
    details: number;
  };
  programs: ProgramSnapshot[];
  recentTxs: RecentTx[];
  feed: 'all' | 'sampled';
  alerts: AlertEvent[];
  activeAlerts: string[];
  telegram: boolean;
}
