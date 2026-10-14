// Envelopes: build, receive and process (M1-7b; 04 §3.1–§3.4, §3.1.1 G-2, §3.3 G-46/D-66; 07 §3.2).
//
// Send (build): `identity.assertCanSend()` first; the payload passes its strict schema; the core
// picks the recipient set itself (04 §3.2 to a contact, §3.4.1 on the owner channel), one entry per
// distinct `enc` key; a fresh CEK seals the payload (key-committing AEAD) and is wrapped to every
// entry with the CEK-derived ephemeral key; the agent key signs envelopeHash; the JCS form is at most
// 24 576 bytes. The ciphertext envelope is stored as sent, the payload only in an `enc` column.
//
// Receive, in the order of 04 §3.1.1 (steps 1 and 2 are transport-nostr's):
// - `receive` runs steps 3 (strict parse) and 4 (signature) and stores the envelope as `received`
//   with its seen rows in one store transaction (07 §3.2). It returns `verified`, `processed` (a
//   final outcome: invalid, duplicate or refused duplicate) or `retry` (nothing written).
// - `processReceived` runs steps 5–9 for every `received` row, `card-update` first, and stores each
//   outcome (`ok`, `request`, `refused`, held, dropped) in one store transaction with its effects.
//   Held envelopes are run again from step 5 at the start of each pass and whenever a `card-update`
//   is applied for their owner `kid`.
//
// Hard rules here: every crypto operation is a call into @agentlink/crypto (I-8). The CEK is held
// only until step 8 and wiped there, at the first failure, or when the envelope is held. Nothing
// from an inbound envelope (its text, its payload, its keys) goes into an error, a log line or a
// report beyond its validated envelope ID (I-5, I-7). Reports carry fixed reason codes only.
import {
  AEAD_CT_MAX_LENGTH,
  AEAD_TAG_LENGTH,
  ENVELOPE_ID_LENGTH,
  HPKE_ENC_LENGTH,
  THREAD_ID_LENGTH,
  WRAPPED_CEK_LENGTH,
  canonicalize,
  checkKeyCommitment,
  decodeBase64url,
  decodeHex0x,
  decodeUtf8,
  decryptPayload,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  encryptPayload,
  envelopeHash,
  generateCek,
  parseEnvelope,
  parseJson,
  randomBytes,
  verifyEnvelope,
  wipe,
  wrapCek,
  type AgentCard,
  type Envelope,
  type EnvelopeHeader,
  type EnvelopeRecipient,
  type JsonValue,
} from '@agentlink/crypto';
import {
  CLOCK_SKEW_SECONDS,
  MAX_ENVELOPE_BYTES,
  envelopeSchema,
  payloadSchema,
  type Payload,
  type PayloadType,
} from '@agentlink/types';
import { agentNostrKey } from './card.js';
import {
  HELD_RELEASE_SECONDS,
  MAX_HELD_PER_OWNER_KID,
  MAX_RECEIVED_ENVELOPES,
} from './constants.js';
import {
  screenInboundTx,
  type ContactBook,
  type InboundCard,
  type PreparedCardUpdate,
} from './contacts.js';
import { nowOf, seal, type CoreContext } from './context.js';
import { checkRecipientWrap, kidOf } from './envelope-wraps.js';
import { CoreError } from './errors.js';
import type { IdentityService } from './identity.js';
import type { Row } from './store/schema.js';
import type { StoreTx } from './store/store.js';

// --- Public types --------------------------------------------------------------------------------

/** Where an envelope goes: a contact (04 §3.2 set) or the agent's own owner (§3.4.1 set). */
export type EnvelopeDestination = { readonly contact: string } | { readonly owner: true };

export interface BuildEnvelopeInput {
  readonly to: EnvelopeDestination;
  /** `{type, body, replyTo, files}` (04 §3.4); checked against the strict payload schema. */
  readonly payload: unknown;
  /** A 16-byte thread id (base64url). Default: the replied-to envelope's thread, else the thread
   * already in use with that party, else a new one. */
  readonly thread?: string;
}

export interface BuiltEnvelope {
  /** The signed envelope; its JCS form is the rumor content (04 §3.1.1, §3.5). */
  readonly envelope: Envelope;
  /** `0x` + 64 lowercase hex (04 §2.4.1). */
  readonly envelopeHash: string;
  readonly thread: string;
  /** One Nostr key per gift wrap (04 §3.5), 64 lowercase hex, distinct, in recipient order. */
  readonly recipientNostrKeys: readonly string[];
}

/** An envelope from transport-nostr (M1-5a `unwrapGiftWrap`): its signature is not yet checked. */
export interface ReceiveInput {
  readonly envelope: unknown;
  /** The gift-wrap event id (64 lowercase hex), recorded in `seen` (07 §3.2). */
  readonly giftWrapId?: string;
}

/**
 * The handler result for the transport sync (M1-5c): `verified` stored as `received` with its seen
 * rows; `processed` a final outcome (it failed steps 3–4, which records nothing, or it is a
 * duplicate or a refused duplicate `id`, recorded as seen); `retry` nothing was written (store
 * error or the `received` cap), so a later sync may fetch it again.
 */
export type ReceiveStatus = 'verified' | 'processed' | 'retry';

export type InboundOutcome =
  'ok' | 'request' | 'held' | 'refused' | 'dropped' | 'duplicate' | 'deferred' | 'sent_copy';

/** Fixed reason codes (never inbound text). */
export type InboundReason =
  | 'invalid'
  | 'not_for_agent'
  | 'open_failed'
  | 'key_commitment'
  | 'payload_invalid'
  | 'blocked'
  | 'removed'
  | 'revoked'
  | 'owner_key_type'
  | 'owner_channel_type'
  | 'card_update_invalid'
  | 'held_owner_inactive'
  | 'superseded_key'
  | 'owner_entry_missing'
  | 'wrap_mismatch'
  | 'future_created_at'
  | 'duplicate_id'
  | 'unreadable';

