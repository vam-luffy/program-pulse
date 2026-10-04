import { createRequire } from 'node:module';
import type { IdlRegistry } from '../idl.js';
import { fromGeyserTx, type GeyserTxUpdate, type SlotClock } from '../normalize.js';
import type { TxSink } from '../types.js';

const require = createRequire(import.meta.url);

/**
 * The Yellowstone client ships as CommonJS (v4.0.2 is the last pure-JS release built on
 * @grpc/grpc-js, so it runs on Windows/macOS/Linux without native binaries).
 */
export const yellowstone = require('@triton-one/yellowstone-grpc') as typeof import('@triton-one/yellowstone-grpc') & {
  default: typeof import('@triton-one/yellowstone-grpc').default;
};

export const CommitmentLevel = { processed: 0, confirmed: 1, finalized: 2 } as const;

function decodeTxErr(buf: Uint8Array): unknown {
  try {
    return yellowstone.txErrDecode.decode(buf);
  } catch {
    return 'failed';
  }
}

export interface GeyserUpdate {
  slot?: { slot: string };
  transaction?: GeyserTxUpdate;
  ping?: unknown;
  pong?: unknown;
}

export interface GeyserContext {
  watched: Set<string>;
  idl: IdlRegistry;
  clock: SlotClock;
  /** Highest slot observed on the stream: used for `from_slot` replay after reconnect. */
  lastSlot: number;
}

/** Shared by the gRPC and Mirage sources: both receive identical SubscribeUpdate messages. */
export function handleGeyserUpdate(u: GeyserUpdate, sink: TxSink, ctx: GeyserContext): void {
  if (u.slot) {
    const s = Number(u.slot.slot);
    ctx.clock.observe(s);
    if (s > ctx.lastSlot) ctx.lastSlot = s;
    sink.slot(s);
  }
  if (u.transaction) {
    const tx = fromGeyserTx(u.transaction, ctx.watched, ctx.idl, ctx.clock, decodeTxErr);
    if (tx && tx.programIds.length) {
      if (tx.slot > ctx.lastSlot) ctx.lastSlot = tx.slot;
      sink.tx(tx);
    }
  }
}

export function buildSubscribeRequest(programIds: string[], commitment: keyof typeof CommitmentLevel, fromSlot?: number) {
  return {
    accounts: {},
    // Slot updates let us measure stream lag even when watched programs are quiet.
    slots: { pulse_slots: { filterByCommitment: true } },
    transactions: {
      // Server-side filter: only transactions that touch one of the watched programs.
      // `failed` left unset => both successful and failed transactions are delivered.
      pulse_txs: { vote: false, accountInclude: programIds, accountExclude: [], accountRequired: [] },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel[commitment],
    ...(fromSlot ? { fromSlot: String(fromSlot) } : {}),
  };
}
