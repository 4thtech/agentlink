// The send pipeline (07 §2 `sendMessage`; 03 §4.1; 06 §2.2 `agentlink_send`; M1-7k).
//
// policy check -> action -> store -> result (07 §2), for the Talk types `text | note | request |
// delivery` to a paired contact:
// 1. The input is checked first: a `body` with a `terms` key returns `USE_TERMS_TOOLS` (06 §2.2,
//    D-55) and nothing is stored, not even an idempotency row. Exactly one of `text` and `body`.
// 2. With a `clientRequestId`, the idempotency row decides (06 §1 rule 6, 07 §3.3): replay,
//    IDEMPOTENCY_KEY_REUSED, in progress, resume, or run.
// 3. `identity.assertCanSend()`; the policy's `envelope.send` rule for the contact (06 §3; D-70: a
//    paired contact may Talk while the policy fails closed); then the envelope is built and signed
//    (M1-7b) and the rule is checked again with its size. A denial stores and publishes nothing.
// 4. Routing and wrapping (07 §4.1, §4.3; outbox.ts): one gift wrap per distinct recipient key. A
//    list that cannot be read fails the send before anything is stored.
// 5. One store transaction: the idempotency compare-and-set (07 §3.3 "Effects"), the contact still
//    active, the outbound envelope and all of its outbox rows (07 §3.2 "Transaction"). If it fails,
//    nothing is published.
// 6. The result is stored (idempotency), then the envelope's rows are published. A relay outage
//    does not fail the send: the rows stay pending and the outbox retries (07 §4.2).
//
// FILES-AI-1 (D-152; 06 §2.3 "Send by content"): with `contentFile: {name, content}` the idempotency
// row binds the raw name, the content's SHA-256 and length (never the content, never a path), so a
// repeat is answered before anything is written. Inside the run, after the pause and before the
// contact policy: the name and the content checks (FILE_NAME, FILE_TYPE, FILE_NOT_TEXT,
// FILE_TOO_LARGE); then the contact policy (POLICY_DENIED); then the verified policy's allowed folders
// (none: needs_setup `no_folder`); then the platform's Send folder writer, which holds the ID's own
// pinned Send folder, calls the budget reservation (one store transaction) and only then creates the
// file. The send then takes the written realpath through every `path` rule, but the bytes it encrypts
// are the ones in memory. Anything but `ok` removes the file this call wrote; the content refusals
// are never kept under the clientRequestId.
//
// Errors are CoreErrors with fixed sentences; nothing of the message, the contact or a key goes
// into an error or a log line (I-5, I-7). Logs carry counts only.
import {
  canonicalize,
  createSha256,
  encodeHex,
  encodeUtf8,
  sha256,
  type JsonValue,
} from '@4thtech-io/crypto';
import { PAYLOAD_MAX_BYTES } from '@4thtech-io/storage';
import { SEND_TOOL_PAYLOAD_TYPES, mimeForName, payloadSchema } from '@4thtech-io/types';
import { IDEMPOTENCY_KEY_REUSED } from './constants.js';
import type { ContactBook } from './contacts.js';
import { nowOf, type CoreContext } from './context.js';
import type { EnvelopeService } from './envelopes.js';
import { CoreError } from './errors.js';
import {
  deleteUploaded,
  prepareOutgoing,
  type FilesNeedsSetup,
  type OutgoingRecord,
  type SentFile,
} from './files/outgoing.js';
import {
  CONTENT_FILE_UNKEPT,
  FILE_BUDGET,
  FILE_NAME_TAKEN,
  FILE_TYPE,
  SEND_FOLDER_UNAVAILABLE,
  contentFileBytes,
  contentFileName,
  reserveContentBudget,
  type ContentFileCode,
} from './files/content-file.js';
import type { FilesPlatform, OutgoingFile, SendFolderWriteResult } from './files/platform.js';
import { sealFileRows } from './files/records.js';
import type { IdempotencyRun, IdempotencyService } from './idempotency.js';
import type { IdentityService } from './identity.js';
import type { OutboxService } from './outbox.js';
import type { OwnerActions } from './owner-actions.js';
import { evaluate, type PolicyDecision } from './policy-engine.js';

