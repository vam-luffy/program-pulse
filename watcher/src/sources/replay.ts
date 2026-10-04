import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { IdlRegistry } from '../idl.js';
import { logger } from '../log.js';
import { fromRpcTx, SlotClock, type RpcTx } from '../normalize.js';
import type { NormalizedTx, Source, TxSink } from '../types.js';

const log = logger('replay');
const SLOT_MS = 400;

export interface Fixture {
  programId: string;
  label?: string;
  source?: string;
  fetchedAt?: string;
  transactions: RpcTx[];
}

export function loadFixture(file: string): Fixture {
  const f = JSON.parse(readFileSync(file, 'utf8')) as Fixture;
  if (!f.programId || !Array.isArray(f.transactions)) throw new Error(`${basename(file)} is not a Program Pulse fixture`);
  return f;
}

export interface ReplayTrack {
  programId: string;
  /** offset in ms from loop start (at speed 1) */
  at: number[];
  txs: NormalizedTx[];
  loopMs: number;
}

/** Turn a fixture into a timed track: slot spacing x 400ms, txs inside a slot spread evenly. */
export function buildTrack(f: Fixture, watched: Set<string>, idl: IdlRegistry): ReplayTrack {
  const clock = new SlotClock();
  const rows = f.transactions
    .map((t) => fromRpcTx(t, watched, idl, clock))
    .filter((t): t is NormalizedTx => !!t && t.programIds.length > 0)
    .sort((a, b) => a.slot - b.slot);
  if (!rows.length) return { programId: f.programId, at: [], txs: [], loopMs: 1000 };
  const first = rows[0].slot;
  const perSlot = new Map<number, number>();
  for (const r of rows) perSlot.set(r.slot, (perSlot.get(r.slot) ?? 0) + 1);
  const seen = new Map<number, number>();
  const at = rows.map((r) => {
    const k = seen.get(r.slot) ?? 0;
    seen.set(r.slot, k + 1);
    return (r.slot - first) * SLOT_MS + (k / perSlot.get(r.slot)!) * SLOT_MS;
  });
  const loopMs = (rows[rows.length - 1].slot - first + 1) * SLOT_MS;
  return { programId: f.programId, at, txs: rows, loopMs };
}

/**
 * Chaos schedule (240s cycle) used by `--chaos` so every alert type can be demoed on replay:
 *   0-90s   normal
 *   90-150s second program paused       -> "silence" alert
 *   150-210s first program at 4x speed  -> "spike" alert
 *   210-240s normal (alerts resolve)
 */
export function chaosFactor(trackIndex: number, elapsedMs: number): number {
  const t = (elapsedMs / 1000) % 240;
  if (trackIndex === 1 && t >= 90 && t < 150) return 0;
  if (trackIndex === 0 && t >= 150 && t < 210) return 4;
  return 1;
}

export interface ReplayOptions {
  files: string[];
  programIds: string[];
  speed: number;
  chaos: boolean;
  idl: IdlRegistry;
  clock: SlotClock;
}

export class ReplaySource implements Source {
  readonly name = 'replay' as const;
  readonly label = 'Replay (recorded mainnet fixtures)';
  private timer: NodeJS.Timeout | null = null;
  private tracks: ReplayTrack[] = [];
  private baseSlot = 0;
  private startMs = 0;
  /** Simulated chain tip so stream-lag metrics behave like a live stream. */
  tip = 0;

  constructor(private readonly o: ReplayOptions) {}

  async start(sink: TxSink): Promise<void> {
    const watched = new Set(this.o.programIds);
    for (const f of this.o.files) {
      const fx = loadFixture(f);
      const track = buildTrack(fx, watched, this.o.idl);
      if (track.txs.length) this.tracks.push(track);
      log.info(`loaded ${basename(f)}: ${track.txs.length} txs over ${(track.loopMs / 1000).toFixed(1)}s of chain time (${fx.programId.slice(0, 6)}…)`);
    }
    if (!this.tracks.length) throw new Error('replay: no fixtures found. Run `npm run fixtures` first.');
    this.baseSlot = Math.max(...this.tracks.flatMap((t) => t.txs.map((x) => x.slot)));
    this.startMs = Date.now();
    log.info(`replaying at ${this.o.speed}x${this.o.chaos ? ' with chaos schedule (silence + spike every 4 min)' : ''}; signatures are real, slots are rebased`);

    const cursors = this.tracks.map(() => ({ i: 0, loopStart: 0, virtual: 0 }));
    let lastTick = Date.now();
    const tick = () => {
      const now = Date.now();
      const dt = now - lastTick;
      lastTick = now;
      const elapsed = now - this.startMs;
      this.tip = this.baseSlot + Math.floor(elapsed / SLOT_MS);
      this.o.clock.observe(this.tip, now);
      sink.slot(this.tip - 1);
      // A paused program must be fully silent, including other tracks' txs that route through it
      // (e.g. Jupiter swaps that hop through Pump.fun).
      const paused = this.o.chaos ? this.tracks.filter((_, ti) => chaosFactor(ti, elapsed) === 0).map((t) => t.programId) : [];
      this.tracks.forEach((track, ti) => {
        const c = cursors[ti];
        const factor = this.o.chaos ? chaosFactor(ti, elapsed) : 1;
        c.virtual += dt * this.o.speed * factor;
        // Emit every tx whose scheduled offset has passed; wrap around at the end of the track.
        let guard = 0;
        while (guard++ < 5000) {
          const due = c.loopStart + track.at[c.i];
          if (due > c.virtual) break;
          const src = track.txs[c.i];
          if (!paused.some((p) => src.programIds.includes(p))) {
            sink.tx({ ...src, slot: this.tip - 1 - Math.floor(Math.random() * 2), ts: now });
          }
          c.i++;
          if (c.i >= track.txs.length) {
            c.i = 0;
            c.loopStart += track.loopMs;
          }
        }
      });
    };
    this.timer = setInterval(tick, 100);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
