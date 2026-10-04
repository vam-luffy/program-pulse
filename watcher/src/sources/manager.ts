import { logger } from '../log.js';
import { SourceUnavailableError, type Source, type SourceName, type TxSink } from '../types.js';

const log = logger('source');

export interface SourceAttempt {
  name: SourceName;
  label: string;
  ok: boolean;
  reason?: string;
  at: number;
}

const NEXT_HINT: Record<SourceName, string> = {
  grpc: 'Yellowstone gRPC',
  mirage: 'Mirage WebSocket',
  ws: 'Solami WebSocket logsSubscribe',
  rpc: 'Solami RPC polling',
  replay: 'replay',
};

/**
 * Tries sources in order and keeps the first that delivers data. While running on a
 * fallback, periodically retries the preferred source (gRPC) so a plan upgrade is
 * picked up without a restart.
 */
export class SourceManager {
  active: Source | null = null;
  activeSince = 0;
  attempts: SourceAttempt[] = [];
  private upgradeTimer: NodeJS.Timeout | null = null;
  private upgrading = false;

  constructor(
    private readonly factories: (() => Source)[],
    private readonly sink: TxSink,
    private readonly upgradeIntervalMs = 5 * 60_000,
    private readonly onActive: (s: Source) => void = () => undefined,
  ) {}

  private record(a: SourceAttempt) {
    this.attempts.unshift(a);
    this.attempts.length = Math.min(this.attempts.length, 20);
  }

  async start(): Promise<Source> {
    for (let i = 0; i < this.factories.length; i++) {
      const src = this.factories[i]();
      log.info(`trying ${src.label}...`);
      try {
        await src.start(this.sink);
        this.active = src;
        this.activeSince = Date.now();
        this.record({ name: src.name, label: src.label, ok: true, at: Date.now() });
        log.info(`ACTIVE SOURCE: ${src.label}`);
        this.onActive(src);
        if (i > 0 && this.upgradeIntervalMs > 0) this.scheduleUpgrade(i);
        return src;
      } catch (e) {
        await src.stop().catch(() => undefined);
        const reason = e instanceof SourceUnavailableError ? e.message : (e as Error).message;
        this.record({ name: src.name, label: src.label, ok: false, reason, at: Date.now() });
        const next = this.factories[i + 1]?.();
        log.warn(`${src.label} unavailable: ${reason}` + (next ? ` -> falling back to ${NEXT_HINT[next.name]}` : ''));
        if (!next) throw new Error('No data source available. Check SOLAMI_API_KEY, or run with --replay to try without a key.', { cause: e });
      }
    }
    throw new Error('No data source configured.');
  }

  /** Every N minutes, retry sources ranked above the active one (e.g. after a Pro trial starts). */
  private scheduleUpgrade(activeIndex: number) {
    this.upgradeTimer = setInterval(async () => {
      if (this.upgrading) return;
      this.upgrading = true;
      try {
        for (let i = 0; i < activeIndex; i++) {
          const src = this.factories[i]();
          try {
            await src.start(this.sink);
            const old = this.active;
            this.active = src;
            this.activeSince = Date.now();
            this.record({ name: src.name, label: src.label, ok: true, at: Date.now() });
            log.info(`UPGRADED SOURCE: ${old?.label} -> ${src.label}`);
            this.onActive(src);
            await old?.stop();
            if (i === 0 && this.upgradeTimer) clearInterval(this.upgradeTimer);
            activeIndex = i;
            break;
          } catch (e) {
            await src.stop().catch(() => undefined);
            log.debug(`upgrade to ${src.label} still unavailable: ${(e as Error).message}`);
          }
        }
      } finally {
        this.upgrading = false;
      }
    }, this.upgradeIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.upgradeTimer) clearInterval(this.upgradeTimer);
    await this.active?.stop();
  }
}