/** The MCP tool whose idempotency rows these are (06 §2.0). */
export const SEND_TOOL = 'agentlink_send';

export type SendMessageType = (typeof SEND_TOOL_PAYLOAD_TYPES)[number];

/** `client.sendMessage` input (06 §2.2, §2.3; `notarize` and `approvalId` join with M1-7i). */
export interface SendMessageInput {
  /** The contact's agent ID (04 §2.9). Resolving a name to an ID is the MCP layer's (M1-9). */
  readonly to: string;
  readonly text?: string;
  /** Default `text`. */
  readonly type?: SendMessageType;
  /** A JSON object. A `terms` key is refused with USE_TERMS_TOOLS (06 §2.2, D-55). */
  readonly body?: Readonly<Record<string, unknown>>;
  readonly replyTo?: string;
  readonly clientRequestId?: string;
  /**
   * Files to attach (06 §2.3, M1-7f), at most 16, each already opened by the platform through its
   * allowed-folder check; the core checks the realpath again (04 §4).
   */
  readonly files?: readonly OutgoingFile[];
  /**
   * FILES-AI-1 (D-152; 06 §2.3 "Send by content"): a small text file the AI wrote, saved into the
   * ID's own Send folder by the platform's writer and sent from these bytes. Not with `files`.
   */
  readonly contentFile?: { readonly name: string; readonly content: string };
}

export const USE_TERMS_TOOLS = 'USE_TERMS_TOOLS' as const;
export const POLICY_DENIED = 'POLICY_DENIED' as const;
/** 04 §3.4 (G-27, D-85): the files cannot fit in one payload, even all stored. Nothing was sent. */
export const PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE' as const;
/** A file above `files.maxSendSizeMB`. Nothing was read or sent. */
export const FILE_TOO_LARGE = 'FILE_TOO_LARGE' as const;

/** REL051-CF2: an outbound message's delivery state (07 §3.2). */
export type SendDelivery = 'queued' | 'sent' | 'not_delivered';

export type SendMessageResult =
  | {
      readonly status: 'ok';
      readonly envelopeId: string;
      readonly thread: string;
      /** RFC 3339 UTC, seconds: the envelope's createdAt. */
      readonly sentAt: string;
      /** Where each attached file went (only when files were attached). */
      readonly files?: readonly SentFile[];
      /**
       * REL051-CF2: where the message is right after the first publish (07 §3.2 `delivery`):
       * `sent` once the relays accepted it (07 §4.2), `queued` while it waits for them (the outbox
       * sends it on its own when they are back), `not_delivered` when it was given up. Read from the
       * envelope at answer time, also for a repeat with the same clientRequestId; never stored.
       */
      readonly delivery?: SendDelivery;
      /**
       * FILES-AI-1: the file written by content: the saved name (`notes (2).md` after a clash), the
       * size and SHA-256 of the in-memory bytes, and the Send folder in its fixed `~` form.
       */
      readonly contentFile?: {
        readonly name: string;
        readonly size: number;
        readonly plaintextSha256: string;
        readonly sendFolder: string;
      };
    }
  | {
      readonly status: 'rejected';
      readonly code:
        | typeof USE_TERMS_TOOLS
        | typeof IDEMPOTENCY_KEY_REUSED
        | typeof POLICY_DENIED
        | typeof PAYLOAD_TOO_LARGE
        | typeof FILE_TOO_LARGE
        | ContentFileCode;
    }
  /** A file send that needs the owner first (06 §2.3): an allowed folder or own storage. */
  | { readonly status: 'needs_setup'; readonly reason: FilesNeedsSetup }
  /** Another execution holds this clientRequestId: run nothing, try again shortly (07 §3.3). */
  | { readonly status: 'in_progress' };

