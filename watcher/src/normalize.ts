import bs58 from 'bs58';
import type { IdlRegistry } from './idl.js';
import type { IxHit, NormalizedTx } from './types.js';

const SLOT_MS = 400;

/**
 * Estimates wall-clock time for a slot from the most recent (slot, time) anchor.
 * Confirmed transactions often carry blockTime = 0, so we need this for every source.
 */
export class SlotClock {
  private anchorSlot = 0;
  private anchorMs = 0;
  constructor(private readonly now: () => number = Date.now) {}

  observe(slot: number, atMs = this.now()): void {
    if (slot >= this.anchorSlot) {
      this.anchorSlot = slot;
      this.anchorMs = atMs;
    }
  }

  get latestSlot(): number {
    return this.anchorSlot;
  }

  timeOf(slot: number, blockTimeSec?: number | null): number {
    if (blockTimeSec && blockTimeSec > 0) return blockTimeSec * 1000;
    if (!this.anchorSlot) return this.now();
    return Math.min(this.now(), this.anchorMs - (this.anchorSlot - slot) * SLOT_MS);
  }
}

export function describeError(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const ie = (err as { InstructionError?: [number, unknown] }).InstructionError;
    if (ie) {
      const [idx, inner] = ie;
      if (typeof inner === 'string') return `ix ${idx}: ${inner}`;
      const custom = (inner as { Custom?: number })?.Custom;
      if (custom !== undefined) return `ix ${idx}: custom 0x${custom.toString(16)} (${custom})`;
      return `ix ${idx}: ${JSON.stringify(inner)}`;
    }
    return JSON.stringify(err).slice(0, 80);
  }
  return String(err);
}

interface RawIx {
  programIdIndex: number;
  data: Uint8Array;
}

function collect(
  keys: string[],
  outer: RawIx[],
  inner: RawIx[],
  watched: Set<string>,
  idl: IdlRegistry,
): { programIds: string[]; instructions: IxHit[] } {
  const instructions: IxHit[] = [];
  const touched = new Set<string>();
  const visit = (ix: RawIx, isInner: boolean) => {
    const pid = keys[ix.programIdIndex];
    if (pid && watched.has(pid)) {
      touched.add(pid);
      instructions.push({ programId: pid, name: idl.decode(pid, ix.data), inner: isInner });
    }
  };
  outer.forEach((ix) => visit(ix, false));
  inner.forEach((ix) => visit(ix, true));
  // A tx can mention a watched program as a plain account without executing it.
  for (const k of keys) if (watched.has(k)) touched.add(k);
  return { programIds: [...touched], instructions };
}

/* ---------------- JSON-RPC (`encoding: "json"`) ---------------- */

export interface RpcTx {
  slot: number;
  blockTime?: number | null;
  signature?: string;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: { programIdIndex: number; data: string }[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    computeUnitsConsumed?: number;
    innerInstructions?: { index: number; instructions: { programIdIndex: number; data: string }[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}

const b58 = (s: string): Uint8Array => {
  try {
    return bs58.decode(s);
  } catch {
    return new Uint8Array();
  }
};

export function fromRpcTx(tx: RpcTx, watched: Set<string>, idl: IdlRegistry, clock: SlotClock): NormalizedTx | null {
  if (!tx?.transaction?.message) return null;
  const msg = tx.transaction.message;
  const keys = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const outer = msg.instructions.map((i) => ({ programIdIndex: i.programIdIndex, data: b58(i.data) }));
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions.map((i) => ({ programIdIndex: i.programIdIndex, data: b58(i.data) })));
  const { programIds, instructions } = collect(keys, outer, inner, watched, idl);
  return {
    signature: tx.signature ?? tx.transaction.signatures[0],
    slot: tx.slot,
    ts: clock.timeOf(tx.slot, tx.blockTime),
    success: !tx.meta?.err,
    error: describeError(tx.meta?.err),
    programIds,
    signer: msg.accountKeys[0],
    feeLamports: tx.meta?.fee,
    computeUnits: tx.meta?.computeUnitsConsumed,
    instructions,
    detailed: true,
  };
}

/* ---------------- Yellowstone protobuf (gRPC and Mirage) ---------------- */

export interface GeyserTxUpdate {
  slot: string | number;
  transaction?: {
    signature: Uint8Array;
    isVote: boolean;
    transaction?: {
      signatures: Uint8Array[];
      message?: {
        accountKeys: Uint8Array[];
        instructions: { programIdIndex: number; data: Uint8Array }[];
      };
    };
    meta?: {
      err?: { err: Uint8Array };
      fee: string | number;
      computeUnitsConsumed?: string | number;
      innerInstructions: { index: number; instructions: { programIdIndex: number; data: Uint8Array }[] }[];
      loadedWritableAddresses: Uint8Array[];
      loadedReadonlyAddresses: Uint8Array[];
    };
  };
}

export function fromGeyserTx(
  u: GeyserTxUpdate,
  watched: Set<string>,
  idl: IdlRegistry,
  clock: SlotClock,
  decodeErr?: (buf: Uint8Array) => unknown,
): NormalizedTx | null {
  const info = u.transaction;
  const msg = info?.transaction?.message;
  if (!info || !msg) return null;
  const enc = (b: Uint8Array) => bs58.encode(b);
  const meta = info.meta;
  const keys = [...msg.accountKeys, ...(meta?.loadedWritableAddresses ?? []), ...(meta?.loadedReadonlyAddresses ?? [])].map(enc);
  const inner = (meta?.innerInstructions ?? []).flatMap((g) => g.instructions);
  const { programIds, instructions } = collect(keys, msg.instructions, inner, watched, idl);
  const slot = Number(u.slot);
  const failed = !!meta?.err && meta.err.err?.length > 0;
  let error: string | undefined;
  if (failed) {
    try {
      error = describeError(decodeErr ? decodeErr(meta!.err!.err) : undefined) ?? 'failed';
    } catch {
      error = 'failed';
    }
  }
  return {
    signature: enc(info.signature),
    slot,
    ts: clock.timeOf(slot),
    success: !failed,
    error,
    programIds,
    signer: keys[0],
    feeLamports: meta ? Number(meta.fee) : undefined,
    computeUnits: meta?.computeUnitsConsumed !== undefined ? Number(meta.computeUnitsConsumed) : undefined,
    instructions,
    detailed: true,
  };
}
