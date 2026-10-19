// Contacts (04 §2.9, §2.6, §3.4.1; 02 F-13, F-14; 07 §3 `contacts`, `pairings`).
//
// - Keyed by agentId: at most one contact per agentId, never the own agentId.
// - Pairing is two steps (IR-M1-7a-1 M-2). stagePairing checks a received card (cardSig by ownerEvm,
//   cardAgentSig by agentEvm, name and relays matching the card, not expired) and the re-pair rules,
//   and stores it in `pairings` only: nothing in `contacts` changes. completePairing runs when the
//   handshake completes (04 §3.6, M1-7c): in one store transaction it checks the evidence (the
//   counterparty's handshake or ack stored as received from the card's own key, and ours as sent),
//   checks the rules again, writes the contact with pairing `complete` and deletes the staged row.
//   A card alone is public and replayable, so it completes nothing (04 §2.9).
// - The evidence is bound to the pairing (M1-7c, IR-M1-7a-1 R2-L1): the pairing ID is the handshake
//   envelope `id`, and the two envelopes must verify as a 04 §3.6.1 transcript whose counterparty
//   card is the staged card and whose other card is this agent's. Concurrent pairings converge by
//   the 04 §2.9 tie-break (the later handshake `createdAt`, then the larger envelopeHash).
// - A re-pair (an agentId that is already a contact) is allowed only with unchanged owner keys and a
//   keyEpoch that is not lower, and never for a revoked agentId (a `revoked_agents` row is never
//   deleted).
// - A card-update needs only cardSig, the same agentEvm and owner keys and a strictly higher epoch.
// - No card may claim a key of another contact (current or earlier), of the own agent at any epoch,
//   or of a revoked agent (L-2).
// - Block keeps the contact and drops its later envelopes (F-14). Remove leaves a tombstone (status
//   `removed`) that keeps the keys, so later envelopes from them are dropped too, never queued as
//   requests or held (M-1). Only a fresh completed pairing brings a removed contact back.
// - Display names are self-declared (04 §2.4) and untrusted (I-5): callers show them only under the
//   contact-name rule or inside the untrusted block (06 §2.1, §4). A name the owner chose is kept.
// - The card is sealed at rest; only public lookup values stay clear: agent_nostr, nostr_keys,
//   key_epoch and the owner fingerprint (a hash of the owner's public keys) (M-3).
// - "Safety code checked" (04 §2.5.1, §3.6.1; M1-7c-b): applyContactCheck stores the owner's signed
//   `contact.check` in `safety_check` only when its `pairingDigest` equals the digest recomputed from
//   the stored signed `handshake` and `handshake-ack`; nonce, nonce record and write are one store
//   transaction (07 §3.4). safetyCodeChecked re-verifies that object against a fresh recomputation on
//   every read; the `safety_code_checked` column is a cache that is never read. A completed re-pair
//   clears both.
import {
  canonicalize,
  decodeBase64url,
  decodeHex,
  encodeBase64url,
  encodeHex,
  formatFingerprint,
  parseJson,
  randomBytes,
  type AgentCard,
  type JsonValue,
} from '@4thtech-io/crypto';
import type { ContactDisplayName, IdentityLabel, OwnerAlias } from '@4thtech-io/types';
import {
  agentNostrKey,
  cardPopInvalid,
  checkReceivedCard,
  ownerFingerprintHex,
  parseStoredCard,
  storedCardText,
  type CardInput,
  type StoredCard,
} from './card.js';
import {
  storedContactCheckHolds,
  verifyContactCheck,
  type ContactCheckContext,
  type ContactCheckRefusal,
  type PairingDigestLookup,
} from './contact-check.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import { openOwnCard, readIdentity } from './identity.js';
import { restrictName } from './names.js';
import { verifyPairingTranscript, type PairingTranscript } from './safety-code.js';
import type { Row } from './store/schema.js';
import {
  openStoredPairingMessage,
  ownKids,
  recomputeStoredPairing,
  type StoredPairingCode,
} from './stored-envelope.js';
import type { StoreTx } from './store/store.js';

export type ContactStatus = Row<'contacts'>['status'];
export type PairingState = Row<'contacts'>['pairing'];