interface Request {
  readonly to: string;
  readonly payload: {
    readonly type: string;
    readonly body: unknown;
    readonly replyTo: string | null;
  };
  readonly files: readonly OutgoingFile[];
  /** FILES-AI-1: the content file, checked in the run (06 §2.3 order). */
  readonly contentFile?: { readonly name: unknown; readonly content: unknown };
  /** `args` as for `action.args` (04 §3.4.1): defaults applied, without clientRequestId. */
  readonly args: Readonly<Record<string, unknown>>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const invalid = (): never => {
  throw new CoreError('payload_invalid', 'The message content is not valid.');
};

/** The checked request, or the USE_TERMS_TOOLS refusal. Throws for any other bad input. */
function readInput(input: SendMessageInput): Request | 'terms' {
  if (!isPlainObject(input)) return invalid();
  const { to, text, body, replyTo, files, contentFile } = input;
  const type = input.type ?? 'text';
  if (body !== undefined && isPlainObject(body) && Object.hasOwn(body, 'terms')) return 'terms';
  if (!(SEND_TOOL_PAYLOAD_TYPES as readonly unknown[]).includes(type)) {
    throw new CoreError('type_not_sendable', 'This message type cannot be sent this way.');
  }
  if (typeof to !== 'string' || to.length === 0) return invalid();
  if ((text === undefined) === (body === undefined)) return invalid();
  if (text !== undefined && typeof text !== 'string') return invalid();
  if (body !== undefined && !isPlainObject(body)) return invalid();
  if (replyTo !== undefined && typeof replyTo !== 'string') return invalid();
  if (files !== undefined && (!Array.isArray(files) || files.length > 16)) return invalid();
  if (contentFile !== undefined && (!isPlainObject(contentFile) || files !== undefined)) {
    return invalid();
  }
  const payload = {
    type,
    body: text ?? body,
    replyTo: replyTo ?? null,
    files: [],
  };
  if (!payloadSchema.safeParse(payload).success) return invalid();
  const attached: readonly OutgoingFile[] = files ?? [];
  return {
    to,
    payload: { type: payload.type, body: payload.body, replyTo: payload.replyTo },
    files: attached,
    ...(contentFile === undefined
      ? {}
      : { contentFile: { name: contentFile['name'], content: contentFile['content'] } }),
    args: {
      to,
      type,
      text: text ?? null,
      body: body ?? null,
      replyTo: replyTo ?? null,
      // Only with files, so the args (and their digest) of a plain message stay as they were. The
      // realpath stays local: idempotency keeps only a keyed digest of the args (07 §3.3).
      ...(attached.length === 0
        ? {}
        : {
            files: attached.map((f) => ({
              realpath: typeof f?.realpath === 'string' ? f.realpath : null,
              size: typeof f?.size === 'number' ? f.size : null,
              name: typeof f?.name === 'string' ? f.name : null,
              mime: typeof f?.mime === 'string' ? f.mime : null,
            })),
          }),
      // FILES-AI-1: the raw name, the content's hash and length; never the content or a path.
      ...(contentFile === undefined ? {} : { contentFile: contentFileArgs(contentFile) }),
    },
  };
}

/** The idempotency args of a content file (06 §2.3: "the record holds the content's hash"). */
function contentFileArgs(
  file: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { name, content } = file;
  const text = typeof content === 'string' ? content : '';
  const hasher = createSha256();
  // Lone surrogates encode as U+FFFD: `chars` and the refusal in the run keep two such inputs apart.
  hasher.update(new TextEncoder().encode(text));
  return {
    name: typeof name === 'string' ? name : null,
    sha256: typeof content === 'string' ? encodeHex(hasher.digest()) : null,
    chars: typeof content === 'string' ? content.length : null,
  };
}

const iso = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const isSendResult = (v: unknown): v is SendMessageResult =>
  isPlainObject(v) && (v.status === 'ok' || v.status === 'rejected' || v.status === 'needs_setup');

export interface SendDeps {
  readonly identity: IdentityService;
  readonly contacts: ContactBook;
  readonly envelopes: EnvelopeService;
  readonly ownerActions: OwnerActions;
  readonly idempotency: IdempotencyService;
  readonly outbox: OutboxService;
  /** The files platform (M1-7f); without it a send with files fails with `files_unavailable`. */
  readonly files?: FilesPlatform;
}

export class SendService {
  readonly #ctx: CoreContext;
  readonly #deps: SendDeps;

