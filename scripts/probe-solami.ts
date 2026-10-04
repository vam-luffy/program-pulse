/**
 * Probe which Solami products your API key can reach.
 *   npm run probe
 * Never prints the key. Prints one line per endpoint: OK / AUTH / TIER / ERROR.
 */
import 'dotenv/config';
import WebSocket from 'ws';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ygrpc = require('@triton-one/yellowstone-grpc');
const Client = ygrpc.default ?? ygrpc;

const key = process.env.SOLAMI_API_KEY ?? '';
if (!key) {
  console.error('SOLAMI_API_KEY is not set (.env). Nothing to probe.');
  process.exit(1);
}
const rpcUrl = process.env.SOLAMI_RPC_URL || `https://rpc.solami.dev/sol?api_key=${key}`;
const wsUrl = process.env.SOLAMI_WS_URL || `wss://ws.solami.dev/ws/sol?api_key=${key}`;
const grpcUrl = process.env.SOLAMI_GRPC_ENDPOINT || 'https://grpc.solami.dev';
const api = process.env.SOLAMI_API_URL || 'https://api.solami.dev';

const redact = (s: string) => s.split(key).join('<key>');
const line = (name: string, status: string, detail: string) =>
  console.log(`${status.padEnd(6)} ${name.padEnd(34)} ${redact(detail).slice(0, 160)}`);

async function rpc() {
  try {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
    });
    const body = await r.text();
    line('RPC getSlot', r.ok && body.includes('"result"') ? 'OK' : r.status === 401 || r.status === 403 ? 'AUTH' : 'ERROR', `${r.status} ${body}`);
  } catch (e) {
    line('RPC getSlot', 'ERROR', String(e));
  }
}

function ws() {
  return new Promise<void>((resolve) => {
    const sock = new WebSocket(wsUrl);
    const t = setTimeout(() => { line('WebSocket slotSubscribe', 'ERROR', 'timeout 8s'); sock.terminate(); resolve(); }, 8000);
    sock.on('open', () => sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe' })));
    sock.on('message', (m) => {
      const s = m.toString();
      if (s.includes('slotNotification')) {
        line('WebSocket slotSubscribe', 'OK', s.slice(0, 120));
        clearTimeout(t); sock.close(); resolve();
      } else if (s.includes('error')) {
        line('WebSocket slotSubscribe', 'ERROR', s);
        clearTimeout(t); sock.close(); resolve();
      }
    });
    sock.on('unexpected-response', (_req, res) => {
      line('WebSocket slotSubscribe', res.statusCode === 401 || res.statusCode === 403 ? 'AUTH' : 'ERROR', `HTTP ${res.statusCode}`);
      clearTimeout(t); resolve();
    });
    sock.on('error', (e) => { line('WebSocket slotSubscribe', 'ERROR', String(e)); clearTimeout(t); resolve(); });
  });
}

async function grpc() {
  const client = new Client(grpcUrl, key, { 'grpc.max_receive_message_length': 64 * 1024 * 1024 });
  try {
    const slot = await Promise.race([
      client.getSlot(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000)),
    ]);
    line('gRPC GetSlot (unary)', 'OK', `slot ${slot}`);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    line('gRPC GetSlot (unary)', /PERMISSION_DENIED|UNAUTHENTICATED/.test(msg) ? 'AUTH' : 'ERROR', msg);
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (status: string, detail: string) => {
      if (done) return; done = true;
      line('gRPC Subscribe (tx filter)', status, detail);
      try { stream?.cancel(); } catch { /* ignore */ }
      resolve();
    };
    let stream: { cancel(): void; on: (...a: unknown[]) => void; write: (r: unknown, cb: (e?: Error) => void) => void } | undefined;
    const t = setTimeout(() => finish('ERROR', 'no update within 10s'), 10_000);
    client.subscribe().then((s: typeof stream) => {
      stream = s!;
      stream.on('data', (u: { transaction?: { slot: string } }) => {
        if (u.transaction) { clearTimeout(t); finish('OK', `tx update at slot ${u.transaction.slot}`); }
      });
      stream.on('error', (e: Error) => {
        clearTimeout(t);
        finish(/PERMISSION_DENIED|UNAUTHENTICATED|RESOURCE_EXHAUSTED/.test(e.message) ? 'TIER' : 'ERROR', e.message);
      });
      stream.write({
        accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {}, accountsDataSlice: [],
        transactions: { probe: { vote: false, failed: true, accountInclude: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'], accountExclude: [], accountRequired: [] } },
        commitment: 1,
      }, (err?: Error) => { if (err) { clearTimeout(t); finish('ERROR', err.message); } });
    }).catch((e: Error) => { clearTimeout(t); finish('ERROR', e.message); });
  });
}

async function rest(name: string, method: string, path: string, body?: unknown) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(`${api}${path}${sep}api_key=${encodeURIComponent(key)}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const status = r.ok ? 'OK' : r.status === 401 || r.status === 403 ? 'AUTH' : r.status === 402 || r.status === 429 ? 'TIER' : 'ERROR';
    line(name, status, `${r.status} ${text}`);
  } catch (e) {
    line(name, 'ERROR', String(e));
  }
}

console.log('Probing Solami endpoints (key redacted)...');
await rpc();
await ws();
await grpc();
await rest('Mirage list (account API)', 'POST', '/mirage/list');
await rest('Data API token intel', 'GET', '/data/token/intel?chain=solana&mint=So11111111111111111111111111111111111111112');
await rest('Beam tip addresses (no auth)', 'GET', '/onchain/tip-addresses');
process.exit(0);
