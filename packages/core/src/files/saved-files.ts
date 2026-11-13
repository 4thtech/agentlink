// RET-2: the saved-file index (D-148; 07 §3.8; 04 §4.2; proposed, owner confirms at merge).
//
// One `saved_files` row per received file the core saved into the Inbox folder, by any path
// (auto-save, Save, `agentlink_fetch_file`), written in the store transaction that records the save
// (incoming.ts) and kept after the day-7 shred of the receiver's `files` row (retention.ts deletes
// only `files`). It names the file by its message and index, the contact, the single saved name
// (sealed, never a path), size, the payload's plaintextSha256, and the device and inode the file got
// after its move into place (sealed). It holds no file key and no URL. The history delete (RET-3)
// reads it through `openSavedFile` and touches a file only when it still has that device, inode,
// size and hash.
//
// Never logged: a name, a folder, a path, a hash, a device or an inode (I-7). Counts only.
import { CoreError } from '../errors.js';
import type { CoreContext } from '../context.js';
import type { Row, Sealed } from '../store/schema.js';
import { rowKeyOf, type StoreTx } from '../store/store.js';
import type { SavedFileIdentity } from './platform.js';

/** One `saved_files` row with its sealed values opened (for the core only; never logged). */
export interface SavedFileView {
  readonly envelopeId: string;
  readonly index: number;
  readonly contactId: string | null;
  /** The single name inside the Inbox folder; never a path. */
  readonly name: string;
  readonly size: number;
  /** The payload's plaintextSha256, lowercase hex. */
  readonly sha256: string;
  /** Device and inode as decimal text; null when the platform could not tell (never deletable). */
  readonly dev: string | null;
  readonly ino: string | null;
  readonly savedAt: number;
  readonly trashedAt: number | null;
}

/** What one backfill did: counts only. */
export interface BackfillSavedFilesResult {
  /** Rows written. */
  readonly indexed: number;
  /** Recorded saves not indexed: the file is missing, not a regular file (a link), or unreadable. */
  readonly skipped: number;
}

type SealedColumn = 'saved_name' | 'dev' | 'ino';

async function openColumn(
  ctx: Pick<CoreContext, 'cipher'>,
  row: Row<'saved_files'>,
  column: SealedColumn,
  sealed: Sealed,
): Promise<string> {
  try {
    return await ctx.cipher.open(
      { table: 'saved_files', column, rowKey: rowKeyOf([row.envelope_id, row.idx]) },
      sealed,
    );
  } catch {
    throw new CoreError('store_unreadable', 'A stored value could not be read.');
  }
}

/**
 * Opens one index row (fail closed: a sealed value that does not open is `store_unreadable`, never
 * an empty name). The caller must still check the name is one visible segment before any use.
 */
export async function openSavedFile(
  ctx: Pick<CoreContext, 'cipher'>,
  row: Row<'saved_files'>,
): Promise<SavedFileView> {
  const name = await openColumn(ctx, row, 'saved_name', row.saved_name);
  const dev = row.dev === null ? null : await openColumn(ctx, row, 'dev', row.dev);
  const ino = row.ino === null ? null : await openColumn(ctx, row, 'ino', row.ino);
  return Object.freeze({
    envelopeId: row.envelope_id,
    index: row.idx,
    contactId: row.contact_id,
    name,
    size: row.size,
    sha256: row.sha256,
    dev,
    ino,
    savedAt: row.saved_at,
    trashedAt: row.trashed_at,
  });
}

/** The sealed values of one index row, bound to its table, column and row key (07 §3.1). */
export interface SealedSavedFile {
  readonly saved_name: Sealed;
  readonly dev: Sealed | null;
  readonly ino: Sealed | null;
}

export async function sealSavedFile(
  ctx: Pick<CoreContext, 'cipher'>,
  envelopeId: string,
  index: number,
  name: string,
  identity: SavedFileIdentity | undefined,
): Promise<SealedSavedFile> {
  const at = (column: SealedColumn) =>
    ({ table: 'saved_files', column, rowKey: rowKeyOf([envelopeId, index]) }) as const;
  const known = identity !== undefined && isDecimal(identity.dev) && isDecimal(identity.ino);
  return {
    saved_name: await ctx.cipher.seal(at('saved_name'), name),
    dev: known ? await ctx.cipher.seal(at('dev'), identity.dev) : null,
    ino: known ? await ctx.cipher.seal(at('ino'), identity.ino) : null,
  };
}

const isDecimal = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,24}$/.test(value);

/** The fields of one save, before sealing. */
export interface SavedFileFacts {
  readonly envelopeId: string;
  readonly index: number;
  readonly size: number;
  /** The payload's plaintextSha256 (any case; stored lowercase). */
  readonly sha256: string;
  readonly savedAt: number;
}

/**
 * Writes the index row of one save inside the caller's transaction: a new row, or the row of an
 * earlier save of the same file replaced (the file was saved again under a new name, so the old
 * device and inode no longer name it). The contact is the message's.
 */
export function putSavedFileTx(tx: StoreTx, facts: SavedFileFacts, sealed: SealedSavedFile): void {
  const key = { envelope_id: facts.envelopeId, idx: facts.index };
  const contact = tx.get('envelopes', { envelope_id: facts.envelopeId })?.contact_id ?? null;
  const row: Row<'saved_files'> = {
    ...key,
    contact_id: contact,
    saved_name: sealed.saved_name,
    size: facts.size,
    sha256: facts.sha256.toLowerCase(),
    dev: sealed.dev,
    ino: sealed.ino,
    saved_at: facts.savedAt,
    trashed_at: null,
  };
  if (tx.get('saved_files', key) === undefined) tx.insert('saved_files', row);
  else tx.update('saved_files', key, row);
}