  constructor(ctx: CoreContext, deps: SendDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const request = readInput(input);
    if (request === 'terms') return { status: 'rejected', code: USE_TERMS_TOOLS };
    this.#deps.outbox.requireTransport();
    const clientRequestId = input.clientRequestId;
    if (clientRequestId === undefined) {
      const done = await this.#run(request, undefined);
      await this.#publish(done);
      return this.#withDelivery(done.result);
    }
    const { idempotency } = this.#deps;
    const start = await idempotency.begin({ tool: SEND_TOOL, clientRequestId, args: request.args });
    switch (start.kind) {
      case 'replay':
        if (!isSendResult(start.result)) {
          throw new CoreError('store_unreadable', 'A stored value could not be read.');
        }
        return this.#withDelivery(start.result);
      case 'key_reused':
        return { status: 'rejected', code: IDEMPOTENCY_KEY_REUSED };
      case 'in_progress':
        return { status: 'in_progress' };
      case 'stale_approval':
        // A send result is never `pending_approval`, so this is not a send row (fail closed).
        throw new CoreError('store_unreadable', 'A stored value could not be read.');
      case 'resume': {
        const done = await this.#resume(start.run);
        await idempotency.finish(start.run, done.result);
        await this.#publish(done);
        return this.#withDelivery(done.result);
      }
      case 'run': {
        let done: { result: SendMessageResult; envelopeId?: string };
        try {
          done = await this.#run(request, start.run);
        } catch (error) {
          // No durable effect: delete the row, so a retry runs once the cause is fixed (07 §3.3).
          // With an effect the row stays `running` and a later call resumes from it.
          if (start.run.effects.length === 0) {
            await idempotency.finish(start.run, null, { keep: false }).catch(() => false);
          }
          throw error;
        }
        if (
          done.result.status === 'needs_setup' ||
          (request.contentFile !== undefined &&
            done.result.status === 'rejected' &&
            CONTENT_FILE_UNKEPT.has(done.result.code))
        ) {
          // Nothing happened and the owner is about to fix the cause (an allowed folder, own
          // storage): the row is deleted, never replayed, so the same clientRequestId runs again
          // (07 §3.3).
          await idempotency.finish(start.run, null, { keep: false }).catch(() => false);
          return done.result;
        }
        await idempotency.finish(start.run, done.result);
        await this.#publish(done);
        return this.#withDelivery(done.result);
      }
    }
  }

  async #decide(to: string, sizeBytes: number): Promise<PolicyDecision> {
    const policy = await this.#deps.ownerActions.loadPolicy();
    return evaluate(policy, { kind: 'envelope.send', contact: to, sizeBytes });
  }

