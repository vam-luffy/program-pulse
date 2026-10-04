import { resolve } from 'node:path';
import { AlertEngine, type Notifier } from './alerts.js';
import { loadConfig, ROOT } from './config.js';
import { HealthTracker } from './health.js';
import { IdlRegistry } from './idl.js';
import { logger } from './log.js';
import { Aggregator } from './metrics.js';
import { SlotClock } from './normalize.js';
import { LogNotifier, TelegramNotifier } from './notify.js';
import { Pipeline } from './pipeline.js';
import { RpcClient } from './rpc.js';
import { PulseServer } from './server.js';
import { GrpcSource } from './sources/grpc.js';
import { SourceManager } from './sources/manager.js';
import { MirageSource } from './sources/mirage.js';
import { loadFixture, ReplaySource } from './sources/replay.js';
import { RpcPollSource } from './sources/rpcPoll.js';
import { WsLogsSource } from './sources/wsLogs.js';
import type { Source } from './types.js';

const log = logger('pulse');

async function main() {
  const cfg = loadConfig();
  const replay = cfg.source === 'replay';

  if (replay && !process.env.PROGRAM_IDS) {
    // In replay mode watch whatever programs the fixtures were recorded for.
    cfg.programIds = cfg.replay.files.map((f) => loadFixture(f).programId);
    for (const f of cfg.replay.files) {
      const fx = loadFixture(f);
      if (fx.label) cfg.labels[fx.programId] ??= fx.label;
    }
  }
  if (!cfg.programIds.length) throw new Error('PROGRAM_IDS is empty');

  const idl = IdlRegistry.fromDir(cfg.idlDir);
  const clock = new SlotClock();
  const agg = new Aggregator(cfg.programIds, cfg.labels);
  const pipeline = new Pipeline(agg, !replay);

  log.info(`Program Pulse starting: ${cfg.programIds.map((p) => `${cfg.labels[p]} (${p})`).join(', ')}`);
  log.info(`IDLs loaded for: ${idl.programs.map((p) => cfg.labels[p] ?? p).join(', ') || 'none (instruction names shown as hex discriminators)'}`);
  if (!replay && !cfg.apiKey) log.warn('SOLAMI_API_KEY is not set: using the public RPC only. Get a key at https://solami.dev or run with --replay.');

  const rpc = replay ? null : new RpcClient(cfg.rpcUrl, cfg.rpcMaxRps);

  const factories: Record<string, () => Source> = {
    grpc: () => new GrpcSource({ endpoint: cfg.grpcEndpoint, token: cfg.grpcToken, programIds: cfg.programIds, commitment: cfg.commitment, backfillSlots: cfg.backfillSlots, idl, clock, rpc: rpc! }),
    mirage: () => new MirageSource({ apiKey: cfg.apiKey, apiUrl: cfg.apiUrl, subscriptionId: cfg.mirageSubscriptionId, programIds: cfg.programIds, commitment: cfg.commitment, idl, clock }),
    ws: () => new WsLogsSource({ url: cfg.wsUrl, programIds: cfg.programIds, commitment: cfg.commitment, clock }),
    rpc: () => new RpcPollSource({ rpc: rpc!, programIds: cfg.programIds, commitment: cfg.commitment, pollIntervalMs: cfg.pollIntervalMs, sampleIntervalMs: cfg.sampleIntervalMs, sampleSize: cfg.sampleSize, idl, clock }),
  };
  let replaySource: ReplaySource | null = null;
  let chain: (() => Source)[];
  if (replay) {
    replaySource = new ReplaySource({ files: cfg.replay.files, programIds: cfg.programIds, speed: cfg.replay.speed, chaos: cfg.replay.chaos, idl, clock });
    chain = [() => replaySource!];
  } else if (cfg.source === 'auto') {
    chain = cfg.apiKey ? [factories.grpc, factories.mirage, factories.ws, factories.rpc] : [factories.rpc];
  } else {
    chain = [factories[cfg.source]];
  }

  const notifiers: Notifier[] = [new LogNotifier()];
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    notifiers.push(new TelegramNotifier(cfg.telegramBotToken, cfg.telegramChatId));
    log.info('Telegram alerts enabled');
  } else {
    log.info('Telegram alerts disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable)');
  }
  const alerts = new AlertEngine(agg, cfg.alertRules, notifiers, cfg.alertCooldownMs);
  const health = new HealthTracker(pipeline.stats, rpc, cfg.commitment, replaySource ? () => replaySource!.tip : undefined);
  const manager = new SourceManager(chain, pipeline, replay ? 0 : cfg.grpcUpgradeIntervalMs, (src) => {
    agg.feedDetailedOnly = src.name === 'rpc';
  });

  const startedAt = Date.now();
  const snapshot = () => ({
    generatedAt: Date.now(),
    startedAt,
    mode: replay ? 'replay' : 'live',
    cluster: 'mainnet-beta',
    source: {
      name: manager.active?.name ?? null,
      label: manager.active?.label ?? 'connecting…',
      since: manager.activeSince || null,
      attempts: manager.attempts,
      replay: replay ? { speed: cfg.replay.speed, chaos: cfg.replay.chaos } : null,
    },
    health: health.snapshot(),
    programs: agg.snapshot(),
    recentTxs: agg.recentTxs(),
    feed: agg.feedDetailedOnly ? 'sampled' : 'all',
    alerts: alerts.recent(),
    activeAlerts: alerts.active(),
    rules: cfg.alertRules,
    telegram: notifiers.length > 1,
  });

  const server = new PulseServer({ snapshot, port: cfg.port, host: cfg.host, snapshotIntervalMs: cfg.snapshotIntervalMs, staticDir: resolve(ROOT, 'dashboard', 'dist') });
  await server.listen();
  health.start(cfg.slotPollMs);
  await manager.start();

  const alertTimer = setInterval(() => {
    for (const e of alerts.evaluate()) server.broadcast('alert', e);
  }, 5000);

  const statusTimer = setInterval(() => {
    const h = health.snapshot();
    const parts = agg.snapshot().map((p) => `${p.label}: ${p.txPerMin} tx/min, err ${p.errorRate5m === null ? '-' : (p.errorRate5m * 100).toFixed(1) + '%'}`);
    log.info(`${parts.join(' | ')} | lag ${h.lagSlots ?? '-'} slots | ${server.clientCount} dashboard client(s)`);
  }, 30_000);

  const shutdown = async () => {
    log.info('shutting down');
    clearInterval(alertTimer);
    clearInterval(statusTimer);
    health.stop();
    await manager.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error((e as Error).message);
  process.exit(1);
});
