// refresh-link (M1-7f-3; 04 §4 "Delivery", 07 §5.2; the `request` body of @4thtech-io/types).
//
// The recipient of a stored file asks the sender for a fresh download link, and the sender's core
// answers when it is online:
// - Request (recipient): a `request` envelope to the contact that sent the file, body
//   `{kind: "refresh-link", envelopeId, fileIndex}`, `replyTo` the file's envelope. It names the file
//   by position only, never by `ciphertextSha256`, a URL or a key, because a `request` is shown in
//   the inbox (06 §2.1).
// - Answer (sender): a `file` envelope to the same contact, `replyTo` the request, whose body is the
//   same `{kind: "refresh-link", envelopeId, fileIndex}` and whose one `files[]` entry is the
//   original entry with the fresh `url`. The link travels only in that end-to-end-encrypted entry,
//   which no inbox item, tool result or log line shows (06 §2.1, I-7); the file key in it is the one
//   this contact already received for that file, so nobody learns anything new. The answer is an
//   ordinary file message: the recipient can fetch it on its own, and its core also moves the fresh
//   link into the receiver row of the original file so fetchFile on that envelope works again.
//
// Rules (proposed, owner confirms at merge):
// - Retention is never extended (04 §4). The sender answers only while its own `files` row exists
//   and `now < expires_at`, and the fresh link expires at that same `expires_at`; the recipient keeps
//   the earlier of its row's `expires_at` and the answer's. A refresh helps when the storage refuses
//   a link before then (07 §5.2: temporary credentials; reconnected own storage), never after.
// - Only own storage answers (`s3`, a new presigned GET from the adapter). The drop fixes its signed
//   URL and expiry at upload, so a refresh could only return the same link (07 §5.4); inline files
//   have no link. Neither gets an answer.
// - Only the contact the file was sent to gets an answer: the request must come from the contact of
//   the outbound envelope it names (I-5). An unknown sender's request is a queued request, never
//   `ok`, so it never reaches this code.
// - The recipient takes an answer only when it answers a refresh-link request this agent sent, for
//   a file this same contact sent it, and its entry has the same `ciphertextSha256` and size as the
//   receiver row. The link is checked again when it is fetched (checkFetchUrl and the platform's
//   SSRF-safe download, 04 §4).
// - Bounded: at most MAX_LINK_ANSWERS_PER_PASS answers per pass, one per file per pass; the
//   per-contact rate limit already counted each request when it was stored (07 §3.2).
//
// Logging (I-7): counts and fixed codes only; never a URL, a locator, an object key or a file key.
import { encodeUtf8, parseJson } from '@4thtech-io/crypto';
import { payloadSchema, refreshLinkRequestBodySchema, type Payload } from '@4thtech-io/types';
import { nowOf, open, seal, type CoreContext } from '../context.js';
import type { EnvelopeService, InboundReport } from '../envelopes.js';
import { CoreError } from '../errors.js';
import type { IdentityService } from '../identity.js';
import type { OutboxService } from '../outbox.js';
import type { OwnerActions } from '../owner-actions.js';
import { evaluate, type EffectivePolicy } from '../policy-engine.js';
import type { Row } from '../store/schema.js';
import type { FilesPlatform } from './platform.js';
import { openFileObject } from './records.js';

/** `body.kind` of a refresh-link request and of its answer. */
export const REFRESH_LINK_KIND = 'refresh-link' as const;

/** At most this many refresh-link answers are sent per processing pass. */
export const MAX_LINK_ANSWERS_PER_PASS = 50;

export interface RequestFileLinkInput {
  /** A file message this agent received from a contact. */
  readonly envelopeId: string;
  /** Default 0. */
  readonly fileIndex?: number;
}

