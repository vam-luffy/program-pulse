import { useEffect, useState } from 'react';
import { Sparkline } from './Sparkline';
import { ago, clock, compact, duration, explorerAccount, explorerTx, pct, short, sol } from './format';
import type { AlertEvent, ProgramSnapshot, RecentTx, Snapshot } from './types';
import { useStream, type ConnState } from './useStream';

const PALETTE = ['#3ee6a8', '#7aa2ff', '#ffb547', '#ff7ad9', '#5ee0ff', '#c3a6ff'];

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function errColor(rate: number | null) {
  if (rate === null) return 'var(--muted)';
  if (rate >= 0.6) return 'var(--red)';
  if (rate >= 0.3) return 'var(--amber)';
  return 'var(--green)';
}

function lagColor(lag: number | null) {
  if (lag === null) return 'var(--muted)';
  if (lag > 30) return 'var(--red)';
  if (lag > 8) return 'var(--amber)';
  return 'var(--green)';
}

function Header({ snap, conn, now }: { snap: Snapshot | null; conn: ConnState; now: number }) {
  const h = snap?.health;
  const replay = snap?.mode === 'replay';
  return (
    <header className="top">
      <div className="brand">
        <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
          <path d="M3 17h6l3-8 5 15 3-9 2 2h7" fill="none" stroke="var(--green)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div>
          <div className="title">Program Pulse</div>
          <div className="subtitle">live Solana program monitor · powered by Solami</div>
        </div>
      </div>
      <div className="chips">
        <span className={`chip ${replay ? 'chip-amber' : 'chip-green'}`}>
          <span className={`dot ${conn === 'open' ? 'pulse' : ''}`} />
          {replay ? `REPLAY${snap?.source.replay?.chaos ? ' · CHAOS' : ''}` : 'LIVE · MAINNET'}
        </span>
        <span className="chip" title={snap?.source.attempts.map((a) => `${a.ok ? '✓' : '✗'} ${a.label}${a.reason ? `: ${a.reason}` : ''}`).join('\n')}>
          <span className="k">source</span> {snap?.source.label ?? '…'}
        </span>
        <span className="chip mono">
          <span className="k">chain slot</span> {h?.chainSlot ? h.chainSlot.toLocaleString('en-US') : '–'}
        </span>
        <span className="chip mono" style={{ color: lagColor(h?.lagSlots ?? null) }}>
          <span className="k">stream lag</span> {h?.lagSlots ?? '–'} slots{h?.lagMs !== null && h?.lagMs !== undefined ? ` · ${(h.lagMs / 1000).toFixed(1)}s` : ''}
        </span>
        <span className="chip mono">
          <span className="k">uptime</span> {snap ? duration(now - snap.startedAt) : '–'}
        </span>
        {conn !== 'open' && <span className="chip chip-red">watcher {conn}</span>}
      </div>
    </header>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value mono" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function ProgramCard({ p, color, now, alerting }: { p: ProgramSnapshot; color: string; now: number; alerting: boolean }) {
  const sampled = p.detailCoverage !== null && p.detailCoverage < 0.98;
  const errSeries = p.series.errorRate;
  return (
    <section className={`card program ${alerting ? 'alerting' : ''}`}>
      <div className="card-head">
        <div>
          <span className="swatch" style={{ background: color }} />
          <span className="program-name">{p.label}</span>
          <a className="pid mono" href={explorerAccount(p.programId)} target="_blank" rel="noreferrer">
            {short(p.programId, 6, 6)}
          </a>
        </div>
        <div className="muted small mono">
          slot {p.lastSeenSlot ? p.lastSeenSlot.toLocaleString('en-US') : '–'} · {ago(p.lastSeenAt, now)}
        </div>
      </div>

      <div className="hero">
        <div className="hero-block">
          <div className="stat-label">tx / min</div>
          <div className="hero-value mono" style={{ color }}>
            {compact(p.txPerMin)}
          </div>
          <Sparkline values={p.series.txPerMin} color={color} label="tx per minute, last 10 minutes" />
        </div>
        <div className="hero-block">
          <div className="stat-label">error rate · 5m</div>
          <div className="hero-value mono" style={{ color: errColor(p.errorRate5m) }}>
            {pct(p.errorRate5m)}
          </div>
          <Sparkline values={errSeries} color="#ff5d6c" max={1} label="error rate, last 10 minutes" />
        </div>
      </div>

      <div className="stats">
        <Stat label="ok / failed · 1h" value={`${compact(p.window1h.ok)} / ${compact(p.window1h.fail)}`} />
        <Stat label="unique signers · 1h" value={compact(p.uniqueSigners1h)} sub={sampled ? 'from sampled txs' : undefined} />
        <Stat label="avg compute units" value={compact(p.avgComputeUnits)} />
        <Stat label="avg fee (SOL)" value={sol(p.avgFeeLamports)} sub={`${sol(p.feeLamports1h, 3)} SOL seen · 1h`} />
      </div>

      <div className="ix">
        <div className="ix-head">
          <span className="stat-label">top instructions · 1h</span>
          {sampled && <span className="tag">sampled {pct(p.detailCoverage, 1)} of txs</span>}
        </div>
        {p.topInstructions.length === 0 && <div className="muted small">waiting for decoded instructions…</div>}
        {p.topInstructions.slice(0, 5).map((ix) => (
          <div className="ix-row" key={ix.name}>
            <span className={`ix-name mono ${ix.name.startsWith('0x') ? 'hex' : ''}`}>{ix.name}</span>
            <span className="ix-bar">
              <span style={{ width: `${Math.max(2, ix.pct * 100)}%`, background: color }} />
            </span>
            <span className="ix-pct mono">{pct(ix.pct, 0)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TxFeed({ txs, labels, colors }: { txs: RecentTx[]; labels: Record<string, string>; colors: Record<string, string> }) {
  return (
    <section className="card feed">
      <div className="card-head">
        <span className="section-title">Live transactions</span>
        <span className="muted small">last {txs.length} · click to open in Solscan</span>
      </div>
      <div className="feed-table">
        <div className="feed-row feed-header">
          <span>time</span>
          <span>program</span>
          <span>instruction</span>
          <span>status</span>
          <span>signer</span>
          <span className="num">CU</span>
          <span className="num">fee</span>
          <span>signature</span>
        </div>
        <div className="feed-body">
          {txs.map((t) => {
            const pid = t.programIds[0];
            return (
              <a className="feed-row" key={t.signature} href={explorerTx(t.signature)} target="_blank" rel="noreferrer">
                <span className="mono muted">{clock(t.ts)}</span>
                <span>
                  <span className="pill" style={{ borderColor: colors[pid], color: colors[pid] }}>
                    {labels[pid] ?? short(pid)}
                    {t.programIds.length > 1 ? ` +${t.programIds.length - 1}` : ''}
                  </span>
                </span>
                <span className={`mono ${t.ix?.startsWith('0x') || !t.ix ? 'hex' : ''}`} title={!t.ix && t.signer ? 'failed before the watched program was invoked' : undefined}>
                  {t.ix ?? (t.signer ? 'not reached' : '…')}
                </span>
                <span className={t.success ? 'ok' : 'fail'} title={t.error}>
                  {t.success ? '✓ ok' : `✗ ${t.error ? short(t.error, 18, 0) : 'failed'}`}
                </span>
                <span className="mono muted">{short(t.signer)}</span>
                <span className="mono num">{compact(t.computeUnits)}</span>
                <span className="mono num">{t.feeLamports !== undefined ? compact(t.feeLamports) : '–'}</span>
                <span className="mono link">{short(t.signature, 6, 4)} ↗</span>
              </a>
            );
          })}
          {txs.length === 0 && <div className="muted small pad">waiting for transactions…</div>}
        </div>
      </div>
    </section>
  );
}

const RULE_LABEL: Record<AlertEvent['rule'], string> = { error_rate: 'error rate', silence: 'silence', spike: 'tx spike' };

function Alerts({ snap, now }: { snap: Snapshot; now: number }) {
  return (
    <section className="card alerts">
      <div className="card-head">
        <span className="section-title">Alerts</span>
        <span className="muted small">{snap.telegram ? 'Telegram + log' : 'log only · Telegram off'}</span>
      </div>
      <div className="alert-list">
        {snap.alerts.length === 0 && <div className="muted small pad">All quiet. Rules: error rate, silence, tx/min spike.</div>}
        {snap.alerts.slice(0, 8).map((a) => (
          <div key={a.id} className={`alert ${a.state}`}>
            <div className="alert-top">
              <span className={`badge ${a.state}`}>{a.state === 'firing' ? 'FIRING' : 'RESOLVED'}</span>
              <span className="alert-rule">{RULE_LABEL[a.rule]}</span>
              <span className="muted small">{ago(a.at, now)}</span>
            </div>
            <div className="alert-msg">{a.message}</div>
          </div>
        ))}
      </div>
      <div className="path">
        <div className="stat-label">data path</div>
        {snap.source.attempts
          .slice()
          .reverse()
          .slice(-4)
          .map((a, i) => (
            <div key={i} className="path-row small">
              <span className={a.ok ? 'ok' : 'fail'}>{a.ok ? '●' : '○'}</span> <span>{a.label}</span>
              {a.reason && <span className="muted"> – {short(a.reason, 46, 0)}</span>}
            </div>
          ))}
        {snap.health.rpc && (
          <div className="path-row small muted mono">
            RPC {snap.health.rpc.host} · {compact(snap.health.rpc.calls)} calls · {snap.health.rpc.rateLimited} rate-limited
          </div>
        )}
      </div>
    </section>
  );
}

export default function App() {
  const { snap, conn, flash } = useStream();
  const now = useNow();
  const labels: Record<string, string> = {};
  const colors: Record<string, string> = {};
  snap?.programs.forEach((p, i) => {
    labels[p.programId] = p.label;
    colors[p.programId] = PALETTE[i % PALETTE.length];
  });
  const alerting = new Set((snap?.activeAlerts ?? []).map((k) => k.split(':')[2]));

  return (
    <div className="app">
      <Header snap={snap} conn={conn} now={now} />
      {flash && (
        <div className={`toast ${flash.state}`}>
          <b>{flash.state === 'firing' ? 'ALERT' : 'RESOLVED'}</b> {flash.message}
        </div>
      )}
      {!snap ? (
        <div className="empty">Connecting to watcher… start it with <code>npm run dev</code> or <code>npm run dev:replay</code></div>
      ) : (
        <main>
          <div className="programs" style={{ gridTemplateColumns: `repeat(${Math.min(snap.programs.length, 3)}, minmax(0, 1fr))` }}>
            {snap.programs.map((p) => (
              <ProgramCard key={p.programId} p={p} color={colors[p.programId]} now={now} alerting={alerting.has(p.programId)} />
            ))}
          </div>
          <div className="bottom">
            <TxFeed txs={snap.recentTxs} labels={labels} colors={colors} />
            <Alerts snap={snap} now={now} />
          </div>
        </main>
      )}
    </div>
  );
}
