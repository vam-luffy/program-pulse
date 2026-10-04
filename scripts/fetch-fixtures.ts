/**
 * Record real mainnet transactions for replay mode ("try it without a key").
 *
 *   npm run fixtures                      # Jupiter v6 + Pump.fun, 200 each, public RPC
 *   npm run fixtures -- --program <id> --name myprog --count 200 [--rpc <url>]
 *
 * Uses getSignaturesForAddress + getTransaction against the PUBLIC mainnet RPC by default
 * (https://api.mainnet-beta.solana.com), paced to stay under its per-method rate limit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const RPC = arg('rpc') ?? 'https://api.mainnet-beta.solana.com';
const COUNT = Number(arg('count') ?? 200);
const RPS = Number(arg('rps') ?? 3);

const targets: { programId: string; name: string; label: string }[] = arg('program')
  ? [{ programId: arg('program')!, name: arg('name') ?? arg('program')!.slice(0, 8), label: arg('label') ?? arg('name') ?? 'Program' }]
  : [
      { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', name: 'jupiter', label: 'Jupiter v6' },
      { programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', name: 'pumpfun', label: 'Pump.fun' },
    ];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = lastCall + 1000 / RPS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (r.status === 429) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const body = (await r.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) {
      if (body.error.code === 429 || /rate/i.test(body.error.message)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`${method}: ${body.error.message}`);
    }
    return body.result as T;
  }
  throw new Error(`${method}: gave up after retries (rate limited)`);
}

interface Tx {
  slot: number;
  blockTime: number | null;
  version?: unknown;
  transaction: { signatures: string[]; message: Record<string, unknown> };
  meta: Record<string, unknown> | null;
}

/** Keep only what the watcher needs so fixtures stay small. */
function slim(tx: Tx, signature: string) {
  const m = tx.meta ?? {};
  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    version: tx.version,
    transaction: {
      signatures: tx.transaction.signatures.slice(0, 1),
      message: { accountKeys: tx.transaction.message.accountKeys, instructions: tx.transaction.message.instructions },
    },
    meta: {
      err: m.err ?? null,
      fee: m.fee,
      computeUnitsConsumed: m.computeUnitsConsumed,
      innerInstructions: m.innerInstructions,
      loadedAddresses: m.loadedAddresses,
    },
  };
}

mkdirSync(resolve(ROOT, 'fixtures'), { recursive: true });
for (const t of targets) {
  console.log(`[${t.name}] getSignaturesForAddress ${t.programId} limit ${COUNT} via ${new URL(RPC).host}`);
  const sigs = await rpc<{ signature: string; slot: number; err: unknown }[]>('getSignaturesForAddress', [t.programId, { limit: COUNT, commitment: 'finalized' }]);
  const txs = [];
  let i = 0;
  for (const s of sigs) {
    i++;
    try {
      const tx = await rpc<Tx | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
      if (tx) txs.push(slim(tx, s.signature));
    } catch (e) {
      console.warn(`  skip ${s.signature.slice(0, 10)}: ${(e as Error).message}`);
    }
    if (i % 25 === 0) console.log(`  ${i}/${sigs.length}`);
  }
  const failed = txs.filter((x) => x.meta.err).length;
  const file = resolve(ROOT, 'fixtures', `${t.name}.json`);
  writeFileSync(
    file,
    JSON.stringify({ programId: t.programId, label: t.label, source: RPC, fetchedAt: new Date().toISOString(), transactions: txs }),
  );
  const slots = txs.map((x) => x.slot);
  console.log(`[${t.name}] saved ${txs.length} txs (${failed} failed) slots ${Math.min(...slots)}..${Math.max(...slots)} -> ${file}`);
}
