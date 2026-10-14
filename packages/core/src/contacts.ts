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
import {
  canonicalize,
  decodeHex,
  encodeBase64url,
  encodeHex,
  formatFingerprint,
  randomBytes,
  type AgentCard,
} from '@agentlink/crypto';
import {
  agentNostrKey,
  checkReceivedCard,
  ownerFingerprintHex,
  parseStoredCard,
  storedCardText,
  type CardInput,
  type StoredCard,
} from './card.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import type { Row } from './store/schema.js';
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
  readonly card: AgentCard;
  readonly keyEpoch: number;
  /** Display only: identifies, does not authenticate (04 §2.9). */
  readonly ownerFingerprint: { readonly short: string; readonly long: string };
  readonly status: ContactStatus;
  readonly pairing: PairingState;
  readonly safetyCodeChecked: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A received card to stage for pairing, with this side's role and the invite's expiry. */
export interface StagePairingInput extends CardInput {
  /** `inviter` (A, made the invite) or `invitee` (B, accepted it) (04 §3.6). */
  readonly role: 'inviter' | 'invitee';
  /** When the staged pairing lapses, in unix seconds: the invite's expiry (04 §2.9). */
  readonly expiresAt: number;
}

/** The completion evidence: both pairing envelopes, as stored by M1-7c (04 §3.6, §3.4.1). */
export interface CompletePairingInput {
  readonly pairingId: string;
  readonly handshakeEnvelopeId: string;
  readonly handshakeAckEnvelopeId: string;
}

/** A card-update body (04 §3.4.1): no cardAgentSig is needed. */
export interface CardUpdateInput {
  readonly card: unknown;
  readonly cardSig: unknown;
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