export interface InboundReport {
  /** The validated envelope `id` (base64url, 16 bytes); absent when the envelope did not parse. */
  readonly envelopeId?: string;
  readonly outcome: InboundOutcome;
  readonly reason?: InboundReason;
  /** The contact the envelope is attributed to, when `from` is one of its keys. */
  readonly contactId?: string;
  /**
   * The contact signed entries that carry different keys, or reused an `id` (04 §3.1.1 steps 5, 8
   * and 9): the activity feed flags it. Never set for a sender that is not a contact.
   */
  readonly flagged: boolean;
}

export interface ReceiveResult {
  readonly status: ReceiveStatus;
  readonly report: InboundReport;
}

// --- Constants -----------------------------------------------------------------------------------

/** `envelopes.type` of a `received` row: its payload type is known only after step 6. */
export const UNOPENED_TYPE = 'unopened';

/** 04 §3.1.1 limits table: at most 7 recomputed seals for the step 8 wrap check. */
export const MAX_WRAP_CHECKS = 7;

/** Types whose `from` may be the agent's own owner key (04 §3.1.1 key table). */
const OWNER_KEY_TYPES: ReadonlySet<PayloadType> = new Set(['approval', 'policy', 'revoke']);
/** Owner-channel types an agent accepts from nobody but its own owner key (04 §3.4.1). */
const OWNER_CHANNEL_TYPES: ReadonlySet<PayloadType> = new Set([
  'approval-request',
  'approval',
  'policy',
]);
/** Pairing types: their receiver rules are M1-7c (04 §3.6). */
const PAIRING_TYPES: ReadonlySet<PayloadType> = new Set(['handshake', 'handshake-ack']);
/**
 * Accepted types whose effects later cards implement (M1-7c pairing, M1-7d/M1-7e approvals and
 * policies, M1-7h revoke). Steps 5–9 run; the row then stays `received` for that handler.
 */
const DEFERRED_TYPES: ReadonlySet<PayloadType> = new Set([
  ...PAIRING_TYPES,
  'approval',
  'policy',
  'revoke',
]);
/** Types the agent key never signs (04 §3.1.1 key table: owner-authored). */
const OWNER_AUTHORED_TYPES: ReadonlySet<PayloadType> = new Set(['approval', 'revoke']);
/** Types the agent sends on its owner channel (04 §3.4.1). */
const AGENT_OWNER_CHANNEL_TYPES: ReadonlySet<PayloadType> = new Set([
  'approval-request',
  'policy',
  'card-update',
]);

const HEX64 = /^[0-9a-f]{64}$/;

// --- Internal types ------------------------------------------------------------------------------

/** The agent's own keys at every epoch and its owner's keys from its current card. */
interface OwnKeys {
  /** kid (base64url) → epoch of the agent's own `enc` keys, every epoch up to the KeyStore's. */
  readonly agentKids: ReadonlyMap<string, number>;
  readonly agentNostr: ReadonlySet<string>;
  readonly ownerEnc: Uint8Array;
  readonly ownerKid: string;
  readonly ownerNostr: string;
}

/** The contacts' current cards, indexed for steps 7 and 8. */
interface Book {
  readonly byId: ReadonlyMap<string, InboundCard>;
  /** Contact owner Nostr keys (64 hex): the key table drops other types from them. */
  readonly ownerNostr: ReadonlySet<string>;
  /** Owner `kid` (base64url) → the contacts whose card names that `ownerEnc`. */
  readonly byOwnerKid: ReadonlyMap<string, readonly InboundCard[]>;
}

/** One envelope to process: a `received` row, or a held row run again (07 §3.2). */
interface Item {
  readonly envelopeId: string;
  readonly envelopeHash: string;
  readonly envelopeJson: string;
  readonly source: 'received' | 'held';
  readonly releaseAt?: number;
}

/** An envelope that passed steps 5 and 6. Owns `cek` until step 8 (or the first failure). */
interface Opened {
  readonly item: Item;
  readonly envelope: Envelope;
  readonly id: Uint8Array;
  cek: Uint8Array | undefined;
  readonly payload: Payload;
  readonly payloadText: string;
}

type Final =
  | { readonly kind: 'drop'; readonly reason: InboundReason; readonly contactId?: string }
  | {
      readonly kind: 'refuse';
      readonly reason: InboundReason;
      readonly contactId?: string;
      readonly flagged: boolean;
    };

type Disposition =
  | Final
  | {
      readonly kind: 'accept';
      readonly state: 'ok' | 'request' | 'sent_copy';
      readonly contactId?: string;
      readonly senderCard?: AgentCard;
      readonly cardUpdate?: PreparedCardUpdate;
    }
  | { readonly kind: 'deferred'; readonly contactId?: string; readonly senderCard?: AgentCard }
  | { readonly kind: 'hold'; readonly ownerKid: string }
  | { readonly kind: 'keep_held' };

const report = (
  envelopeId: string | undefined,
  outcome: InboundOutcome,
  extra: { reason?: InboundReason; contactId?: string; flagged?: boolean } = {},
): InboundReport => ({
  ...(envelopeId === undefined ? {} : { envelopeId }),
  outcome,
  ...(extra.reason === undefined ? {} : { reason: extra.reason }),
  ...(extra.contactId === undefined ? {} : { contactId: extra.contactId }),
  flagged: extra.flagged ?? false,
});

const bytesOf = (hex0x: string): Uint8Array => decodeHex0x(hex0x, { length: 32 });

function wipeCek(opened: Opened): void {
  if (opened.cek !== undefined) {
    wipe(opened.cek);
    opened.cek = undefined;
  }
}

// --- Service -------------------------------------------------------------------------------------

export class EnvelopeService {
  readonly #ctx: CoreContext;
  readonly #identity: IdentityService;
  readonly #contacts: ContactBook;

