// Fetching a received file (M1-7f; 06 §2.3 `agentlink_fetch_file`; 04 §4; D-84).
//
// The `files[]` entry comes from a contact's payload, so every field is untrusted (I-5):
// - the size is checked against `files.maxReceiveSizeMB` before anything is fetched, and the
//   download is capped at its exact ALF1 length (decryptDownload counts too);
// - a `url` passes the raw-string SSRF check here (checkFetchUrl) and is fetched only through the
//   platform's SSRF-safe download (04 §4); it is a secret and never logged (I-7);
// - an inline ciphertext is checked against `ciphertextSha256` before any decryption;
// - plaintext goes only to a quarantine file in the inbox folder (D-84) and is renamed to its final
//   name only after the final chunk and both hashes verified; on any failure it is removed;
// - the name is sanitised (file-name.ts), never overwrites an existing entry (a suffix is added),
//   and must be a single visible segment directly inside the resolved inbox folder;
// - nothing is ever executed.
import { decodeBase64url, wipe } from '@4thtech-io/crypto';
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
import { payloadSchema } from '@4thtech-io/types';
import { nowOf, open, type CoreContext } from '../context.js';
import { CoreError } from '../errors.js';
import { checkFetchUrl } from '../fetch-url.js';
import { sanitizeFileName, withNameSuffix } from '../file-name.js';
import {
  isInsideFolder,
  parseAbsolutePath,
  segmentsBelow,
  type PathFlavor,
} from '../path-guard.js';
import { evaluate, policyLimits, type EffectivePolicy } from '../policy-engine.js';
import type { FilesPlatform } from './platform.js';

export interface FetchFileInput {
  readonly envelopeId: string;
  /** Default 0. */
  readonly fileIndex?: number;
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

/** A free name for `base` in the folder: never an existing entry (file, folder or link). */
async function freeName(ops: TempFileOps, base: string): Promise<string> {
  const taken = new Set(await ops.list());
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n += 1) {
    const name = withNameSuffix(base, n);
    if (!taken.has(name)) return name;
  }
  throw inboxUnavailable();
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

  constructor(
    ctx: CoreContext,
    platform: FilesPlatform | undefined,
    loadPolicy: () => Promise<EffectivePolicy>,
  ) {
    this.#ctx = ctx;
    this.#platform = platform;
    this.#loadPolicy = loadPolicy;
  }

  async fetch(input: FetchFileInput): Promise<FetchFileResult> {
    const ctx = this.#ctx;
    const platform = this.#platform;
    if (platform === undefined) {
      throw new CoreError('files_unavailable', 'This agent cannot save files here.');
    }
    const envelopeId = input?.envelopeId;
    const index = input?.fileIndex ?? 0;
    if (typeof envelopeId !== 'string' || !Number.isSafeInteger(index) || index < 0) {
      return { status: 'not_found' };
    }
    const row = await ctx.store.transaction((tx) =>
      tx.get('envelopes', { envelope_id: envelopeId }),
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
      const url = entry.url as string;
      if (nowOf(ctx) >= entry.expiresAt) return { status: 'rejected', code: 'LINK_EXPIRED' };
      if (!checkFetchUrl(url).ok) return { status: 'rejected', code: 'URL_REFUSED' };
      try {
        source = platform.download(url);
      } catch {
        // The platform's own error can carry the URL (I-7).
        throw new CoreError('file_download_failed', 'The file could not be downloaded.');
      }
    }

    // The inbox folder and a free, safe name inside it.
    const flavor = platform.flavor ?? 'posix';
    let inbox;
    try {
      inbox = await platform.inbox(policy.policy.files.inboxFolder);
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
    const { realpath: folder, ops } = inbox;
    if (!this.#swept.has(folder)) {
      try {
        await removeStaleTempFiles(ops);
      } catch {
        throw inboxUnavailable();
      }
      this.#swept.add(folder);
    }
    let name: string;
    try {
      name = await freeName(ops, sanitizeFileName(entry.name));
    } catch {
      throw inboxUnavailable();
    }
    const savedTo = placeIn(folder, name, flavor);
    let sink;
    try {
      sink = await createTempFileSink(ops, name);
    } catch {
      throw inboxUnavailable();
    }

    const fileKey = decodeBase64url(entry.fileKey);
    try {
      const done = await decryptDownload(source, sink, {
        fileKey,
        plaintextSize: entry.size,
        ciphertextSha256: entry.ciphertextSha256,
        plaintextSha256: entry.plaintextSha256,
        maxPlaintextBytes: limits.maxReceiveBytes,
      });
      ctx.log.info('file saved', { size: done.plaintextSize });
      return { status: 'ok', savedTo, name, size: done.plaintextSize, integrity: 'verified' };
    } catch (error) {
      // decryptDownload has discarded the quarantine file. Fixed codes only (I-7).
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
}
