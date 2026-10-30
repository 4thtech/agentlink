// The `card-update` sender (M1-4d-f; 04 §2.6, §2.9, §3.4.1; 07 §4.3; D-102).
//
// - When. Every change of the agent's card is a new key epoch (a relay or name change is a rotation,
//   07 §4.3), so a contact holds the current card exactly when it got a message carrying it: the
//   pairing message (`handshake` or `handshake-ack`) or a `card-update` from the current key. Each
//   pass sends one `card-update` to every active, paired contact that has neither, so the pass is
//   idempotent and resumes after a crash, a missing transport or a failed send. A `card-update`
//   that the outbox gave up on (`not_delivered`) does not count, so it is sent again.
// - What. `{card, cardSig, cardAgentSig, cardPop, name, relays}` for the current card: both card
//   signatures travel with it (04 §2.9, D-102), so the contact can attach them to a proof pack.
// - How. An ordinary envelope from the agent's current key with the full 04 §3.2 recipient set,
//   stored with its outbox rows in one store transaction, then published (07 §3.2), like an ack.
// - Policy (D-106, decided by Tali, 2026-10-19). A card-update goes only to a contact that the
//   owner's `contacts.allowed` permits: the `envelope.send` evaluation that every other message
//   gets (06 §3). Fail closed: while the policy cannot be read or fails closed (G-6), none is sent;
//   the next pass, after the owner repairs the policy, sends them.
// - Catch-up (W4-RENAME-REACHES-CONTACTS, D-141 (6); 04 §3.4.1 "Catch-up"). A contact that holds a
//   card-update for the current card may still not have received it. When the newest verified
//   envelope from an active, paired contact lists one of this agent's superseded `agentEnc` kids among
//   its recipients, was created after the last card-update sent to that contact, and that card-update
//   is at least CATCH_UP_SECONDS old, the pass sends it the current card again (at most once per
//   contact per 24 h), under the same D-106 rule. Derived from the stored envelopes; no new state.
// - Who may call it. The core only (sync, and the owner flow after a rotation). No MCP tool creates
//   or passes a `card-update` (04 §3.4.1, I-4): the payload is built here from the own stored card.
//
// I-7: logs carry counts only, never a card, a signature or a key.
import { decodeHex0x, encodeUtf8, type JsonValue } from '@4thtech-io/crypto';
import { kidOf } from './envelope-wraps.js';
import type { SignedCard } from './card.js';
import type { CoreContext } from './context.js';
import type { EnvelopeService } from './envelopes.js';
import { CoreError } from './errors.js';
import { openOwnCard, readIdentity, type IdentityService } from './identity.js';
import { nowOf } from './context.js';
import type { OutboxService } from './outbox.js';
import type { OwnerActions } from './owner-actions.js';
import { evaluate, type EffectivePolicy } from './policy-engine.js';
import type { Row } from './store/schema.js';
import type { StoreTx } from './store/store.js';

/** At most this many card-updates per pass; the rest go in the next pass. */
export const MAX_CARD_UPDATES_PER_PASS = 200;

/** D-141 (6): a catch-up card-update goes to one contact at most once per this many seconds. */
export const CATCH_UP_SECONDS = 86_400;

export interface CardUpdateSendResult {
  /** Contacts that got a card-update stored for sending in this pass. */
  readonly sent: number;
  /** Contacts whose card-update could not be built or stored; the next pass tries again. */
  readonly failed: number;
}

export interface CardUpdateSenderDeps {
  readonly identity: IdentityService;
  readonly envelopes: EnvelopeService;
  readonly outbox: OutboxService;
  readonly ownerActions: OwnerActions;
}

/** The `card-update` payload for the own current card (04 §3.4.1). */
export function cardUpdatePayloadOf(signed: SignedCard): JsonValue {
  return {
    type: 'card-update',
    body: {
      card: signed.card as unknown as JsonValue,
      cardSig: signed.cardSig,
      cardAgentSig: signed.cardAgentSig,
      cardPop: signed.cardPop,
      name: signed.name,
      relays: [...signed.relays],
    },
    replyTo: null,
    files: [],
  };
}

