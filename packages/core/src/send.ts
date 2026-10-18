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
// Errors are CoreErrors with fixed sentences; nothing of the message, the contact or a key goes
// into an error or a log line (I-5, I-7). Logs carry counts only.
import { encodeUtf8 } from '@4thtech-io/crypto';
import { SEND_TOOL_PAYLOAD_TYPES, payloadSchema } from '@4thtech-io/types';
import { IDEMPOTENCY_KEY_REUSED } from './constants.js';
import type { ContactBook } from './contacts.js';
import type { CoreContext } from './context.js';
import type { EnvelopeService } from './envelopes.js';
import { CoreError } from './errors.js';
import type { IdempotencyRun, IdempotencyService } from './idempotency.js';
import type { IdentityService } from './identity.js';
import type { OutboxService } from './outbox.js';
import type { OwnerActions } from './owner-actions.js';
import { evaluate, type PolicyDecision } from './policy-engine.js';

/** The MCP tool whose idempotency rows these are (06 §2.0). */
export const SEND_TOOL = 'agentlink_send';

export type SendMessageType = (typeof SEND_TOOL_PAYLOAD_TYPES)[number];

/** `client.sendMessage` input (06 §2.2; files, `notarize` and `approvalId` join with M1-7f/M1-7i). */
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
}

export const USE_TERMS_TOOLS = 'USE_TERMS_TOOLS' as const;
export const POLICY_DENIED = 'POLICY_DENIED' as const;

export type SendMessageResult =
  | {
      readonly status: 'ok';
      readonly envelopeId: string;
      readonly thread: string;
      /** RFC 3339 UTC, seconds: the envelope's createdAt. */
      readonly sentAt: string;
    }
  | {
      readonly status: 'rejected';
      readonly code: typeof USE_TERMS_TOOLS | typeof IDEMPOTENCY_KEY_REUSED | typeof POLICY_DENIED;
    }
  /** Another execution holds this clientRequestId: run nothing, try again shortly (07 §3.3). */
  | { readonly status: 'in_progress' };

interface Request {
  readonly to: string;
  readonly payload: unknown;
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
  const { to, text, body, replyTo } = input;
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
  const payload = {
    type,
    body: text ?? body,
    replyTo: replyTo ?? null,
    files: [],
  };
  if (!payloadSchema.safeParse(payload).success) return invalid();
  return {
    to,
    payload,
    args: {
      to,
      type,
      text: text ?? null,
      body: body ?? null,
      replyTo: replyTo ?? null,
    },
  };
}

const iso = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const isSendResult = (v: unknown): v is SendMessageResult =>
  isPlainObject(v) && (v.status === 'ok' || v.status === 'rejected');

export interface SendDeps {
  readonly identity: IdentityService;
  readonly contacts: ContactBook;
  readonly envelopes: EnvelopeService;
  readonly ownerActions: OwnerActions;
  readonly idempotency: IdempotencyService;
  readonly outbox: OutboxService;
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
      return done.result;
    }
    const { idempotency } = this.#deps;
    const start = await idempotency.begin({ tool: SEND_TOOL, clientRequestId, args: request.args });
    switch (start.kind) {
      case 'replay':
        if (!isSendResult(start.result)) {
          throw new CoreError('store_unreadable', 'A stored value could not be read.');
        }
        return start.result;
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
        return done.result;
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
        await idempotency.finish(start.run, done.result);
        await this.#publish(done);
        return done.result;
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
    const ctx = this.#ctx;
    const { identity, envelopes, outbox, idempotency } = this.#deps;
    await identity.assertCanSend();
    // The contact rule before anything is signed; the size rule once the envelope exists.
    if ((await this.#decide(request.to, 0)) !== 'allow') {
      return { result: { status: 'rejected', code: POLICY_DENIED } };
    }
    const { built, row } = await envelopes.prepare({
      to: { contact: request.to },
      payload: request.payload,
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
    });
    if (run !== undefined && prepared !== undefined) idempotency.committed(run, prepared);
    ctx.log.info('message stored for sending', { wraps: rows.length });
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
}
