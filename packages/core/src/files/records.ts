// The sender's `files` rows (07 §3): what it needs later for refresh-link and retention (04 §4).
// The name, the locator, the download URL and the file key are sealed under the store key (`enc`,
// 07 §3.1, bound to the table, column and row key). The drop locator is its signed GET URL, a bearer
// secret (IR-M1-6c-1), so it is only ever stored sealed and never logged.
//
// The sealed locator is JSON: `{kind, locator, keyEpoch?}`. For a drop object `keyEpoch` is the drop
// key epoch it was uploaded under (M1-1g-g; 04 §2.1, 07 §5.4): only the uploading drop key can
// delete it, so the delete is signed with that epoch's key even after a rotation.
import { MAX_KEY_EPOCH } from '@4thtech-io/crypto';
import { StorageError, type StorageAdapter, type StoredObject } from '@4thtech-io/storage';
import type { CoreContext } from '../context.js';
import { open, seal } from '../context.js';
import { CoreError } from '../errors.js';
import type { Row } from '../store/schema.js';
import { dropAdapter, type OutgoingRecord } from './outgoing.js';
import type { FilesPlatform } from './platform.js';

/** Seals the rows for one envelope's files. Call before the store transaction (no await inside). */
export async function sealFileRows(
  ctx: CoreContext,
  envelopeId: string,
  records: readonly OutgoingRecord[],
): Promise<Row<'files'>[]> {
  const rows: Row<'files'>[] = [];
  for (const r of records) {
    const key = [envelopeId, r.idx];
    const keyEpoch = r.object?.keyEpoch;
    const locator = JSON.stringify({
      kind: r.kind,
      locator: r.object?.locator ?? null,
      ...(keyEpoch === undefined ? {} : { keyEpoch }),
    });
    rows.push({
      envelope_id: envelopeId,
      idx: r.idx,
      name: await seal(ctx, 'files', 'name', key, r.entry.name),
      size: r.entry.size,
      sha256: r.entry.ciphertextSha256,
      locator: await seal(ctx, 'files', 'locator', key, locator),
      url: r.entry.url === null ? null : await seal(ctx, 'files', 'url', key, r.entry.url),
      file_key: await seal(ctx, 'files', 'file_key', key, r.entry.fileKey),
      expires_at: r.entry.expiresAt,
      deleted_at: null,
      // M1-1g-i: the retention in effect at send time; a later policy change never applies to it.
      delete_after: r.deleteAfter,
      // MSG-FILES-IO-b: only a received file is saved by fetchFile.
      saved_name: null,
    });
  }
  return rows;
}

function notDeleted(): CoreError {
  return new CoreError('storage_failed', 'The file could not be deleted.');
}

const isKeyEpoch = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_KEY_EPOCH;

/**
 * The stored object a sender `files` row names, with the drop key epoch of its upload, or null for
 * an inline file or a receiver row (nothing this agent stored). A locator that does not parse is the fixed `storage_failed`.
 */
export async function openFileObject(
  ctx: CoreContext,
  row: Row<'files'>,
): Promise<{ readonly kind: 'drop' | 's3'; readonly object: StoredObject } | null> {
  const text = await open(ctx, 'files', 'locator', [row.envelope_id, row.idx], row.locator);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw notDeleted();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw notDeleted();
  const { kind, locator, keyEpoch } = parsed as Record<string, unknown>;
  // `received` (M1-7f-2): a receiver row names nothing this agent stored, so it deletes nothing.
  if (kind === 'inline' || kind === 'received') return null;
  if ((kind !== 'drop' && kind !== 's3') || typeof locator !== 'string') throw notDeleted();
  if (keyEpoch !== undefined && (kind !== 'drop' || !isKeyEpoch(keyEpoch))) throw notDeleted();
  return {
    kind,
    object: {
      kind,
      locator,
      size: row.size,
      sha256: row.sha256,
      ...(keyEpoch === undefined ? {} : { keyEpoch }),
    },
  };
}

/**
 * Deletes the stored object of one sender `files` row (retention, `files.deleteAfter`; 04 §4) through
 * the storage that holds it: own storage, or the drop with a DELETE signed by the drop key of the
 * upload epoch. An inline file has nothing to delete. Errors are fixed codes and messages; nothing
 * about the object reaches a log line or an error (I-7).
 */
export async function deleteFileObject(
  ctx: CoreContext,
  platform: FilesPlatform,
  row: Row<'files'>,
): Promise<void> {
  const stored = await openFileObject(ctx, row);
  if (stored === null) return;
  let adapter: StorageAdapter | undefined;
  try {
    adapter = stored.kind === 'drop' ? dropAdapter(ctx, platform) : platform.ownStorage;
  } catch {
    throw notDeleted();
  }
  if (adapter === undefined) throw notDeleted();
  try {
    await adapter.delete(stored.object);
  } catch (error) {
    if (
      error instanceof StorageError &&
      (error.code === 'rate_limited' || error.code === 'unavailable' || error.code === 'network')
    ) {
      throw new CoreError(
        'storage_unavailable',
        'File storage is busy or unavailable. Try again later.',
      );
    }
    throw notDeleted();
  }
}