/**
 * Whether the contact got a message carrying the card whose key is `fromKey`: its pairing message
 * from this agent, or a `card-update` from that key not given up on.
 */
function holdsCard(tx: StoreTx, contact: Row<'contacts'>, fromKey: string): boolean {
  for (const id of [contact.handshake_envelope_id, contact.handshake_ack_envelope_id]) {
    if (id === null) continue;
    const row = tx.get('envelopes', { envelope_id: id });
    if (row?.direction === 'out' && row.from_key === fromKey) return true;
  }
  return tx
    .select('envelopes', {
      direction: 'out',
      type: 'card-update',
      contact_id: contact.contact_id,
      from_key: fromKey,
    })
    .some((row) => row.delivery !== 'not_delivered');
}

const isRevoked = (tx: StoreTx, row: Row<'contacts'>): boolean =>
  row.status === 'revoked' || tx.get('revoked_agents', { agent_evm: row.contact_id }) !== undefined;

const waiting = (tx: StoreTx, row: Row<'contacts'>, fromKey: string): boolean =>
  row.status === 'active' &&
  row.pairing === 'complete' &&
  !isRevoked(tx, row) &&
  !holdsCard(tx, row, fromKey);

/** D-141 (6): what the catch-up check needs: the own superseded encryption kids and the time. */
interface CatchUp {
  readonly kids: ReadonlySet<string>;
  readonly now: number;
}

/** The recipient kids of a stored envelope's JSON, or none when it cannot be read. */
function recipientKids(json: string | null): readonly string[] {
  if (json === null) return [];
  try {
    const value = JSON.parse(json) as { recipients?: unknown };
    if (!Array.isArray(value.recipients)) return [];
    return value.recipients
      .map((r: unknown) =>
        typeof r === 'object' && r !== null ? (r as { kid?: unknown }).kid : '',
      )
      .filter((kid): kid is string => typeof kid === 'string');
  } catch {
    return [];
  }
}

/**
 * D-141 (6): the contact holds a card-update but still encrypts to a superseded key of this agent:
 * its newest verified envelope lists such a kid, was created after the last card-update sent to it,
 * and that one is at least CATCH_UP_SECONDS old.
 */
function catchUpDue(tx: StoreTx, row: Row<'contacts'>, catchUp: CatchUp): boolean {
  if (catchUp.kids.size === 0) return false;
  if (row.status !== 'active' || row.pairing !== 'complete' || isRevoked(tx, row)) return false;
  const [latest] = tx.select(
    'envelopes',
    { direction: 'in', state: 'ok', contact_id: row.contact_id },
    { orderBy: [['created_at', 'desc']], limit: 1 },
  );
  if (
    latest === undefined ||
    !recipientKids(latest.envelope_json).some((k) => catchUp.kids.has(k))
  ) {
    return false;
  }
  const [last] = tx.select(
    'envelopes',
    { direction: 'out', type: 'card-update', contact_id: row.contact_id },
    { orderBy: [['created_at', 'desc']], limit: 1 },
  );
  if (last === undefined) return false;
  return latest.created_at > last.created_at && catchUp.now - last.created_at >= CATCH_UP_SECONDS;
}

const due = (tx: StoreTx, row: Row<'contacts'>, fromKey: string, catchUp: CatchUp): boolean =>
  waiting(tx, row, fromKey) || catchUpDue(tx, row, catchUp);

export class CardUpdateSender {
  readonly #ctx: CoreContext;
  readonly #deps: CardUpdateSenderDeps;

  constructor(ctx: CoreContext, deps: CardUpdateSenderDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
  }

