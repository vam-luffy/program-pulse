import type { AlertEvent, Notifier } from './alerts.js';
import { logger } from './log.js';

const log = logger('alert');

export class LogNotifier implements Notifier {
  notify(e: AlertEvent): void {
    const fn = e.state === 'firing' ? log.warn : log.info;
    fn(`${e.state === 'firing' ? 'FIRING ' : 'RESOLVED'} ${e.rule} ${e.message}`);
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Telegram Bot API sendMessage. Messages are queued and sent at most ~1/s to respect bot limits. */
export class TelegramNotifier implements Notifier {
  private queue: string[] = [];
  private sending = false;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  format(e: AlertEvent): string {
    const icon = e.state === 'firing' ? '🔴' : '🟢';
    return [
      `${icon} <b>Program Pulse</b> ${e.state.toUpperCase()}: <b>${escapeHtml(e.rule.replace('_', ' '))}</b>`,
      escapeHtml(e.message),
      `<code>${e.programId}</code>`,
      `<a href="https://solscan.io/account/${e.programId}">solscan</a>`,
    ].join('\n');
  }

  notify(e: AlertEvent): void {
    this.queue.push(this.format(e));
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length) {
      const text = this.queue.shift()!;
      try {
        const r = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        });
        if (!r.ok) log.warn(`telegram sendMessage failed: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      } catch (err) {
        log.warn('telegram sendMessage error', err);
      }
      await new Promise((res) => setTimeout(res, 1100));
    }
    this.sending = false;
  }
}
