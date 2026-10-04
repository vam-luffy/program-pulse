import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { anchorDiscriminator, IdlRegistry, toSnake } from '../src/idl.js';
import { describeError, fromGeyserTx, fromRpcTx, SlotClock, type RpcTx } from '../src/normalize.js';
import { pickFromSlot } from '../src/sources/grpc.js';
import { buildSubscribeRequest } from '../src/sources/geyser.js';
import { chaosFactor } from '../src/sources/replay.js';
import { parseLogs } from '../src/sources/wsLogs.js';
import { SeenSet } from '../src/pipeline.js';

const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const disc = (name: string) => Buffer.from(anchorDiscriminator(name), 'hex');

describe('IDL discriminators', () => {
  it('derives Anchor discriminators (known pump.fun values)', () => {
    expect(anchorDiscriminator('buy')).toBe('66063d1201daebea');
    expect(anchorDiscriminator('sell')).toBe('33e685a4017f83ad');
    expect(anchorDiscriminator('sharedAccountsRoute')).toBe(anchorDiscriminator('shared_accounts_route'));
  });

  it('converts camelCase / PascalCase to snake_case', () => {
    expect(toSnake('SharedAccountsRoute')).toBe('shared_accounts_route');
    expect(toSnake('buyExactSolIn')).toBe('buy_exact_sol_in');
  });

  it('decodes names, falls back to hex, labels anchor events; accepts explicit discriminators', () => {
    const reg = new IdlRegistry();
    reg.add(PUMP, [{ name: 'buy' }, { name: 'custom', discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }]);
    expect(reg.decode(PUMP, Buffer.concat([disc('buy'), Buffer.alloc(16)]))).toBe('buy');
    expect(reg.decode(PUMP, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe('custom');
    expect(reg.decode(PUMP, Uint8Array.from([9, 9]))).toBe('0x0909');
    expect(reg.decode(JUP, disc('route'))).toBe(`0x${anchorDiscriminator('route')}`);
    expect(reg.decode(PUMP, Buffer.from('e445a52e51cb9a1d00', 'hex'))).toBe('(anchor event)');
  });

  it('loads the bundled IDL files', () => {
    const reg = IdlRegistry.fromDir(fileURLToPath(new URL('../../idls', import.meta.url)));
    expect(reg.has(JUP)).toBe(true);
    expect(reg.decode(JUP, disc('shared_accounts_route'))).toBe('shared_accounts_route');
    expect(reg.decode(PUMP, disc('sell'))).toBe('sell');
  });
});

describe('normalize', () => {
  const reg = new IdlRegistry();
  reg.add(JUP, [{ name: 'route' }]);
  reg.add(PUMP, [{ name: 'buy' }]);
  const watched = new Set([JUP, PUMP]);

  it('normalizes a JSON-RPC transaction incl. v0 loaded addresses and inner instructions', () => {
    const raw: RpcTx = {
      slot: 100,
      blockTime: 1_700_000_000,
      transaction: {
        signatures: ['SIG1'],
        message: {
          accountKeys: ['Payer111', JUP, 'Other'],
          instructions: [{ programIdIndex: 1, data: bs58.encode(disc('route')) }],
        },
      },
      meta: {
        err: { InstructionError: [0, { Custom: 6001 }] },
        fee: 5000,
        computeUnitsConsumed: 123_456,
        innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 3, data: bs58.encode(disc('buy')) }] }],
        loadedAddresses: { writable: [PUMP], readonly: [] },
      },
    };
    const tx = fromRpcTx(raw, watched, reg, new SlotClock())!;
    expect(tx.signature).toBe('SIG1');
    expect(tx.success).toBe(false);
    expect(tx.error).toBe('ix 0: custom 0x1771 (6001)');
    expect(tx.ts).toBe(1_700_000_000_000);
    expect(tx.signer).toBe('Payer111');
    expect(tx.programIds.sort()).toEqual([JUP, PUMP].sort());
    expect(tx.instructions).toEqual([
      { programId: JUP, name: 'route', inner: false },
      { programId: PUMP, name: 'buy', inner: true },
    ]);
    expect(tx.computeUnits).toBe(123_456);
  });

  it('normalizes a Yellowstone SubscribeUpdateTransaction', () => {
    const key = (s: string) => bs58.decode(s);
    const payer = bs58.encode(Buffer.alloc(32, 7));
    const tx = fromGeyserTx(
      {
        slot: '777',
        transaction: {
          signature: Buffer.alloc(64, 1),
          isVote: false,
          transaction: { signatures: [], message: { accountKeys: [key(payer), key(PUMP)], instructions: [{ programIdIndex: 1, data: disc('buy') }] } },
          meta: { fee: '5000', computeUnitsConsumed: '42', innerInstructions: [], loadedWritableAddresses: [], loadedReadonlyAddresses: [] },
        },
      },
      watched,
      reg,
      new SlotClock(),
    )!;
    expect(tx.slot).toBe(777);
    expect(tx.success).toBe(true);
    expect(tx.signer).toBe(payer);
    expect(tx.feeLamports).toBe(5000);
    expect(tx.computeUnits).toBe(42);
    expect(tx.instructions![0].name).toBe('buy');
    expect(tx.signature).toBe(bs58.encode(Buffer.alloc(64, 1)));
  });

  it('describes common error shapes', () => {
    expect(describeError(null)).toBeUndefined();
    expect(describeError('AccountInUse')).toBe('AccountInUse');
    expect(describeError({ InstructionError: [2, 'InvalidAccountData'] })).toBe('ix 2: InvalidAccountData');
  });

  it('estimates time from slot when blockTime is missing', () => {
    let now = 1_000_000;
    const c = new SlotClock(() => now);
    c.observe(1000, now);
    now += 1000;
    expect(c.timeOf(990)).toBe(1_000_000 - 4000);
    expect(c.timeOf(1005)).toBe(now); // never in the future
  });
});

