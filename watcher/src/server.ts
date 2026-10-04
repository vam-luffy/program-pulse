import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { logger } from './log.js';

const log = logger('http');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

export interface ServerDeps {
  snapshot: () => unknown;
  port: number;
  host: string;
  snapshotIntervalMs: number;
  /** Built dashboard (dashboard/dist). Served at / when present. */
  staticDir?: string;
}

/**
 * Tiny dependency-free HTTP server:
 *   GET /api/state      full JSON snapshot
 *   GET /api/stream     Server-Sent Events: `snapshot` every SNAPSHOT_INTERVAL_MS, `alert` on fire/resolve
 *   GET /healthz        liveness
 *   GET /*              built dashboard (if present)
 */
export class PulseServer {
  private server: Server;
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly d: ServerDeps) {
    this.server = createServer((req, res) => this.route(req, res));
  }

  listen(): Promise<void> {
    return new Promise((res, rej) => {
      this.server.once('error', rej);
      this.server.listen(this.d.port, this.d.host, () => {
        log.info(`API on http://localhost:${this.d.port}  (GET /api/state, SSE /api/stream)`);
        res();
      });
      this.timer = setInterval(() => this.broadcast('snapshot', this.d.snapshot()), this.d.snapshotIntervalMs);
      this.heartbeat = setInterval(() => this.clients.forEach((c) => c.write(': ping\n\n')), 15_000);
    });
  }

  broadcast(event: string, data: unknown): void {
    if (!this.clients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(payload);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (url.pathname === '/healthz') return this.json(res, { ok: true });
    if (url.pathname === '/api/state') return this.json(res, this.d.snapshot());
    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`event: snapshot\ndata: ${JSON.stringify(this.d.snapshot())}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (url.pathname.startsWith('/api/')) return this.json(res, { error: 'not found' }, 404);
    return this.serveStatic(url.pathname, res);
  }

  private json(res: ServerResponse, body: unknown, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private serveStatic(pathname: string, res: ServerResponse) {
    const dir = this.d.staticDir;
    if (!dir || !existsSync(dir)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Program Pulse watcher is running. Dashboard: `npm run dev` (http://localhost:5173) or `npm run build` to serve it here. API: /api/state, /api/stream');
    }
    const root = resolve(dir);
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