export type RequestFileLinkResult =
  | {
      readonly status: 'ok';
      /** The envelope ID of the request; the sender's answer replies to it. */
      readonly requestId: string;
    }
  | { readonly status: 'not_found' }
  | {
      readonly status: 'rejected';
      /**
       * LINK_EXPIRED: retention has passed (the file key is gone here); NOT_REFRESHABLE: an inline
       * file, which has no link; POLICY_DENIED: the rules do not allow a message to this contact.
       */
      readonly code: 'LINK_EXPIRED' | 'NOT_REFRESHABLE' | 'POLICY_DENIED';
    };

export interface FileLinksResult {
  /** Answers this agent sent, as the sender. */
  readonly answered: number;
  /** Receiver rows whose link this agent replaced from an answer. */
  readonly refreshed: number;
}

export interface FileLinksDeps {
  readonly identity: IdentityService;
  readonly envelopes: EnvelopeService;
  readonly outbox: OutboxService;
  readonly ownerActions: OwnerActions;
}

interface Body {
  readonly envelopeId: string;
  readonly fileIndex: number;
}

const refreshPayload = (
  type: 'request' | 'file',
  body: Body,
  replyTo: string,
  files: unknown[],
) => ({
  type,
  body: { kind: REFRESH_LINK_KIND, envelopeId: body.envelopeId, fileIndex: body.fileIndex },
  replyTo,
  files,
});

/** The refresh-link body of a payload, or undefined. */
function refreshBodyOf(payload: Payload): Body | undefined {
  const parsed = refreshLinkRequestBodySchema.safeParse(payload.body);
  return parsed.success ? parsed.data : undefined;
}

export class FileLinks {
  readonly #ctx: CoreContext;
  readonly #deps: FileLinksDeps;
  readonly #platform: FilesPlatform | undefined;