describe('WebSocket log parsing', () => {
  it('extracts Anchor instruction names for watched programs and top-level CU', () => {
    const logs = [
      'Program ComputeBudget111111111111111111111111111111 invoke [1]',
      'Program ComputeBudget111111111111111111111111111111 success',
      `Program ${JUP} invoke [1]`,
      'Program log: Instruction: SharedAccountsRoute',
      `Program ${PUMP} invoke [2]`,
      'Program log: Instruction: Buy',
      `Program ${PUMP} consumed 30000 of 180000 compute units`,
      `Program ${PUMP} success`,
      `Program ${JUP} consumed 90000 of 200000 compute units`,
      `Program ${JUP} success`,
    ];
    const r = parseLogs(logs, new Set([JUP, PUMP]));
    expect(r.instructions).toEqual([
      { programId: JUP, name: 'shared_accounts_route', inner: false },
      { programId: PUMP, name: 'buy', inner: true },
    ]);
    expect(r.computeUnits).toBe(90000);
  });
});

describe('gRPC slot replay', () => {
  it('resumes at lastSlot + 1 after a reconnect', () => {
    expect(pickFromSlot(5000, 5100, 150)).toBe(5001);
  });
  it('clamps to the replay window when the gap is too large', () => {
    expect(pickFromSlot(1000, 10_000, 150)).toBe(10_000 - 3400);
  });
  it('backfills on first connect, or starts live without a chain slot', () => {
    expect(pickFromSlot(0, 10_000, 150)).toBe(9850);
    expect(pickFromSlot(0, null, 150)).toBeUndefined();
    expect(pickFromSlot(0, 10_000, 0)).toBeUndefined();
  });
  it('builds a server-side filtered subscribe request', () => {
    const r = buildSubscribeRequest([JUP], 'confirmed', 42);
    expect(r.transactions.pulse_txs.accountInclude).toEqual([JUP]);
    expect(r.transactions.pulse_txs.vote).toBe(false);
    expect('failed' in r.transactions.pulse_txs).toBe(false);
    expect(r.commitment).toBe(1);
    expect(r.fromSlot).toBe('42');
    expect('fromSlot' in buildSubscribeRequest([JUP], 'confirmed')).toBe(false);
  });
  it('dedupes signatures replayed after reconnect', () => {
    const s = new SeenSet(3);
    expect(s.add('a')).toBe(true);
    expect(s.add('a')).toBe(false);
    s.add('b');
    s.add('c');
    s.add('d'); // evicts a
    expect(s.add('a')).toBe(true);
  });
});

describe('replay chaos schedule', () => {
  it('pauses track 2 then spikes track 1', () => {
    expect(chaosFactor(1, 100_000)).toBe(0);
    expect(chaosFactor(0, 100_000)).toBe(1);
    expect(chaosFactor(0, 160_000)).toBe(4);
    expect(chaosFactor(1, 230_000)).toBe(1);
    expect(chaosFactor(1, 240_000 + 100_000)).toBe(0);
  });
});
