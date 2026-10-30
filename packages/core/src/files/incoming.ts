// Fetching a received file (M1-7f; 06 §2.3 `agentlink_fetch_file`; 04 §4; D-84).
//
// The `files[]` entry comes from a contact's payload, so every field is untrusted (I-5):
// - the size is checked against `files.maxReceiveSizeMB` before anything is fetched, and the
//   download is capped at its exact ALF1 length (decryptDownload counts too);
// - a `url` passes the raw-string SSRF check here (checkFetchUrl) and is fetched only through the
//   platform's SSRF-safe download (04 §4); it is a secret and never logged (I-7). The URL is the
//   receiver row's, which a refresh-link answer can replace (M1-7f-3, refresh-link.ts);
// - an inline ciphertext is checked against `ciphertextSha256` before any decryption;
// - plaintext goes only to a quarantine file in the inbox folder (D-84) and is renamed to its final
//   name only after the final chunk and both hashes verified; on any failure it is removed;
// - the name is sanitised (file-name.ts), never overwrites an existing entry (a suffix is added),
//   and must be a single visible segment directly inside the resolved inbox folder;
// - once the file is saved, that single name (never the path, never the sender's raw name) is
//   recorded sealed in the receiver row's `saved_name` (MSG-FILES-IO-b); it is never logged;
// - nothing is ever executed.
// W4-AUTO-SAVE (D-142, 04 §4.1): every save, automatic or not, takes the one lock of its file
// (`<envelope ID>.<index>`), so auto-save, Save in the app and `agentlink_fetch_file` at once write
// one copy; a file already saved and still a regular file directly inside the Inbox folder is
// answered from the record, without a second download or copy. The name gets `.download` under the
// name rule; the temporary file gets the OS quarantine mark before its move into place (required for
// an automatic save: a failed mark removes it and saves nothing, `folder_cannot_mark`); an automatic
// save first keeps 1 GiB free on the folder's volume (`disk_full`), and a write that runs out of space
// removes its temporary file (`disk_full`).
import { decodeBase64url, encodeBase64url, randomBytes, wipe } from '@4thtech-io/crypto';
import {
  StorageError,
  alf1CiphertextSize,
  createInlineAdapter,
  createTempFileSink,
  decryptDownload,
  removeStaleTempFiles,
  type CiphertextSource,
  type TempFileOps,
} from '@4thtech-io/storage';
import { payloadSchema, type Payload } from '@4thtech-io/types';
import { nowOf, open, seal, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import { checkFetchUrl } from '../fetch-url.js';
import { savedFileName, withNameSuffix, withRandomNameSuffix } from '../file-name.js';
import {
  isInsideFolder,
  parseAbsolutePath,
  segmentsBelow,
  type PathFlavor,
} from '../path-guard.js';
import {
  evaluate,
  policyLimits,
  type EffectivePolicy,
  type PolicyLimits,
} from '../policy-engine.js';
import type { Row } from '../store/schema.js';
import type { FilesPlatform, InboxFolder } from './platform.js';
import { SHREDDED_FILE_KEY } from './received.js';

export interface FetchFileInput {
  readonly envelopeId: string;
  /** Default 0. */
  readonly fileIndex?: number;
}

/** W4-AUTO-SAVE: how the background loop's automatic save differs from a requested one. */
export interface AutoSaveOptions {
  /** Bytes that must stay free on the folder's volume after the declared size (04 §4.1: 1 GiB). */
  readonly reserveBytes: number;
  /** Runs inside the file's lock right before the download; false stops the save (nothing written). */
  readonly beforeDownload?: () => Promise<boolean>;
}

/** Fetch options. */
export interface FetchFileOptions {
  /** Present only for the automatic save (auto-save.ts). */
  readonly auto?: AutoSaveOptions;
}

export type FetchFileResult =
  | {
      readonly status: 'ok';
      /** The saved file's path: the inbox folder's realpath and the final name. */
      readonly savedTo: string;
      /** The final, sanitised name (it can differ from the sender's). */
      readonly name: string;
      readonly size: number;
      readonly integrity: 'verified';
    }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'rejected';
      readonly code:
        'FILE_TOO_LARGE' | 'INTEGRITY_FAILED' | 'LINK_EXPIRED' | 'URL_REFUSED' | 'POLICY_DENIED';
    };

/** How many ` (n)` suffixes are tried before the save gives up. */
const MAX_NAME_ATTEMPTS = 1_000;

function inboxUnavailable(): CoreError {
  return new CoreError('inbox_unavailable', 'The inbox folder cannot take files now.');
}

