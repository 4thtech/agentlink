// Delivery acknowledgements (02 F-23, P1; M1-7h; SEC-RECEIPTS-DEFAULT, D-156): a free, signed
// "received" acknowledgement over Talk, never on-chain. On by default; the owner's signed policy
// `receipts.sendReceived: false` ("Send received receipts" off) turns it off.
//
// - Sending. After a processing pass, each new message from an active, fully paired contact
//   (INBOX_TYPES) gets one `ack` envelope back to that contact: `{type: "ack", body: {kind:
//   "received", envelopeId, envelopeHash}, replyTo: envelopeId}` (v2: the body binds the content
//   hash, not only the sender-chosen ID). Never to a blocked, removed or revoked contact or an
//   unknown sender, and never from the fetch-only catch-up (06 §2.0). It is an ordinary envelope
//   from the agent's current key (04 §3.1.1 key table), with the full 04 §3.2 recipient set, signed
//   and stored as a staged outbox message (`queued`, no rows yet; IR-M1-7h-1 F04 b): the next outbox
//   pass gives it its wraps and rows and publishes it (outbox.ts `enqueueStaged`, 07 §3.2), so a
//   processing pass never waits on relays. The `envelope.send` policy applies, read once per pass.
//   One ack per message: a message already acknowledged gets none again. An `ack` is never
//   acknowledged, so two agents never loop.
// - Reading. `status(envelopeId)` reports whether the contact that an outbound envelope went to has
//   acknowledged it (classifyAck): an `ack` stored as `ok` from that same contact, signed by a key
//   that contact's card history holds (the epoch in force at ack time; a later rotation does not
//   void it, a key it never held is refused), whose `replyTo` and `body.envelopeId` both name it.
//   With `body.envelopeHash` equal to the envelope's hash it is `verified` (delivered); without one
//   (an older app's id-only ack) it is `older_app`, weaker, and never satisfies a proof surface; with
//   any other hash it is ignored. An ack proves only that the contact's AI received these bytes; it is
//   not an on-chain receipt (05 §3) and never "opened". In a proof pack it is the "automatic device
//   receipt" (DEVICE_RECEIPT_LABEL).
//
// I-5, I-7: ack payloads are inbound content; nothing from them reaches a log line or an error.
// Logs carry counts only.
import { encodeUtf8, parseJson } from '@4thtech-io/crypto';
import {
  DEVICE_RECEIPT_LABEL,
  payloadSchema,
  sendReceivedOf,
  type Payload,
} from '@4thtech-io/types';
import type { CoreContext } from './context.js';
import { nowOf, open } from './context.js';
import type { EnvelopeService, InboundReport } from './envelopes.js';
import { CoreError } from './errors.js';
import type { IdentityService } from './identity.js';
import { INBOX_TYPES } from './inbox.js';
import type { OutboxService } from './outbox.js';
import type { OwnerActions } from './owner-actions.js';
import { evaluate } from './policy-engine.js';
import { readRestoreState, restoredReplay } from './restore-guard.js';
import type { Row } from './store/schema.js';
import type { StoreTx } from './store/store.js';

/** `body.kind` of a delivery acknowledgement (02 F-23). */
export const ACK_KIND_RECEIVED = 'received' as const;

/** The proof pack's label for the off-chain ack (07 §8; D-156). */
export { DEVICE_RECEIPT_LABEL };

/** At most this many acks are sent per processing pass; the rest are skipped (counted). */
export const MAX_ACKS_PER_PASS = 200;

/** At most this many stored acks are read per contact for one lookup (newest first). */
export const MAX_ACKS_SCANNED = 1_000;

/** Allowance for clock skew when looking for this agent's own earlier acks of a message, seconds. */
const OWN_ACK_SKEW_SECONDS = 600;

const HASH = /^0x[0-9a-f]{64}$/;

/** The keys an ack body may carry (04 §3.4 v2; v1 has only `kind` and `envelopeId`). */
const ACK_BODY_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'envelopeId',
  'envelopeHash',
  'recordId',
]);

/**
 * How strongly a stored ack confirms an outbound envelope: `verified` binds its envelopeHash (v2);
 * `older_app` names its ID only (an app from before v2): received, but weaker.
 */
export type AckStrength = 'verified' | 'older_app';

/** The ack an outbound envelope has, as far as this agent knows. */
export interface DeliveryAckStatus {
  /** The relay delivery state of the envelope (07 §3.2 `envelopes.delivery`). */
  readonly delivery: 'queued' | 'sent' | 'not_delivered' | null;
  /** True once the contact's AI acknowledged it, by either kind of ack (02 F-23). */
  readonly received: boolean;
  /** True only for a v2 ack over this envelope's hash: the one state that reads as delivered. */
  readonly verified: boolean;
  /** The strongest ack, or null. */
  readonly receipt: AckStrength | null;
  /** The ack's `createdAt` (chosen by the contact's agent), when received. */
  readonly receivedAt?: number;
}

