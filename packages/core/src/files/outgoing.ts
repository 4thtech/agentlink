// Sending files (M1-7f; 04 §3.4, §4; 06 §2.3; 07 §5.6; D-48, D-85).
//
// Order, so that nothing is read or uploaded for a send that is refused:
// 1. Each file: the size cap, then an allowed folder (the realpath strictly inside a resolved
//    `files.allowedFolders` entry, 04 §4), then where it would be stored (07 §5.6 steps 2–5).
// 2. The D-85 packing plan, with the "cannot fit" check first (packing.ts, IR-M1-6c-1 L2).
// 3. A stored file whose storage needs setup → `needs_setup`, before any upload.
// 4. Each file is read once and encrypted with a fresh file key (ALF1 STREAM through
//    @4thtech-io/storage's putEncrypted, which uses @4thtech-io/crypto; D-80): inline into the
//    payload, or uploaded to own storage or the drop. The drop adapter signs with the KeyStore's
//    drop key (KeyStore.signDropRequest, M1-1g-e); this file never holds a key.
// On any failure every object already uploaded is deleted (best effort; the drop and the bucket
// lifecycle rule expire the rest).
//
// Zero access (I-2): storage gets only ciphertext. The file key, name and plaintext hash go only
// into the end-to-end-encrypted payload and the sealed `files` row. The drop locator is a signed
// GET URL, a bearer secret (IR-M1-6c-1): it goes only into the payload and a sealed column, and
// never into a log line or an error (I-7). Errors are fixed CoreErrors; no storage error text or
// cause is passed on.
import { encodeBase64url, wipe } from '@4thtech-io/crypto';
import {
  DROP_MAX_CIPHERTEXT_BYTES,
  StorageError,
  alf1CiphertextSize,
  createDropAdapter,
  createInlineAdapter,
  putEncrypted,
  selectStorage,
  selectionForError,
  type DropAdapter,
  type StorageAdapter,
  type StoredObject,
} from '@4thtech-io/storage';
import { MAX_URL_LENGTH } from '@4thtech-io/types';
import { nowOf, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import { evaluateFileSend, policyLimits, type EffectivePolicy } from '../policy-engine.js';
import { decidePath, parseAbsolutePath } from '../path-guard.js';
import { planPacking, type PackingBase, type PackingFile } from './packing.js';
import type { FilesPlatform, OutgoingFile } from './platform.js';

const DAY = 86_400;
const MAX_EXPIRY_DAYS = 7;
const DEFAULT_MIME = 'application/octet-stream';
const MAX_NAME_CODE_POINTS = 256;

/** Why a file send needs the owner first (06 §2.3, 07 §5.6). */
export type FilesNeedsSetup = 'no_folder' | 'outside_folder' | 'no_own_storage' | 'size' | 'quota';

/** Where a sent file went, as the send result reports it (06 §2.2 `FileInfo.delivery`). */
export interface SentFile {
  readonly index: number;
  readonly delivery: 'inline' | 'drop' | 'own';
  /** Unix seconds; null for inline. */
  readonly expiresAt: number | null;
}

/** A payload `files[]` entry (04 §3.4). */
export interface FileEntry {
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly plaintextSha256: string;
  readonly ciphertextSha256: string;
  readonly inline: string | null;
  readonly url: string | null;
  readonly fileKey: string;
  readonly expiresAt: number;
}

/** What the sender keeps of one file (the sealed `files` row, 07 §3) and how to delete it. */
export interface OutgoingRecord extends Uploaded {
  readonly idx: number;
  readonly entry: FileEntry;
  readonly kind: 'inline' | 'drop' | 's3';
}

export type OutgoingOutcome =
  | {
      readonly kind: 'ok';
      readonly entries: readonly FileEntry[];
      readonly records: readonly OutgoingRecord[];
      readonly sent: readonly SentFile[];
    }
  | { readonly kind: 'needs_setup'; readonly reason: FilesNeedsSetup }
  | { readonly kind: 'rejected'; readonly code: 'PAYLOAD_TOO_LARGE' | 'FILE_TOO_LARGE' };

interface Checked {
  readonly file: OutgoingFile;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  /** Where it goes if it is not inline. */
  readonly stored: 'own' | 'drop' | FilesNeedsSetup;
}

const codePoints = (s: string): number => [...s].length;

function invalid(): CoreError {
  return new CoreError('files_invalid', 'A file to send is not valid.');
}

/** The last segment of a realpath, or undefined. */
function baseName(realpath: string, flavor: 'posix' | 'win32'): string | undefined {
  const parsed = parseAbsolutePath(realpath, flavor);
  if (parsed === undefined) return undefined;
  // parseAbsolutePath lower-cases win32 segments; take the original spelling of the last one.
  const sep = flavor === 'posix' ? '/' : /[\\/]/;
  const parts = realpath.split(sep).filter((p) => p !== '');
  return parts[parts.length - 1];
}

/** An object in storage and the adapter that can delete it. */
export interface Uploaded {
  readonly object: StoredObject | null;
  readonly adapter: StorageAdapter | null;
}

/** Deletes uploaded objects, best effort; never throws and never logs a locator. */
export async function deleteUploaded(
  ctx: CoreContext,
  objects: readonly Uploaded[],
): Promise<void> {
  let failed = 0;
  for (const r of objects) {
    if (r.object === null || r.adapter === null) continue;
    try {
      await r.adapter.delete(r.object);
    } catch {
      failed += 1;
    }
  }
  if (failed > 0) ctx.log.warn('uploaded file not deleted; it expires', { files: failed });
}

export interface OutgoingDeps {
  readonly ctx: CoreContext;
  readonly platform: FilesPlatform;
  readonly policy: EffectivePolicy;
}

/** Builds the drop adapter for this send (no I/O until a put). */
function dropAdapter(ctx: CoreContext, platform: FilesPlatform): DropAdapter | undefined {
  const drop = platform.drop;
  if (drop === undefined) return undefined;
  try {
    return createDropAdapter({
      ...(drop.endpoint === undefined ? {} : { endpoint: drop.endpoint }),
      ...(drop.maxBytes === undefined ? {} : { maxBytes: drop.maxBytes }),
      signer: ctx.keyStore,
      fetch: drop.fetch,
      now: () => new Date(nowOf(ctx) * 1000),
      logger: ctx.log,
    });
  } catch {
    throw new CoreError('storage_failed', 'The file storage is not configured correctly.');
  }
}

/** Maps a storage failure to a send outcome or a fixed error (never the storage's own text). */
function storageFailure(error: unknown): OutgoingOutcome {
  const selection = selectionForError(error);
  if (selection?.mode === 'needs_setup') return { kind: 'needs_setup', reason: selection.reason };
  if (selection?.mode === 'retry') {
    throw new CoreError(
      'storage_unavailable',
      'File storage is busy or unavailable. Try again later.',
    );
  }
  if (error instanceof StorageError && error.code === 'size_mismatch') {
    throw new CoreError('file_changed', 'The file changed while it was being sent.');
  }
  if (error instanceof CoreError) throw error;
  throw new CoreError('storage_failed', 'The file could not be stored.');
}

/**
 * Checks, plans, encrypts and stores the files of one send. Returns the payload entries and what the
 * sender keeps, or the refusal. Nothing is read or uploaded unless every check passed.
 */
export async function prepareOutgoing(
  deps: OutgoingDeps,
  base: PackingBase,
  files: readonly OutgoingFile[],
): Promise<OutgoingOutcome> {
  const { ctx, platform, policy } = deps;
  const flavor = platform.flavor ?? 'posix';
  if (!Array.isArray(files) || files.length > 16) throw invalid();
  const limits = policyLimits(policy);
  const own = platform.ownStorage;
  const drop = dropAdapter(ctx, platform);
  const dropMax = drop?.maxBytes ?? DROP_MAX_CIPHERTEXT_BYTES;
  const filesPolicy = policy.mode === 'fail_closed' ? undefined : policy.policy.files;
  let folders: readonly string[] = [];
  if (limits.allowedFolders.length > 0) {
    try {
      folders = await platform.allowedFolderRealpaths(limits.allowedFolders);
    } catch {
      // The platform's own error can name a path; it is replaced (I-7).
      throw new CoreError('files_unavailable', 'The allowed folders cannot be read now.');
    }
  }

  // 1. Every file is checked before any is read.
  const checked: Checked[] = [];
  for (const file of files) {
    if (file === null || typeof file !== 'object' || typeof file.open !== 'function') {
      throw invalid();
    }
    const { realpath, size } = file;
    if (typeof realpath !== 'string' || !Number.isSafeInteger(size) || size < 0) throw invalid();
    const name = file.name ?? baseName(realpath, flavor);
    const mime = file.mime ?? DEFAULT_MIME;
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      codePoints(name) > MAX_NAME_CODE_POINTS ||
      typeof mime !== 'string'
    ) {
      throw invalid();
    }
    const ciphertextSize = alf1CiphertextSize(size);
    const evaluation = evaluateFileSend(
      policy,
      { kind: 'file.send', sizeBytes: size, realpath },
      {
        allowedFolderRealpaths: folders,
        ownStorageConfigured: own !== undefined,
        dropCanTake: drop !== undefined && ciphertextSize <= dropMax,
      },
    );
    if (evaluation.decision === 'deny') {
      if (evaluation.reason === 'too_large') return { kind: 'rejected', code: 'FILE_TOO_LARGE' };
      if (evaluation.reason === 'no_folder' || evaluation.reason === 'outside_folder') {
        return { kind: 'needs_setup', reason: evaluation.reason };
      }
      // needs_storage: decided below, per file, only if the file is stored after packing.
    }
    // 04 §4: no hidden file or folder below the allowed folder (the platform refuses them as well,
    // with the protected roots it alone knows).
    const guarded = decidePath({
      requested: realpath,
      resolved: realpath,
      allowedFolders: folders,
      protectedRoots: [],
      flavor,
    });
    if (!guarded.ok) return { kind: 'needs_setup', reason: 'outside_folder' };
    let stored: Checked['stored'] = 'no_own_storage';
    if (filesPolicy !== undefined) {
      const selection = selectStorage({
        policy: filesPolicy.storage,
        ownConfigured: own !== undefined,
        ciphertextSize,
        dropMaxBytes: dropMax,
      });
      stored =
        selection.mode === 'needs_setup'
          ? selection.reason
          : selection.mode === 'drop' && drop === undefined
            ? 'no_own_storage'
            : selection.mode;
    }
    checked.push({ file, name, mime, size, stored });
  }

  // 2. The D-85 plan, refused before any upload when it cannot fit.
  const days = Math.min(limits.defaultExpiryDays, MAX_EXPIRY_DAYS);
  const expiresAt = nowOf(ctx) + days * DAY;
  const packing: PackingFile[] = checked.map((c) => ({
    name: c.name,
    mime: c.mime,
    size: c.size,
    expiresAt,
    storedUrlLength:
      c.stored === 'drop' && drop !== undefined ? drop.maxGetUrlLength : MAX_URL_LENGTH,
  }));
  const plan = planPacking(base, packing);
  if (!plan.fits) return { kind: 'rejected', code: 'PAYLOAD_TOO_LARGE' };

  // 3. A stored file needs a storage that can take it.
  for (let i = 0; i < checked.length; i += 1) {
    const stored = (checked[i] as Checked).stored;
    if (plan.inline[i] !== true && stored !== 'own' && stored !== 'drop') {
      return { kind: 'needs_setup', reason: stored };
    }
  }

  // 4. Read, encrypt, store.
  const now = (): Date => new Date(nowOf(ctx) * 1000);
  const inlineAdapter = createInlineAdapter({ now, logger: ctx.log });
  const expiry = new Date(expiresAt * 1000);
  const records: OutgoingRecord[] = [];
  const uploaded: Uploaded[] = [];
  try {
    for (let i = 0; i < checked.length; i += 1) {
      const c = checked[i] as Checked;
      const inline = plan.inline[i] === true;
      const kind: OutgoingRecord['kind'] = inline ? 'inline' : c.stored === 'own' ? 's3' : 'drop';
      const adapter: StorageAdapter =
        kind === 'inline'
          ? inlineAdapter
          : kind === 's3'
            ? (own as StorageAdapter)
            : (drop as DropAdapter);
      let plaintext: ReadableStream<Uint8Array> | Uint8Array;
      try {
        plaintext = await c.file.open();
      } catch {
        throw new CoreError('file_changed', 'The file could not be read.');
      }
      const encrypted = await putEncrypted(adapter, plaintext, {
        plaintextSize: c.size,
        expiresAt: expiry,
      });
      let fileKey: string;
      try {
        fileKey = encodeBase64url(encrypted.fileKey);
      } finally {
        wipe(encrypted.fileKey);
      }
      const object = encrypted.object;
      let url: string | null = null;
      let entryExpiry = expiresAt;
      if (kind !== 'inline') {
        // Kept first, so a failure below still deletes the object.
        uploaded.push({ object, adapter });
        if (kind === 'drop') {
          // The drop fixes the expiry at upload and returns the same signed URL (07 §5.4).
          const presigned = await (drop as DropAdapter).presign(object, expiry);
          url = presigned.url;
          entryExpiry = Math.min(expiresAt, Math.floor(presigned.expiresAt.getTime() / 1000));
        } else {
          url = await adapter.presignGet(object, expiry);
        }
      }
      records.push({
        idx: i,
        kind,
        object: kind === 'inline' ? null : object,
        adapter: kind === 'inline' ? null : adapter,
        entry: {
          name: c.name,
          size: c.size,
          mime: c.mime,
          plaintextSha256: encrypted.plaintextSha256,
          ciphertextSha256: encrypted.ciphertextSha256,
          inline: kind === 'inline' ? object.locator : null,
          url,
          fileKey,
          expiresAt: entryExpiry,
        },
      });
    }
  } catch (error) {
    await deleteUploaded(ctx, uploaded);
    return storageFailure(error);
  }
  ctx.log.info('files prepared', {
    inline: records.filter((r) => r.kind === 'inline').length,
    stored: records.filter((r) => r.kind !== 'inline').length,
  });
  return {
    kind: 'ok',
    entries: records.map((r) => r.entry),
    records,
    sent: records.map((r) => ({
      index: r.idx,
      delivery: r.kind === 'inline' ? 'inline' : r.kind === 'drop' ? 'drop' : 'own',
      expiresAt: r.kind === 'inline' ? null : r.entry.expiresAt,
    })),
  };
}