function diskFull(): CoreError {
  return new CoreError('disk_full', 'The disk of the Inbox folder is almost full.');
}

/**
 * A free name for `base` in the folder: never an existing entry (file, folder or link). Names are
 * compared case-insensitively, so a case-insensitive volume never sees two names for one entry; the
 * exclusive create and the no-replace move catch the rest. After " (999)" a random 8-character
 * suffix (04 §4.1).
 */
async function freeName(ops: TempFileOps, base: string): Promise<string> {
  const taken = new Set((await ops.list()).map((n) => n.toLowerCase()));
  // The name itself, then "{stem} (2){ext}" to " (999)" (04 §4.1).
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n += n === 0 ? 2 : 1) {
    const name = withNameSuffix(base, n);
    if (!taken.has(name.toLowerCase())) return name;
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = withRandomNameSuffix(base, encodeBase64url(randomBytes(6)));
    if (!taken.has(name.toLowerCase())) return name;
  }
  throw inboxUnavailable();
}

/** Failures the wrapped file operations saw, read after the sink gave up (fixed flags only). */
interface WriteState {
  diskFull: boolean;
  cannotMark: boolean;
  /** Another process recorded this file as saved meanwhile (IR-W4-AUTO-SAVE-1 L1). */
  savedElsewhere: boolean;
  /** The name the file got when the first pick was taken at the move (IR SEC L2). */
  finalName?: string;
}

/** What the move needs besides the folder (fix round 1). */
interface MoveOptions {
  /** The sanitised base name, for a new free name when the picked one was taken at the move. */
  readonly base: string;
  /**
   * Right before the move: false when another process recorded this file as saved since this save
   * began (the store is shared; the in-memory lock is per process). The temporary file is removed.
   */
  readonly stillUnsaved: () => Promise<boolean>;
}

/** Moves tried with a fresh free name after the picked name was taken at the move. */
const MOVE_RETRIES = 3;

const isDiskFull = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { saveError?: unknown }).saveError === 'disk_full';

/**
 * The folder's file operations with the D-142 steps: a write that runs out of space is noted; before
 * the temporary file moves to its name it gets the quarantine mark, read back by the platform. A mark
 * that fails stops an automatic save (the sink then removes the temporary file); a requested save
 * keeps the mark where possible (04 §4.1).
 */
function markedOps(
  inbox: InboxFolder,
  requireMark: boolean,
  state: WriteState,
  move: MoveOptions,
): TempFileOps {
  const ops = inbox.ops;
  return Object.freeze<TempFileOps>({
    async create(name) {
      const handle = await ops.create(name);
      return {
        async write(chunk) {
          try {
            await handle.write(chunk);
          } catch (error) {
            if (isDiskFull(error)) state.diskFull = true;
            throw error;
          }
        },
        async close() {
          try {
            await handle.close();
          } catch (error) {
            if (isDiskFull(error)) state.diskFull = true;
            throw error;
          }
        },
      };
    },
    async rename(from, to) {
      let mark: string;
      try {
        mark = inbox.mark === undefined ? 'unsupported' : await inbox.mark(from);
      } catch {
        mark = 'failed';
      }
      if (mark !== 'marked' && mark !== 'unsupported' && requireMark) {
        state.cannotMark = true;
        throw inboxUnavailable();
      }
      if (!(await move.stillUnsaved())) {
        state.savedElsewhere = true;
        throw inboxUnavailable();
      }
      try {
        await ops.rename(from, to);
        return;
      } catch (error) {
        // The name was taken between the pick and the move (the move never replaces): a fresh free
        // name, with the bytes already verified in the temporary file (no second download).
        let last: unknown = error;
        for (let attempt = 0; attempt < MOVE_RETRIES; attempt += 1) {
          const next = await freeName(ops, move.base);
          try {
            await ops.rename(from, next);
            state.finalName = next;
            return;
          } catch (retryError) {
            last = retryError;
          }
        }
        throw last;
      }
    },
    remove: (name) => ops.remove(name),
    list: () => ops.list(),
  });
}

/** `folder` + separator + `name`, checked to be one visible segment directly inside `folder`. */
function placeIn(folder: string, name: string, flavor: PathFlavor): string {
  const sep = flavor === 'posix' ? '/' : '\\';
  const path = `${folder.endsWith(sep) ? folder.slice(0, -1) : folder}${sep}${name}`;
  const below = segmentsBelow(path, folder, flavor);
  if (
    !isInsideFolder(path, folder, { flavor, self: 'outside' }) ||
    below?.length !== 1 ||
    name.startsWith('.')
  ) {
    throw inboxUnavailable();
  }
  return path;
}