  /**
   * Sends the current card to every active, paired contact that does not hold it yet. Throws before
   * anything is stored when the agent cannot send (`transport_unavailable`, `rotation_pending`,
   * revoked); otherwise a failure for one contact is counted and retried in the next pass.
   */
  async sendPending(): Promise<CardUpdateSendResult> {
    const { identity, outbox } = this.#deps;
    outbox.requireTransport();
    await identity.assertCanSend();
    const signed = await identity.signedCard();
    // Epoch 0 has no earlier card: every contact paired with this one.
    if (signed.card.keyEpoch === 0) return { sent: 0, failed: 0 };
    const fromKey = signed.card.agentNostr.slice(2);
    // D-106: only contacts the owner's `contacts.allowed` permits; none while the policy fails closed.
    let policy: EffectivePolicy;
    try {
      policy = await this.#deps.ownerActions.loadPolicy();
    } catch {
      policy = { mode: 'fail_closed', problem: 'unreadable' } as EffectivePolicy;
    }
    if (policy.mode === 'fail_closed') {
      this.#ctx.log.warn('card updates held: the policy cannot be used');
      return { sent: 0, failed: 0 };
    }
    const catchUp: CatchUp = { kids: await this.#supersededKids(), now: nowOf(this.#ctx) };
    const dueIds = await this.#ctx.store.transaction((tx) =>
      tx
        .select(
          'contacts',
          { status: 'active', pairing: 'complete' },
          { orderBy: [['contact_id', 'asc']] },
        )
        .filter((row) => due(tx, row, fromKey, catchUp))
        .map((row) => row.contact_id),
    );
    const allowed = (contact: string, sizeBytes: number): boolean =>
      evaluate(policy, { kind: 'envelope.send', contact, sizeBytes }) === 'allow';
    const payload = cardUpdatePayloadOf(signed);
    let sent = 0;
    let failed = 0;
    for (const contactId of dueIds
      .filter((id) => allowed(id, 0))
      .slice(0, MAX_CARD_UPDATES_PER_PASS)) {
      try {
        if (await this.#send(contactId, payload, fromKey, allowed, catchUp)) sent += 1;
      } catch {
        failed += 1;
      }
    }
    if (sent > 0 || failed > 0) this.#ctx.log.info('card updates', { sent, failed });
    return { sent, failed };
  }

  /** D-141 (6): the kids of this agent's superseded encryption keys (its earlier cards). */
  async #supersededKids(): Promise<ReadonlySet<string>> {
    const got = await readIdentity(this.#ctx);
    if (got === undefined) return new Set();
    const stored = await openOwnCard(this.#ctx, got.row);
    if (stored === undefined) return new Set();
    const current = stored.card.agentEnc;
    return new Set(
      stored.history
        .map((h) => h.card.agentEnc)
        .filter((enc) => enc !== current)
        .map((enc) => kidOf(decodeHex0x(enc, { length: 32 }))),
    );
  }

  /** Stores one card-update with its outbox rows, then publishes it. False when no longer due. */
  async #send(
    contactId: string,
    payload: JsonValue,
    fromKey: string,
    allowed: (contact: string, sizeBytes: number) => boolean,
    catchUp: CatchUp,
  ): Promise<boolean> {
    const { envelopes, outbox } = this.#deps;
    const { built, row } = await envelopes.prepare({ to: { contact: contactId }, payload });
    // The size cap of the same evaluation, on the built envelope (as for every other message).
    if (!allowed(contactId, encodeUtf8(row.envelope_json ?? '').length)) return false;
    // Built from the key the card names; a rotation in between makes it stale.
    if (row.from_key !== fromKey) {
      throw new CoreError('key_epoch_mismatch', 'The identity changed while sending. Try again.');
    }
    const routes = await outbox.routes(await outbox.contactPeer(contactId));
    const keys = routes.map((r) => r.recipient);
    if (
      keys.length !== built.recipientNostrKeys.length ||
      !built.recipientNostrKeys.every((k) => keys.includes(k))
    ) {
      throw new CoreError('contact_conflict', 'The contact changed meanwhile. Try again.');
    }
    const rows = await outbox.prepareRows(built.envelope, routes);
    const stored = await this.#ctx.store.transaction((tx) => {
      const contact = tx.get('contacts', { contact_id: contactId });
      // Another process sent it meanwhile, or the contact is no longer active: nothing stored.
      if (contact === undefined || !due(tx, contact, fromKey, catchUp)) return false;
      tx.insert('envelopes', row);
      for (const r of rows) tx.insert('outbox', r);
      return true;
    });
    if (!stored) return false;
    try {
      await outbox.publishEnvelope(built.envelope.id);
    } catch {
      // The rows stay pending; the outbox retries (07 §3.2).
    }
    return true;
  }
}
