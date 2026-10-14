// What the core services share. Internal: built once by AgentLinkClient.create.
import type { KeyStore } from '@agentlink/crypto';
import type { Logger } from '@agentlink/log';
import { CoreError } from './errors.js';
import type { Sealed, TableName } from './store/schema.js';
import { rowKeyOf, type Store, type StoreCipher } from './store/store.js';

export interface CoreContext {
  readonly keyStore: KeyStore;
  readonly store: Store;
  readonly cipher: StoreCipher;
  /** Unix seconds. The core reads the clock and passes `now` to the store (07 §3.1). */
  readonly now: () => number;
  readonly log: Logger;
}

export function seal(
  ctx: CoreContext,
  table: TableName,
  column: string,
  key: readonly (string | number)[],
  plaintext: string,
): Promise<Sealed> {
  return ctx.cipher.seal({ table, column, rowKey: rowKeyOf(key) }, plaintext);
}

/** Opens a sealed column. A value that does not open makes the row unreadable (07 §3.1, fail closed). */
export async function open(
  ctx: CoreContext,
  table: TableName,
  column: string,
  key: readonly (string | number)[],
  sealed: Sealed,
): Promise<string> {
  try {
    return await ctx.cipher.open({ table, column, rowKey: rowKeyOf(key) }, sealed);
  } catch {
    throw new CoreError('store_unreadable', 'A stored value could not be read.');
  }
}

/** Reads a current unix time from the clock, refusing anything that is not one (fail closed). */
export function nowOf(ctx: CoreContext): number {
  const t = ctx.now();
  if (!Number.isSafeInteger(t) || t < 0) {
    throw new CoreError('clock_invalid', 'The clock did not return a valid time.');
  }
  return t;
}