/** A contact as the core returns it. `name.value` is untrusted text (I-5). */
export interface ContactView {
  /** The contact's agentId (04 §2.9). */
  readonly id: string;
  readonly name: {
    readonly value: string;
    readonly source: 'counterparty' | 'owner';
    /** True for a name the counterparty chose (04 §2.4): label it self-declared. */
    readonly selfDeclared: boolean;
  };
  /**
   * How the contact is shown outside the untrusted block (06 §2.1): an owner-set alias, or the
   * restricted name (restrictName), with its identity label. Render with renderContactName.
   */
  readonly display: ContactDisplayName;
  readonly card: AgentCard;
  readonly keyEpoch: number;
  /** Display only: identifies, does not authenticate (04 §2.9). */
  readonly ownerFingerprint: { readonly short: string; readonly long: string };
  readonly status: ContactStatus;
  readonly pairing: PairingState;
  /**
   * Derived on every read from the stored `contacts.safety_check` object, never from a flag: true
   * only while that owner-signed `contact.check` verifies (`agent`, `owner`, `sig`), names this
   * contact, and its `pairingDigest` equals the digest recomputed now from the stored signed
   * `handshake` and `handshake-ack` (04 §2.5.1, §3.6.1, G-28; M1-7c-b).
   */
  readonly safetyCodeChecked: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The result of applyContactCheck. A refusal carries a fixed code only (I-5) and changes nothing;
 * the owner surface shows "not applied, sign again" (04 §2.5.1).
 */
export type ContactCheckOutcome =
  | { readonly status: 'applied'; readonly contact: ContactView }
  | { readonly status: 'refused'; readonly reason: ContactCheckRefusal };

/** A received card to stage for pairing, with this side's role and the invite's expiry. */
export interface StagePairingInput extends CardInput {
  /** `inviter` (A, made the invite) or `invitee` (B, accepted it) (04 §3.6). */
  readonly role: 'inviter' | 'invitee';
  /** When the staged pairing lapses, in unix seconds: the invite's expiry (04 §2.9). */
  readonly expiresAt: number;
  /**
   * The pairing ID: the `handshake` envelope `id` (16 bytes, base64url), which binds the completion
   * evidence to this pairing (IR-M1-7a-1 R2-L1). Default: 16 random bytes, the `id` the invitee then
   * gives its handshake.
   */
  readonly pairingId?: string;
}

/** The completion evidence: both pairing envelopes, as stored by M1-7c (04 §3.6, §3.4.1). */
export interface CompletePairingInput {
  readonly pairingId: string;
  /** Must equal `pairingId`: the pairing ID is the handshake envelope `id`. */
  readonly handshakeEnvelopeId: string;
  readonly handshakeAckEnvelopeId: string;
}

/** A staged pairing's checked card and its values (07 §3 `pairings`). */
export interface StagedPairing {
  readonly pairingId: string;
  readonly role: 'inviter' | 'invitee';
  readonly card: AgentCard;
  readonly cardSig: string;
  readonly cardAgentSig: string | null;
  /**
   * The card's `cardPop` (04 §2.9, D-102), verified: from the `handshake` (inviter side) or, for the
   * invitee, from the `handshake-ack` at completion (the invite carries none). Null without one.
   */
  readonly cardPop: string | null;
  /** Self-declared, untrusted (I-5). */
  readonly name: string;
  readonly relays: readonly string[];
  readonly expiresAt: number;
}

/** A checked card ready to stage inside the caller's store transaction. */
export interface PreparedStage {
  readonly staged: StagedPairing;
  /** Writes the `pairings` row; throws a CoreError (aborting the transaction) when a rule fails. */
  readonly apply: (tx: StoreTx) => void;
}

/** What a completion wrote: the contact row, and whether this pairing replaced the stored one. */
export interface PairingCompletion {
  readonly row: Row<'contacts'>;
  /** False when a concurrent pairing with a later handshake was kept (04 §2.9). */
  readonly replaced: boolean;
}

/** A verified, bound completion ready to apply inside the caller's store transaction. */
export interface PreparedCompletion {
  readonly contactId: string;
  readonly apply: (tx: StoreTx) => PairingCompletion;
}

/**
 * A proof pack's `signer` (07 §8): the record signer (the card's `agentEvm`), its card and `cardSig`,
 * and the card's proof of possession (`cardAgentSig` and `cardPop`, together or not at all; D-102).
 */
export interface ProofPackSigner {
  readonly evm: string;
  readonly agentCard: AgentCard;
  readonly cardSig: string;
  readonly cardAgentSig?: string;
  readonly cardPop?: string;
}

/** The signer block of a stored card: the pair only when both signatures are stored. */
function signerOf(stored: StoredCard): ProofPackSigner {
  const base = { evm: stored.card.agentEvm, agentCard: stored.card, cardSig: stored.cardSig };
  return stored.cardAgentSig !== null && stored.cardPop !== null
    ? { ...base, cardAgentSig: stored.cardAgentSig, cardPop: stored.cardPop }
    : base;
}

/**
 * A card-update body (04 §3.4.1): no cardAgentSig is needed for acceptance. `cardAgentSig` and
 * `cardPop` (04 §2.9, D-102) come together or not at all; when present, both must verify.
 */
export interface CardUpdateInput {
  readonly card: unknown;
  readonly cardSig: unknown;
  readonly cardAgentSig?: unknown;
  readonly cardPop?: unknown;
  readonly name: unknown;
  readonly relays: unknown;
}

/** A checked card-update, ready to apply inside the caller's store transaction (M1-7b). */
export interface PreparedCardUpdate {
  readonly card: AgentCard;
  /** Writes the new card; throws a CoreError (aborting the transaction) when a rule fails. */
  readonly apply: (tx: StoreTx) => Row<'contacts'>;
}

/** A stored contact's current card and status, for the inbound checks (04 §3.1.1, M1-7b). */
export interface InboundCard {
  readonly id: string;
  readonly status: ContactStatus;
  readonly card: AgentCard;
}

export type InboundSender =
  | { readonly kind: 'contact'; readonly contactId: string }
  /** A key of an earlier card of this contact: refused except for a card-update (04 §3.1.1 step 7). */
  | { readonly kind: 'superseded'; readonly contactId: string }
  /** Not a contact key: requests queue or held (04 §3.1.1 step 7, M1-7b). */
  | { readonly kind: 'unknown' };

export type InboundScreen =
  | {
      readonly action: 'drop';
      readonly reason: 'blocked' | 'removed' | 'revoked' | 'malformed';
    }
  | { readonly action: 'continue'; readonly sender: InboundSender };

const NOSTR_KEY = /^[0-9a-f]{64}$/;
const PAIRING_ID_BYTES = 16;

function unreadable(): never {
  throw new CoreError('store_unreadable', 'A stored contact could not be read.');
}

function parseKeyList(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable();
  }
  if (!Array.isArray(parsed) || !parsed.every((k) => typeof k === 'string')) return unreadable();
  return parsed as string[];
}

const withKey = (keys: string[], key: string): string =>
  JSON.stringify(keys.includes(key) ? keys : [...keys, key]);

/** Revoked means either a `revoked_agents` row or contact status `revoked` (07 §3.4). */
function isRevoked(tx: StoreTx, agentId: string, row: Row<'contacts'> | undefined): boolean {
  return (
    row?.status === 'revoked' || tx.get('revoked_agents', { agent_evm: agentId }) !== undefined
  );
}

const notFound = (): never => {
  throw new CoreError('contact_not_found', 'No contact has that ID.');
};