  constructor(ctx: CoreContext, identity: IdentityService, contacts: ContactBook) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#contacts = contacts;
  }

  // --- Send --------------------------------------------------------------------------------------

  /**
   * Builds, signs and stores an outbound envelope (04 §3.1–§3.4). The core chooses the recipient
   * set; the caller never supplies keys. Publishing (gift wraps, outbox) is the send flow's.
   */
  async build(input: BuildEnvelopeInput): Promise<BuiltEnvelope> {
    const ctx = this.#ctx;
    await this.#identity.assertCanSend();
    const parsed = payloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new CoreError('payload_invalid', 'The message content is not valid.');
    }
    const payload = parsed.data;
    const toOwner = 'owner' in input.to && input.to.owner === true;
    const contactId = toOwner ? undefined : (input.to as { readonly contact: string }).contact;
    if (
      OWNER_AUTHORED_TYPES.has(payload.type) ||
      PAIRING_TYPES.has(payload.type) ||
      (toOwner && !AGENT_OWNER_CHANNEL_TYPES.has(payload.type)) ||
      (!toOwner && OWNER_CHANNEL_TYPES.has(payload.type))
    ) {
      throw new CoreError('type_not_sendable', 'This message type cannot be sent this way.');
    }

    const self = await this.#identity.get();
    if (self === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
    }
    const bundle = await ctx.keyStore.getPublicBundle();
    const ownCard = self.card;
    // A card-update announces this agent's own card, never another one (04 §3.4.1).
    if (payload.type === 'card-update' && payload.body.card.agentEvm !== self.agentId) {
      throw new CoreError('payload_invalid', 'The message content is not valid.');
    }
    const parties: { readonly enc: Uint8Array; readonly nostr: string }[] = [];
    if (contactId !== undefined) {
      const contact = await this.#contacts.get(contactId);
      if (contact.status !== 'active' || contact.pairing !== 'complete') {
        throw new CoreError('contact_not_active', 'That contact cannot receive messages now.');
      }
      // 04 §3.2: recipient agent, recipient owner, sender owner, sender agent.
      parties.push(
        { enc: bytesOf(contact.card.agentEnc), nostr: agentNostrKey(contact.card) },
        { enc: bytesOf(contact.card.ownerEnc), nostr: contact.card.ownerNostr.slice(2) },
      );
    }
    parties.push(
      { enc: bytesOf(ownCard.ownerEnc), nostr: ownCard.ownerNostr.slice(2) },
      { enc: bundle.agentEnc, nostr: encodeHex(bundle.agentNostr) },
    );
    // One entry per distinct `enc` key, one gift wrap per distinct Nostr key (04 §3.1.1, §3.5).
    const encKeys: Uint8Array[] = [];
    const seenEnc = new Set<string>();
    const nostrKeys: string[] = [];
    for (const party of parties) {
      const hex = encodeHex(party.enc);
      if (!seenEnc.has(hex)) {
        seenEnc.add(hex);
        encKeys.push(party.enc);
      }
      if (!nostrKeys.includes(party.nostr)) nostrKeys.push(party.nostr);
    }

    const thread = await this.#threadFor(input, payload, contactId);
    const now = nowOf(ctx);
    const id = randomBytes(ENVELOPE_ID_LENGTH);
    const payloadText = canonicalize(payload as unknown as JsonValue);
    const plaintext = encodeUtf8(payloadText);
    // 04 §3.1.1 limits: `ct` is at most AEAD_CT_MAX_LENGTH bytes (plaintext plus the 16-byte tag).
    if (plaintext.length + AEAD_TAG_LENGTH > AEAD_CT_MAX_LENGTH) {
      throw new CoreError('envelope_too_large', 'The message is too large to send.');
    }
    const cek = generateCek();
    let unsigned: Omit<Envelope, 'sig'>;
    try {
      const recipients: EnvelopeRecipient[] = [];
      for (const pk of encKeys) {
        const wrapped = await wrapCek(pk, id, cek);
        recipients.push({
          kid: kidOf(pk),
          enc: encodeBase64url(wrapped.enc),
          wk: encodeBase64url(wrapped.wk),
        });
      }
      const header: EnvelopeHeader = {
        v: 1,
        id: encodeBase64url(id),
        thread,
        from: encodeHex(bundle.agentNostr),
        createdAt: now,
        recipients,
      };
      const aead = await encryptPayload(header, cek, plaintext);
      unsigned = { ...header, aead };
    } finally {
      wipe(cek);
    }
    const hash = envelopeHash(unsigned);
    const envelope = parseEnvelope({ ...unsigned, sig: await ctx.keyStore.signEnvelopeHash(hash) });
    const envelopeJson = canonicalize(envelope as unknown as JsonValue);
    if (encodeUtf8(envelopeJson).length > MAX_ENVELOPE_BYTES) {
      throw new CoreError('envelope_too_large', 'The message is too large to send.');
    }
    const hashHex = encodeHex0x(hash);
    const sealed = await seal(ctx, 'envelopes', 'payload_json', [envelope.id], payloadText);
    await ctx.store.transaction((tx) => {
      tx.insert('envelopes', {
        envelope_id: envelope.id,
        envelope_hash: hashHex,
        thread_id: thread,
        direction: 'out',
        contact_id: contactId ?? null,
        from_key: envelope.from,
        type: payload.type,
        state: 'ok',
        refused_reason: null,
        created_at: now,
        envelope_json: envelopeJson,
        payload_json: sealed,
        read_at: null,
        delivery: 'queued',
      });
    });
    return { envelope, envelopeHash: hashHex, thread, recipientNostrKeys: nostrKeys };
  }

  /** The thread: given, the replied-to envelope's, the one in use with that party, or a new one. */
  async #threadFor(
    input: BuildEnvelopeInput,
    payload: Payload,
    contactId: string | undefined,
  ): Promise<string> {
    if (input.thread !== undefined) {
      try {
        decodeBase64url(input.thread, { length: THREAD_ID_LENGTH });
      } catch {
        throw new CoreError('thread_invalid', 'The thread ID is not valid.');
      }
      return input.thread;
    }
    const existing = await this.#ctx.store.transaction((tx) => {
      const party = { contact_id: contactId ?? null, state: 'ok' as const };
      if (payload.replyTo !== null) {
        const replied = tx.get('envelopes', { envelope_id: payload.replyTo });
        if (replied?.contact_id === party.contact_id && replied.state === 'ok') {
          return replied.thread_id;
        }
      }
      const where =
        contactId === undefined
          ? { ...party, direction: 'out' as const, type: { in: [...AGENT_OWNER_CHANNEL_TYPES] } }
          : party;
      return tx.select('envelopes', where, {
        orderBy: [
          ['created_at', 'desc'],
          ['envelope_id', 'asc'],
        ],
        limit: 1,
      })[0]?.thread_id;
    });
    return existing ?? encodeBase64url(randomBytes(THREAD_ID_LENGTH));
  }

  // --- Receive: steps 3 and 4 --------------------------------------------------------------------

  /**
   * Steps 3 (strict parse) and 4 (signature), then stores the envelope as `received` with its seen
   * rows in one store transaction (07 §3.2). An envelope that fails 3 or 4 writes nothing. An `id`
   * already stored with the same envelopeHash is a duplicate (dropped silently); with another hash
   * it is refused and, when `from` is a contact's key, the contact is flagged (step 9, 07 §3.2:
   * never an insert error). The seen rows are keyed on the gift-wrap id and on envelopeHash, never on
   * the sender-chosen `id` alone (IR-M1-5a-1 L-3).
   */
  async receive(input: ReceiveInput): Promise<ReceiveResult> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(input.envelope);
      if (!envelopeSchema.safeParse(envelope).success) throw new Error('shape');
      // Step 4: BIP-340 under `from`, envelope tag only.
      if (!verifyEnvelope(envelope)) throw new Error('signature');
    } catch {
      return { status: 'processed', report: report(undefined, 'dropped', { reason: 'invalid' }) };
    }
    const hashHex = encodeHex0x(envelopeHash(envelope));
    const envelopeJson = canonicalize(envelope as unknown as JsonValue);
    const wrapId =
      typeof input.giftWrapId === 'string' && HEX64.test(input.giftWrapId)
        ? input.giftWrapId
        : undefined;
    try {
      const now = nowOf(this.#ctx);
      return await this.#ctx.store.transaction((tx): ReceiveResult => {
        const markSeen = (): void => {
          if (wrapId !== undefined && tx.get('seen', { kind: 'wrap', id: wrapId }) === undefined) {
            tx.insert('seen', { kind: 'wrap', id: wrapId, first_seen_at: now });
          }
          if (tx.get('seen', { kind: 'envelope', id: hashHex }) === undefined) {
            tx.insert('seen', { kind: 'envelope', id: hashHex, first_seen_at: now });
          }
        };
        const stored =
          tx.get('envelopes', { envelope_id: envelope.id }) ??
          tx.get('held_envelopes', { envelope_id: envelope.id });
        if (stored !== undefined) {
          if (stored.envelope_hash === hashHex) {
            markSeen();
            return { status: 'processed', report: report(envelope.id, 'duplicate') };
          }
          if (stored.from_key !== envelope.from) {
            // Another key's envelope holds this id (IR-M1-5a-1 L-3): it must not suppress this one.
            // Nothing is recorded, so a later sync offers it again once that row is gone.
            return { status: 'retry', report: report(envelope.id, 'deferred') };
          }
          // Step 9: the same sender signed two envelopes under one id.
          markSeen();
          const screen = screenInboundTx(tx, envelope.from);
          const contactId =
            screen.action === 'continue' && screen.sender.kind !== 'unknown'
              ? screen.sender.contactId
              : undefined;
          return {
            status: 'processed',
            report: report(envelope.id, 'refused', {
              reason: 'duplicate_id',
              ...(contactId === undefined ? {} : { contactId }),
              flagged: contactId !== undefined,
            }),
          };
        }
        if (tx.count('envelopes', { state: 'received' }) >= MAX_RECEIVED_ENVELOPES) {
          return { status: 'retry', report: report(envelope.id, 'deferred') };
        }
        tx.insert('envelopes', {
          envelope_id: envelope.id,
          envelope_hash: hashHex,
          thread_id: envelope.thread,
          direction: 'in',
          contact_id: null,
          from_key: envelope.from,
          type: UNOPENED_TYPE,
          state: 'received',
          refused_reason: null,
          created_at: envelope.createdAt,
          envelope_json: envelopeJson,
          payload_json: null,
          read_at: null,
          delivery: null,
        });
        markSeen();
        return { status: 'verified', report: report(envelope.id, 'deferred') };
      });
    } catch {
      // Fail closed (07 §3.2): nothing is stored and nothing marked as seen.
      return { status: 'retry', report: report(envelope.id, 'deferred') };
    }
  }

  // --- Process: steps 5 to 9 ---------------------------------------------------------------------

  /**
   * One processing pass (07 §3.2): held rows that can move first, then every `received` row, with
   * `card-update` envelopes before any other (04 §3.1.1 step 7). Each applied `card-update` runs
   * the held rows of that contact's owner `kid` again from step 5. Returns one report per envelope
   * whose state changed or that a later card handles (`deferred`).
   */
  async processReceived(): Promise<InboundReport[]> {
    const ctx = this.#ctx;
    const own = await this.#ownKeys();
    let book = await this.#book();
    const reports: InboundReport[] = [];
    reports.push(...(await this.#runHeld(own, book)));

    const rows = await ctx.store.transaction((tx) =>
      tx.select(
        'envelopes',
        { state: 'received', direction: 'in' },
        {
          orderBy: [
            ['created_at', 'asc'],
            ['envelope_id', 'asc'],
          ],
          limit: MAX_RECEIVED_ENVELOPES,
        },
      ),
    );
    const opened: Opened[] = [];
    try {
      for (const row of rows) {
        const item: Item = {
          envelopeId: row.envelope_id,
          envelopeHash: row.envelope_hash,
          envelopeJson: row.envelope_json ?? '',
          source: 'received',
        };
        const result = await this.#open(item, own);
        if ('kind' in result) {
          const done = await this.#settle(item, result);
          if (done !== undefined) reports.push(done);
        } else {
          opened.push(result);
        }
      }
      // Step 7, arrival order: every card-update of this pass before any other envelope.
      const ordered = [
        ...opened.filter((o) => o.payload.type === 'card-update'),
        ...opened.filter((o) => o.payload.type !== 'card-update'),
      ];
      for (const o of ordered) {
        const { report: done, applied } = await this.#decide(o, own, book);
        if (done !== undefined) reports.push(done);
        if (applied !== undefined) {
          book = await this.#book();
          reports.push(...(await this.#runHeld(own, book, kidOf(bytesOf(applied.ownerEnc)))));
        }
      }
    } finally {
      for (const o of opened) wipeCek(o);
    }
    return reports;
  }

  /**
   * Held rows (04 §3.1.1 step 7, 07 §3.2): each one whose `from` is now a blocked, removed or
   * revoked key is dropped; one whose `from` is now a contact's current key, or that is due
   * (release_at), runs again from step 5 with exactly one `unwrapCek`. The rest stay held.
   */
  async #runHeld(own: OwnKeys, book: Book, ownerKid?: string): Promise<InboundReport[]> {
    const now = nowOf(this.#ctx);
    const candidates = await this.#ctx.store.transaction((tx) =>
      tx
        .select('held_envelopes', ownerKid === undefined ? {} : { owner_kid: ownerKid }, {
          orderBy: [
            ['received_at', 'asc'],
            ['envelope_id', 'asc'],
          ],
        })
        .map((row) => ({ row, screen: screenInboundTx(tx, row.from_key) })),
    );
    const reports: InboundReport[] = [];
    for (const { row, screen } of candidates) {
      const item: Item = {
        envelopeId: row.envelope_id,
        envelopeHash: row.envelope_hash,
        envelopeJson: row.envelope_json,
        source: 'held',
        releaseAt: row.release_at,
      };
      const claimed = screen.action === 'continue' && screen.sender.kind === 'contact';
      if (screen.action === 'continue' && !claimed && row.release_at > now) continue;
      const result = await this.#open(item, own);
      if ('kind' in result) {
        const done = await this.#settle(item, result);
        if (done !== undefined) reports.push(done);
        continue;
      }
      try {
        const { report: done } = await this.#decide(result, own, book);
        if (done !== undefined) reports.push(done);
      } finally {
        wipeCek(result);
      }
    }
    return reports;
  }

  /** The agent's own keys at every KeyStore epoch, and its owner's keys from its stored card. */
  async #ownKeys(): Promise<OwnKeys> {
    const self = await this.#identity.get();
    if (self === undefined) {
      throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
    }
    const current = await this.#ctx.keyStore.getPublicBundle();
    const agentKids = new Map<string, number>();
    const agentNostr = new Set<string>();
    for (let epoch = 0; epoch <= current.keyEpoch; epoch += 1) {
      const bundle = await this.#ctx.keyStore.getPublicBundle({ epoch });
      agentKids.set(encodeBase64url(bundle.kid), epoch);
      agentNostr.add(encodeHex(bundle.agentNostr));
    }
    const ownerEnc = bytesOf(self.card.ownerEnc);
    return {
      agentKids,
      agentNostr,
      ownerEnc,
      ownerKid: kidOf(ownerEnc),
      ownerNostr: self.card.ownerNostr.slice(2),
    };
  }

  async #book(): Promise<Book> {
    const cards = await this.#contacts.inboundCards();
    const byId = new Map<string, InboundCard>();
    const ownerNostr = new Set<string>();
    const byOwnerKid = new Map<string, InboundCard[]>();
    for (const c of cards) {
      byId.set(c.id, c);
      ownerNostr.add(c.card.ownerNostr.slice(2));
      const kid = kidOf(bytesOf(c.card.ownerEnc));
      byOwnerKid.set(kid, [...(byOwnerKid.get(kid) ?? []), c]);
    }
    return { byId, ownerNostr, byOwnerKid };
  }

  /**
   * Steps 5 and 6. Step 5: the entry whose `kid` is one of the agent's own `enc` keys, at the
   * highest matching epoch, opened with exactly one `unwrapCek`; the `kc` check before AES-GCM.
   * A `kc` mismatch (the commitment check fails) is told apart from a failed tag only here, through
   * the separate commitment check; `decryptPayload` reports both as `open_failed`. Step 6: the
   * payload's strict schema. On success the CEK stays in the result for step 8.
   */
  async #open(item: Item, own: OwnKeys): Promise<Opened | Final> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(parseJson(item.envelopeJson));
    } catch {
      return { kind: 'drop', reason: 'unreadable' };
    }
    const id = decodeBase64url(envelope.id, { length: ENVELOPE_ID_LENGTH });
    let pick: { readonly entry: EnvelopeRecipient; readonly epoch: number } | undefined;
    for (const entry of envelope.recipients) {
      const epoch = own.agentKids.get(entry.kid);
      if (epoch !== undefined && (pick === undefined || epoch > pick.epoch)) {
        pick = { entry, epoch };
      }
    }
    if (pick === undefined) return { kind: 'drop', reason: 'not_for_agent' };
    let cek: Uint8Array;
    try {
      cek = await this.#ctx.keyStore.unwrapCek(
        {
          enc: decodeBase64url(pick.entry.enc, { length: HPKE_ENC_LENGTH }),
          wk: decodeBase64url(pick.entry.wk, { length: WRAPPED_CEK_LENGTH }),
        },
        id,
        { epoch: pick.epoch },
      );
    } catch {
      return { kind: 'drop', reason: 'open_failed' };
    }
    let keep = false;
    try {
      if (!checkKeyCommitment(envelope, cek)) {
        // Signature-valid (step 4) and a commitment its wrap for this agent does not carry.
        return { kind: 'refuse', reason: 'key_commitment', flagged: true };
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await decryptPayload(envelope, cek);
      } catch {
        return { kind: 'drop', reason: 'open_failed' };
      }
      let payloadText: string;
      let payload: Payload;
      try {
        payloadText = decodeUtf8(plaintext);
        const parsed = payloadSchema.safeParse(parseJson(payloadText));
        if (!parsed.success) return { kind: 'drop', reason: 'payload_invalid' };
        payload = parsed.data;
      } catch {
        return { kind: 'drop', reason: 'payload_invalid' };
      } finally {
        wipe(plaintext);
      }
      keep = true;
      return { item, envelope, id, cek, payload, payloadText };
    } finally {
      if (!keep) wipe(cek);
    }
  }

  /**
   * Steps 7, 8 and 9 for an opened envelope, then its outcome in one store transaction. Wipes the
   * CEK after step 8 (or at the first failure, or when the envelope is held). `applied` is the new
   * card when a `card-update` was applied.
   */
  async #decide(
    o: Opened,
    own: OwnKeys,
    book: Book,
  ): Promise<{ readonly report?: InboundReport | undefined; readonly applied?: AgentCard }> {
    const disposition = await this.#senderRole(o, own, book);
    if (disposition.kind === 'hold' || disposition.kind === 'keep_held') {
      wipeCek(o);
      if (disposition.kind === 'keep_held') return {};
      return { report: await this.#hold(o, disposition.ownerKid) };
    }
    if (disposition.kind === 'drop' || disposition.kind === 'refuse') {
      wipeCek(o);
      return { report: await this.#settle(o.item, disposition, o.envelope, o.payload.type) };
    }
    // Step 8.
    const step8 = await this.#wrapCheck(o, own, disposition.senderCard);
    wipeCek(o);
    if (step8 !== undefined) {
      const final: Final = {
        kind: 'refuse',
        reason: step8,
        ...(disposition.contactId === undefined ? {} : { contactId: disposition.contactId }),
        flagged: step8 === 'wrap_mismatch' && disposition.contactId !== undefined,
      };
      return { report: await this.#settle(o.item, final, o.envelope, o.payload.type) };
    }
    // Step 9: freshness (uniqueness was enforced when it was stored as `received`).
    const now = nowOf(this.#ctx);
    if (o.envelope.createdAt > now + CLOCK_SKEW_SECONDS) {
      const final: Final = {
        kind: 'refuse',
        reason: 'future_created_at',
        ...(disposition.contactId === undefined ? {} : { contactId: disposition.contactId }),
        flagged: false,
      };
      return { report: await this.#settle(o.item, final, o.envelope, o.payload.type) };
    }
    if (
      disposition.kind === 'deferred' ||
      (disposition.state !== 'sent_copy' && DEFERRED_TYPES.has(o.payload.type))
    ) {
      return {
        report: report(o.item.envelopeId, 'deferred', {
          ...(disposition.contactId === undefined ? {} : { contactId: disposition.contactId }),
        }),
      };
    }
    return this.#accept(o, disposition);
  }

  /** Step 7: the sender role the type requires, the key table and the arrival-order rule. */
  async #senderRole(o: Opened, own: OwnKeys, book: Book): Promise<Disposition> {
    const { envelope, payload } = o;
    const { from } = envelope;
    const type = payload.type;
    if (own.agentNostr.has(from)) {
      // The agent's own sent copy (04 §3.2 entry 4, §3.4.1 owner card-update): stored as sent,
      // never applied.
      return { kind: 'accept', state: 'sent_copy' };
    }
    if (from === own.ownerNostr) {
      return OWNER_KEY_TYPES.has(type)
        ? { kind: 'deferred' }
        : { kind: 'drop', reason: 'owner_key_type' };
    }
    const screen = await this.#ctx.store.transaction((tx) => screenInboundTx(tx, from));
    if (screen.action === 'drop') {
      return { kind: 'drop', reason: screen.reason === 'malformed' ? 'invalid' : screen.reason };
    }
    const sender = screen.sender;
    if (type === 'revoke') {
      // Authority comes from the carried SignedOwnerAction, whatever the `from` (M1-7h).
      return {
        kind: 'deferred',
        ...(sender.kind === 'unknown' ? {} : { contactId: sender.contactId }),
      };
    }
    if (book.ownerNostr.has(from)) return { kind: 'drop', reason: 'owner_key_type' };
    if (OWNER_CHANNEL_TYPES.has(type)) return { kind: 'drop', reason: 'owner_channel_type' };

    if (sender.kind !== 'unknown') {
      const contactId = sender.contactId;
      if (type === 'card-update') return this.#cardUpdate(o, contactId);
      if (sender.kind === 'superseded') {
        return { kind: 'refuse', reason: 'superseded_key', contactId, flagged: false };
      }
      const senderCard = book.byId.get(contactId)?.card;
      if (senderCard === undefined) return { kind: 'drop', reason: 'unreadable' };
      return PAIRING_TYPES.has(type)
        ? { kind: 'deferred', contactId, senderCard }
        : { kind: 'accept', state: 'ok', contactId, senderCard };
    }

    // Unknown key. A card-update from the new key of a stored contact: authority from cardSig.
    if (type === 'card-update') {
      const named = book.byId.get(payload.body.card.agentEvm);
      if (named !== undefined && agentNostrKey(named.card) !== from) {
        const bodyKey = payload.body.card.agentNostr.slice(2);
        if (bodyKey === from) {
          if (named.status !== 'active') return { kind: 'drop', reason: named.status };
          return this.#cardUpdate(o, named.id);
        }
      }
    }
    if (PAIRING_TYPES.has(type)) return { kind: 'deferred' };
    // Arrival order: a stored contact owner's `kid` among the recipients holds it. A kid of a
    // blocked, removed or revoked contact's owner drops it (IR-M1-7a-1 R2-M1).
    const kids = new Set(envelope.recipients.map((r) => r.kid));
    const matches: InboundCard[] = [];
    for (const [kid, cards] of book.byOwnerKid) if (kids.has(kid)) matches.push(...cards);
    if (matches.some((c) => c.status !== 'active')) {
      return { kind: 'drop', reason: 'held_owner_inactive' };
    }
    const first = matches[0];
    if (first !== undefined) {
      const now = nowOf(this.#ctx);
      if (o.item.source === 'held') {
        if ((o.item.releaseAt ?? 0) > now) return { kind: 'keep_held' };
        return { kind: 'accept', state: 'request' };
      }
      return { kind: 'hold', ownerKid: kidOf(bytesOf(first.card.ownerEnc)) };
    }
    return { kind: 'accept', state: 'request' };
  }

  /** A card-update for `contactId`: §3.4.1 through ContactBook; its card is the step 8 sender card. */
  async #cardUpdate(o: Opened, contactId: string): Promise<Disposition> {
    if (o.payload.type !== 'card-update' || o.payload.body.card.agentEvm !== contactId) {
      return { kind: 'drop', reason: 'card_update_invalid', contactId };
    }
    try {
      const prepared = await this.#contacts.prepareCardUpdate(o.payload.body);
      return {
        kind: 'accept',
        state: 'ok',
        contactId,
        senderCard: prepared.card,
        cardUpdate: prepared,
      };
    } catch (error) {
      if (error instanceof CoreError && error.code !== 'store_unreadable') {
        return { kind: 'drop', reason: 'card_update_invalid', contactId };
      }
      throw error;
    }
  }

  /**
   * Step 8: the own owner's entry must be present, and it, plus the sender's agent and owner
   * entries when the sender's card is held, must be the wrap of this CEK byte for byte (§3.3).
   * Entries for keys the core does not hold are not checked. At most MAX_WRAP_CHECKS seals.
   */
  async #wrapCheck(
    o: Opened,
    own: OwnKeys,
    senderCard: AgentCard | undefined,
  ): Promise<InboundReason | undefined> {
    const cek = o.cek;
    if (cek === undefined) return 'open_failed';
    const ownerEntry = o.envelope.recipients.find((r) => r.kid === own.ownerKid);
    if (ownerEntry === undefined) return 'owner_entry_missing';
    const checks: { readonly pk: Uint8Array; readonly entry: EnvelopeRecipient }[] = [
      { pk: own.ownerEnc, entry: ownerEntry },
    ];
    const checked = new Set([own.ownerKid]);
    if (senderCard !== undefined) {
      for (const pk of [bytesOf(senderCard.agentEnc), bytesOf(senderCard.ownerEnc)]) {
        const kid = kidOf(pk);
        if (checked.has(kid)) continue;
        checked.add(kid);
        const entry = o.envelope.recipients.find((r) => r.kid === kid);
        if (entry !== undefined) checks.push({ pk, entry });
      }
    }
    let ok = true;
    for (const { pk, entry } of checks.slice(0, MAX_WRAP_CHECKS)) {
      // Every check runs, so the time taken does not show which entry differed.
      if (!(await checkRecipientWrap(pk, entry, o.id, cek))) ok = false;
    }
    return ok ? undefined : 'wrap_mismatch';
  }

  /** Stores an accepted envelope (`ok`, `request` or a sent copy) with its card-update, if any. */
  async #accept(
    o: Opened,
    d: Extract<Disposition, { kind: 'accept' }>,
  ): Promise<{ readonly report?: InboundReport | undefined; readonly applied?: AgentCard }> {
    const ctx = this.#ctx;
    const { item, envelope, payload } = o;
    const sealed = await seal(ctx, 'envelopes', 'payload_json', [item.envelopeId], o.payloadText);
    const row: Row<'envelopes'> = {
      envelope_id: item.envelopeId,
      envelope_hash: item.envelopeHash,
      thread_id: envelope.thread,
      direction: d.state === 'sent_copy' ? 'out' : 'in',
      contact_id: d.state === 'ok' ? (d.contactId ?? null) : null,
      from_key: envelope.from,
      type: payload.type,
      state: d.state === 'request' ? 'request' : 'ok',
      refused_reason: null,
      created_at: envelope.createdAt,
      envelope_json: item.envelopeJson,
      payload_json: sealed,
      read_at: null,
      delivery: null,
    };
    try {
      const done = await ctx.store.transaction((tx) => {
        if (!claim(tx, item)) return false;
        d.cardUpdate?.apply(tx);
        writeRow(tx, item, row);
        return true;
      });
      if (!done) return {};
    } catch (error) {
      if (d.cardUpdate !== undefined && error instanceof CoreError) {
        // The card-update broke a §3.4.1 rule at apply time: dropped, nothing applied.
        const final: Final = {
          kind: 'drop',
          reason: 'card_update_invalid',
          ...(d.contactId === undefined ? {} : { contactId: d.contactId }),
        };
        return { report: await this.#settle(item, final, envelope, o.payload.type) };
      }
      throw error;
    }
    const outcome: InboundOutcome =
      d.state === 'sent_copy' ? 'sent_copy' : d.state === 'request' ? 'request' : 'ok';
    return {
      report: report(item.envelopeId, outcome, {
        ...(d.state === 'ok' && d.contactId !== undefined ? { contactId: d.contactId } : {}),
      }),
      ...(d.cardUpdate === undefined ? {} : { applied: d.cardUpdate.card }),
    };
  }

  /** Moves a `received` row into the held pool (cap per owner kid, oldest dropped first). */
  async #hold(o: Opened, ownerKid: string): Promise<InboundReport | undefined> {
    const ctx = this.#ctx;
    const { item } = o;
    const now = nowOf(ctx);
    const sealed = await seal(
      ctx,
      'held_envelopes',
      'payload_json',
      [item.envelopeId],
      o.payloadText,
    );
    const done = await ctx.store.transaction((tx) => {
      if (!claim(tx, item)) return false;
      tx.delete('envelopes', { envelope_id: item.envelopeId });
      for (;;) {
        if (tx.count('held_envelopes', { owner_kid: ownerKid }) < MAX_HELD_PER_OWNER_KID) break;
        const oldest = tx.select(
          'held_envelopes',
          { owner_kid: ownerKid },
          {
            orderBy: [
              ['received_at', 'asc'],
              ['envelope_id', 'asc'],
            ],
            limit: 1,
          },
        )[0];
        if (oldest === undefined) break;
        tx.delete('held_envelopes', { envelope_id: oldest.envelope_id });
      }
      tx.insert('held_envelopes', {
        envelope_id: item.envelopeId,
        envelope_hash: item.envelopeHash,
        from_key: o.envelope.from,
        owner_kid: ownerKid,
        envelope_json: item.envelopeJson,
        payload_json: sealed,
        received_at: now,
        release_at: now + HELD_RELEASE_SECONDS,
      });
      return true;
    });
    return done ? report(item.envelopeId, 'held') : undefined;
  }

  /**
   * Stores a final drop or refusal. A drop deletes the row (its seen rows stay). A refusal keeps a
   * `refused` row without the ciphertext or the payload (07 §3). For a step 5 `kc` mismatch the
   * sender is classified here: from a blocked, removed or revoked key it is dropped, never stored;
   * a contact is flagged; a stranger is never flagged.
   */
  async #settle(
    item: Item,
    final: Final,
    parsed?: Envelope,
    type?: PayloadType,
  ): Promise<InboundReport | undefined> {
    const ctx = this.#ctx;
    let envelope = parsed;
    if (envelope === undefined && final.kind === 'refuse') {
      envelope = parseEnvelope(parseJson(item.envelopeJson));
    }
    const result = await ctx.store.transaction((tx) => {
      if (!claim(tx, item)) return undefined;
      let effective: Final = final;
      if (final.kind === 'refuse' && final.reason === 'key_commitment' && envelope !== undefined) {
        const screen = screenInboundTx(tx, envelope.from);
        if (screen.action === 'drop') {
          effective = {
            kind: 'drop',
            reason: screen.reason === 'malformed' ? 'invalid' : screen.reason,
          };
        } else if (screen.sender.kind === 'unknown') {
          effective = { kind: 'refuse', reason: 'key_commitment', flagged: false };
        } else {
          effective = {
            kind: 'refuse',
            reason: 'key_commitment',
            contactId: screen.sender.contactId,
            flagged: true,
          };
        }
      }
      if (effective.kind === 'drop' || envelope === undefined) {
        deleteRow(tx, item);
        return effective.kind === 'drop'
          ? report(item.envelopeId, 'dropped', {
              reason: effective.reason,
              ...(effective.contactId === undefined ? {} : { contactId: effective.contactId }),
            })
          : report(item.envelopeId, 'dropped', { reason: effective.reason });
      }
      writeRow(tx, item, {
        envelope_id: item.envelopeId,
        envelope_hash: item.envelopeHash,
        thread_id: envelope.thread,
        direction: 'in',
        contact_id: effective.contactId ?? null,
        from_key: envelope.from,
        type: type ?? UNOPENED_TYPE,
        state: 'refused',
        refused_reason: effective.reason,
        created_at: envelope.createdAt,
        envelope_json: null,
        payload_json: null,
        read_at: null,
        delivery: null,
      });
      return report(item.envelopeId, 'refused', {
        reason: effective.reason,
        ...(effective.contactId === undefined ? {} : { contactId: effective.contactId }),
        flagged: effective.flagged,
      });
    });
    return result;
  }
}

