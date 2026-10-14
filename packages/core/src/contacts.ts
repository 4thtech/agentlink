// Contacts (04 §2.9, §2.6, §3.4.1; 02 F-13, F-14; 07 §3 `contacts`).
//
// - Keyed by agentId: at most one contact per agentId, never the own agentId.
// - A contact is added only from a verified card: cardSig by ownerEvm, cardAgentSig by agentEvm, name
//   and relays matching the card. The pairing protocol (handshake, ack, safety code) is M1-7c; it calls
//   addFromCard when a pairing completes, so nothing changes before completion (04 §2.9).
// - A re-pair (an agentId that is already a contact) is allowed only with unchanged owner keys and a
//   keyEpoch that is not lower, and never for a revoked agentId. A revocation is final: a
//   `revoked_agents` row is never deleted, so a removed revoked contact cannot be paired again.
// - A card-update needs only cardSig, the same agentEvm and owner keys and a strictly higher epoch.
// - Block keeps the contact and drops its later envelopes (F-14). Remove deletes the contact; its keys
//   are then unknown senders, which go to the requests queue (F-13), unless revoked.
// - Display names are self-declared (04 §2.4) and untrusted (I-5): callers show them only under the
//   contact-name rule or inside the untrusted block (06 §2.1, §4).
import {
  canonicalize,
  decodeHex,
  decodeHex0x,
  encodeHex,
  formatFingerprint,
  ownerFingerprint,
  parseAgentCardJson,
  verifyCardOwnerSig,
  type AgentCard,
  type JsonValue,
} from '@agentlink/crypto';
import { agentNostrKey, checkReceivedCard, sameOwnerKeys, type CardInput } from './card.js';
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

/** A card-update body (04 §3.4.1): no cardAgentSig is needed. */
export interface CardUpdateInput {
  readonly card: unknown;
  readonly cardSig: unknown;
  readonly name: unknown;
  readonly relays: unknown;
}

export type InboundSender =
  | { readonly kind: 'contact'; readonly contactId: string }
  /** A key of an earlier card of this contact: refused except for a card-update (04 §3.1.1 step 7). */
  | { readonly kind: 'superseded'; readonly contactId: string }
  /** Not a contact key: requests queue or held (04 §3.1.1 step 7, M1-7b). */
  | { readonly kind: 'unknown' };

export type InboundScreen =
  | { readonly action: 'drop'; readonly reason: 'blocked' | 'revoked' | 'malformed' }
  | { readonly action: 'continue'; readonly sender: InboundSender };

const NOSTR_KEY = /^[0-9a-f]{64}$/;

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

function storedCard(row: Row<'contacts'>): AgentCard {
  let card: AgentCard;
  try {
    card = parseAgentCardJson(row.agent_card_json);
  } catch {
    return unreadable();
  }
  // Re-verified on load: a stored card that no longer verifies is unreadable, never trusted.
  if (
    card.agentEvm !== row.contact_id ||
    card.keyEpoch !== row.key_epoch ||
    agentNostrKey(card) !== row.agent_nostr ||
    !verifyCardOwnerSig(card, row.card_sig)
  ) {
    return unreadable();
  }
  return card;
}

/** Revoked means either a `revoked_agents` row or contact status `revoked` (07 §3.4). */
function isRevoked(tx: StoreTx, agentId: string, row: Row<'contacts'> | undefined): boolean {
  return (
    row?.status === 'revoked' || tx.get('revoked_agents', { agent_evm: agentId }) !== undefined
  );
}

function fingerprintLong(card: AgentCard): string {
  return encodeHex(
    ownerFingerprint(
      decodeHex0x(card.ownerEvm, { length: 20 }),
      decodeHex0x(card.ownerNostr, { length: 32 }),
      decodeHex0x(card.ownerEnc, { length: 32 }),
    ),
  );
}