/**
 * L-2: a card may not claim a key that belongs to another contact (current or earlier), to a revoked
 * agent, or to the own agent at any epoch. Runs inside the writing transaction.
 */
function assertKeyFree(tx: StoreTx, id: string, nostr: string, ownKeys: readonly string[]): void {
  const conflict = (): never => {
    throw new CoreError('contact_conflict', 'That agent key already belongs to another agent.');
  };
  if (ownKeys.includes(nostr)) conflict();
  for (const row of tx.select('contacts', { contact_id: { ne: id } })) {
    if (row.agent_nostr === nostr || parseKeyList(row.nostr_keys).includes(nostr)) conflict();
  }
  for (const row of tx.select('revoked_agents', { agent_evm: { ne: id } })) {
    if (parseKeyList(row.nostr_keys).includes(nostr)) conflict();
  }
}

/** Re-pair rules (04 §2.9) on the stored clear columns: same owner keys, epoch not lower. */
function assertRepairAllowed(
  existing: Row<'contacts'> | undefined,
  card: { readonly ownerFingerprint: string; readonly keyEpoch: number },
): void {
  if (existing === undefined) return;
  if (existing.owner_fingerprint !== card.ownerFingerprint) {
    throw new CoreError('repair_owner_changed', 'The owner of that agent has changed.');
  }
  if (card.keyEpoch < existing.key_epoch) {
    throw new CoreError('repair_epoch_lower', 'That card is older than the stored one.');
  }
}

