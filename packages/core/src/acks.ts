// Delivery acknowledgements (02 F-23, P1; M1-7h): a free, signed "received" acknowledgement over
// Talk, never on-chain. Behind a flag (`deliveryAcks`, off by default).
//
// - Sending. After a processing pass, each new message from a paired contact (INBOX_TYPES) gets one
//   `ack` envelope back to that contact: `{type: "ack", body: {kind: "received", envelopeId},
//   replyTo: envelopeId}`. It is an ordinary envelope from the agent's current key (04 §3.1.1 key
//   table), with the full 04 §3.2 recipient set, stored with its outbox rows in one store
//   transaction and published like any send (07 §3.2). The `envelope.send` policy applies: a contact
//   the policy does not allow gets no ack. An `ack` is never acknowledged, so two agents never loop.
//   Only `syncInbox` sends acks; the fetch-only catch-up never does (06 §2.0).
// - Reading. `status(envelopeId)` reports whether the contact that an outbound envelope went to
//   has acknowledged it: an `ack` stored as `ok` from that same contact (so from its current key,
//   04 §3.1.1 step 7) whose `replyTo` and `body.envelopeId` both name it. An ack proves only that the
//   contact's agent processed the envelope; it is not a receipt (05 §3) and never "opened".
//
// I-5, I-7: ack payloads are inbound content; nothing from them reaches a log line or an error.
// Logs carry counts only.
import { encodeUtf8, parseJson } from '@agentlink/crypto';
import { payloadSchema } from '@agentlink/types';
import type { CoreContext } from './context.js';
import { open } from './context.js';
import type { EnvelopeService, InboundReport } from './envelopes.js';
import { CoreError } from './errors.js';
import type { IdentityService } from './identity.js';
import { INBOX_TYPES } from './inbox.js';
import type { OutboxService } from './outbox.js';
import type { OwnerActions } from './owner-actions.js';
import { evaluate } from './policy-engine.js';

/** `body.kind` of a delivery acknowledgement (02 F-23). */
export const ACK_KIND_RECEIVED = 'received' as const;

/** At most this many acks are sent per processing pass; the rest are skipped (counted). */
export const MAX_ACKS_PER_PASS = 200;

/** At most this many stored acks are read for one `status` lookup (newest first). */
const MAX_ACKS_SCANNED = 1_000;

/** The ack an outbound envelope has, as far as this agent knows. */
export interface DeliveryAckStatus {
  /** The relay delivery state of the envelope (07 §3.2 `envelopes.delivery`). */
  readonly delivery: 'queued' | 'sent' | 'not_delivered' | null;
  /** True once the contact's agent acknowledged it (02 F-23). */
  readonly received: boolean;
  /** The ack's `createdAt` (chosen by the contact's agent), when received. */
  readonly receivedAt?: number;
}

export interface DeliveryAcksDeps {
  readonly identity: IdentityService;
  readonly envelopes: EnvelopeService;
  readonly outbox: OutboxService;
  readonly ownerActions: OwnerActions;
}

/** The ack payload for an inbound envelope. */
export const ackPayload = (envelopeId: string) => ({
  type: 'ack' as const,
  body: { kind: ACK_KIND_RECEIVED, envelopeId },
  replyTo: envelopeId,
  files: [],
});

export class DeliveryAcks {
  readonly #ctx: CoreContext;
  readonly #deps: DeliveryAcksDeps;
  /** The F-23 flag (P1). Off by default. */
  readonly enabled: boolean;