const ok = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

export class FileFetcher {
  readonly #ctx: CoreContext;
  readonly #platform: FilesPlatform | undefined;
  readonly #loadPolicy: () => Promise<EffectivePolicy>;
  /** Inbox folders already swept for stale quarantine files (D-84: once, before the first save). */
  readonly #swept = new Set<string>();
  /** W4-AUTO-SAVE: the one lock per file (`<envelope ID>.<index>`), shared by every save path. */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    ctx: CoreContext,
    platform: FilesPlatform | undefined,
    loadPolicy: () => Promise<EffectivePolicy>,
  ) {
    this.#ctx = ctx;
    this.#platform = platform;
    this.#loadPolicy = loadPolicy;
  }

  /** True when this runtime can save files (it has a file system; the cloud agent has none). */
  get available(): boolean {
    return this.#platform !== undefined;
  }

  async fetch(input: FetchFileInput, options: FetchFileOptions = {}): Promise<FetchFileResult> {
    if (this.#platform === undefined) {
      throw new CoreError('files_unavailable', 'This agent cannot save files here.');
    }
    const envelopeId = input?.envelopeId;
    const index = input?.fileIndex ?? 0;
    if (typeof envelopeId !== 'string' || !Number.isSafeInteger(index) || index < 0) {
      return { status: 'not_found' };
    }
    // One save per file at a time (04 §4.1): a second waits, then finds the first one's record.
    const key = `${envelopeId}.${String(index)}`;
    const before = this.#locks.get(key) ?? Promise.resolve();
    const run = before
      .catch(() => undefined)
      .then(() => this.#fetchLocked(envelopeId, index, options));
    this.#locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === run) this.#locks.delete(key);
    }
  }

  async #fetchLocked(
    envelopeId: string,
    index: number,
    options: FetchFileOptions,
  ): Promise<FetchFileResult> {
    const ctx = this.#ctx;
    const platform = this.#platform as FilesPlatform;
    const auto = options.auto;
    const [row, keyRow] = await ctx.store.transaction(
      (tx) =>
        [
          tx.get('envelopes', { envelope_id: envelopeId }),
          tx.get('files', { envelope_id: envelopeId, idx: index }),
        ] as const,
    );
    // A processed message from a contact only: never an own envelope, a request or a refused row.
    if (
      row === undefined ||
      row.direction !== 'in' ||
      row.state !== 'ok' ||
      row.contact_id === null ||
      row.payload_json === null
    ) {
      return { status: 'not_found' };
    }
    const text = await open(ctx, 'envelopes', 'payload_json', [envelopeId], row.payload_json);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    const payload = payloadSchema.safeParse(parsed);
    if (!payload.success) {
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    const entry = payload.data.files[index];
    if (entry === undefined) return { status: 'not_found' };

    // Policy first: the size cap, before anything is fetched (06 §3 `files.maxReceiveSizeMB`).
    const policy = await this.#loadPolicy();
    const decision = evaluate(policy, { kind: 'file.receive', sizeBytes: entry.size });
    if (decision === 'deny') return { status: 'rejected', code: 'FILE_TOO_LARGE' };
    if (decision !== 'allow' || policy.mode === 'fail_closed') {
      return { status: 'rejected', code: 'POLICY_DENIED' };
    }
    const limits = policyLimits(policy);

    // The Inbox folder, resolved under the folder rules of 04 §4.1 at every save.
    const flavor = platform.flavor ?? 'posix';
    let inbox: InboxFolder;
    try {
      inbox = await platform.inbox(policy.policy.files.inboxFolder, limits.allowedFolders);
    } catch {
      throw inboxUnavailable();
    }
    if (
      inbox === null ||
      typeof inbox !== 'object' ||
      typeof inbox.realpath !== 'string' ||
      parseAbsolutePath(inbox.realpath, flavor) === undefined
    ) {
      throw inboxUnavailable();
    }
    try {
      return await this.#saveInto(inbox, flavor, envelopeId, index, entry, keyRow, limits, auto);
    } finally {
      await inbox.close?.().catch(() => undefined);
    }
  }

  async #saveInto(
    inbox: InboxFolder,
    flavor: PathFlavor,
    envelopeId: string,
    index: number,
    entry: Payload['files'][number],
    keyRow: Row<'files'> | undefined,
    limits: PolicyLimits,
    auto: AutoSaveOptions | undefined,
  ): Promise<FetchFileResult> {
    const ctx = this.#ctx;
    const platform = this.#platform as FilesPlatform;
    const { realpath: folder, ops } = inbox;

    // Already saved (by auto-save, Save or an earlier fetch) and still a regular file directly inside
    // the Inbox folder: answered from the record, no second download or copy (06 §2.3, D-142).
    if (keyRow !== undefined && keyRow.saved_name !== null) {
      const known = await this.#stillSaved(inbox, envelopeId, index, keyRow.saved_name);
      if (known !== undefined) {
        return {
          status: 'ok',
          savedTo: placeIn(folder, known, flavor),
          name: known,
          size: entry.size,
          integrity: 'verified',
        };
      }
    }
    if (auto !== undefined) {
      if (auto.beforeDownload !== undefined && !(await auto.beforeDownload())) {
        return { status: 'rejected', code: 'POLICY_DENIED' };
      }
      // 04 §4.1 "Disk full": at least the reserve stays free after the declared size.
      let free: number | undefined;
      try {
        free = inbox.freeBytes === undefined ? undefined : await inbox.freeBytes();
      } catch {
        throw inboxUnavailable();
      }
      if (free !== undefined && (!Number.isFinite(free) || free - entry.size < auto.reserveBytes)) {
        throw diskFull();
      }
    }
    if (!this.#swept.has(folder)) {
      try {
        await removeStaleTempFiles(ops);
      } catch {
        throw inboxUnavailable();
      }
      this.#swept.add(folder);
    }

    // The file key (M1-7f-2, D-98): from the sealed receiver row. Once retention deleted the row the
    // key is gone and the file can no longer be opened. A payload stored before M1-7f-2 still
    // carries its key and has no row; that key is used as it is.
    let fileKeyText: string;
    // The link (M1-7f-3): the receiver row's, which a refresh-link answer may have replaced, and its
    // expiry, which is never later than the entry's (04 §4); the entry's for a payload without a row.
    let url = entry.url;
    let expiresAt = entry.expiresAt;
    if (keyRow !== undefined) {
      // The row was written from this entry at ingest; anything else is not this file's key.
      if (keyRow.sha256 !== entry.ciphertextSha256) {
        return { status: 'rejected', code: 'INTEGRITY_FAILED' };
      }
      fileKeyText = await open(ctx, 'files', 'file_key', [envelopeId, index], keyRow.file_key);
      if (entry.inline === null && keyRow.url !== null) {
        url = await open(ctx, 'files', 'url', [envelopeId, index], keyRow.url);
        expiresAt = Math.min(expiresAt, keyRow.expires_at);
      }
    } else if (entry.fileKey === SHREDDED_FILE_KEY) {
      return { status: 'rejected', code: 'LINK_EXPIRED' };
    } else {
      fileKeyText = entry.fileKey;
    }

    // The source. Inline: the ciphertext hash before any decryption. URL: expiry and SSRF check.
    let source: CiphertextSource;
    if (entry.inline !== null) {
      let bytes: Uint8Array;
      try {
        bytes = createInlineAdapter().read({
          kind: 'inline',
          locator: entry.inline,
          size: alf1CiphertextSize(entry.size),
          sha256: entry.ciphertextSha256,
        });
      } catch {
        return { status: 'rejected', code: 'INTEGRITY_FAILED' };
      }
      source = ok(bytes);
    } else {
      if (url === null || nowOf(ctx) >= expiresAt) {
        return { status: 'rejected', code: 'LINK_EXPIRED' };
      }
      // A refreshed link is checked here exactly like the first one (04 §4).
      if (!checkFetchUrl(url).ok) return { status: 'rejected', code: 'URL_REFUSED' };
      try {
        source = platform.download(url);
      } catch {
        // The platform's own error can carry the URL (I-7).
        throw new CoreError('file_download_failed', 'The file could not be downloaded.');
      }
    }

    // A free, safe name inside the Inbox folder (resolved above).
    const base = savedFileName(entry.name);
    let name: string;
    try {
      name = await freeName(ops, base);
    } catch {
      throw inboxUnavailable();
    }
    placeIn(folder, name, flavor);
    const state: WriteState = { diskFull: false, cannotMark: false, savedElsewhere: false };
    // The record as this save found it: a different one at the move means another process saved it.
    const startRecord = keyRow?.saved_name ?? null;
    const stillUnsaved = async (): Promise<boolean> => {
      const current = await ctx.store.transaction((tx) =>
        tx.get('files', { envelope_id: envelopeId, idx: index }),
      );
      return (current?.saved_name ?? null) === startRecord;
    };
    let sink;
    try {
      sink = await createTempFileSink(
        markedOps(inbox, auto !== undefined, state, { base, stillUnsaved }),
        name,
      );
    } catch (error) {
      if (isDiskFull(error)) throw diskFull();
      throw inboxUnavailable();
    }

    let fileKey: Uint8Array;
    try {
      fileKey = decodeBase64url(fileKeyText);
    } catch {
      await sink.discard();
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    try {
      const done = await decryptDownload(source, sink, {
        fileKey,
        plaintextSize: entry.size,
        ciphertextSha256: entry.ciphertextSha256,
        plaintextSha256: entry.plaintextSha256,
        maxPlaintextBytes: limits.maxReceiveBytes,
      });
      ctx.log.info('file saved', { size: done.plaintextSize });
      const finalName = state.finalName ?? name;
      const savedTo = placeIn(folder, finalName, flavor);
      if (keyRow !== undefined) {
        await this.#recordSavedName(envelopeId, index, keyRow.sha256, finalName, startRecord);
      }
      return {
        status: 'ok',
        savedTo,
        name: finalName,
        size: done.plaintextSize,
        integrity: 'verified',
      };
    } catch (error) {
      // decryptDownload has discarded the quarantine file. Fixed codes only (I-7).
      if (state.savedElsewhere) {
        // Another process saved this file meanwhile: answered from its record, no second copy.
        const row = await ctx.store.transaction((tx) =>
          tx.get('files', { envelope_id: envelopeId, idx: index }),
        );
        const known =
          row?.saved_name == null
            ? undefined
            : await this.#stillSaved(inbox, envelopeId, index, row.saved_name);
        if (known !== undefined) {
          return {
            status: 'ok',
            savedTo: placeIn(folder, known, flavor),
            name: known,
            size: entry.size,
            integrity: 'verified',
          };
        }
        throw inboxUnavailable();
      }
      if (state.cannotMark) {
        ctx.log.warn('file not saved', { code: 'folder_cannot_mark' });
        throw new CoreError('folder_cannot_mark', 'The Inbox folder cannot mark downloaded files.');
      }
      if (state.diskFull) {
        ctx.log.warn('file not saved', { code: 'disk_full' });
        throw diskFull();
      }
      const code = error instanceof StorageError ? error.code : 'download_failed';
      ctx.log.warn('file not saved', { code });
      if (code === 'integrity_failed' || code === 'size_mismatch' || code === 'too_large') {
        return { status: 'rejected', code: 'INTEGRITY_FAILED' };
      }
      if (code === 'expired') return { status: 'rejected', code: 'LINK_EXPIRED' };
      throw new CoreError('file_download_failed', 'The file could not be downloaded.');
    } finally {
      wipe(fileKey);
    }
  }

  /**
   * The recorded name when it is still a regular file directly inside the Inbox folder, else
   * undefined (then the file is saved again). A record that does not open is treated as none.
   */
  async #stillSaved(
    inbox: InboxFolder,
    envelopeId: string,
    index: number,
    sealed: NonNullable<Row<'files'>['saved_name']>,
  ): Promise<string | undefined> {
    let name: string;
    try {
      name = await open(this.#ctx, 'files', 'saved_name', [envelopeId, index], sealed);
    } catch {
      return undefined;
    }
    if (typeof name !== 'string' || name.length === 0 || name.startsWith('.')) return undefined;
    if (/[\\/\0]/.test(name)) return undefined;
    try {
      if (inbox.isSavedFile !== undefined) {
        return (await inbox.isSavedFile(name)) ? name : undefined;
      }
      return (await inbox.ops.list()).includes(name) ? name : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Records where the file was saved (MSG-FILES-IO-b): `name` is the single segment placeIn checked
   * inside the inbox folder's realpath, sealed like `name` (store key, AAD bound to table, column
   * and row key). Only into the same receiver row (same ciphertext hash) if retention has not
   * deleted it meanwhile. The file is already saved, so a store failure only leaves the record
   * unset: a fixed warning, never the name (I-7).
   */
  async #recordSavedName(
    envelopeId: string,
    index: number,
    sha256: string,
    name: string,
    startRecord: Row<'files'>['saved_name'],
  ): Promise<void> {
    const ctx = this.#ctx;
    try {
      const sealed = await seal(ctx, 'files', 'saved_name', [envelopeId, index], name);
      await ctx.store.transaction((tx) => {
        const key = { envelope_id: envelopeId, idx: index };
        const row = tx.get('files', key);
        if (row?.sha256 !== sha256) return;
        // Only over the record this save found: another process's newer record is kept.
        if ((row.saved_name ?? null) !== startRecord) return;
        tx.update('files', key, { saved_name: sealed });
      });
    } catch {
      ctx.log.warn('saved name not recorded', { code: 'store_failed' });
    }
  }
}