// --- Store helpers (inside one transaction) ------------------------------------------------------

/** True while the item is still where this pass found it, with the same envelopeHash. */
function claim(tx: StoreTx, item: Item): boolean {
  if (item.source === 'received') {
    const row = tx.get('envelopes', { envelope_id: item.envelopeId });
    return row?.state === 'received' && row.envelope_hash === item.envelopeHash;
  }
  const held = tx.get('held_envelopes', { envelope_id: item.envelopeId });
  return held?.envelope_hash === item.envelopeHash;
}

/** Writes the outcome row: updates the `received` row, or moves a held row into `envelopes`. */
function writeRow(tx: StoreTx, item: Item, row: Row<'envelopes'>): void {
  if (item.source === 'received') {
    const { envelope_id: envelopeId, ...patch } = row;
    if (tx.update('envelopes', { envelope_id: envelopeId, state: 'received' }, patch) !== 1) {
      throw new CoreError('store_unreadable', 'A stored envelope changed meanwhile.');
    }
    return;
  }
  tx.delete('held_envelopes', { envelope_id: item.envelopeId });
  if (tx.get('envelopes', { envelope_id: item.envelopeId }) !== undefined) {
    throw new CoreError('store_unreadable', 'A stored envelope changed meanwhile.');
  }
  tx.insert('envelopes', row);
}

function deleteRow(tx: StoreTx, item: Item): void {
  if (item.source === 'received') {
    tx.delete('envelopes', { envelope_id: item.envelopeId, state: 'received' });
  } else {
    tx.delete('held_envelopes', { envelope_id: item.envelopeId });
  }
}