export interface DeliveryAcksDeps {
  readonly identity: IdentityService;
  readonly envelopes: EnvelopeService;
  readonly outbox: OutboxService;
  readonly ownerActions: OwnerActions;
}

/** The v2 ack payload for an inbound envelope: its ID and its envelopeHash (`0x` + 64 hex). */
export const ackPayload = (envelopeId: string, envelopeHash: string, recordId?: string) => ({
  type: 'ack' as const,
  body: {
    kind: ACK_KIND_RECEIVED,
    envelopeId,
    envelopeHash,
    // 04 §3.4: `recordId` only when the received envelope carried a proof (a record is known).
    ...(recordId === undefined ? {} : { recordId }),
  },
  replyTo: envelopeId,
  files: [],
});

/**
 * The sender's check of one stored ack against one outbound envelope. `fromKey` is the key that
 * signed the ack (64 lowercase hex); `contactKeys` every key the contact's card history holds (its
 * current key and the earlier ones). Undefined when the ack does not count.
 */
export function classifyAck(input: {
  readonly payload: Payload;
  readonly fromKey: string;
  readonly contactKeys: readonly string[];
  readonly envelopeId: string;
  readonly envelopeHash: string;
}): AckStrength | undefined {
  const { payload } = input;
  if (payload.type !== 'ack') return undefined;
  if (!input.contactKeys.includes(input.fromKey)) return undefined;
  const body = payload.body;
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (b['kind'] !== ACK_KIND_RECEIVED) return undefined;
  // Strict (04 §3.4): v2 names only these keys, v1 only `kind` and `envelopeId`.
  if (!Object.keys(b).every((k) => ACK_BODY_KEYS.has(k))) return undefined;
  const recordId = b['recordId'];
  if (recordId !== undefined && (typeof recordId !== 'string' || !HASH.test(recordId))) {
    return undefined;
  }
  if (payload.replyTo !== input.envelopeId || b['envelopeId'] !== input.envelopeId) {
    return undefined;
  }
  if (!Object.hasOwn(b, 'envelopeHash')) return 'older_app';
  const hash = b['envelopeHash'];
  if (typeof hash !== 'string' || !HASH.test(hash) || hash !== input.envelopeHash) {
    return undefined;
  }
  return 'verified';
}

/** Every key a contact's card history holds: the current one and the earlier ones (07 §3). */
function contactKeysTx(tx: StoreTx, contactId: string): readonly string[] {
  const row = tx.get('contacts', { contact_id: contactId });
  if (row === undefined) return [];
  let earlier: unknown;
  try {
    earlier = JSON.parse(row.nostr_keys);
  } catch {
    earlier = [];
  }
  const list = Array.isArray(earlier)
    ? (earlier as unknown[]).filter((k): k is string => typeof k === 'string')
    : [];
  return [row.agent_nostr, ...list];
}

/** One outbound envelope to look up. */
export interface AckTarget {
  readonly envelopeId: string;
  readonly envelopeHash: string;
  readonly contactId: string;
}

/** The strongest ack found for one target. */
export interface AckFound {
  readonly strength: AckStrength;
  /** The earliest `createdAt` among the acks of that strength. */
  readonly at: number;
  /** That ack's stored row (the proof pack's device receipt uses a verified one). */
  readonly row: Row<'envelopes'>;
}