export class ContactBook {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  /** The own agent's Nostr keys at every epoch up to the current one (L-2). */
  async #ownKeys(): Promise<string[]> {
    const current = await this.#ctx.keyStore.getPublicBundle();
    const keys: string[] = [];
    for (let epoch = 0; epoch <= current.keyEpoch; epoch += 1) {
      const bundle = await this.#ctx.keyStore.getPublicBundle({ epoch });
      keys.push(encodeHex(bundle.agentNostr));
    }
    return keys;
  }

  /** The contact's stored card, re-verified and matched against the row's clear columns. */
  async #card(row: Row<'contacts'>): Promise<AgentCard> {
    const stored = parseStoredCard(
      await open(this.#ctx, 'contacts', 'agent_card_json', [row.contact_id], row.agent_card_json),
    );
    const { card } = stored;
    if (
      card.agentEvm !== row.contact_id ||
      card.keyEpoch !== row.key_epoch ||
      agentNostrKey(card) !== row.agent_nostr ||
      ownerFingerprintHex(card) !== row.owner_fingerprint
    ) {
      return unreadable();
    }
    return card;
  }

  /**
   * The proof pack `signer` card for an envelope `from` key (07 §8; 04 §2.9, D-102), for
   * `exportProofPack` (M1-7g): the own current card, or the stored current card of the contact whose
   * current message key is `from`, re-verified, with its `cardSig` and, when stored, its
   * `cardAgentSig` and `cardPop` together, so the pack can verify. A card without the pair (one that
   * came from a peer before M1-4d-d) is returned alone, and its packs stay `record_only`. Undefined
   * for any other key, an earlier epoch's key included: only the current card is stored.
   */
  async proofSigner(from: string): Promise<ProofPackSigner | undefined> {
    const ctx = this.#ctx;
    if (typeof from !== 'string' || !/^[0-9a-f]{64}$/.test(from)) return undefined;
    const got = await readIdentity(ctx);
    if (got !== undefined) {
      const own = await openOwnCard(ctx, got.row);
      if (own !== undefined && agentNostrKey(own.card) === from) return signerOf(own);
    }
    const row = await ctx.store.transaction((tx) =>
      tx.select('contacts', { agent_nostr: from }).find((r) => r.status !== 'removed'),
    );
    if (row === undefined) return undefined;
    const stored = parseStoredCard(
      await open(ctx, 'contacts', 'agent_card_json', [row.contact_id], row.agent_card_json),
    );
    const { card } = stored;
    if (
      card.agentEvm !== row.contact_id ||
      card.keyEpoch !== row.key_epoch ||
      agentNostrKey(card) !== row.agent_nostr ||
      ownerFingerprintHex(card) !== row.owner_fingerprint
    ) {
      return unreadable();
    }
    return signerOf(stored);
  }

  /**
   * Who may sign an owner action for this agent (04 §2.5.1): the agent's own ID from its KeyStore and
   * `ownerNostr` from its own stored card, re-verified as IdentityService reads it (openOwnCard,
   * IR-M1-7c-b-1 F03), and whether the own agent is revoked. Undefined before init.
   */
  async #ownAuthority(): Promise<
    (Omit<ContactCheckContext, 'now'> & { readonly revoked: boolean }) | undefined
  > {
    const ctx = this.#ctx;
    const { agentId } = await ctx.keyStore.getPublicBundle();
    const got = await readIdentity(ctx);
    if (got?.row.agent_id !== agentId) return undefined;
    const stored = await openOwnCard(ctx, got.row);
    if (stored === undefined) return undefined;
    return { agent: agentId, ownerNostr: stored.card.ownerNostr, revoked: got.revoked };
  }

  /** 04 §3.6.1: the stored `contact.check` against a fresh recomputation; never a flag or digest. */
  async #safetyCodeChecked(row: Row<'contacts'>, card: AgentCard): Promise<boolean> {
    if (row.safety_check === null || row.pairing !== 'complete') return false;
    let stored: unknown;
    try {
      stored = parseJson(row.safety_check);
    } catch {
      return false;
    }
    const own = await this.#ownAuthority();
    if (own === undefined) return false;
    const pair = await recomputeStoredPairing(this.#ctx, row.contact_id, card);
    if (pair.status !== 'ok') return false;
    return storedContactCheckHolds(stored, {
      agent: own.agent,
      ownerNostr: own.ownerNostr,
      contact: row.contact_id,
      pairingDigest: pair.pairingDigest,
    });
  }

  async #view(row: Row<'contacts'>): Promise<ContactView> {
    const key = [row.contact_id];
    const card = await this.#card(row);
    const name = await open(this.#ctx, 'contacts', 'name', key, row.name);
    const short = formatFingerprint(decodeHex(row.owner_fingerprint, { length: 32 }), 'short');
    const safetyCodeChecked = await this.#safetyCodeChecked(row, card);
    const label: IdentityLabel = safetyCodeChecked ? 'safety-code-checked' : 'self-declared';
    const display: ContactDisplayName =
      row.name_source === 'owner'
        ? { name: name as OwnerAlias, label, nameSource: 'owner' }
        : { name: restrictName(name, short), label, nameSource: 'counterparty' };
    return {
      id: row.contact_id,
      name: {
        value: name,
        source: row.name_source,
        selfDeclared: row.name_source === 'counterparty',
      },
      display,
      card,
      keyEpoch: row.key_epoch,
      ownerFingerprint: {
        short,
        long: row.owner_fingerprint,
      },
      status: row.status,
      pairing: row.pairing,
      safetyCodeChecked,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Contacts that are not removed, oldest first. */
  async list(): Promise<ContactView[]> {
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select(
        'contacts',
        { status: { ne: 'removed' } },
        {
          orderBy: [
            ['created_at', 'asc'],
            ['contact_id', 'asc'],
          ],
        },
      ),
    );
    const out: ContactView[] = [];
    for (const row of rows) out.push(await this.#view(row));
    return out;
  }

  async get(id: string): Promise<ContactView> {
    const row = await this.#ctx.store.transaction((tx) => tx.get('contacts', { contact_id: id }));
    if (row === undefined || row.status === 'removed') return notFound();
    return this.#view(row);
  }

  /**
   * Applies an owner-signed `contact.check` (04 §2.5.1, §3.6.1; G-28): "They match" on an owner
   * surface (the local app, the desktop app, `agentlink contacts --verify` in the owner's terminal).
   * Authority is the owner signature alone (I-4): no MCP tool produces or passes one.
   *
   * Refused, with nothing written, unless: the object is in its exact strict form; it is bound to
   * this agent and signed by the owner key in this agent's own card; it is fresh (G-7: `issuedAt` at
   * most S ahead, not expired, lifetime at most 24 h); `contact` is a contact with a completed
   * pairing; its `pairingDigest` equals the digest recomputed now from that pairing's stored signed
   * `handshake` and `handshake-ack`. The nonce is checked after the object checks and before the
   * op's rule (04 §2.5.1). One store transaction then checks that the contact still points at the
   * same pair, checks the nonce again and records it (07 §3.4) and stores the signed object in
   * `safety_check`. A later check with a fresh nonce replaces it (idempotent).
   *
   * Refused with `identity_revoked` once the own agent is revoked, like every owner action (M1-7d).
   * OwnerActions.apply routes a `contact.check` here; its refusal codes are OwnerActionRefusal codes.
   */
  async applyContactCheck(signed: unknown): Promise<ContactCheckOutcome> {
    const ctx = this.#ctx;
    const now = nowOf(ctx);
    const refused = (reason: ContactCheckRefusal): ContactCheckOutcome => {
      // A fixed code only: nothing from the object or the contact (I-5, I-7).
      ctx.log.warn('owner action refused', { op: 'contact.check', reason });
      return { status: 'refused', reason };
    };
    const own = await this.#ownAuthority();
    if (own === undefined) return refused('identity_missing');
    if (own.revoked) return refused('identity_revoked');
    let pair: StoredPairingCode | undefined;
    const lookup = async (contact: string): Promise<PairingDigestLookup> => {
      const row = await ctx.store.transaction((tx) => {
        const r = tx.get('contacts', { contact_id: contact });
        return r === undefined || r.status === 'removed' || isRevoked(tx, contact, r)
          ? undefined
          : r;
      });
      if (row === undefined) return { status: 'unknown' };
      pair = await recomputeStoredPairing(ctx, contact, await this.#card(row));
      if (pair.status === 'ok') return { status: 'ok', pairingDigest: pair.pairingDigest };
      return pair.reason === 'not_paired' ? { status: 'unknown' } : { status: 'unavailable' };
    };
    const nonceUsed = (nonce: string): Promise<boolean> =>
      ctx.store.transaction((tx) => tx.get('owner_action_nonces', { nonce }) !== undefined);
    const verdict = await verifyContactCheck(
      signed,
      { agent: own.agent, ownerNostr: own.ownerNostr, now, nonceUsed },
      lookup,
    );
    if (!verdict.ok) return refused(verdict.reason);
    const checked = pair;
    if (checked?.status !== 'ok') return refused('pairing_unavailable');
    const { body } = verdict.signed;
    const text = canonicalize(verdict.signed as unknown as JsonValue);
    const written = await ctx.store.transaction((tx): Row<'contacts'> | ContactCheckRefusal => {
      const row = tx.get('contacts', { contact_id: body.params.contact });
      if (
        row === undefined ||
        row.status === 'removed' ||
        isRevoked(tx, row.contact_id, row) ||
        row.pairing !== 'complete' ||
        row.handshake_envelope_id !== checked.handshakeEnvelopeId ||
        row.handshake_ack_envelope_id !== checked.ackEnvelopeId
      ) {
        return 'store_changed';
      }
      if (tx.get('owner_action_nonces', { nonce: body.nonce }) !== undefined) return 'nonce_used';
      tx.insert('owner_action_nonces', {
        nonce: body.nonce,
        op: body.op,
        action_hash: verdict.actionHash,
        issued_at: body.issuedAt,
        expires_at: body.expiresAt,
        applied_at: now,
      });
      const patch = { safety_check: text, safety_code_checked: 1 as const, updated_at: now };
      tx.update('contacts', { contact_id: row.contact_id }, patch);
      return { ...row, ...patch };
    });
    if (typeof written === 'string') return refused(written);
    ctx.log.info('safety code checked by the owner', { op: 'contact.check' });
    return { status: 'applied', contact: await this.#view(written) };
  }

  /**
   * Checks a received card for staging (04 §2.9): the card, the re-pair rules and the key rule, and
   * seals its values. `apply` writes the `pairings` row inside the caller's store transaction and
   * checks the rules again there; nothing in `contacts` changes. The pairing flow (M1-7c) stages and
   * stores its own pairing envelope in one transaction.
   */
  async prepareStage(input: StagePairingInput): Promise<PreparedStage> {
    const ctx = this.#ctx;
    const now = nowOf(ctx);
    const checked = checkReceivedCard(input, { requireAgentSig: true, now });
    const { card } = checked;
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      throw new CoreError(
        'pairing_expired',
        'The pairing has expired. Start again with a new invite.',
      );
    }
    if (input.role !== 'inviter' && input.role !== 'invitee') {
      throw new CoreError('card_invalid', 'The pairing role is not valid.');
    }
    const own = await ctx.keyStore.getPublicBundle();
    if (card.agentEvm === own.agentId) {
      throw new CoreError('contact_is_self', 'An agent cannot add itself as a contact.');
    }
    let pairingId: string;
    if (input.pairingId === undefined) {
      pairingId = encodeBase64url(randomBytes(PAIRING_ID_BYTES));
    } else {
      try {
        decodeBase64url(input.pairingId, { length: PAIRING_ID_BYTES });
      } catch {
        throw new CoreError('pairing_not_found', 'No pairing in progress has that ID.');
      }
      pairingId = input.pairingId;
    }
    const ownKeys = await this.#ownKeys();
    const id = card.agentEvm;
    const nostr = agentNostrKey(card);
    const fingerprint = ownerFingerprintHex(card);
    const key = [pairingId];
    const row: Row<'pairings'> = {
      pairing_id: pairingId,
      contact_id: id,
      role: input.role,
      agent_nostr: nostr,
      key_epoch: card.keyEpoch,
      owner_fingerprint: fingerprint,
      agent_card_json: await seal(ctx, 'pairings', 'agent_card_json', key, storedCardText(checked)),
      name: await seal(ctx, 'pairings', 'name', key, checked.name),
      relays: await seal(ctx, 'pairings', 'relays', key, canonicalize([...checked.relays])),
      created_at: now,
      expires_at: input.expiresAt,
    };
    const staged: StagedPairing = {
      pairingId,
      role: input.role,
      card,
      cardSig: checked.cardSig,
      cardAgentSig: checked.cardAgentSig,
      cardPop: checked.cardPop,
      name: checked.name,
      relays: checked.relays,
      expiresAt: input.expiresAt,
    };
    const apply = (tx: StoreTx): void => {
      const existing = tx.get('contacts', { contact_id: id });
      if (isRevoked(tx, id, existing)) {
        throw new CoreError('contact_revoked', 'That agent has been revoked and cannot be paired.');
      }
      assertRepairAllowed(existing, { ownerFingerprint: fingerprint, keyEpoch: card.keyEpoch });
      assertKeyFree(tx, id, nostr, ownKeys);
      tx.insert('pairings', row);
    };
    return { staged, apply };
  }

  /**
   * Stages a pairing from a received card (04 §2.9). Checks the card and the re-pair rules, then
   * stores it in `pairings`. Nothing about an existing contact changes until completePairing.
   */
  async stagePairing(input: StagePairingInput): Promise<{ readonly pairingId: string }> {
    const prepared = await this.prepareStage(input);
    await this.#ctx.store.transaction((tx) => prepared.apply(tx));
    return { pairingId: prepared.staged.pairingId };
  }

  /** Drops a staged pairing that will not complete. Changes nothing else. */
  async abortPairing(pairingId: string): Promise<void> {
    const deleted = await this.#ctx.store.transaction((tx) =>
      tx.delete('pairings', { pairing_id: pairingId }),
    );
    if (deleted === 0) {
      throw new CoreError('pairing_not_found', 'No pairing in progress has that ID.');
    }
  }

  /**
   * A staged pairing read back and checked again in full (its card, also its expiry at `now`), or
   * undefined when none has that ID. A row that does not match its own clear columns is unreadable.
   */
  async readStaged(pairingId: string): Promise<StagedPairing | undefined> {
    const ctx = this.#ctx;
    const row = await ctx.store.transaction((tx) => tx.get('pairings', { pairing_id: pairingId }));
    if (row === undefined) return undefined;
    const key = [pairingId];
    const stored = parseStoredCard(
      await open(ctx, 'pairings', 'agent_card_json', key, row.agent_card_json),
    );
    const name = await open(ctx, 'pairings', 'name', key, row.name);
    const relaysText = await open(ctx, 'pairings', 'relays', key, row.relays);
    let relays: unknown;
    try {
      relays = JSON.parse(relaysText);
    } catch {
      return unreadable();
    }
    const checked = checkReceivedCard(
      {
        card: stored.card,
        cardSig: stored.cardSig,
        cardAgentSig: stored.cardAgentSig,
        ...(stored.cardPop === null ? {} : { cardPop: stored.cardPop }),
        name,
        relays,
      },
      { requireAgentSig: true, now: nowOf(ctx) },
    );
    const { card } = checked;
    if (
      card.agentEvm !== row.contact_id ||
      agentNostrKey(card) !== row.agent_nostr ||
      card.keyEpoch !== row.key_epoch ||
      ownerFingerprintHex(card) !== row.owner_fingerprint
    ) {
      return unreadable();
    }
    return {
      pairingId,
      role: row.role,
      card,
      cardSig: checked.cardSig,
      cardAgentSig: checked.cardAgentSig,
      cardPop: checked.cardPop,
      name: checked.name,
      relays: checked.relays,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Prepares the completion of a staged pairing from its verified transcript (04 §2.9, §3.6,
   * §3.6.1). The binding (IR-M1-7a-1 R2-L1): the pairing ID is the `handshake` envelope `id`, the
   * transcript passed 04 §3.6.1 steps 1-5 for this agent, this side's role is the staged role, and
   * the counterparty card in it is exactly the staged card. So another pairing's envelopes, even
   * between the same two agents, complete nothing here. `apply` runs inside the caller's store
   * transaction: the staged row and both envelope rows (by ID and envelopeHash, the counterparty's
   * received from the card key and processed, ours sent) are checked again, then the revocation,
   * re-pair and key rules, the 04 §2.9 tie-break for concurrent pairings, and the contact is written
   * and the staged row deleted. A completed re-pair replaces the card and the pairing columns and
   * clears the safety check (a new pairing has a new code). A removed contact becomes active again;
   * a blocked one stays blocked.
   */
  async prepareCompletion(
    staged: StagedPairing,
    transcript: PairingTranscript,
  ): Promise<PreparedCompletion> {
    const ctx = this.#ctx;
    const missing = (): never => {
      throw new CoreError(
        'pairing_evidence_missing',
        'The pairing has not completed: its handshake is missing.',
      );
    };
    const self = await ctx.keyStore.getPublicBundle();
    if (
      transcript.handshake.envelope.id !== staged.pairingId ||
      transcript.role !== staged.role ||
      canonicalize(transcript.peerCard as unknown as JsonValue) !==
        canonicalize(staged.card as unknown as JsonValue) ||
      (staged.role === 'inviter' ? transcript.inviterCard : transcript.inviteeCard).agentEvm !==
        self.agentId
    ) {
      return missing();
    }
    const now = nowOf(ctx);
    const { card } = staged;
    const ownKeys = await this.#ownKeys();
    const id = card.agentEvm;
    const nostr = agentNostrKey(card);
    const fingerprint = ownerFingerprintHex(card);
    const ckey = [id];
    const signed: StoredCard = {
      card,
      cardSig: staged.cardSig,
      cardAgentSig: staged.cardAgentSig,
      cardPop: staged.cardPop,
    };
    const sealedCard = await seal(ctx, 'contacts', 'agent_card_json', ckey, storedCardText(signed));
    const sealedName = await seal(ctx, 'contacts', 'name', ckey, staged.name);
    const sealedRelays = await seal(
      ctx,
      'contacts',
      'relays',
      ckey,
      canonicalize([...staged.relays]),
    );
    const handshakeId = transcript.handshake.envelope.id;
    const ackId = transcript.ack.envelope.id;
    const apply = (tx: StoreTx): PairingCompletion => {
      const current = tx.get('pairings', { pairing_id: staged.pairingId });
      if (current === undefined) {
        throw new CoreError('pairing_not_found', 'No pairing in progress has that ID.');
      }
      if (current.expires_at <= now) {
        throw new CoreError(
          'pairing_expired',
          'The pairing has expired. Start again with a new invite.',
        );
      }
      if (
        current.role !== staged.role ||
        current.contact_id !== id ||
        current.agent_nostr !== nostr ||
        current.key_epoch !== card.keyEpoch ||
        current.owner_fingerprint !== fingerprint
      ) {
        return missing();
      }
      // Evidence (04 §2.9 liveness): both envelopes stored exactly as verified; the counterparty's
      // received from the card's key and processed, ours sent.
      const handshake = tx.get('envelopes', { envelope_id: handshakeId });
      const ack = tx.get('envelopes', { envelope_id: ackId });
      const [theirs, ours] = current.role === 'inviter' ? [handshake, ack] : [ack, handshake];
      if (
        handshake?.type !== 'handshake' ||
        handshake.envelope_hash !== transcript.handshake.hash ||
        ack?.type !== 'handshake-ack' ||
        ack.envelope_hash !== transcript.ack.hash ||
        theirs?.direction !== 'in' ||
        theirs.state !== 'ok' ||
        theirs.from_key !== current.agent_nostr ||
        ours?.direction !== 'out'
      ) {
        return missing();
      }
      const existing = tx.get('contacts', { contact_id: id });
      if (isRevoked(tx, id, existing)) {
        throw new CoreError('contact_revoked', 'That agent has been revoked and cannot be paired.');
      }
      assertRepairAllowed(existing, {
        ownerFingerprint: current.owner_fingerprint,
        keyEpoch: current.key_epoch,
      });
      assertKeyFree(tx, id, current.agent_nostr, ownKeys);
      for (const envelopeId of [handshakeId, ackId]) {
        tx.update('envelopes', { envelope_id: envelopeId }, { contact_id: id });
      }
      if (tx.delete('pairings', { pairing_id: staged.pairingId }) !== 1) {
        throw new CoreError('pairing_not_found', 'No pairing in progress has that ID.');
      }
      // 04 §2.9 concurrent pairings: keep the completed pairing whose handshake has the later
      // createdAt, ties broken by the larger envelopeHash (compared as bytes: same-length lowercase
      // hex compares the same way). Both sides hold both handshakes, so both keep the same one.
      if (existing?.pairing === 'complete' && existing.handshake_envelope_id !== null) {
        const kept = tx.get('envelopes', { envelope_id: existing.handshake_envelope_id });
        const createdAt = transcript.handshake.envelope.createdAt;
        if (
          kept !== undefined &&
          (kept.created_at > createdAt ||
            (kept.created_at === createdAt && kept.envelope_hash > transcript.handshake.hash))
        ) {
          return { row: existing, replaced: false };
        }
      }
      const fields = {
        agent_card_json: sealedCard,
        relays: sealedRelays,
        agent_nostr: current.agent_nostr,
        key_epoch: current.key_epoch,
        owner_fingerprint: current.owner_fingerprint,
        verified: 0 as const,
        pairing: 'complete' as const,
        handshake_envelope_id: handshakeId,
        handshake_ack_envelope_id: ackId,
        code_commit: null,
        nonce_b: null,
        safety_check: null,
        safety_code_checked: 0 as const,
        updated_at: now,
      };
      let written: Row<'contacts'>;
      if (existing === undefined) {
        written = {
          contact_id: id,
          name: sealedName,
          name_source: 'counterparty',
          ...fields,
          nostr_keys: JSON.stringify([current.agent_nostr]),
          status: 'active',
          created_at: now,
        };
        tx.insert('contacts', written);
      } else {
        // L-4: a name the owner chose is kept; the counterparty name follows its card otherwise.
        const ownerName = existing.name_source === 'owner';
        const patch = {
          ...fields,
          name: ownerName ? existing.name : sealedName,
          name_source: existing.name_source,
          nostr_keys: withKey(parseKeyList(existing.nostr_keys), current.agent_nostr),
          status: existing.status === 'removed' ? ('active' as const) : existing.status,
        };
        const where = {
          contact_id: id,
          updated_at: existing.updated_at,
          key_epoch: existing.key_epoch,
        };
        if (tx.update('contacts', where, patch) !== 1) {
          throw new CoreError('contact_conflict', 'The contact changed meanwhile. Try again.');
        }
        written = { ...existing, ...patch };
      }
      return { row: written, replaced: true };
    };
    return { contactId: id, apply };
  }

  /**
   * Commits a staged pairing from its two stored pairing envelopes (04 §2.9, §3.6). Both are opened
   * with the agent's own key and verified as a transcript (04 §3.6.1 steps 1-5) bound to this
   * pairing (prepareCompletion); a pair that does not verify, or that belongs to another pairing, is
   * `pairing_evidence_missing`. The pairing flow (M1-7c) completes inside the transaction that
   * stores the last envelope; this entry point completes from envelopes already stored.
   */
  async completePairing(input: CompletePairingInput): Promise<ContactView> {
    const ctx = this.#ctx;
    const staged = await this.readStaged(input.pairingId);
    if (staged === undefined) {
      throw new CoreError('pairing_not_found', 'No pairing in progress has that ID.');
    }
    const missing = (): never => {
      throw new CoreError(
        'pairing_evidence_missing',
        'The pairing has not completed: its handshake is missing.',
      );
    };
    if (input.handshakeEnvelopeId !== input.pairingId) return missing();
    const rows = await ctx.store.transaction((tx) => ({
      handshake: tx.get('envelopes', { envelope_id: input.handshakeEnvelopeId }),
      ack: tx.get('envelopes', { envelope_id: input.handshakeAckEnvelopeId }),
    }));
    if (rows.handshake === undefined || rows.ack === undefined) return missing();
    let transcript: PairingTranscript;
    try {
      const kids = await ownKids(ctx);
      transcript = verifyPairingTranscript({
        self: (await ctx.keyStore.getPublicBundle()).agentId,
        contactCard: staged.card,
        handshake: await openStoredPairingMessage(ctx, rows.handshake.envelope_json, kids),
        ack: await openStoredPairingMessage(ctx, rows.ack.envelope_json, kids),
      });
    } catch (error) {
      if (error instanceof CoreError && error.code === 'safety_code_unavailable') return missing();
      throw error;
    }
    if (transcript.ack.envelope.id !== input.handshakeAckEnvelopeId) return missing();
    const prepared = await this.prepareCompletion(staged, transcript);
    const done = await ctx.store.transaction((tx) => prepared.apply(tx));
    ctx.log.info('pairing completed', { keyEpoch: done.row.key_epoch });
    return this.#view(done.row);
  }

  /** Applies a verified card-update (04 §2.6, §3.4.1): same agent and owner, strictly higher epoch. */
  async applyCardUpdate(input: CardUpdateInput): Promise<ContactView> {
    const prepared = await this.prepareCardUpdate(input);
    const row = await this.#ctx.store.transaction((tx) => prepared.apply(tx));
    this.#ctx.log.info('contact card updated', { keyEpoch: prepared.card.keyEpoch });
    return this.#view(row);
  }

  /**
   * Every stored contact's current card with its status (removed and revoked included), for the
   * inbound checks of 04 §3.1.1 (M1-7b): the owner-key table and the hold rule by owner `kid` (step
   * 7) and the wrap check against the sender's card (step 8). Each card is re-verified on load; one
   * that does not verify makes the store unreadable (fail closed).
   */
  async inboundCards(): Promise<readonly InboundCard[]> {
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select('contacts', {}, { orderBy: [['contact_id', 'asc']] }).map((row) => ({
        row,
        revoked: isRevoked(tx, row.contact_id, row),
      })),
    );
    const out: InboundCard[] = [];
    for (const { row, revoked } of rows) {
      const view = await this.#view(row);
      out.push({ id: view.id, status: revoked ? 'revoked' : row.status, card: view.card });
    }
    return out;
  }

  /**
   * Checks a card-update body (04 §3.4.1: cardSig, name and relays against the card) and seals its
   * values, so the caller can apply it inside its own store transaction: M1-7b commits the
   * envelope's outcome and the new card together (07 §3.2). `apply` checks the stored contact again
   * (same agent and owner keys, strictly higher epoch, not removed or revoked, the key rule) and
   * throws a CoreError otherwise, which aborts that transaction.
   */
  async prepareCardUpdate(input: CardUpdateInput): Promise<PreparedCardUpdate> {
    const ctx = this.#ctx;
    const now = nowOf(ctx);
    // 04 §2.9 (D-102): both or neither; a present pair that does not verify drops the whole body.
    if ((input.cardAgentSig === undefined) !== (input.cardPop === undefined)) {
      throw cardPopInvalid();
    }
    const checked = checkReceivedCard(
      {
        card: input.card,
        cardSig: input.cardSig,
        ...(input.cardAgentSig === undefined ? {} : { cardAgentSig: input.cardAgentSig }),
        ...(input.cardPop === undefined ? {} : { cardPop: input.cardPop }),
        name: input.name,
        relays: input.relays,
      },
      { requireAgentSig: false, now },
    );
    const { card } = checked;
    const id = card.agentEvm;
    const nostr = agentNostrKey(card);
    const fingerprint = ownerFingerprintHex(card);
    const ownKeys = await this.#ownKeys();
    const key = [id];
    const update: StoredCard = {
      card,
      cardSig: checked.cardSig,
      cardAgentSig: checked.cardAgentSig,
      cardPop: checked.cardPop,
    };
    const sealedCard = await seal(ctx, 'contacts', 'agent_card_json', key, storedCardText(update));
    const name = await seal(ctx, 'contacts', 'name', key, checked.name);
    const relays = await seal(ctx, 'contacts', 'relays', key, canonicalize([...checked.relays]));
    const apply = (tx: StoreTx): Row<'contacts'> => {
      const existing = tx.get('contacts', { contact_id: id });
      if (existing === undefined || existing.status === 'removed') return notFound();
      if (isRevoked(tx, id, existing)) {
        throw new CoreError('contact_revoked', 'That agent has been revoked.');
      }
      if (existing.owner_fingerprint !== fingerprint) {
        throw new CoreError('owner_keys_changed', 'The owner keys differ from the stored card.');
      }
      if (card.keyEpoch <= existing.key_epoch) {
        throw new CoreError('card_update_not_newer', 'That card is not newer than the stored one.');
      }
      assertKeyFree(tx, id, nostr, ownKeys);
      const ownerName = existing.name_source === 'owner';
      const patch = {
        // L-4: a name the owner chose is kept.
        name: ownerName ? existing.name : name,
        agent_card_json: sealedCard,
        relays,
        agent_nostr: nostr,
        key_epoch: card.keyEpoch,
        nostr_keys: withKey(parseKeyList(existing.nostr_keys), nostr),
        updated_at: now,
      };
      if (tx.update('contacts', { contact_id: id, key_epoch: existing.key_epoch }, patch) !== 1) {
        throw new CoreError('contact_conflict', 'The contact changed meanwhile. Try again.');
      }
      return { ...existing, ...patch };
    };
    return { card, apply };
  }

  /** Blocks a contact (F-14): its later envelopes are dropped. A revoked contact stays revoked. */
  async block(id: string): Promise<ContactView> {
    const now = nowOf(this.#ctx);
    const row = await this.#ctx.store.transaction((tx) => {
      const existing = tx.get('contacts', { contact_id: id });
      if (existing === undefined || existing.status === 'removed') return undefined;
      tx.update(
        'contacts',
        { contact_id: id, status: 'active' },
        { status: 'blocked', updated_at: now },
      );
      return tx.get('contacts', { contact_id: id });
    });
    if (row === undefined) return notFound();
    return this.#view(row);
  }

  /**
   * Removes a contact (F-14): a tombstone with status `removed` that keeps its keys, so its later
   * envelopes are dropped (M-1). A revoked contact stays revoked. Only a fresh completed pairing
   * brings a removed contact back.
   */
  async remove(id: string): Promise<void> {
    const now = nowOf(this.#ctx);
    const found = await this.#ctx.store.transaction((tx) => {
      const existing = tx.get('contacts', { contact_id: id });
      if (existing === undefined || existing.status === 'removed') return false;
      tx.update(
        'contacts',
        { contact_id: id, status: { in: ['active', 'blocked'] } },
        { status: 'removed', updated_at: now },
      );
      return true;
    });
    if (!found) notFound();
  }

  /**
   * Classifies an inbound envelope's `from` (64 lowercase hex) against the contacts and the revoked
   * set, and drops it for a blocked, removed or revoked agent (F-14, 04 §3.4.1). M1-7b runs it at 04
   * §3.1.1 step 7, after the signature (step 4) authenticated `from`; only then may it record the
   * dropped envelope in the seen-set (07 §3.2). Before step 4 `from` is unauthenticated: a drop there
   * writes nothing (L-7). A read error throws, so the envelope is neither processed nor marked as
   * seen (fail closed).
   */
  async screenInbound(from: string): Promise<InboundScreen> {
    if (typeof from !== 'string' || !NOSTR_KEY.test(from)) {
      return { action: 'drop', reason: 'malformed' };
    }
    return this.#ctx.store.transaction((tx) => screenInboundTx(tx, from));
  }
}