  constructor(ctx: CoreContext, deps: FileLinksDeps, platform: FilesPlatform | undefined) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.#platform = platform;
  }

  /**
   * Asks the contact that sent a stored file for a fresh link (recipient side). Checks locally first:
   * a processed message from an active contact, a receiver row that still holds the key (retention
   * not passed) and a stored, not inline, file; then the `envelope.send` policy. The sender answers
   * when it is online; the answer updates this file's link.
   */
  async request(input: RequestFileLinkInput): Promise<RequestFileLinkResult> {
    const ctx = this.#ctx;
    const envelopeId = input?.envelopeId;
    const fileIndex = input?.fileIndex ?? 0;
    if (typeof envelopeId !== 'string' || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
      return { status: 'not_found' };
    }
    const [row, fileRow] = await ctx.store.transaction(
      (tx) =>
        [
          tx.get('envelopes', { envelope_id: envelopeId }),
          tx.get('files', { envelope_id: envelopeId, idx: fileIndex }),
        ] as const,
    );
    if (
      row === undefined ||
      row.direction !== 'in' ||
      row.state !== 'ok' ||
      row.contact_id === null ||
      row.payload_json === null
    ) {
      return { status: 'not_found' };
    }
    const payload = await this.#payload(row);
    const entry = payload.files[fileIndex];
    if (entry === undefined) return { status: 'not_found' };
    if (entry.inline !== null) return { status: 'rejected', code: 'NOT_REFRESHABLE' };
    if (fileRow === undefined || fileRow.expires_at <= nowOf(ctx)) {
      return { status: 'rejected', code: 'LINK_EXPIRED' };
    }
    const contactId = row.contact_id;
    const policy = await this.#deps.ownerActions.loadPolicy();
    const allowed = (sizeBytes: number) =>
      evaluate(policy, { kind: 'envelope.send', contact: contactId, sizeBytes }) === 'allow';
    if (!allowed(0)) return { status: 'rejected', code: 'POLICY_DENIED' };
    const requestId = await this.#send(
      contactId,
      refreshPayload('request', { envelopeId, fileIndex }, envelopeId, []),
      allowed,
    );
    if (requestId === undefined) return { status: 'rejected', code: 'POLICY_DENIED' };
    ctx.log.info('file link requested', {});
    return { status: 'ok', requestId };
  }

  /**
   * After a processing pass: answers each new refresh-link request from a contact (sender side) and
   * takes each new answer (recipient side). Never throws: a failure skips that item and is counted.
   */
  async processInbound(reports: readonly InboundReport[]): Promise<FileLinksResult> {
    const ids = reports
      .filter((r) => r.outcome === 'ok' && r.contactId !== undefined && r.envelopeId !== undefined)
      .map((r) => r.envelopeId as string);
    if (ids.length === 0) return { answered: 0, refreshed: 0 };
    const rows = await this.#ctx.store
      .transaction((tx) => ids.map((id) => tx.get('envelopes', { envelope_id: id })))
      .catch(() => []);
    let answered = 0;
    let refreshed = 0;
    let skipped = 0;
    let policy: EffectivePolicy | undefined;
    const answeredFiles = new Set<string>();
    for (const row of rows) {
      if (
        row === undefined ||
        row.direction !== 'in' ||
        row.state !== 'ok' ||
        row.contact_id === null ||
        row.payload_json === null ||
        (row.type !== 'request' && row.type !== 'file')
      ) {
        continue;
      }
      try {
        const payload = await this.#payload(row);
        const body = refreshBodyOf(payload);
        if (body === undefined) continue;
        if (payload.type === 'request') {
          const key = `${body.envelopeId}/${body.fileIndex}`;
          if (answered >= MAX_LINK_ANSWERS_PER_PASS || answeredFiles.has(key)) {
            skipped += 1;
            continue;
          }
          policy ??= await this.#deps.ownerActions.loadPolicy();
          if (await this.#answer(row, body, policy)) {
            answered += 1;
            answeredFiles.add(key);
          } else skipped += 1;
        } else if (await this.#take(row, payload, body)) {
          refreshed += 1;
        } else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    if (answered > 0 || refreshed > 0 || skipped > 0) {
      this.#ctx.log.info('file links', { answered, refreshed, skipped });
    }
    return { answered, refreshed };
  }

  /** Sender side: answers one request with a fresh link, or returns false. */
  async #answer(request: Row<'envelopes'>, body: Body, policy: EffectivePolicy): Promise<boolean> {
    const ctx = this.#ctx;
    const contactId = request.contact_id as string;
    const own = this.#platform?.ownStorage;
    if (own === undefined) return false;
    const [sent, fileRow] = await ctx.store.transaction(
      (tx) =>
        [
          tx.get('envelopes', { envelope_id: body.envelopeId }),
          tx.get('files', { envelope_id: body.envelopeId, idx: body.fileIndex }),
        ] as const,
    );
    // Only the contact this file was sent to (I-5), only while the sender still holds it.
    if (
      sent === undefined ||
      sent.direction !== 'out' ||
      sent.contact_id !== contactId ||
      sent.payload_json === null ||
      fileRow === undefined ||
      fileRow.deleted_at !== null ||
      fileRow.expires_at <= nowOf(ctx)
    ) {
      return false;
    }
    const stored = await openFileObject(ctx, fileRow);
    if (stored === null || stored.kind !== 's3') return false;
    const entry = (await this.#payload(sent)).files[body.fileIndex];
    if (entry === undefined || entry.ciphertextSha256 !== fileRow.sha256 || entry.url === null) {
      return false;
    }
    const allowed = (sizeBytes: number) =>
      evaluate(policy, { kind: 'envelope.send', contact: contactId, sizeBytes }) === 'allow';
    if (!allowed(0)) return false;
    let url: string;
    try {
      // Never beyond the retention deadline (see the header).
      url = await own.presignGet(stored.object, new Date(fileRow.expires_at * 1000));
    } catch {
      // The adapter's error can carry the object key (I-7).
      throw new CoreError('storage_failed', 'not answered');
    }
    const fresh = { ...entry, url, expiresAt: Math.min(entry.expiresAt, fileRow.expires_at) };
    const answerId = await this.#send(
      contactId,
      refreshPayload('file', body, request.envelope_id, [fresh]),
      allowed,
    );
    return answerId !== undefined;
  }

  /** Recipient side: moves the fresh link of one answer into the receiver row, or returns false. */
  async #take(answer: Row<'envelopes'>, payload: Payload, body: Body): Promise<boolean> {
    const ctx = this.#ctx;
    const contactId = answer.contact_id as string;
    const entry = payload.files.length === 1 ? payload.files[0] : undefined;
    const requestId = payload.replyTo;
    if (entry === undefined || entry.url === null || requestId === null) return false;
    const [request, original, fileRow] = await ctx.store.transaction(
      (tx) =>
        [
          tx.get('envelopes', { envelope_id: requestId }),
          tx.get('envelopes', { envelope_id: body.envelopeId }),
          tx.get('files', { envelope_id: body.envelopeId, idx: body.fileIndex }),
        ] as const,
    );
    // Our own refresh-link request for this very file, to this contact.
    if (
      request === undefined ||
      request.direction !== 'out' ||
      request.type !== 'request' ||
      request.contact_id !== contactId ||
      request.payload_json === null
    ) {
      return false;
    }
    const asked = refreshBodyOf(await this.#payload(request));
    if (asked?.envelopeId !== body.envelopeId || asked.fileIndex !== body.fileIndex) return false;
    // A file this contact sent us, whose key we still hold, with the same ciphertext.
    if (
      original === undefined ||
      original.direction !== 'in' ||
      original.contact_id !== contactId ||
      fileRow === undefined ||
      fileRow.sha256 !== entry.ciphertextSha256 ||
      fileRow.size !== entry.size
    ) {
      return false;
    }
    const key = [body.envelopeId, body.fileIndex];
    const url = await seal(ctx, 'files', 'url', key, entry.url);
    const expiresAt = Math.min(fileRow.expires_at, entry.expiresAt);
    const updated = await ctx.store.transaction((tx) =>
      tx.update(
        'files',
        { envelope_id: body.envelopeId, idx: body.fileIndex, sha256: entry.ciphertextSha256 },
        { url, expires_at: expiresAt },
      ),
    );
    return updated === 1;
  }

  /** Opens and parses a stored payload; anything else is the fixed `store_unreadable`. */
  async #payload(row: Row<'envelopes'>): Promise<Payload> {
    const text = await open(
      this.#ctx,
      'envelopes',
      'payload_json',
      [row.envelope_id],
      row.payload_json as NonNullable<Row<'envelopes'>['payload_json']>,
    );
    const parsed = payloadSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw new CoreError('store_unreadable', 'A stored value could not be read.');
    }
    return parsed.data;
  }

  /**
   * Stores one envelope with its outbox rows, then publishes it (as card-update.ts does). Returns its
   * ID, or undefined when the policy's size cap refuses it.
   */
  async #send(
    contactId: string,
    payload: Readonly<Record<string, unknown>>,
    allowed: (sizeBytes: number) => boolean,
  ): Promise<string | undefined> {
    const { envelopes, outbox, identity } = this.#deps;
    outbox.requireTransport();
    await identity.assertCanSend();
    const { built, row } = await envelopes.prepare({ to: { contact: contactId }, payload });
    if (!allowed(encodeUtf8(row.envelope_json ?? '').length)) return undefined;
    const routes = await outbox.routes(await outbox.contactPeer(contactId));
    const keys = routes.map((r) => r.recipient);
    if (
      keys.length !== built.recipientNostrKeys.length ||
      !built.recipientNostrKeys.every((k) => keys.includes(k))
    ) {
      throw new CoreError('contact_conflict', 'The contact changed meanwhile. Try again.');
    }
    const rows = await outbox.prepareRows(built.envelope, routes);
    await this.#ctx.store.transaction((tx) => {
      const contact = tx.get('contacts', { contact_id: contactId });
      if (contact?.status !== 'active' || contact.pairing !== 'complete') {
        throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
      }
      tx.insert('envelopes', row);
      for (const r of rows) tx.insert('outbox', r);
    });
    try {
      await outbox.publishEnvelope(built.envelope.id);
    } catch {
      // The rows stay pending; the outbox retries (07 §3.2).
    }
    return built.envelope.id;
  }
}