async function openAck(ctx: CoreContext, row: Row<'envelopes'>): Promise<Payload | undefined> {
  if (row.payload_json === null) return undefined;
  try {
    const text = await open(ctx, 'envelopes', 'payload_json', [row.envelope_id], row.payload_json);
    const parsed = payloadSchema.safeParse(parseJson(text));
    return parsed.success && parsed.data.type === 'ack' ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The strongest ack per target (verified over older_app), from the store only. An ack that cannot
 * be read counts as absent (07 §3.1, fail closed).
 */
export async function acksFor(
  ctx: CoreContext,
  targets: readonly AckTarget[],
): Promise<ReadonlyMap<string, AckFound>> {
  const out = new Map<string, AckFound>();
  if (targets.length === 0) return out;
  const byId = new Map(targets.map((t) => [t.envelopeId, t]));
  const contacts = [...new Set(targets.map((t) => t.contactId))];
  const read = await ctx.store.transaction((tx) =>
    contacts.map((contactId) => ({
      keys: contactKeysTx(tx, contactId),
      acks: tx.select(
        'envelopes',
        { direction: 'in', contact_id: contactId, state: 'ok', type: 'ack', deleted_at: null },
        {
          orderBy: [
            ['created_at', 'desc'],
            ['envelope_id', 'asc'],
          ],
          limit: MAX_ACKS_SCANNED,
        },
      ),
    })),
  );
  for (const { keys, acks } of read) {
    for (const ack of acks) {
      const payload = await openAck(ctx, ack);
      const replyTo = payload?.replyTo;
      if (payload === undefined || typeof replyTo !== 'string') continue;
      const target = byId.get(replyTo);
      if (target === undefined || target.contactId !== ack.contact_id) continue;
      const strength = classifyAck({
        payload,
        fromKey: ack.from_key,
        contactKeys: keys,
        envelopeId: target.envelopeId,
        envelopeHash: target.envelopeHash,
      });
      if (strength === undefined) continue;
      const prior = out.get(target.envelopeId);
      if (
        prior === undefined ||
        (prior.strength === 'older_app' && strength === 'verified') ||
        (prior.strength === strength && ack.created_at < prior.at)
      ) {
        out.set(target.envelopeId, { strength, at: ack.created_at, row: ack });
      }
    }
  }
  return out;
}

export class DeliveryAcks {
  readonly #ctx: CoreContext;
  readonly #deps: DeliveryAcksDeps;
  /**
   * False only when the runtime turned acks off for this client. The owner's switch is the signed
   * policy (`receipts.sendReceived`, D-156), read once per pass.
   */
  readonly enabled: boolean;

  constructor(ctx: CoreContext, deps: DeliveryAcksDeps, enabled: boolean) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.enabled = enabled;
  }

  /**
   * Stages one ack for each new message in `reports` (outcome `ok`, from an active contact) that
   * has none yet. Never throws: a failure skips that ack and is counted in the log. Returns the
   * number of acks staged for the outbox; nothing is published here. Does nothing while acks are
   * off.
   */
  async sendFor(reports: readonly InboundReport[]): Promise<number> {
    if (!this.enabled) return 0;
    const ids = [
      ...new Set(
        reports
          .filter((r) => r.outcome === 'ok' && r.contactId !== undefined)
          .map((r) => r.envelopeId)
          .filter((id): id is string => id !== undefined),
      ),
    ];
    if (ids.length === 0) return 0;
    let policy: Awaited<ReturnType<OwnerActions['loadPolicy']>>;
    try {
      policy = await this.#deps.ownerActions.loadPolicy();
    } catch {
      return 0;
    }
    // The owner's "Send received receipts" switch (D-156); a policy that fails closed sends none.
    if (policy.mode === 'fail_closed' || !sendReceivedOf(policy.policy)) return 0;
    const rows = await this.#ctx.store
      .transaction((tx) => ids.map((id) => tx.get('envelopes', { envelope_id: id })))
      .catch(() => []);
    // SEC-RESTORE-GUARD: a message sent before a restore of this ID gets no ack (an earlier copy of
    // this ID may have acknowledged it already); an unreadable mark acknowledges nothing.
    const restore = await readRestoreState(this.#ctx);
    const eligible: Row<'envelopes'>[] = [];
    for (const row of rows) {
      if (
        row !== undefined &&
        !restoredReplay(restore, row.created_at) &&
        row.direction === 'in' &&
        row.state === 'ok' &&
        row.contact_id !== null &&
        INBOX_TYPES.includes(row.type)
      ) {
        eligible.push(row);
      }
    }
    let already: ReadonlySet<string>;
    try {
      already = await this.#alreadyAcked(eligible);
    } catch {
      return 0;
    }
    let sent = 0;
    let skipped = 0;
    for (const row of eligible) {
      if (already.has(row.envelope_id)) continue;
      if (sent >= MAX_ACKS_PER_PASS) {
        skipped += 1;
        continue;
      }
      try {
        if (await this.#stage(row.contact_id as string, row, policy)) sent += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    if (sent > 0 || skipped > 0) this.#ctx.log.info('delivery acks', { sent, skipped });
    return sent;
  }

  /**
   * The inbound envelopes among `rows` this agent already acknowledged (one ack per message): its
   * own outbound acks to each contact since shortly before the earliest of them was stored here,
   * read once per contact.
   */
  async #alreadyAcked(rows: readonly Row<'envelopes'>[]): Promise<ReadonlySet<string>> {
    const done = new Set<string>();
    if (rows.length === 0) return done;
    const wanted = new Set(rows.map((r) => r.envelope_id));
    const own = await this.#ctx.store.transaction((tx) => {
      // From when this agent first stored each message (its seen row, our clock), never the
      // sender-chosen `createdAt`; a message without a seen row looks back from now.
      const now = nowOf(this.#ctx);
      const since = new Map<string, number>();
      for (const row of rows) {
        const c = row.contact_id as string;
        const stored =
          tx.get('seen', { kind: 'envelope', id: row.envelope_hash })?.first_seen_at ?? now;
        since.set(c, Math.min(since.get(c) ?? stored, stored));
      }
      return [...since].flatMap(([contactId, from]) =>
        tx
          .select(
            'envelopes',
            { direction: 'out', contact_id: contactId, type: 'ack' },
            {
              orderBy: [
                ['created_at', 'desc'],
                ['envelope_id', 'asc'],
              ],
              limit: MAX_ACKS_SCANNED,
            },
          )
          .filter((r) => r.created_at >= from - OWN_ACK_SKEW_SECONDS),
      );
    });
    for (const ack of own) {
      const replyTo = (await openAck(this.#ctx, ack))?.replyTo;
      if (typeof replyTo === 'string' && wanted.has(replyTo)) done.add(replyTo);
    }
    return done;
  }

  /**
   * Signs one ack and stores it staged for the outbox (07 §3.2): the envelope row `queued`, without
   * outbox rows, which the outbox pass adds (outbox.ts). False when the contact is not an active,
   * fully paired contact, or the policy refuses it.
   */
  async #stage(
    contactId: string,
    inbound: Row<'envelopes'>,
    policy: Awaited<ReturnType<OwnerActions['loadPolicy']>>,
  ): Promise<boolean> {
    const { identity, envelopes, outbox } = this.#deps;
    const isActive = (tx: StoreTx): boolean => {
      const contact = tx.get('contacts', { contact_id: contactId });
      // SEC-INVITE-CAPS: no ack to a contact that waits for the owner's Keep.
      return (
        contact?.status === 'active' &&
        contact.pairing === 'complete' &&
        contact.waiting_owner !== 1
      );
    };
    // Checked before anything is signed, and again in the writing transaction.
    if (!(await this.#ctx.store.transaction(isActive))) return false;
    outbox.requireTransport();
    await identity.assertCanSend();
    if (evaluate(policy, { kind: 'envelope.send', contact: contactId, sizeBytes: 0 }) !== 'allow') {
      return false;
    }
    // 04 §3.4: a proof-carrying envelope's ack names its record (the verified record this agent
    // stored for it from the contact's `proof` body).
    const recordId = await this.#ctx.store.transaction((tx) =>
      tx
        .select('proofs', { envelope_id: inbound.envelope_id, status: 'received' })
        .map((r) => r.record_id)
        .find((id) => HASH.test(id)),
    );
    const { row } = await envelopes.prepare({
      to: { contact: contactId },
      payload: ackPayload(inbound.envelope_id, inbound.envelope_hash, recordId),
      // D-156: the signed time is rounded down to the minute; the outbox adds the 5–90 s delay.
      roundCreatedAt: true,
    });
    const size = encodeUtf8(row.envelope_json ?? '').length;
    if (
      evaluate(policy, { kind: 'envelope.send', contact: contactId, sizeBytes: size }) !== 'allow'
    ) {
      return false;
    }
    await this.#ctx.store.transaction((tx) => {
      if (!isActive(tx)) {
        throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
      }
      // Staged: `queued` with no outbox rows (07 §3.2); never published from here (F04 b).
      tx.insert('envelopes', { ...row, delivery: 'queued' });
    });
    return true;
  }

  /**
   * SEC-RECEIPTS-DEFAULT (11 §5.10): whether the "received receipts are now on" note is still due
   * for an AI app: the owner's rule sends them (absent reads as on), this agent has an active
   * contact, and it has not sent any ack yet. Store only; false when anything cannot be read.
   */
  async noticeDue(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const policy = await this.#deps.ownerActions.loadPolicy();
      if (policy.mode === 'fail_closed' || !sendReceivedOf(policy.policy)) return false;
      return await this.#ctx.store.transaction(
        (tx) =>
          tx.count('envelopes', { direction: 'out', type: 'ack' }) === 0 &&
          tx.count('contacts', { status: 'active' }) > 0,
      );
    } catch {
      return false;
    }
  }

  /**
   * Whether the contact acknowledged an outbound envelope, and how strongly. Reads the store only.
   * @throws CoreError `envelope_not_found` for an ID that is not an outbound envelope to a contact.
   */
  async status(envelopeId: string): Promise<DeliveryAckStatus> {
    const row = await this.#ctx.store.transaction((tx) => {
      const found = tx.get('envelopes', { envelope_id: envelopeId });
      return found === undefined || found.direction !== 'out' || found.contact_id === null
        ? undefined
        : found;
    });
    if (row === undefined || row.contact_id === null) {
      throw new CoreError('envelope_not_found', 'That message was not found.');
    }
    const found = (
      await acksFor(this.#ctx, [
        { envelopeId, envelopeHash: row.envelope_hash, contactId: row.contact_id },
      ])
    ).get(envelopeId);
    return {
      delivery: row.delivery,
      received: found !== undefined,
      verified: found?.strength === 'verified',
      receipt: found?.strength ?? null,
      ...(found === undefined ? {} : { receivedAt: found.at }),
    };
  }
}
