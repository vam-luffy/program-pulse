/** A single instruction executed against a watched program (top-level or CPI). */
export interface IxHit {
  programId: string;
  /** Decoded Anchor instruction name, or `0x<hex>` of the discriminator when unknown. */
  name: string;
  /** true when this instruction was invoked via CPI (inner instruction). */
  inner: boolean;
}

/**
 * Normalized transaction. Every source (gRPC, Mirage, WS logs, RPC polling, replay)
 * produces this shape. Detail fields are optional because some fallback sources only
 * see a subset (e.g. signatures-only polling).
 */
export interface NormalizedTx {
  signature: string;
  slot: number;
  /** Best-known wall-clock time in ms (blockTime when known, else estimated from slot). */
  ts: number;
  success: boolean;
  /** Short error description when failed. */
  error?: string;
  /** Watched programs this transaction touched. */
  programIds: string[];
  /** Fee payer (first signer). Undefined when the source does not expose it. */
  signer?: string;
  feeLamports?: number;
  computeUnits?: number;
  instructions?: IxHit[];
  /** true when signer/fee/instructions were observed (vs a signature-only summary). */
  detailed: boolean;
}

export type SourceName = 'grpc' | 'mirage' | 'ws' | 'rpc' | 'replay';

export interface TxSink {
  /** A transaction observed for the first time (counted in rates and error rates). */
  tx(tx: NormalizedTx): void;
  /** Extra detail for a transaction (samples in polling mode). Only enriches detail stats. */
  detail(tx: NormalizedTx): void;
  /** The newest slot the source has seen (stream progress, independent of program activity). */
  slot(slot: number): void;
}

export interface Source {
  readonly name: SourceName;
  /** Human label, e.g. "Solami Yellowstone gRPC". */
  readonly label: string;
  /** Resolves once the source is delivering data; rejects with SourceUnavailableError otherwise. */
  start(sink: TxSink): Promise<void>;
  stop(): Promise<void>;
}

export class SourceUnavailableError extends Error {
  constructor(
    public readonly source: SourceName,
    message: string,
  ) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}