  async #view(row: Row<'contacts'>): Promise<ContactView> {
    const key = [row.contact_id];
    const stored = parseStoredCard(
      await open(this.#ctx, 'contacts', 'agent_card_json', key, row.agent_card_json),
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
    const name = await open(this.#ctx, 'contacts', 'name', key, row.name);
    return {
      id: row.contact_id,
      name: {
        value: name,
        source: row.name_source,
        selfDeclared: row.name_source === 'counterparty',
      },
      card,
      keyEpoch: row.key_epoch,
      ownerFingerprint: {
        short: formatFingerprint(decodeHex(row.owner_fingerprint, { length: 32 }), 'short'),
        long: row.owner_fingerprint,
      },
      status: row.status,
      pairing: row.pairing,
      safetyCodeChecked: row.safety_code_checked === 1,
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
   * Stages a pairing from a received card (04 §2.9). Checks the card and the re-pair rules, then
   * stores it in `pairings`. Nothing about an existing contact changes until completePairing.
   */
  async stagePairing(input: StagePairingInput): Promise<{ readonly pairingId: string }> {
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
    const ownKeys = await this.#ownKeys();
    const id = card.agentEvm;
    const nostr = agentNostrKey(card);
    const fingerprint = ownerFingerprintHex(card);
    const pairingId = encodeBase64url(randomBytes(PAIRING_ID_BYTES));
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
    await ctx.store.transaction((tx) => {
      const existing = tx.get('contacts', { contact_id: id });
      if (isRevoked(tx, id, existing)) {
        throw new CoreError('contact_revoked', 'That agent has been revoked and cannot be paired.');
      }
      assertRepairAllowed(existing, { ownerFingerprint: fingerprint, keyEpoch: card.keyEpoch });
      assertKeyFree(tx, id, nostr, ownKeys);
      tx.insert('pairings', row);
    });
    return { pairingId };
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
   * Commits a staged pairing once its handshake completed (04 §2.9, §3.6), in one store transaction:
   * the evidence, the revocation and re-pair rules and the key rule are checked again, the contact is
   * written with pairing `complete` and the staged row is deleted. A completed re-pair replaces the
   * card and the pairing columns and clears the safety check (a new pairing has a new code). A removed
   * contact becomes active again; a blocked one stays blocked.
   */
  async completePairing(input: CompletePairingInput): Promise<ContactView> {
    const ctx = this.#ctx;
    const { pairingId } = input;
    const staged = await ctx.store.transaction((tx) =>
      tx.get('pairings', { pairing_id: pairingId }),
    );
    if (staged === undefined) {
      throw new CoreError('pairing_not_found', 'No pairing in progress has that ID.');
    }
    const now = nowOf(ctx);
    const skey = [pairingId];
    const stored = parseStoredCard(
      await open(ctx, 'pairings', 'agent_card_json', skey, staged.agent_card_json),
    );
    const name = await open(ctx, 'pairings', 'name', skey, staged.name);
    const relaysText = await open(ctx, 'pairings', 'relays', skey, staged.relays);
    let relays: unknown;
    try {
      relays = JSON.parse(relaysText);
    } catch {
      return unreadable();
    }
    // The staged card is checked again in full (also its expiry at `now`).
    const checked = checkReceivedCard(
      {
        card: stored.card,
        cardSig: stored.cardSig,
        cardAgentSig: stored.cardAgentSig,
        name,
        relays,
      },
      { requireAgentSig: true, now },
    );
    const { card } = checked;
    if (
      card.agentEvm !== staged.contact_id ||
      agentNostrKey(card) !== staged.agent_nostr ||
      card.keyEpoch !== staged.key_epoch ||
      ownerFingerprintHex(card) !== staged.owner_fingerprint
    ) {
      return unreadable();
    }
    const ownKeys = await this.#ownKeys();
    const id = card.agentEvm;
    const ckey = [id];
    const sealedCard = await seal(
      ctx,
      'contacts',
      'agent_card_json',
      ckey,
      storedCardText(checked),
    );
    const sealedName = await seal(ctx, 'contacts', 'name', ckey, checked.name);
    const sealedRelays = await seal(
      ctx,
      'contacts',
      'relays',
      ckey,
      canonicalize([...checked.relays]),
    );

    const row = await ctx.store.transaction((tx): Row<'contacts'> => {
      const current = tx.get('pairings', { pairing_id: pairingId });
      if (current === undefined) {
        throw new CoreError('pairing_not_found', 'No pairing in progress has that ID.');
      }
      if (current.expires_at <= now) {
        throw new CoreError(
          'pairing_expired',
          'The pairing has expired. Start again with a new invite.',
        );
      }
      // Evidence (04 §2.9 liveness): the counterparty's envelope was received from the card's key
      // and processed; ours was sent. M1-7c verifies and stores both before calling this.
      const handshake = tx.get('envelopes', { envelope_id: input.handshakeEnvelopeId });
      const ack = tx.get('envelopes', { envelope_id: input.handshakeAckEnvelopeId });
      const [theirs, ours] = current.role === 'inviter' ? [handshake, ack] : [ack, handshake];
      if (
        handshake?.type !== 'handshake' ||
        ack?.type !== 'handshake-ack' ||
        theirs?.direction !== 'in' ||
        theirs.state !== 'ok' ||
        theirs.from_key !== current.agent_nostr ||
        ours?.direction !== 'out'
      ) {
        throw new CoreError(
          'pairing_evidence_missing',
          'The pairing has not completed: its handshake is missing.',
        );
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
      const fields = {
        agent_card_json: sealedCard,
        relays: sealedRelays,
        agent_nostr: current.agent_nostr,
        key_epoch: current.key_epoch,
        owner_fingerprint: current.owner_fingerprint,
        verified: 0 as const,
        pairing: 'complete' as const,
        handshake_envelope_id: input.handshakeEnvelopeId,
        handshake_ack_envelope_id: input.handshakeAckEnvelopeId,
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
      if (tx.delete('pairings', { pairing_id: pairingId }) !== 1) {
        throw new CoreError('pairing_not_found', 'No pairing in progress has that ID.');
      }
      return written;
    });
    ctx.log.info('pairing completed', { keyEpoch: row.key_epoch });
    return this.#view(row);
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
    const checked = checkReceivedCard(
      { card: input.card, cardSig: input.cardSig, name: input.name, relays: input.relays },
      { requireAgentSig: false, now },
    );
    const { card } = checked;
    const id = card.agentEvm;
    const nostr = agentNostrKey(card);
    const fingerprint = ownerFingerprintHex(card);
    const ownKeys = await this.#ownKeys();
    const key = [id];
    const update: StoredCard = { card, cardSig: checked.cardSig, cardAgentSig: null };
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
