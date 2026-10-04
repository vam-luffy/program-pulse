import { redact } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? 20;
const secrets = { apiKey: process.env.SOLAMI_API_KEY ?? '', grpcToken: process.env.SOLAMI_GRPC_TOKEN ?? '', telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '' };

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < min || process.env.VITEST) return;
  const time = new Date().toISOString().slice(11, 23);
  let line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) line += ' ' + (extra instanceof Error ? extra.message : JSON.stringify(extra));
  line = redact(line, secrets);
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export function logger(scope: string) {
  return {
    debug: (m: string, x?: unknown) => emit('debug', scope, m, x),
    info: (m: string, x?: unknown) => emit('info', scope, m, x),
    warn: (m: string, x?: unknown) => emit('warn', scope, m, x),
    error: (m: string, x?: unknown) => emit('error', scope, m, x),
  };
}
export type Logger = ReturnType<typeof logger>;