/**
 * screenInbound inside the caller's store transaction (M1-7b: the screen and the outcome it leads to
 * commit together, 07 §3.2). A `from` that is not 64 lowercase hex is `malformed`.
 */
export function screenInboundTx(tx: StoreTx, from: string): InboundScreen {
  if (!NOSTR_KEY.test(from)) return { action: 'drop', reason: 'malformed' };
  for (const revoked of tx.select('revoked_agents')) {
    if (parseKeyList(revoked.nostr_keys).includes(from)) {
      return { action: 'drop', reason: 'revoked' };
    }
  }
  let row = tx.select('contacts', { agent_nostr: from })[0];
  let kind: 'contact' | 'superseded' = 'contact';
  if (row === undefined) {
    row = tx.select('contacts').find((r) => parseKeyList(r.nostr_keys).includes(from));
    kind = 'superseded';
  }
  if (row === undefined) return { action: 'continue', sender: { kind: 'unknown' } };
  if (isRevoked(tx, row.contact_id, row)) return { action: 'drop', reason: 'revoked' };
  if (row.status === 'blocked') return { action: 'drop', reason: 'blocked' };
  if (row.status === 'removed') return { action: 'drop', reason: 'removed' };
  return { action: 'continue', sender: { kind, contactId: row.contact_id } };
}
