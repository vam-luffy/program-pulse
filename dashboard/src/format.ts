export const compact = (n: number | null | undefined, digits = 1): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(digits) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(digits) + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(digits) + 'k';
  return Math.round(n).toLocaleString('en-US');
};

export const pct = (x: number | null | undefined, digits = 1): string =>
  x === null || x === undefined ? '–' : `${(x * 100).toFixed(digits)}%`;

export const sol = (lamports: number | null | undefined, digits = 6): string =>
  lamports === null || lamports === undefined ? '–' : `${(lamports / 1e9).toFixed(digits)}`;

export const short = (s: string | undefined, a = 4, b = 4): string => (s ? (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s) : '–');

export const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });

export const ago = (ms: number | null | undefined, now = Date.now()): string => {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

export const duration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};

export const explorerTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const explorerAccount = (a: string) => `https://solscan.io/account/${a}`;
