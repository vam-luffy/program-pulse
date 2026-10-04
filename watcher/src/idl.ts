import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Anchor emits events through a self-CPI whose data starts with this tag. */
export const ANCHOR_EVENT_IX_TAG = 'e445a52e51cb9a1d';

export function toSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Anchor instruction discriminator: sha256("global:<snake_name>")[0..8]. */
export function anchorDiscriminator(name: string): string {
  return createHash('sha256').update(`global:${toSnake(name)}`).digest('hex').slice(0, 16);
}

interface IdlInstruction {
  name: string;
  discriminator?: number[];
}

/**
 * Maps program id -> (discriminator hex -> instruction name).
 * Supports both the Anchor >=0.30 IDL format (explicit `discriminator` arrays)
 * and the legacy format (names only; discriminators are derived).
 */
export class IdlRegistry {
  private byProgram = new Map<string, Map<string, string>>();

  static fromDir(dir: string): IdlRegistry {
    const reg = new IdlRegistry();
    if (!existsSync(dir)) return reg;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const programId = (json.address as string | undefined) ?? (json.metadata?.address as string | undefined) ?? file.replace(/\.json$/, '');
        reg.add(programId, json.instructions ?? []);
      } catch {
        // A broken IDL file should never take the watcher down; it just won't decode names.
      }
    }
    return reg;
  }

  add(programId: string, instructions: IdlInstruction[]): void {
    const map = this.byProgram.get(programId) ?? new Map<string, string>();
    for (const ix of instructions) {
      const disc = ix.discriminator?.length === 8 ? Buffer.from(ix.discriminator).toString('hex') : anchorDiscriminator(ix.name);
      map.set(disc, ix.name);
    }
    this.byProgram.set(programId, map);
  }

  has(programId: string): boolean {
    return this.byProgram.has(programId);
  }

  get programs(): string[] {
    return [...this.byProgram.keys()];
  }

  /** Name for an instruction's data, or `0x<hex>` of its (up to 8 byte) prefix. */
  decode(programId: string, data: Uint8Array): string {
    if (data.length === 0) return '(empty)';
    const head = Buffer.from(data.subarray(0, 8)).toString('hex');
    if (head === ANCHOR_EVENT_IX_TAG) return '(anchor event)';
    const name = this.byProgram.get(programId)?.get(head);
    return name ?? `0x${head}`;
  }
}
