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
// Hard rules here: every crypto operation is a call into @4thtech-io/crypto (I-8). The CEK is held
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
  parseReceivedJson,
  parseEnvelopeText,
  randomBytes,
  verifyEnvelope,
  wipe,
  wrapCek,
  type AgentCard,
  type Envelope,
  type EnvelopeHeader,
  type EnvelopeRecipient,
  type JsonValue,
} from '@4thtech-io/crypto';
import {
  CLOCK_SKEW_SECONDS,
  MAX_ENVELOPE_BYTES,
  envelopeSchema,
  payloadSchema,
  type Payload,
  type PayloadType,
} from '@4thtech-io/types';
import { agentNostrKey } from './card.js';
import {
  HELD_RELEASE_SECONDS,
  MAX_HELD_PER_OWNER_KID,
  MAX_RECEIVED_ENVELOPES,
  TERMS_WAIT_SECONDS,
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
import { receivedFileRows } from './files/received.js';
import type { IdentityService } from './identity.js';
import { REQUESTS_FULL, isBlockedTx, pruneRefusedTx, requestsFullTx } from './requests.js';
import {
  isTermsType,
  termsBodyOf,
  type TermsAdmission,
  type TermsInboundHook,
} from './terms-store.js';
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
  /** The sender's card is held and the recipients lack its `ownerEnc` `kid` (G-51, D-71 (4)). */
  | 'sender_owner_entry_missing'
  | 'wrap_mismatch'
  | 'future_created_at'
  | 'duplicate_id'
  | 'unreadable'
  /** A type this build has no handler for from that sender (a revoke from an unknown key). */
  | 'type_unhandled'
  // Pairing (04 §3.6, §3.6.1; M1-7c). A drop keeps nothing; a refusal keeps a `refused` row.
  /** A `handshake` naming no invite this agent holds (dropped before any store write). */
  | 'invite_unknown'
  /** A `handshake` for an invite past its stored expiry. */
  | 'invite_expired'
  /** A second valid answer to a used invite: refused, and the owner is warned (04 §3.6). */
  | 'invite_used'
  /** A `handshake-ack` naming no pairing in progress from that key (dropped). */
  | 'pairing_unknown'
  /** A pairing message that fails a 04 §3.6 or §3.4.1 check (proof, sender key, card, binding). */
  | 'pairing_invalid'
  /** A valid pairing refused by the 04 §2.9 rules (revoked, owner keys changed, key in use, self). */
  | 'pairing_refused'
  /** A `handshake-ack` whose `codeReveal` does not open `codeCommit`: the pairing stays pending. */
  | 'safety_commit_mismatch'
  /** An owner-authored type (`approval`, `revoke`) signed by the agent's own key. */
  | 'agent_key_type'
  /** `receive` was given a gift-wrap id that is not 64 lowercase hex (a caller bug). */
  | 'wrap_id_invalid'
  /** The requests queue is at a limit for this unknown key or in total (07 §3.2; M1-7e). */
  | 'requests_full'
  /**
   * `from` is in the owner's blocked keys (D-72; 04 §3.1.1 step 5): dropped before any HPKE open,
   * or after step 6 for an envelope that skipped that drop and is neither held for a contact's key
   * change nor a contact's card-update (IR-D-72-1 F01, F10).
   */
  | 'sender_blocked'
  /** A `revoke` whose SignedOwnerAction does not verify against the named agent (04 §3.4.1). */
  | 'revoke_invalid'
  /** Above `contacts.rateLimitPerContactPerHour` for the sender's contact (07 §3.2). */
  | 'rate_limited'
  /**
   * An `offer`, `accept` or `reject` the negotiation chain refuses (04 §3.4: version gap, fork,
   * locked version, resend link, answer rules; M1-32). Stored as refused and shown in the activity
   * feed; a second envelope for a version from the same sender also flags the contact (rule 1).
   */
  | 'terms_refused'
  /**
   * With outcome `deferred`: an `offer` the chain cannot decide yet because a version it links to
   * has not arrived (M1-32-b). It stays `received` and is decided again in later passes; once the
   * wait lapses (TERMS_WAIT_SECONDS from its signed createdAt) it is refused with `terms_refused`.
   */
  | 'terms_waiting'
  /**
   * A `proof` envelope whose body does not match the on-chain record (04 §3.4 checks, M1-7g-c):
   * stored as refused after processing, and the contact is flagged. Reported by the proof service.
   */
  | 'proof_mismatch'
  /** As `proof_mismatch`, for a Record whose `parentRecordId` is another signer's (D-109). */
  | 'proof_parent_mismatch';

export interface InboundReport {
  /** The validated envelope `id` (base64url, 16 bytes); absent when the envelope did not parse. */
  readonly envelopeId?: string;
  readonly outcome: InboundOutcome;
  readonly reason?: InboundReason;
  /** The contact the envelope is attributed to, when `from` is one of its keys. */
  readonly contactId?: string;
  /**
   * The contact signed entries that carry different keys, or reused an `id` (04 §3.1.1 steps 5, 8
   * and 9), or sent a `proof` body that does not match the chain (04 §3.4): the activity feed flags
   * it. Never set for a sender that is not a contact.
   */
  readonly flagged: boolean;
  /** For an applied `revoke`: its activity line, counts only (07 §3.2, §3.4; M1-7h-b). */
  readonly revoke?: RevokeActivity;
}

/**
 * A `handshake` or `handshake-ack` that passed 04 §3.1.1 steps 3–9 (M1-7c). The pairing flow runs
 * the 04 §3.6 receiver rules and stores the outcome itself, inside one store transaction that
 * `claim`s the row first.
 */
export interface InboundPairing {
  readonly envelopeId: string;
  readonly envelopeHash: string;
  readonly envelopeJson: string;
  readonly envelope: Envelope;
  readonly payload: Payload;
  readonly payloadText: string;
  /** Set when `from` is a contact's current key (a re-pair). */
  readonly contactId?: string;
  /** True while the row is still where processing found it, with the same envelopeHash. */
  claim(tx: StoreTx): boolean;
  /** Writes the outcome row in place of the `received` row. */
  write(tx: StoreTx, row: Row<'envelopes'>): void;
}

/** The pairing flow's outcome: stored by the flow (`done`), or a drop or refusal stored here. */
export type PairingOutcome =
  | { readonly kind: 'done'; readonly report?: InboundReport }
  | { readonly kind: 'drop'; readonly reason: InboundReason; readonly contactId?: string }
  | {
      readonly kind: 'refuse';
      readonly reason: InboundReason;
      readonly contactId?: string;
      readonly flagged: boolean;
    };

/** The pairing flow as the envelope pipeline sees it (M1-7c). */
export interface PairingHandler {
  /**
   * Inside a store transaction, before step 8: whether a pairing exists that this message could
   * belong to. A reason drops it at once, so a flood from strangers stores nothing (IR-M1-7b-1 M-1).
   */
  screen(tx: StoreTx, payload: Payload, from: string): InboundReason | undefined;
  handle(inbound: InboundPairing): Promise<PairingOutcome>;
}

export interface ReceiveResult {
  readonly status: ReceiveStatus;
  readonly report: InboundReport;
}

/**
 * What applying a `revoke` changed, for the activity feed (07 §3.2 "The activity feed reports it";
 * M1-7h-b): counts only, never an ID or anything from the envelope (I-7).
 */
export interface RevokeActivity {
  /** True when the own agent was revoked; otherwise the report's `contactId` was. */
  readonly self: boolean;
  /** `pending` outbox rows stopped as `not_delivered` with reason `revoked` (07 §3.2). */
  readonly outboxStopped: number;
  /** Pending approvals with that agent as counterparty, now `void` (04 §3.4.2 void rule 3). */
  readonly approvalsVoided: number;
  /** `unclaimed` or `claimed` commitment parts with that agent as counterparty, now `void`. */
  readonly partsVoided: number;
}

/**
 * A verified `revoke` (04 §3.4.1, 07 §3.4; M1-7h, M1-7h-b): `effect` runs inside the store
 * transaction that stores the revoke envelope. It returns `noop` when the agent is already revoked
 * (a re-published copy: nothing is stored), `stale` when an approval appeared that `prepare` could
 * not read (nothing is written; the row stays `received` for the next pass), or the activity.
 */
export interface PreparedRevoke {
  /** The revoked contact; absent when the own agent is revoked. */
  readonly contactId?: string;
  readonly effect: (tx: StoreTx) => RevokeActivity | 'noop' | 'stale';
}

/** The revocation flow as the envelope pipeline sees it (M1-7h). */
export interface RevokeHandler {
  /** Verifies the carried `agent.revoke`; a reason drops the envelope (fail closed). */
  prepare(payload: Payload): Promise<PreparedRevoke | { readonly reason: InboundReason }>;
}

/**
 * The per-contact rate limit (07 §3.2 `rate_counters`; M1-7h): `limit` is read once per processing
 * pass; `countTx` runs in the transaction that stores a contact's envelope (`ok` or `refused`) and
 * returns false when it would go above the limit, so the envelope is dropped instead.
 */
export interface RateLimitHook {
  limit(): Promise<number>;
  countTx(tx: StoreTx, contactId: string, limit: number, now: number): boolean;
}

/** Optional handlers of the processing pass. */
export interface EnvelopeHooks {
  readonly revocation?: RevokeHandler;
  readonly rateLimit?: RateLimitHook;
  /** The negotiation chain rules for a contact's `offer`, `accept` and `reject` (M1-32). */
  readonly terms?: TermsInboundHook;
}

// --- Constants -----------------------------------------------------------------------------------

/** `envelopes.type` of a `received` row: its payload type is known only after step 6. */
export const UNOPENED_TYPE = 'unopened';

/** `processReceived` opens and decides `received` rows in batches of this size (IR-M1-7b-1 L-5). */
export const PROCESS_BATCH = 50;

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
/** Pairing types: their receiver rules are the pairing flow's (M1-7c, 04 §3.6, §3.4.1). */
const PAIRING_TYPES: ReadonlySet<PayloadType> = new Set(['handshake', 'handshake-ack']);
/**
 * Accepted types whose effects later cards implement (M1-7d/M1-7e approvals and policies, M1-7h
 * revoke). Steps 5–9 run; the row then stays `received` for that handler.
 */
const DEFERRED_TYPES: ReadonlySet<PayloadType> = new Set(['approval', 'policy', 'revoke']);
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

/** A terms envelope waiting for a version it links to (M1-32-b): no plaintext, no key. */
interface Waiting {
  readonly item: Item;
  readonly contactId: string;
  readonly type: PayloadType;
  /** The signed createdAt: the wait lapses TERMS_WAIT_SECONDS after it. */
  readonly createdAt: number;
  /** The terms version, so the pass decides a chain's waiting envelopes in link order. */
  readonly version: number;
}

/** What one processing pass tracks for the waiting terms envelopes (M1-32-b). */
interface Pass {
  waiting: Waiting[];
  /** Terms envelopes the chain took since the waiting list was last decided again. */
  taken: number;
}

/** An envelope that passed steps 5 and 6. Owns `cek` until step 8 (or the first failure). */
interface Opened {
  readonly item: Item;
  readonly envelope: Envelope;
  readonly id: Uint8Array;
  cek: Uint8Array | undefined;
  readonly payload: Payload;
  readonly payloadText: string;
  /**
   * `from` is a blocked key and this first run skipped the step 5 drop because step 7 could hold it
   * for a contact's rotation (D-72, IR-D-72-1 F01): once the type is known it is dropped unless it is
   * held or a contact's card-update.
   */
  readonly blockedSkip: boolean;
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
      /** A verified revoke's effects (M1-7h): applied with the envelope row, or `noop`. */
      readonly revoke?: PreparedRevoke;
      /** A terms envelope the chain took (M1-32): re-checked and applied with the envelope row. */
      readonly terms?: Extract<TermsAdmission, { refused: false }>;
    }
  | { readonly kind: 'deferred'; readonly contactId?: string; readonly senderCard?: AgentCard }
  | { readonly kind: 'pairing'; readonly contactId?: string; readonly senderCard: AgentCard }
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
  readonly #pairing: PairingHandler | undefined;
  readonly #hooks: EnvelopeHooks;
  /** The rate limit of the current processing pass (RateLimitHook.limit), when a hook is set. */
  #rateLimit: number | undefined;

  constructor(
    ctx: CoreContext,
    identity: IdentityService,
    contacts: ContactBook,
    pairing?: PairingHandler,
    hooks: EnvelopeHooks = {},
  ) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#contacts = contacts;
    this.#pairing = pairing;
    this.#hooks = hooks;
  }

  // --- Send --------------------------------------------------------------------------------------

  /**
   * Builds, signs and stores an outbound envelope (04 §3.1–§3.4). The core chooses the recipient
   * set; the caller never supplies keys. Publishing (gift wraps, outbox) is the send flow's.
   */
  async build(input: BuildEnvelopeInput): Promise<BuiltEnvelope> {
    const { built, row } = await this.prepare(input);
    await this.#ctx.store.transaction((tx) => {
      tx.insert('envelopes', row);
    });
    return built;
  }

  /**
   * Builds and signs an outbound envelope like `build`, without storing it: the caller inserts
   * `row` in its own store transaction (07 §3.2: the send pipeline stores the envelope together
   * with all of its outbox rows, M1-7k).
   */
  async prepare(
    input: BuildEnvelopeInput,
  ): Promise<{ readonly built: BuiltEnvelope; readonly row: Row<'envelopes'> }> {
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
    const parties: Party[] = [];
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
    const thread = await this.#threadFor(input, payload, contactId);
    const sealed = await sealOutbound(ctx, { parties, payload, thread });
    const row = await outboundRow(ctx, sealed, contactId ?? null);
    return {
      built: {
        envelope: sealed.envelope,
        envelopeHash: sealed.envelopeHash,
        thread,
        recipientNostrKeys: sealed.recipientNostrKeys,
      },
      row,
    };
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
    // IR-M1-7b-1 L-4: a gift-wrap id that is present but not 64 lowercase hex is a caller bug
    // (transport passes the verified event id). It is refused, so the bug shows, and nothing is
    // stored or marked seen.
    const wrapId = input.giftWrapId;
    if (wrapId !== undefined && (typeof wrapId !== 'string' || !HEX64.test(wrapId))) {
      return {
        status: 'retry',
        report: report(undefined, 'dropped', { reason: 'wrap_id_invalid' }),
      };
    }
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
            // Residual (IR-M1-7b-1 L-3): while the colliding row is stored durably (a request, a
            // refused row), this one keeps returning `retry` and is lost after the 48 h look-back.
            // Only a co-recipient who learned the 16-byte id in advance can do this. A later
            // schema version may key `envelopes` on (envelope_id, envelope_hash).
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
          refused_at: null,
          request_accepted_at: null,
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
   * the held rows of that contact's owner `kid` again from step 5. Terms envelopes that wait for a
   * version they link to are decided again at the end of the pass (#runWaiting, M1-32-b). Returns
   * one report per envelope whose state changed, that a later card handles, or that waits
   * (`deferred`).
   */
  async processReceived(): Promise<InboundReport[]> {
    const ctx = this.#ctx;
    // D-72 retention: expired refusals from unknown keys are pruned first (07 §3.2). The count in
    // requestsFullTx ignores them already, so this only reclaims the rows.
    const pruneAt = nowOf(ctx);
    await ctx.store.transaction((tx) => pruneRefusedTx(tx, pruneAt));
    const own = await this.#ownKeys();
    let book = await this.#book();
    // 07 §3.2 rate_counters: the limit is read once per pass; a policy that cannot be read gives the
    // fail-closed hard caps (policyLimits), never no limit.
    this.#rateLimit = await this.#hooks.rateLimit?.limit();
    const reports: InboundReport[] = [];
    const pass: Pass = { waiting: [], taken: 0 };
    reports.push(...(await this.#runHeld(own, book, pass)));

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
    // IR-M1-7b-1 L-5: rows are opened and decided in batches of PROCESS_BATCH, so at most that many
    // CEKs and plaintexts are in memory at once. Card-updates go first within each batch. A
    // contact's envelope from a new key that lands in an earlier batch than its card-update is
    // held there and released when the card-update is applied (step 7), so the outcome is the same.
    for (let start = 0; start < rows.length; start += PROCESS_BATCH) {
      const opened: Opened[] = [];
      try {
        for (const row of rows.slice(start, start + PROCESS_BATCH)) {
          const item: Item = {
            envelopeId: row.envelope_id,
            envelopeHash: row.envelope_hash,
            envelopeJson: row.envelope_json ?? '',
            source: 'received',
          };
          const result = await this.#open(item, own, book);
          if ('kind' in result) {
            const done = await this.#settle(item, result);
            if (done !== undefined) reports.push(done);
          } else {
            opened.push(result);
          }
        }
        // Step 7, arrival order: every card-update of the batch before any other envelope.
        const ordered = [
          ...opened.filter((o) => o.payload.type === 'card-update'),
          ...opened.filter((o) => o.payload.type !== 'card-update'),
        ];
        for (const o of ordered) {
          const { report: done, applied } = await this.#decide(o, own, book, pass);
          if (done !== undefined) reports.push(done);
          if (applied !== undefined) {
            book = await this.#book();
            reports.push(
              ...(await this.#runHeld(own, book, pass, {
                ownerKid: kidOf(bytesOf(applied.ownerEnc)),
                fromKey: applied.agentNostr.slice(2),
              })),
            );
          }
        }
      } finally {
        for (const o of opened) wipeCek(o);
      }
    }
    reports.push(...(await this.#runWaiting(own, book, pass)));
    return reports;
  }

  /**
   * The terms envelopes that wait for a version they link to (M1-32-b; D-74, 04 §3.4: the chain is
   * decided by its links, never by arrival order or createdAt). While the pass took any terms
   * envelope since they were last decided, each is opened and decided again (one `unwrapCek`
   * each), in link order (contact, version, createdAt, ID), until a round takes nothing. Then each
   * one still waiting is refused if its wait lapsed, or stays `received` for a later pass. So one
   * chain ends in the same stored set whatever order and whatever syncs its envelopes arrive in.
   * One report per envelope: its final outcome in this pass.
   */
  async #runWaiting(own: OwnKeys, book: Book, pass: Pass): Promise<InboundReport[]> {
    const reports: InboundReport[] = [];
    let list = pass.waiting;
    pass.waiting = [];
    while (list.length > 0 && pass.taken > 0) {
      pass.taken = 0;
      list.sort(
        (x, y) =>
          (x.contactId < y.contactId ? -1 : x.contactId > y.contactId ? 1 : 0) ||
          x.version - y.version ||
          x.createdAt - y.createdAt ||
          (x.item.envelopeId < y.item.envelopeId
            ? -1
            : x.item.envelopeId > y.item.envelopeId
              ? 1
              : 0),
      );
      for (const w of list) {
        const result = await this.#open(w.item, own, book);
        if ('kind' in result) {
          const done = await this.#settle(w.item, result);
          if (done !== undefined) reports.push(done);
          continue;
        }
        try {
          const { report: done } = await this.#decide(result, own, book, pass);
          if (done !== undefined) reports.push(done);
        } finally {
          wipeCek(result);
        }
      }
      list = pass.waiting;
      pass.waiting = [];
    }
    const now = nowOf(this.#ctx);
    for (const w of list) {
      if (now > w.createdAt + TERMS_WAIT_SECONDS) {
        const final: Final = {
          kind: 'refuse',
          reason: 'terms_refused',
          contactId: w.contactId,
          flagged: false,
        };
        const done = await this.#settle(w.item, final, undefined, w.type);
        if (done !== undefined) reports.push(done);
      } else {
        reports.push(
          report(w.item.envelopeId, 'deferred', {
            reason: 'terms_waiting',
            contactId: w.contactId,
          }),
        );
      }
    }
    return reports;
  }

  /**
   * Held rows (04 §3.1.1 step 7, 07 §3.2): each one whose `from` is now a blocked, removed or
   * revoked key is dropped; one whose `from` is now a contact's current key, or that is due
   * (release_at), runs again from step 5 with exactly one `unwrapCek`. The rest stay held.
   * After a card-update, `after` limits the pass to the rows held under that card's owner `kid`
   * and the rows from that card's agent key (held under another owner `kid`, G-51).
   */
  async #runHeld(
    own: OwnKeys,
    book: Book,
    pass: Pass,
    after?: { readonly ownerKid: string; readonly fromKey: string },
  ): Promise<InboundReport[]> {
    const now = nowOf(this.#ctx);
    const order = {
      orderBy: [
        ['received_at', 'asc'],
        ['envelope_id', 'asc'],
      ],
    } as const;
    const candidates = await this.#ctx.store.transaction((tx) => {
      const rows =
        after === undefined
          ? tx.select('held_envelopes', {}, order)
          : [
              ...tx.select('held_envelopes', { owner_kid: after.ownerKid }, order),
              ...tx
                .select('held_envelopes', { from_key: after.fromKey }, order)
                .filter((r) => r.owner_kid !== after.ownerKid),
            ].sort(
              (x, y) =>
                x.received_at - y.received_at ||
                (x.envelope_id < y.envelope_id ? -1 : x.envelope_id > y.envelope_id ? 1 : 0),
            );
      return rows.map((row) => ({ row, screen: screenInboundTx(tx, row.from_key) }));
    });
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
      const result = await this.#open(item, own, book);
      if ('kind' in result) {
        const done = await this.#settle(item, result);
        if (done !== undefined) reports.push(done);
        continue;
      }
      try {
        const { report: done } = await this.#decide(result, own, book, pass);
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
   * The blocked-key drop at the start of step 5 (D-72; 07 §3.2 `blocked_keys`). `from` in the
   * blocked keys and not a contact's current key: `drop`, unless this is a first run (a `received`
   * row) whose recipients include a stored contact's owner `kid`, the step 7 hold condition visible
   * before any open: then `skip`, so a contact's card-update from a blocked new epoch key can still
   * arrive (IR-D-72-1 F01). A held row run again gets no skip: unclaimed, it is dropped when due. A
   * blocked set that cannot be read throws, and the pass stops with nothing processed (07 §3.2).
   */
  async #blockedGate(
    item: Item,
    envelope: Envelope,
    book: Book,
  ): Promise<'pass' | 'skip' | 'drop'> {
    const from = envelope.from;
    const blocked = await this.#ctx.store.transaction((tx) => blockedSenderTx(tx, from));
    if (!blocked) return 'pass';
    if (item.source === 'received' && envelope.recipients.some((r) => book.byOwnerKid.has(r.kid))) {
      return 'skip';
    }
    return 'drop';
  }

  /**
   * Steps 5 and 6. Step 5: the entry whose `kid` is one of the agent's own `enc` keys, at the
   * highest matching epoch, opened with exactly one `unwrapCek`; the `kc` check before AES-GCM.
   * A `kc` mismatch (the commitment check fails) is told apart from a failed tag only here, through
   * the separate commitment check; `decryptPayload` reports both as `open_failed`. Step 6: the
   * payload's strict schema. On success the CEK stays in the result for step 8.
   */
  async #open(item: Item, own: OwnKeys, book: Book): Promise<Opened | Final> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelopeText(item.envelopeJson);
    } catch {
      return { kind: 'drop', reason: 'unreadable' };
    }
    // Blocked key first (D-72): after the step 4 signature, before the own-entry lookup and any
    // unwrapCek, so only an envelope that key signed is dropped and it costs no decryption.
    const gate = await this.#blockedGate(item, envelope, book);
    if (gate === 'drop') return { kind: 'drop', reason: 'sender_blocked' };
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
        // Signature-valid (step 4) and a commitment its wrap for this agent does not carry. From a
        // blocked key that took the rotation skip it is dropped, never stored, so a blocked key
        // uses no queue space (IR-M1-7e-2-1 F01).
        if (gate === 'skip') return { kind: 'drop', reason: 'sender_blocked' };
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
        // Received text (04 §2.5.1, D-128): an `approval`, `policy` or `revoke` payload carries a
        // SignedOwnerAction and a pairing or card-update payload a card: no duplicate or escaped
        // member name, and integer tokens only (every payload number is a protocol integer).
        const parsed = payloadSchema.safeParse(parseReceivedJson(payloadText));
        if (!parsed.success) return { kind: 'drop', reason: 'payload_invalid' };
        payload = parsed.data;
      } catch {
        return { kind: 'drop', reason: 'payload_invalid' };
      } finally {
        wipe(plaintext);
      }
      keep = true;
      return { item, envelope, id, cek, payload, payloadText, blockedSkip: gate === 'skip' };
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
    pass: Pass,
  ): Promise<{ readonly report?: InboundReport | undefined; readonly applied?: AgentCard }> {
    const disposition = await this.#senderRole(o, own, book);
    // D-72, IR-D-72-1 F01 and F10: an envelope from a blocked key that skipped the step 5 drop is
    // dropped now, unless step 7 holds it for a contact's key change or it is a contact's
    // card-update that passed 04 §3.4.1. A pairing message from a blocked key never gets through.
    if (
      o.blockedSkip &&
      disposition.kind !== 'hold' &&
      !(disposition.kind === 'accept' && disposition.cardUpdate !== undefined)
    ) {
      wipeCek(o);
      return {
        report: await this.#settle(o.item, { kind: 'drop', reason: 'sender_blocked' }),
      };
    }
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
        // A contact is flagged for wraps that differ (G-46) and for leaving out its own owner
        // (G-51); never for leaving out this agent's owner.
        flagged:
          (step8 === 'wrap_mismatch' || step8 === 'sender_owner_entry_missing') &&
          disposition.contactId !== undefined,
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
    if (disposition.kind === 'pairing') {
      return { report: await this.#pairingOutcome(o, disposition) };
    }
    if (o.payload.type === 'revoke' && disposition.kind === 'deferred') {
      return { report: await this.#revokeOutcome(o) };
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
    // The negotiation chain (04 §3.4; M1-32): computed from this agent's own store, before the
    // envelope is stored. A refusal is stored as refused, never taken into the chain.
    const termsHook = this.#hooks.terms;
    if (
      termsHook !== undefined &&
      disposition.state === 'ok' &&
      disposition.contactId !== undefined &&
      isTermsType(o.payload.type)
    ) {
      const admission = await termsHook.admit({
        envelopeId: o.item.envelopeId,
        envelopeHash: o.item.envelopeHash,
        contactId: disposition.contactId,
        createdAt: o.envelope.createdAt,
        thread: o.envelope.thread,
        payload: o.payload,
      });
      if (admission.refused && admission.wait) {
        // A version it links to has not arrived yet (M1-32-b): nothing is written; the row stays
        // where it is and #runWaiting decides it again in this pass, or a later one.
        const version = termsBodyOf(o.payload.type, o.payload.body)?.terms.version ?? 0;
        // Marked as waiting, so it is not an unread item: the inbox page can never return it
        // until the chain takes it (IR-M1-32-b-1 F01). Taking or refusing it rewrites the row.
        if (o.item.source === 'received') {
          const { envelopeId, envelopeHash } = o.item;
          await this.#ctx.store.transaction((tx) =>
            tx.update(
              'envelopes',
              { envelope_id: envelopeId, envelope_hash: envelopeHash, state: 'received' },
              { refused_reason: 'terms_waiting' },
            ),
          );
        }
        pass.waiting.push({
          item: o.item,
          contactId: disposition.contactId,
          type: o.payload.type,
          createdAt: o.envelope.createdAt,
          version,
        });
        return {};
      }
      if (admission.refused) {
        const final: Final = {
          kind: 'refuse',
          reason: 'terms_refused',
          contactId: disposition.contactId,
          flagged: admission.flagged,
        };
        return { report: await this.#settle(o.item, final, o.envelope, o.payload.type) };
      }
      const accepted = await this.#accept(o, { ...disposition, terms: admission });
      if (accepted.report?.outcome === 'ok') pass.taken += 1;
      return accepted;
    }
    return this.#accept(o, disposition);
  }

  /** Step 7: the sender role the type requires, the key table and the arrival-order rule. */
  async #senderRole(o: Opened, own: OwnKeys, book: Book): Promise<Disposition> {
    const { envelope, payload } = o;
    const { from } = envelope;
    const type = payload.type;
    if (own.agentNostr.has(from)) {
      // Key table (04 §3.1.1): the agent key never signs an owner-authored type (IR-M1-7b-1 L-2).
      if (OWNER_AUTHORED_TYPES.has(type)) return { kind: 'drop', reason: 'agent_key_type' };
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
      // Authority comes from the carried SignedOwnerAction, whatever the `from` (04 §3.4.1, D-58):
      // usually the revoked agent's owner key, which is not a contact key. It is verified and
      // applied, or dropped, in this pass (#decide), never parked in `received` (IR-M1-7h-1 F01).
      return sender.kind === 'unknown'
        ? { kind: 'deferred' }
        : { kind: 'deferred', contactId: sender.contactId };
    }
    if (book.ownerNostr.has(from)) return { kind: 'drop', reason: 'owner_key_type' };
    if (OWNER_CHANNEL_TYPES.has(type)) return { kind: 'drop', reason: 'owner_channel_type' };

    if (sender.kind !== 'unknown') {
      const contactId = sender.contactId;
      if (type === 'card-update') return this.#cardUpdate(o, contactId);
      if (sender.kind === 'superseded') {
        return { kind: 'refuse', reason: 'superseded_key', contactId, flagged: false };
      }
      if (PAIRING_TYPES.has(type)) return this.#screenPairing(o, contactId);
      const senderCard = book.byId.get(contactId)?.card;
      if (senderCard === undefined) return { kind: 'drop', reason: 'unreadable' };
      return { kind: 'accept', state: 'ok', contactId, senderCard };
    }

    // Unknown key. A card-update is accepted only from the new key its own card names, for a
    // stored contact (04 §3.4.1: the old or the new epoch key; authority from cardSig). From any
    // other key it is dropped, never held or queued (IR-M1-7b-1 L-1).
    if (type === 'card-update') {
      const named = book.byId.get(payload.body.card.agentEvm);
      const bodyKey = payload.body.card.agentNostr.slice(2);
      if (named === undefined || bodyKey !== from) {
        return { kind: 'drop', reason: 'card_update_invalid' };
      }
      if (named.status !== 'active') return { kind: 'drop', reason: named.status };
      return this.#cardUpdate(o, named.id);
    }
    // Pairing types from an unknown key: only for an invite or a pairing in progress, otherwise
    // dropped at once, never parked in `received` or queued (IR-M1-7b-1 M-1, 04 §3.6).
    if (PAIRING_TYPES.has(type)) return this.#screenPairing(o);
    // Arrival order: a stored contact owner's `kid` among the recipients holds it while any such
    // contact is active (IR-M1-7b-1 M-2). With only blocked, removed or revoked matches it is
    // dropped at once, and a held row with any inactive match is dropped at release instead of
    // becoming a request (IR-M1-7a-1 R2-M1). A held row is never accepted as a contact's without
    // that contact's card-update.
    const kids = new Set(envelope.recipients.map((r) => r.kid));
    const matches: InboundCard[] = [];
    for (const [kid, cards] of book.byOwnerKid) if (kids.has(kid)) matches.push(...cards);
    const active = matches.filter((c) => c.status === 'active');
    const inactive = matches.length > active.length;
    const first = active[0];
    if (first === undefined) {
      return inactive
        ? { kind: 'drop', reason: 'held_owner_inactive' }
        : { kind: 'accept', state: 'request' };
    }
    if (o.item.source === 'held') {
      if ((o.item.releaseAt ?? 0) > nowOf(this.#ctx)) return { kind: 'keep_held' };
      return inactive
        ? { kind: 'drop', reason: 'held_owner_inactive' }
        : { kind: 'accept', state: 'request' };
    }
    return { kind: 'hold', ownerKid: kidOf(bytesOf(first.card.ownerEnc)) };
  }

  /**
   * Step 7 for a pairing message (M1-7c): the pairing flow's screen decides whether a pairing exists
   * that it could belong to; otherwise it is dropped. Its body card is the step 8 sender card (it
   * is verified in full by the pairing flow; a card that does not hold the wraps only refuses).
   */
  async #screenPairing(o: Opened, contactId?: string): Promise<Disposition> {
    const handler = this.#pairing;
    const { payload, envelope } = o;
    const contact = contactId === undefined ? {} : { contactId };
    if (
      handler === undefined ||
      (payload.type !== 'handshake' && payload.type !== 'handshake-ack')
    ) {
      return { kind: 'drop', reason: 'type_unhandled', ...contact };
    }
    const reason = await this.#ctx.store.transaction((tx) =>
      handler.screen(tx, payload, envelope.from),
    );
    if (reason !== undefined) return { kind: 'drop', reason, ...contact };
    return { kind: 'pairing', senderCard: payload.body.card as AgentCard, ...contact };
  }

  /** Hands a pairing message that passed steps 3–9 to the pairing flow and stores a drop or refusal. */
  async #pairingOutcome(
    o: Opened,
    d: Extract<Disposition, { kind: 'pairing' }>,
  ): Promise<InboundReport | undefined> {
    const handler = this.#pairing;
    const contact = d.contactId === undefined ? {} : { contactId: d.contactId };
    let outcome: PairingOutcome;
    if (handler === undefined) {
      outcome = { kind: 'drop', reason: 'type_unhandled', ...contact };
    } else {
      const { item } = o;
      try {
        outcome = await handler.handle({
          envelopeId: item.envelopeId,
          envelopeHash: item.envelopeHash,
          envelopeJson: item.envelopeJson,
          envelope: o.envelope,
          payload: o.payload,
          payloadText: o.payloadText,
          ...contact,
          claim: (tx) => claim(tx, item),
          write: (tx, row) => {
            writeRow(tx, item, row);
          },
        });
      } catch (error) {
        if (!(error instanceof CoreError) || error.code === 'store_unreadable') throw error;
        outcome = { kind: 'drop', reason: 'pairing_invalid', ...contact };
      }
    }
    if (outcome.kind === 'done') return outcome.report;
    return this.#settle(o.item, outcome, o.envelope, o.payload.type);
  }

  /**
   * A `revoke` (04 §3.4.1, 07 §3.4; IR-M1-7h-1 F01): verified against the named agent's stored card
   * and applied with its envelope row in one store transaction, or dropped. Without a handler it is
   * dropped, so it never stays `received`.
   */
  async #revokeOutcome(o: Opened): Promise<InboundReport | undefined> {
    const handler = this.#hooks.revocation;
    const prepared =
      handler === undefined
        ? { reason: 'type_unhandled' as const }
        : await handler.prepare(o.payload).catch((error: unknown) => {
            if (error instanceof CoreError && error.code !== 'store_unreadable') {
              return { reason: 'revoke_invalid' as const };
            }
            throw error;
          });
    if ('reason' in prepared) {
      return this.#settle(o.item, { kind: 'drop', reason: prepared.reason }, o.envelope, 'revoke');
    }
    const { report: done } = await this.#accept(o, {
      kind: 'accept',
      state: 'ok',
      ...(prepared.contactId === undefined ? {} : { contactId: prepared.contactId }),
      revoke: prepared,
    });
    return done;
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
   * Step 8: the own owner's entry must be present and, when the sender's card is held, the entry
   * of that card's owner too (G-51, D-71 (4); one entry meets both when the owners are the same).
   * These, plus the sender's agent entry, must be the wrap of this CEK byte for byte (§3.3).
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
      // The sender's own owner (§3.2 entry 3): a presence check on the kid, no extra unwrap.
      const senderOwnerKid = kidOf(bytesOf(senderCard.ownerEnc));
      if (!o.envelope.recipients.some((r) => r.kid === senderOwnerKid)) {
        return 'sender_owner_entry_missing';
      }
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
    // M1-7f-2 (D-98): an inbound payload's file keys move into sealed receiver `files` rows; the
    // stored payload keeps a placeholder. A sent copy keeps its payload as it is.
    const received =
      d.state === 'sent_copy'
        ? { payloadText: o.payloadText, rows: [] }
        : await receivedFileRows(ctx, item.envelopeId, payload, o.payloadText);
    const sealed = await seal(
      ctx,
      'envelopes',
      'payload_json',
      [item.envelopeId],
      received.payloadText,
    );
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
      refused_at: null,
      request_accepted_at: null,
    };
    const now = nowOf(ctx);
    let revoked: RevokeActivity | undefined;
    try {
      const done = await ctx.store.transaction((tx) => {
        revoked = undefined;
        if (!claim(tx, item)) return 'lost' as const;
        // The chain rows are still those the terms decision was made on; otherwise nothing is
        // written, the row stays `received` and the next pass decides it again (M1-32).
        if (d.terms !== undefined && !d.terms.checkTx(tx)) return 'lost' as const;
        // The requests-queue limits: the count and the insert in this one transaction (07 §3.2).
        // Over a limit nothing is stored and nothing is sent; the seen rows stay.
        // A Block from another process since the step 5 gate (IR-M1-7e-2-1 F02): checked again
        // here, so a blocked key's envelope is never stored as a request.
        if (d.state === 'request' && blockedSenderTx(tx, envelope.from)) {
          deleteRow(tx, item);
          return 'blocked' as const;
        }
        if (d.state === 'request' && requestsFullTx(tx, envelope.from, now)) {
          deleteRow(tx, item);
          return 'full' as const;
        }
        if (d.revoke !== undefined) {
          const applied = d.revoke.effect(tx);
          // An approval the revoke could not read yet: nothing written, decided in a later pass.
          if (applied === 'stale') return 'lost' as const;
          if (applied === 'noop') {
            deleteRow(tx, item);
            return 'noop' as const;
          }
          revoked = applied;
        }
        // 07 §3.2 rate_counters: counted in the transaction that stores the contact's envelope.
        if (
          d.state === 'ok' &&
          d.revoke === undefined &&
          d.contactId !== undefined &&
          !this.#countRate(tx, d.contactId)
        ) {
          deleteRow(tx, item);
          return 'rate' as const;
        }
        if (d.terms !== undefined) d.terms.effectTx(tx, now);
        if (d.cardUpdate !== undefined) {
          d.cardUpdate.apply(tx);
          // 07 §3.2: a card-update that makes a blocked key a contact's current key removes the
          // block in the same transaction; the contact's status governs that key from then on.
          tx.delete('blocked_keys', { from_key: agentNostrKey(d.cardUpdate.card) });
        }
        writeRow(tx, item, row);
        for (const f of received.rows) {
          if (tx.get('files', { envelope_id: f.envelope_id, idx: f.idx }) === undefined) {
            tx.insert('files', f);
          }
        }
        return 'stored' as const;
      });
      if (done === 'lost') return {};
      if (done === 'blocked') {
        return { report: report(item.envelopeId, 'dropped', { reason: 'sender_blocked' }) };
      }
      if (done === 'noop') return { report: report(item.envelopeId, 'duplicate') };
      if (done === 'rate') {
        return {
          report: report(item.envelopeId, 'dropped', {
            reason: 'rate_limited',
            ...(d.contactId === undefined ? {} : { contactId: d.contactId }),
          }),
        };
      }
      if (done === 'full') {
        return { report: report(item.envelopeId, 'dropped', { reason: REQUESTS_FULL }) };
      }
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
    const activity = revoked as RevokeActivity | undefined;
    if (activity !== undefined) {
      // The activity line of a revoke (07 §3.2, §3.4): counts only (I-7).
      ctx.log.info('revoke applied', { ...activity });
    }
    return {
      report: {
        ...report(item.envelopeId, outcome, {
          ...(d.state === 'ok' && d.contactId !== undefined ? { contactId: d.contactId } : {}),
        }),
        ...(activity === undefined ? {} : { revoke: activity }),
      },
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

  /** One envelope of `contactId` counted for the hour; false when it is over the limit. */
  #countRate(tx: StoreTx, contactId: string): boolean {
    const hook = this.#hooks.rateLimit;
    const limit = this.#rateLimit;
    if (hook === undefined || limit === undefined) return true;
    return hook.countTx(tx, contactId, limit, nowOf(this.#ctx));
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
    const now = nowOf(ctx);
    let envelope = parsed;
    if (envelope === undefined && final.kind === 'refuse') {
      envelope = parseEnvelopeText(item.envelopeJson);
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
      // A refusal from a key blocked since the step 5 gate (another process) is dropped, never
      // stored: a blocked key uses no queue space (IR-M1-7e-2-1 F02).
      if (
        effective.kind === 'refuse' &&
        effective.contactId === undefined &&
        envelope !== undefined &&
        blockedSenderTx(tx, envelope.from)
      ) {
        effective = { kind: 'drop', reason: 'sender_blocked' };
      }
      // A refusal from an unknown key counts toward the requests-queue limits (07 §3.2); over a
      // limit it is not stored. Pairing refusals keep their own rules (04 §3.6).
      if (
        effective.kind === 'refuse' &&
        effective.contactId === undefined &&
        envelope !== undefined &&
        !(type !== undefined && PAIRING_TYPES.has(type)) &&
        requestsFullTx(tx, envelope.from, now)
      ) {
        effective = { kind: 'drop', reason: REQUESTS_FULL };
      }
      // 07 §3.2 rate_counters: a contact's refused envelope counts too; above the limit it is dropped.
      if (
        effective.kind === 'refuse' &&
        effective.contactId !== undefined &&
        !this.#countRate(tx, effective.contactId)
      ) {
        effective = { kind: 'drop', reason: 'rate_limited', contactId: effective.contactId };
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
        // D-72: the local time it was stored as refused, for its retention (07 §3.2).
        refused_at: now,
        request_accepted_at: null,
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

// --- Outbound sealing (shared by build and the pairing flow) ----------------------------------------

/** One recipient party: its `enc` key and the Nostr key its gift wrap goes to. */
interface Party {
  readonly enc: Uint8Array;
  readonly nostr: string;
}

/** A signed outbound envelope, not yet stored. */
export interface SealedOutbound {
  readonly envelope: Envelope;
  /** `0x` + 64 lowercase hex (04 §2.4.1). */
  readonly envelopeHash: string;
  /** The JCS text stored in `envelopes.envelope_json`. */
  readonly envelopeJson: string;
  readonly payload: Payload;
  readonly payloadText: string;
  readonly thread: string;
  readonly createdAt: number;
  readonly recipientNostrKeys: readonly string[];
}

/**
 * Seals and signs a payload to the given parties (04 §3.1–§3.3): one entry per distinct `enc` key
 * and one gift wrap per distinct Nostr key, in party order; a fresh CEK, wiped before returning;
 * the agent key signs envelopeHash; the JCS form is at most MAX_ENVELOPE_BYTES.
 */
async function sealOutbound(
  ctx: CoreContext,
  input: {
    readonly parties: readonly Party[];
    readonly payload: Payload;
    readonly thread: string;
    readonly id?: Uint8Array;
  },
): Promise<SealedOutbound> {
  const bundle = await ctx.keyStore.getPublicBundle();
  const encKeys: Uint8Array[] = [];
  const seenEnc = new Set<string>();
  const nostrKeys: string[] = [];
  for (const party of input.parties) {
    const hex = encodeHex(party.enc);
    if (!seenEnc.has(hex)) {
      seenEnc.add(hex);
      encKeys.push(party.enc);
    }
    if (!nostrKeys.includes(party.nostr)) nostrKeys.push(party.nostr);
  }
  const now = nowOf(ctx);
  const id = input.id ?? randomBytes(ENVELOPE_ID_LENGTH);
  const payloadText = canonicalize(input.payload as unknown as JsonValue);
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
      thread: input.thread,
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
  return {
    envelope,
    envelopeHash: encodeHex0x(hash),
    envelopeJson,
    payload: input.payload,
    payloadText,
    thread: input.thread,
    createdAt: now,
    recipientNostrKeys: nostrKeys,
  };
}

/** The `envelopes` row of a sealed outbound envelope: stored as sent, the payload sealed. */
export async function outboundRow(
  ctx: CoreContext,
  sealed: SealedOutbound,
  contactId: string | null,
): Promise<Row<'envelopes'>> {
  const { envelope } = sealed;
  return {
    envelope_id: envelope.id,
    envelope_hash: sealed.envelopeHash,
    thread_id: sealed.thread,
    direction: 'out',
    contact_id: contactId,
    from_key: envelope.from,
    type: sealed.payload.type,
    state: 'ok',
    refused_reason: null,
    created_at: sealed.createdAt,
    envelope_json: sealed.envelopeJson,
    payload_json: await seal(ctx, 'envelopes', 'payload_json', [envelope.id], sealed.payloadText),
    read_at: null,
    delivery: 'queued',
    refused_at: null,
    request_accepted_at: null,
  };
}

/**
 * Seals a `handshake` or `handshake-ack` (04 §3.6, §3.4.1) to the counterparty of a pairing, which
 * is not (or not yet) a contact: recipients per 04 §3.2 from the counterparty's card and this
 * agent's. Core-internal: no MCP tool reaches it (04 §3.4.1, I-4), and it is not exported from the
 * package. `id` is the envelope id (the handshake's id is the pairing ID).
 */
export async function sealPairingEnvelope(
  ctx: CoreContext,
  identity: IdentityService,
  input: {
    readonly payload: unknown;
    readonly peer: AgentCard;
    readonly thread: string;
    readonly id?: Uint8Array;
  },
): Promise<SealedOutbound> {
  await identity.assertCanSend();
  const parsed = payloadSchema.safeParse(input.payload);
  if (!parsed.success || !PAIRING_TYPES.has(parsed.data.type)) {
    throw new CoreError('payload_invalid', 'The message content is not valid.');
  }
  const self = await identity.get();
  if (self === undefined) {
    throw new CoreError('identity_missing', 'This agent has no identity yet. Run init first.');
  }
  const bundle = await ctx.keyStore.getPublicBundle();
  const parties: Party[] = [
    { enc: bytesOf(input.peer.agentEnc), nostr: agentNostrKey(input.peer) },
    { enc: bytesOf(input.peer.ownerEnc), nostr: input.peer.ownerNostr.slice(2) },
    { enc: bytesOf(self.card.ownerEnc), nostr: self.card.ownerNostr.slice(2) },
    { enc: bundle.agentEnc, nostr: encodeHex(bundle.agentNostr) },
  ];
  return sealOutbound(ctx, {
    parties,
    payload: parsed.data,
    thread: input.thread,
    ...(input.id === undefined ? {} : { id: input.id }),
  });
}

// --- Store helpers (inside one transaction) ------------------------------------------------------

/** `from` is in the owner's blocked keys and is not a contact's current key (D-72, 07 §3.2). */
function blockedSenderTx(tx: StoreTx, from: string): boolean {
  return isBlockedTx(tx, from) && tx.count('contacts', { agent_nostr: from }) === 0;
}

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