  constructor(ctx: CoreContext, deps: DeliveryAcksDeps, enabled: boolean) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.enabled = enabled;
  }

  /**
   * Sends one ack for each new message in `reports` (outcome `ok`, from a contact). Never throws:
   * a failure skips that ack and is counted in the log. Returns the number of acks stored for
   * sending. Does nothing while the flag is off.
   */
  async sendFor(reports: readonly InboundReport[]): Promise<number> {
    if (!this.enabled) return 0;
    const candidates = reports.filter(
      (r) => r.outcome === 'ok' && r.contactId !== undefined && r.envelopeId !== undefined,
    );
    if (candidates.length === 0) return 0;
    const rows = await this.#ctx.store
      .transaction((tx) =>
        candidates.map((r) => tx.get('envelopes', { envelope_id: r.envelopeId as string })),
      )
      .catch(() => []);
    let sent = 0;
    let skipped = 0;
    for (const row of rows) {
      if (
        row === undefined ||
        row.direction !== 'in' ||
        row.state !== 'ok' ||
        row.contact_id === null ||
        !INBOX_TYPES.includes(row.type)
      ) {
        continue;
      }
      if (sent >= MAX_ACKS_PER_PASS) {
        skipped += 1;
        continue;
      }
      try {
        if (await this.#send(row.contact_id, row.envelope_id)) sent += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    if (sent > 0 || skipped > 0) this.#ctx.log.info('delivery acks', { sent, skipped });
    return sent;
  }

  /** Stores one ack with its outbox rows, then publishes it. False when the policy refuses it. */
  async #send(contactId: string, envelopeId: string): Promise<boolean> {
    const { identity, envelopes, outbox, ownerActions } = this.#deps;
    outbox.requireTransport();
    await identity.assertCanSend();
    const policy = await ownerActions.loadPolicy();
    if (evaluate(policy, { kind: 'envelope.send', contact: contactId, sizeBytes: 0 }) !== 'allow') {
      return false;
    }
    const { built, row } = await envelopes.prepare({
      to: { contact: contactId },
      payload: ackPayload(envelopeId),
    });
    const size = encodeUtf8(row.envelope_json ?? '').length;
    if (
      evaluate(policy, { kind: 'envelope.send', contact: contactId, sizeBytes: size }) !== 'allow'
    ) {
      return false;
    }
    const routes = await outbox.routes(await outbox.contactPeer(contactId));
    const keys = routes.map((r) => r.recipient);
    if (
      keys.length !== built.recipientNostrKeys.length ||
      !built.recipientNostrKeys.every((k) => keys.includes(k))
    ) {
      return false; // the contact's card changed between the build and the routing
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
    return true;
  }

  /**
   * Whether the contact acknowledged an outbound envelope. Reads the store only.
   * @throws CoreError `envelope_not_found` for an ID that is not an outbound envelope to a contact.
   */
  async status(envelopeId: string): Promise<DeliveryAckStatus> {
    const { row, acks } = await this.#ctx.store.transaction((tx) => {
      const found = tx.get('envelopes', { envelope_id: envelopeId });
      if (found === undefined || found.direction !== 'out' || found.contact_id === null) {
        return { row: undefined, acks: [] };
      }
      return {
        row: found,
        acks: tx.select(
          'envelopes',
          { direction: 'in', contact_id: found.contact_id, state: 'ok', type: 'ack' },
          {
            orderBy: [
              ['created_at', 'desc'],
              ['envelope_id', 'asc'],
            ],
            limit: MAX_ACKS_SCANNED,
          },
        ),
      };
    });
    if (row === undefined) {
      throw new CoreError('envelope_not_found', 'That message was not found.');
    }
    let receivedAt: number | undefined;
    for (const ack of acks) {
      if (ack.payload_json === null) continue;
      try {
        const text = await open(
          this.#ctx,
          'envelopes',
          'payload_json',
          [ack.envelope_id],
          ack.payload_json,
        );
        const parsed = payloadSchema.safeParse(parseJson(text));
        if (!parsed.success || parsed.data.type !== 'ack') continue;
        const body = parsed.data.body;
        if (
          parsed.data.replyTo === envelopeId &&
          typeof body === 'object' &&
          body.kind === ACK_KIND_RECEIVED &&
          body.envelopeId === envelopeId
        ) {
          receivedAt = Math.min(receivedAt ?? ack.created_at, ack.created_at);
        }
      } catch {
        // An ack that cannot be read counts as absent (07 §3.1, fail closed).
      }
    }
    return {
      delivery: row.delivery,
      received: receivedAt !== undefined,
      ...(receivedAt === undefined ? {} : { receivedAt }),
    };
  }
}