export class ContactBook {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  async #view(row: Row<'contacts'>): Promise<ContactView> {
    const card = storedCard(row);
    const name = await open(this.#ctx, 'contacts', 'name', [row.contact_id], row.name);
    if (fingerprintLong(card) !== row.owner_fingerprint) unreadable();
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

  async #get(id: string): Promise<ContactView> {
    const row = await this.#ctx.store.transaction((tx) => tx.get('contacts', { contact_id: id }));
    if (row === undefined) throw new CoreError('contact_not_found', 'No contact has that ID.');
    return this.#view(row);
  }

  async list(): Promise<ContactView[]> {
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select(
        'contacts',
        {},
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

  get(id: string): Promise<ContactView> {
    return this.#get(id);
  }

  /**
   * Adds a contact from a verified card, or completes a re-pair (04 §2.9). Called by the pairing
   * flow (M1-7c) when a pairing completes.
   */
  async addFromCard(input: CardInput): Promise<ContactView> {
    const ctx = this.#ctx;
    const now = nowOf(ctx);
    const checked = checkReceivedCard(input, { requireAgentSig: true, now });
    const { card } = checked;
    const own = await ctx.keyStore.getPublicBundle();
    if (card.agentEvm === own.agentId) {
      throw new CoreError('contact_is_self', 'An agent cannot add itself as a contact.');
    }
    const id = card.agentEvm;
    const nostr = agentNostrKey(card);
    const fields = {
      name: await seal(ctx, 'contacts', 'name', [id], checked.name),
      name_source: 'counterparty' as const,
      agent_card_json: canonicalize(card as unknown as JsonValue),
      card_sig: checked.cardSig,
      card_agent_sig: checked.cardAgentSig,
      relays: await seal(ctx, 'contacts', 'relays', [id], canonicalize([...checked.relays])),
      agent_nostr: nostr,
      key_epoch: card.keyEpoch,
      owner_fingerprint: fingerprintLong(card),
      // A completed pairing gets new pairing columns and a new safety code (04 §2.9, §3.6.1).
      verified: 0 as const,
      pairing: 'pending' as const,
      handshake_envelope_id: null,
      handshake_ack_envelope_id: null,
      code_commit: null,
      nonce_b: null,
      safety_check: null,
      safety_code_checked: 0 as const,
      updated_at: now,
    };
    const row = await ctx.store.transaction((tx) => {
      const existing = tx.get('contacts', { contact_id: id });
      if (isRevoked(tx, id, existing)) {
        throw new CoreError('contact_revoked', 'That agent has been revoked and cannot be paired.');
      }
      const clash = tx.select('contacts', { agent_nostr: nostr, contact_id: { ne: id } });
      if (clash.length > 0) {
        throw new CoreError('contact_conflict', 'Another contact already uses that agent key.');
      }
      if (existing === undefined) {
        const inserted: Row<'contacts'> = {
          contact_id: id,
          ...fields,
          nostr_keys: JSON.stringify([nostr]),
          status: 'active',
          created_at: now,
        };
        tx.insert('contacts', inserted);
        return inserted;
      }
      // Re-pair (04 §2.9): owner keys unchanged and keyEpoch not lower.
      const before = storedCard(existing);
      if (!sameOwnerKeys(before, card)) {
        throw new CoreError('repair_owner_changed', 'The owner of that agent has changed.');
      }
      if (card.keyEpoch < existing.key_epoch) {
        throw new CoreError('repair_epoch_lower', 'That card is older than the stored one.');
      }
      const keys = parseKeyList(existing.nostr_keys);
      const patch = {
        ...fields,
        nostr_keys: JSON.stringify(keys.includes(nostr) ? keys : [...keys, nostr]),
      };
      if (
        tx.update(
          'contacts',
          { contact_id: id, agent_card_json: existing.agent_card_json },
          patch,
        ) !== 1
      ) {
        throw new CoreError('contact_conflict', 'The contact changed meanwhile. Try again.');
      }
      return { ...existing, ...patch };
    });
    ctx.log.info('contact stored', { keyEpoch: card.keyEpoch });
    return this.#view(row);
  }

  /** Applies a verified card-update (04 §2.6, §3.4.1): same agent and owner, strictly higher epoch. */
  async applyCardUpdate(input: CardUpdateInput): Promise<ContactView> {
    const ctx = this.#ctx;
    const now = nowOf(ctx);
    const checked = checkReceivedCard(
      { card: input.card, cardSig: input.cardSig, name: input.name, relays: input.relays },
      { requireAgentSig: false, now },
    );
    const { card } = checked;
    const id = card.agentEvm;
    const nostr = agentNostrKey(card);
    const name = await seal(ctx, 'contacts', 'name', [id], checked.name);
    const relays = await seal(ctx, 'contacts', 'relays', [id], canonicalize([...checked.relays]));
    const row = await ctx.store.transaction((tx) => {
      const existing = tx.get('contacts', { contact_id: id });
      if (existing === undefined) {
        throw new CoreError('contact_not_found', 'No contact has that ID.');
      }
      if (isRevoked(tx, id, existing)) {
        throw new CoreError('contact_revoked', 'That agent has been revoked.');
      }
      if (!sameOwnerKeys(storedCard(existing), card)) {
        throw new CoreError('owner_keys_changed', 'The owner keys differ from the stored card.');
      }
      if (card.keyEpoch <= existing.key_epoch) {
        throw new CoreError('card_update_not_newer', 'That card is not newer than the stored one.');
      }
      const clash = tx.select('contacts', { agent_nostr: nostr, contact_id: { ne: id } });
      if (clash.length > 0) {
        throw new CoreError('contact_conflict', 'Another contact already uses that agent key.');
      }
      const keys = parseKeyList(existing.nostr_keys);
      const patch = {
        name,
        name_source: 'counterparty' as const,
        agent_card_json: canonicalize(card as unknown as JsonValue),
        card_sig: checked.cardSig,
        card_agent_sig: null,
        relays,
        agent_nostr: nostr,
        key_epoch: card.keyEpoch,
        nostr_keys: JSON.stringify(keys.includes(nostr) ? keys : [...keys, nostr]),
        updated_at: now,
      };
      if (tx.update('contacts', { contact_id: id, key_epoch: existing.key_epoch }, patch) !== 1) {
        throw new CoreError('contact_conflict', 'The contact changed meanwhile. Try again.');
      }
      return { ...existing, ...patch };
    });
    ctx.log.info('contact card updated', { keyEpoch: card.keyEpoch });
    return this.#view(row);
  }

  /** Blocks a contact (F-14): its later envelopes are dropped. A revoked contact stays revoked. */
  async block(id: string): Promise<ContactView> {
    const now = nowOf(this.#ctx);
    const found = await this.#ctx.store.transaction((tx) => {
      if (tx.get('contacts', { contact_id: id }) === undefined) return false;
      tx.update(
        'contacts',
        { contact_id: id, status: 'active' },
        { status: 'blocked', updated_at: now },
      );
      return true;
    });
    if (!found) throw new CoreError('contact_not_found', 'No contact has that ID.');
    return this.#get(id);
  }

  /** Removes a contact (F-14). A revoked agent stays in `revoked_agents` and cannot be paired again. */
  async remove(id: string): Promise<void> {
    const deleted = await this.#ctx.store.transaction((tx) =>
      tx.delete('contacts', { contact_id: id }),
    );
    if (deleted === 0) throw new CoreError('contact_not_found', 'No contact has that ID.');
  }

  /**
   * Classifies an inbound envelope's `from` (64 lowercase hex) against the contacts and the revoked
   * set, and drops it for a blocked or revoked agent (F-14, 04 §3.4.1). M1-7b runs it in 04 §3.1.1
   * step 7; dropping earlier is also safe, since it only removes work. A read error throws, so the
   * envelope is neither processed nor marked as seen (fail closed).
   */
  async screenInbound(from: string): Promise<InboundScreen> {
    if (typeof from !== 'string' || !NOSTR_KEY.test(from))
      return { action: 'drop', reason: 'malformed' };
    return this.#ctx.store.transaction((tx): InboundScreen => {
      for (const revoked of tx.select('revoked_agents')) {
        if (parseKeyList(revoked.nostr_keys).includes(from))
          return { action: 'drop', reason: 'revoked' };
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
      return { action: 'continue', sender: { kind, contactId: row.contact_id } };
    });
  }
}
