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
// REL051-A12: with `readText`, a requested save of a text-kind file (by its name, never the sender's
// MIME type) of at most FILE_TEXT_MAX_BYTES also returns its text: the plaintext bytes this save
// wrote, or the saved copy read back, either way only when they hash to the payload's plaintext
// SHA-256 and size and are valid UTF-8 without NUL. Otherwise no text, and the save is unchanged.
// The text is the sender's content (I-5): it is never logged. `savedPaths` answers where already
// saved files are, from the record, for the inbox (06 §2.2 `FileInfo.savedTo`).
import {
  decodeBase64url,
  encodeBase64url,
  encodeHex,
  randomBytes,
  sha256,
  wipe,
} from '@4thtech-io/crypto';
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
import {
  FILE_TEXT_MAX_BYTES,
  fileKindOf,
  isTextKind,
  payloadSchema,
  textOfFile,
  type Payload,
} from '@4thtech-io/types';
import { nowOf, open, seal, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import { checkFetchUrl } from '../fetch-url.js';
import {
  sanitizeFileName,
  savedFileName,
  withNameSuffix,
  withRandomNameSuffix,
} from '../file-name.js';
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
import type { FilesPlatform, InboxFolder, SavedFileIdentity } from './platform.js';
import { SHREDDED_FILE_KEY } from './received.js';
import {
  putSavedFileTx,
  sealSavedFile,
  type BackfillSavedFilesResult,
  type SavedFileFacts,
} from './saved-files.js';

/** RET-2: recorded saves the backfill looks at in one run (receiver rows live at most 7 days). */
const BACKFILL_MAX = 1_000;

export interface FetchFileInput {
  readonly envelopeId: string;
  /** Default 0. */
  readonly fileIndex?: number;
  /** REL051-A12: also return the verified text of a small text file (see the header). */
  readonly readText?: boolean;
}

/** One received file, for `savedPaths`. */
export interface SavedFileRef {
  readonly envelopeId: string;
  readonly fileIndex: number;
}

/** The text of `bytes` when they are exactly the payload's plaintext (size and SHA-256). */
function verifiedText(bytes: Uint8Array, entry: Payload['files'][number]): string | undefined {
  if (bytes.length !== entry.size) return undefined;
  if (encodeHex(sha256(bytes)) !== entry.plaintextSha256.toLowerCase()) return undefined;
  return textOfFile(bytes);
}

/** True when a requested save should also return the text (by the name, never the MIME type). */
const wantsText = (entry: Payload['files'][number]): boolean =>
  entry.size <= FILE_TEXT_MAX_BYTES && isTextKind(fileKindOf(sanitizeFileName(entry.name)));

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
      /** REL051-A12: only with `readText`, for a verified small text file. Untrusted (I-5). */
      readonly text?: string;
    }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'rejected';
      readonly code:
        'FILE_TOO_LARGE' | 'INTEGRITY_FAILED' | 'LINK_EXPIRED' | 'URL_REFUSED' | 'POLICY_DENIED';
    };

/**
 * RET-2: the device, inode and size of a saved file, through the folder handle (no link followed);
 * undefined when the platform cannot tell or the entry is not a regular file. Never throws.
 */
async function identifySaved(
  inbox: InboxFolder,
  name: string,
): Promise<SavedFileIdentity | undefined> {
  if (inbox.identify === undefined) return undefined;
  try {
    const id = await inbox.identify(name);
    if (
      id === undefined ||
      typeof id.dev !== 'string' ||
      typeof id.ino !== 'string' ||
      !Number.isSafeInteger(id.size)
    ) {
      return undefined;
    }
    return id;
  } catch {
    return undefined;
  }
}

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
  /** REL051-A12: copies of the plaintext chunks written, when the text is wanted. */
  collected?: Uint8Array[];
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
          state.collected?.push(chunk.slice());
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

/** The chunks as one array. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * `{text}` of a saved copy read back (REL051-A12) when it is still exactly the payload's plaintext;
 * `{}` otherwise (a changed copy, a platform without `readSaved`, a read that fails).
 */