  async #run(
    request: Request,
    run: IdempotencyRun | undefined,
  ): Promise<{ readonly result: SendMessageResult; readonly envelopeId?: string }> {
    await this.#deps.identity.assertCanSend();
    // FILES-AI-1: the name and the content are checked before the contact rule (06 §2.3 order).
    if (request.contentFile !== undefined) return this.#runContentFile(request, run);
    // The contact rule before anything is read, uploaded or signed; the size rule once the
    // envelope exists.
    if ((await this.#decide(request.to, 0)) !== 'allow') {
      return { result: { status: 'rejected', code: POLICY_DENIED } };
    }
    return this.#runFiles(request, request.files, run);
  }

  /** FILES-AI-1: the content file's checks, the write, then the ordinary file send (06 §2.3). */
  async #runContentFile(
    request: Request,
    run: IdempotencyRun | undefined,
  ): Promise<{ readonly result: SendMessageResult; readonly envelopeId?: string }> {
    const ctx = this.#ctx;
    const refuse = (code: ContentFileCode) => ({ result: { status: 'rejected', code } as const });
    const named = contentFileName(request.contentFile?.name);
    if (!named.ok) return refuse(named.code);
    const content = contentFileBytes(request.contentFile?.content);
    if (!content.ok) return refuse(content.code);
    const bytes = content.bytes;
    // The contact policy, the same rule that decides a `path` send to this contact.
    if ((await this.#decide(request.to, 0)) !== 'allow') {
      return { result: { status: 'rejected', code: POLICY_DENIED } };
    }
    const policy = await this.#deps.ownerActions.loadPolicy();
    const folders = policy.mode === 'fail_closed' ? [] : policy.policy.files.allowedFolders;
    if (!Array.isArray(folders) || folders.length === 0) {
      return { result: { status: 'needs_setup', reason: 'no_folder' } };
    }
    const write = this.#deps.files?.writeSendFolderFile?.bind(this.#deps.files);
    if (write === undefined) {
      throw new CoreError('files_unavailable', 'This agent cannot send files here.');
    }
    let written: SendFolderWriteResult;
    try {
      written = await write({
        allowedFolders: folders,
        name: named.name,
        bytes,
        reserve: async () => {
          try {
            return await reserveContentBudget(ctx.store, nowOf(ctx), bytes.length);
          } catch {
            // Fail closed: an unreadable ledger refuses (FILES_UNAVAILABLE), nothing is written.
            return 'unavailable';
          }
        },
      });
    } catch {
      // The platform's own error can name a path; it is replaced (I-7).
      throw new CoreError('files_unavailable', 'The Send folder cannot be used now.');
    }
    if (!written.ok) {
      switch (written.reason) {
        case 'budget':
          return refuse(FILE_BUDGET);
        case 'budget_unavailable':
          throw new CoreError('files_unavailable', 'The Send folder cannot be used now.');
        case 'name_taken':
          return refuse(FILE_NAME_TAKEN);
        case 'type':
          return refuse(FILE_TYPE);
        default:
          return refuse(SEND_FOLDER_UNAVAILABLE);
      }
    }
    const file: OutgoingFile = {
      realpath: written.realpath,
      name: written.name,
      mime: mimeForName(written.name),
      size: bytes.length,
      // The bytes in memory, never read back from the folder.
      open: () => Promise.resolve(bytes.slice()),
    };
    let done: { readonly result: SendMessageResult; readonly envelopeId?: string };
    try {
      done = await this.#runFiles(request, [file], run);
    } catch (error) {
      await written.remove().catch(() => undefined);
      throw error;
    }
    if (done.result.status !== 'ok') {
      await written.remove().catch(() => undefined);
      return done;
    }
    return {
      ...done,
      result: {
        ...done.result,
        contentFile: {
          name: written.name,
          size: bytes.length,
          plaintextSha256: encodeHex(sha256(bytes)),
          sendFolder: written.sendFolder,
        },
      },
    };
  }

  /** The file send of `files` (none: a plain message), after the contact policy passed. */
  async #runFiles(
    request: Request,
    files: readonly OutgoingFile[],
    run: IdempotencyRun | undefined,
  ): Promise<{ readonly result: SendMessageResult; readonly envelopeId?: string }> {
    const ctx = this.#ctx;
    const { ownerActions } = this.#deps;
    if (files.length === 0) {
      return this.#store(request, { ...request.payload, files: [] }, [], run);
    }
    const platform = this.#deps.files;
    if (platform === undefined) {
      throw new CoreError('files_unavailable', 'This agent cannot send files here.');
    }
    const outcome = await prepareOutgoing(
      { ctx, platform, policy: await ownerActions.loadPolicy() },
      request.payload,
      files,
    );
    if (outcome.kind === 'needs_setup') {
      return { result: { status: 'needs_setup', reason: outcome.reason } };
    }
    if (outcome.kind === 'rejected') return { result: { status: 'rejected', code: outcome.code } };
    const payload = { ...request.payload, files: outcome.entries };
    let done: { readonly result: SendMessageResult; readonly envelopeId?: string };
    try {
      // The final check after upload (04 §3.4, D-85): the payload exactly as it is encrypted.
      const bytes = encodeUtf8(canonicalize(payload as unknown as JsonValue)).length;
      done =
        bytes > PAYLOAD_MAX_BYTES
          ? { result: { status: 'rejected', code: PAYLOAD_TOO_LARGE } }
          : await this.#store(request, payload, outcome.records, run);
    } catch (error) {
      await deleteUploaded(ctx, outcome.records);
      throw error;
    }
    if (done.result.status !== 'ok') {
      // Nothing was stored or sent: the uploads are deleted (04 §3.4).
      await deleteUploaded(ctx, outcome.records);
      return done;
    }
    return { ...done, result: { ...done.result, files: outcome.sent } };
  }

  /** Builds, signs and stores the envelope with its outbox rows and its files rows. */
  async #store(
    request: Request,
    payload: Readonly<Record<string, unknown>>,
    records: readonly OutgoingRecord[],
    run: IdempotencyRun | undefined,
  ): Promise<{ readonly result: SendMessageResult; readonly envelopeId?: string }> {
    const ctx = this.#ctx;
    const { envelopes, outbox, idempotency } = this.#deps;
    const { built, row } = await envelopes.prepare({
      to: { contact: request.to },
      payload,
    });
    const size = encodeUtf8(row.envelope_json ?? '').length;
    if ((await this.#decide(request.to, size)) !== 'allow') {
      return { result: { status: 'rejected', code: POLICY_DENIED } };
    }
    const routes = await outbox.routes(await outbox.contactPeer(request.to));
    const keys = routes.map((r) => r.recipient);
    if (
      keys.length !== built.recipientNostrKeys.length ||
      !built.recipientNostrKeys.every((k) => keys.includes(k))
    ) {
      // The contact's card changed between the build and the routing: send nothing.
      throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
    }
    const rows = await outbox.prepareRows(built.envelope, routes);
    const envelopeId = built.envelope.id;
    // Sealed before the transaction: no await inside it (07 §3.1).
    const fileRows = await sealFileRows(ctx, envelopeId, records);
    const prepared =
      run === undefined ? undefined : await idempotency.prepareEffect(run, [envelopeId]);
    await ctx.store.transaction((tx) => {
      if (run !== undefined && prepared !== undefined && !idempotency.effectTx(tx, run, prepared)) {
        throw new CoreError('idempotency_lost', 'This request is already being handled.');
      }
      const contact = tx.get('contacts', { contact_id: request.to });
      if (contact?.status !== 'active' || contact.pairing !== 'complete') {
        throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
      }
      tx.insert('envelopes', row);
      for (const r of rows) tx.insert('outbox', r);
      for (const f of fileRows) tx.insert('files', f);
    });
    if (run !== undefined && prepared !== undefined) idempotency.committed(run, prepared);
    ctx.log.info(
      'message stored for sending',
      fileRows.length === 0
        ? { wraps: rows.length }
        : { wraps: rows.length, files: fileRows.length },
    );
    return {
      result: {
        status: 'ok',
        envelopeId,
        thread: built.thread,
        sentAt: iso(row.created_at),
      },
      envelopeId,
    };
  }

  /** A takeover with a stored envelope: report it and publish its pending rows (07 §3.3 "Resume"). */
  async #resume(
    run: IdempotencyRun,
  ): Promise<{ readonly result: SendMessageResult; readonly envelopeId: string }> {
    const envelopeId = run.effects[0];
    const row =
      envelopeId === undefined
        ? undefined
        : await this.#ctx.store.transaction((tx) =>
            tx.get('envelopes', { envelope_id: envelopeId }),
          );
    if (row === undefined || envelopeId === undefined || row.direction !== 'out') {
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    return {
      result: { status: 'ok', envelopeId, thread: row.thread_id, sentAt: iso(row.created_at) },
      envelopeId,
    };
  }

  /** The first publish of the envelope's rows. A failure leaves them pending for the outbox. */
  async #publish(done: { readonly envelopeId?: string }): Promise<void> {
    if (done.envelopeId === undefined) return;
    try {
      await this.#deps.outbox.publishEnvelope(done.envelopeId);
    } catch {
      this.#ctx.log.warn('first publish failed; the outbox retries', { envelopes: 1 });
    }
  }

  /**
   * REL051-CF2: an `ok` result with the envelope's delivery state now (07 §3.2), so the caller can
   * tell sent from queued. Not stored with the idempotency row: a repeat reads it again. A row that
   * cannot be read leaves the result as it was (no claim either way).
   */
  async #withDelivery(result: SendMessageResult): Promise<SendMessageResult> {
    if (result.status !== 'ok') return result;
    try {
      const row = await this.#ctx.store.transaction((tx) =>
        tx.get('envelopes', { envelope_id: result.envelopeId }),
      );
      const delivery = row?.direction === 'out' ? row.delivery : undefined;
      if (delivery !== 'queued' && delivery !== 'sent' && delivery !== 'not_delivered') {
        return result;
      }
      return { ...result, delivery };
    } catch {
      return result;
    }
  }
}