async function savedText(
  inbox: InboxFolder,
  name: string,
  entry: Payload['files'][number],
): Promise<{ readonly text?: string }> {
  if (inbox.readSaved === undefined) return {};
  let bytes: Uint8Array | undefined;
  try {
    bytes = await inbox.readSaved(name, FILE_TEXT_MAX_BYTES);
  } catch {
    return {};
  }
  if (!(bytes instanceof Uint8Array)) return {};
  const text = verifiedText(bytes, entry);
  wipe(bytes);
  return text === undefined ? {} : { text };
}

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
      .then(() => this.#fetchLocked(envelopeId, index, options, input.readText === true));
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
    readText: boolean,
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
      // Text only for a requested save (never for auto-save), by the name's kind (REL051-A12).
      const text = readText && auto === undefined && wantsText(entry);
      return await this.#saveInto(
        inbox,
        flavor,
        envelopeId,
        index,
        entry,
        keyRow,
        limits,
        auto,
        text,
      );
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
    wantText: boolean,
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
          ...(wantText ? await savedText(inbox, known, entry) : {}),
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
    const state: WriteState = {
      diskFull: false,
      cannotMark: false,
      savedElsewhere: false,
      ...(wantText ? { collected: [] } : {}),
    };
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
        // RET-2: the device and inode the file got after its move, for the saved-file index.
        const identity = await identifySaved(inbox, finalName);
        await this.#recordSavedName(envelopeId, index, keyRow.sha256, finalName, startRecord, {
          facts: {
            envelopeId,
            index,
            size: done.plaintextSize,
            sha256: entry.plaintextSha256,
            savedAt: nowOf(ctx),
          },
          identity,
        });
      }
      let text: string | undefined;
      if (state.collected !== undefined) {
        const bytes = concat(state.collected);
        text = verifiedText(bytes, entry);
        wipe(bytes);
      }
      return {
        status: 'ok',
        savedTo,
        name: finalName,
        size: done.plaintextSize,
        integrity: 'verified',
        ...(text === undefined ? {} : { text }),
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
            ...(wantText ? await savedText(inbox, known, entry) : {}),
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
      for (const chunk of state.collected ?? []) wipe(chunk);
    }
  }

  /**
   * RET-2 (D-148; 07 §3.8 "Migration"): indexes files saved before schema version 15 whose receiver
   * `files` row still records a saved name (files received in the last 7 days). Best effort and
   * idempotent: a row already in the index is kept; a recorded file that is missing, is not a regular
   * file directly inside the Inbox folder (a link is never followed, 04 §4 realpath rules) or whose
   * message no longer opens is skipped and left unassigned, never deleted. Writes only the index;
   * never touches a file. Logs counts only (I-7).
   */
  async backfillSavedFiles(): Promise<BackfillSavedFilesResult> {
    const ctx = this.#ctx;
    const platform = this.#platform;
    const none: BackfillSavedFilesResult = Object.freeze({ indexed: 0, skipped: 0 });
    if (platform === undefined) return none;
    const candidates = await ctx.store.transaction((tx) => {
      const out: { file: Row<'files'>; message: Row<'envelopes'> }[] = [];
      for (const file of tx.select('files', {}, { limit: BACKFILL_MAX * 4 })) {
        if (out.length >= BACKFILL_MAX) break;
        if (file.saved_name === null) continue;
        if (tx.get('saved_files', { envelope_id: file.envelope_id, idx: file.idx }) !== undefined) {
          continue;
        }
        const message = tx.get('envelopes', { envelope_id: file.envelope_id });
        if (message === undefined) continue;
        out.push({ file, message });
      }
      return out;
    });
    if (candidates.length === 0) return none;
    let indexed = 0;
    let skipped = 0;
    const done = (): BackfillSavedFilesResult => {
      ctx.log.info('saved files indexed', { indexed, skipped });
      return Object.freeze({ indexed, skipped });
    };
    const policy = await this.#loadPolicy();
    if (policy.mode === 'fail_closed') {
      skipped = candidates.length;
      return done();
    }
    const flavor = platform.flavor ?? 'posix';
    let inbox: InboxFolder;
    try {
      inbox = await platform.inbox(
        policy.policy.files.inboxFolder,
        policyLimits(policy).allowedFolders,
      );
    } catch {
      skipped = candidates.length;
      return done();
    }
    try {
      if (typeof inbox?.realpath !== 'string' || !parseAbsolutePath(inbox.realpath, flavor)) {
        skipped = candidates.length;
        return done();
      }
      for (const { file, message } of candidates) {
        const ok = await this.#backfillOne(inbox, file, message).catch(() => false);
        if (ok) indexed += 1;
        else skipped += 1;
      }
    } finally {
      await inbox.close?.().catch(() => undefined);
    }
    return done();
  }

  /** One recorded save into the index (see backfillSavedFiles); false when it is skipped. */
  async #backfillOne(
    inbox: InboxFolder,
    file: Row<'files'>,
    message: Row<'envelopes'>,
  ): Promise<boolean> {
    const ctx = this.#ctx;
    const recorded = file.saved_name;
    if (recorded === null || message.direction !== 'in' || message.payload_json === null) {
      return false;
    }
    // The recorded name, still a regular file directly inside the folder (no link followed).
    const name = await this.#stillSaved(inbox, file.envelope_id, file.idx, recorded);
    if (name === undefined) return false;
    let identity: SavedFileIdentity | undefined;
    if (inbox.identify !== undefined) {
      identity = await identifySaved(inbox, name);
      if (identity === undefined) return false;
    }
    // The size and plaintext hash the sender stated, from the stored payload.
    const text = await open(
      ctx,
      'envelopes',
      'payload_json',
      [message.envelope_id],
      message.payload_json,
    );
    const payload = payloadSchema.safeParse(JSON.parse(text));
    const entry = payload.success ? payload.data.files[file.idx] : undefined;
    if (entry === undefined) return false;
    const facts: SavedFileFacts = {
      envelopeId: file.envelope_id,
      index: file.idx,
      size: entry.size,
      sha256: entry.plaintextSha256,
      savedAt: nowOf(ctx),
    };
    const sealed = await sealSavedFile(ctx, file.envelope_id, file.idx, name, identity);
    return ctx.store.transaction((tx) => {
      const key = { envelope_id: file.envelope_id, idx: file.idx };
      // Only for the record read above, and never over a row a save wrote meanwhile.
      if (tx.get('files', key)?.saved_name !== recorded) return false;
      if (tx.get('saved_files', key) !== undefined) return false;
      putSavedFileTx(tx, facts, sealed);
      return true;
    });
  }

  /**
   * Where each already saved file is now (06 §2.2 `FileInfo.savedTo`, plan item 7 of REL051): the
   * recorded name, when it is still a regular file directly inside the Inbox folder, placed in the
   * folder's realpath; keyed `<envelope ID>.<index>`. A file without a record, or one moved or
   * deleted since, has no entry. Reads only: no lock, nothing written, and the folder is resolved
   * only when a record exists. Never throws: anything that fails leaves entries out.
   */
  async savedPaths(refs: readonly SavedFileRef[]): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    const platform = this.#platform;
    if (platform === undefined || !Array.isArray(refs) || refs.length === 0) return out;
    try {
      const rows = await this.#ctx.store.transaction((tx) =>
        refs.map((ref) =>
          typeof ref?.envelopeId === 'string' && Number.isSafeInteger(ref.fileIndex)
            ? tx.get('files', { envelope_id: ref.envelopeId, idx: ref.fileIndex })
            : undefined,
        ),
      );
      const saved = rows.flatMap((row, i) =>
        row?.saved_name == null ? [] : [{ ref: refs[i]!, row }],
      );
      if (saved.length === 0) return out;
      const policy = await this.#loadPolicy();
      if (policy.mode === 'fail_closed') return out;
      const flavor = platform.flavor ?? 'posix';
      const inbox = await platform.inbox(
        policy.policy.files.inboxFolder,
        policyLimits(policy).allowedFolders,
      );
      try {
        if (typeof inbox?.realpath !== 'string' || !parseAbsolutePath(inbox.realpath, flavor)) {
          return out;
        }
        for (const { ref, row } of saved) {
          const name = await this.#stillSaved(
            inbox,
            ref.envelopeId,
            ref.fileIndex,
            row.saved_name!,
          );
          if (name === undefined) continue;
          try {
            out.set(
              `${ref.envelopeId}.${String(ref.fileIndex)}`,
              placeIn(inbox.realpath, name, flavor),
            );
          } catch {
            // Not a single visible name inside the folder: left out.
          }
        }
      } finally {
        await inbox.close?.().catch(() => undefined);
      }
    } catch {
      this.#ctx.log.info('saved file paths unavailable');
    }
    return out;
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
    index_: { readonly facts: SavedFileFacts; readonly identity: SavedFileIdentity | undefined },
  ): Promise<void> {
    const ctx = this.#ctx;
    try {
      const sealed = await seal(ctx, 'files', 'saved_name', [envelopeId, index], name);
      // RET-2 (07 §3.8): the saved-file index row, in the same transaction as the record.
      const indexed = await sealSavedFile(ctx, envelopeId, index, name, index_.identity);
      await ctx.store.transaction((tx) => {
        const key = { envelope_id: envelopeId, idx: index };
        const row = tx.get('files', key);
        if (row?.sha256 !== sha256) return;
        // Only over the record this save found: another process's newer record is kept.
        if ((row.saved_name ?? null) !== startRecord) return;
        tx.update('files', key, { saved_name: sealed });
        putSavedFileTx(tx, index_.facts, indexed);
      });
    } catch {
      ctx.log.warn('saved name not recorded', { code: 'store_failed' });
    }
  }
}
