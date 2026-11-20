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
// - Legacy relays (RELAY-CARD-MIGRATION, 0.5.13 transition). The contact's wrap of a card-update is
//   ALSO published to the legacy relays (relay-migration.ts cardUpdateLegacyRelays), so a contact
//   still listening there learns the new card (a moved relay list most of all). Only card-updates;
//   every other message keeps to the own and the contact's lists. Bounded by MAX_RELAYS_PER_WRAP,
//   and only until LEGACY_CARD_UPDATE_UNTIL (dated in transport-nostr legacy-relays.ts), and only
//   while the announce opt-out is off (NET-ANNOUNCE-OPTOUT, D-158 (7): the owner accepted that a
//   contact still listening only on the old servers may then miss the update). A legacy
//   relay's OK never makes a card-update count as `sent`: only an OK from a relay of the contact's
//   own list does; one accepted only by legacy relays (or by none yet) counts as `failed` for this
//   pass. Its contact row does not end either: the outbox marks the legacy relays `uncounted`
//   (outbox.ts #uncountedOf), so their OKs never count toward MIN_ACKS, and the row stays pending and
//   retries within the usual backoff until relays of the contact's own list accept it (or is
//   `not_delivered` at give_up_at, and then sent again by the next pass) (07 §3.2, §4.3).
// - Leaving servers (M1-7j, D-158 (5); 07 §4.3). After a change of the own list, the servers that
//   left it are still read for 30 days. The own copies of a card-update (the wraps for the own owner
//   and the own agent, 04 §3.2 entries 3 and 4) go there too; no other message ever does.
// - The owner `card-update` (M1-7j; D-65; 07 §4.3; 04 §3.4.1): one envelope on the owner channel
//   (recipients exactly the agent and its own owner) for each current card, also at epoch 0 and with
//   no contacts, published to the new list, the leaving servers and, unless the owner opted out
//   (`announce_default` false; NET-ANNOUNCE-OPTOUT), the release's default relay set
//   (announceToOwner). It is re-published as a new gift wrap of the same stored envelope (the next
//   outbox attempt) every 24 h while any leaving server runs, and every 7 days otherwise.
// - Who may call it. The core only (sync, and the owner flow after a rotation). No MCP tool creates
//   or passes a `card-update` (04 §3.4.1, I-4): the payload is built here from the own stored card.
//
// I-7: logs carry counts only, never a card, a signature or a key.
import { decodeHex0x, encodeUtf8, parseEnvelope, type JsonValue } from '@4thtech-io/crypto';
import { withdrawFromDefaultServers } from './announce-optout.js';
import { kidOf } from './envelope-wraps.js';
import type { SignedCard } from './card.js';
import type { CoreContext } from './context.js';
import type { EnvelopeService } from './envelopes.js';
import { CoreError } from './errors.js';
import { openOwnCard, readIdentity, type IdentityService } from './identity.js';
import { nowOf, open } from './context.js';
import type { OutboxRoute, OutboxService } from './outbox.js';
import {
  DEFAULT_RELAYS,
  LEGACY_READ_RELAYS,
  MAX_RELAYS_PER_WRAP,
} from '@4thtech-io/transport-nostr';
import { OWNER_CARD_UPDATE_OVERLAP_SECONDS, OWNER_CARD_UPDATE_SECONDS } from './leaving-servers.js';
import { cardUpdateLegacyRelays } from './relay-migration.js';
import type { OwnerActions } from './owner-actions.js';
import { evaluate, type EffectivePolicy } from './policy-engine.js';
import type { Row } from './store/schema.js';
import type { StoreTx } from './store/store.js';

/** At most this many card-updates per pass; the rest go in the next pass. */
export const MAX_CARD_UPDATES_PER_PASS = 200;

/** D-141 (6): a catch-up card-update goes to one contact at most once per this many seconds. */
export const CATCH_UP_SECONDS = 86_400;

export interface CardUpdateSendResult {
  /** Contacts whose card-update a relay of their current list (not a legacy relay) accepted. */
  readonly sent: number;
  /**
   * Contacts whose card-update could not be built or stored (the next pass tries again), or was
   * stored but not yet accepted by a non-legacy relay (the outbox keeps retrying its rows).
   */
  readonly failed: number;
}

/**
 * What one owner `card-update` pass did: `published` (stored and published, or a new wrap of the
 * stored one), `not_due` (published less than the interval ago), `pending` (a wrap of it is still
 * being delivered). Fixed codes only.
 */
/** NET-OWNER-SET: one contact's state after a change of the card (CardUpdateSender.progress). */
export interface CardUpdateProgressItem {
  readonly contactId: string;
  readonly state: 'sent' | 'waiting';
}

/** NET-OWNER-SET: the card-update progress after a change (08 §1 `GET /api/ui/network/progress`). */
export interface CardUpdateProgress {
  /** Unix seconds the current card was committed; null at the first card (nothing changed yet). */
  readonly changedAt: number | null;
  readonly total: number;
  readonly sent: number;
  readonly waiting: number;
  readonly items: readonly CardUpdateProgressItem[];
}

export type OwnerAnnounceResult = 'published' | 'not_due' | 'pending';

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

/**
 * NET-OWNER-SET: whether a relay accepted a message carrying the card whose key is `fromKey` for the
 * contact: its pairing message from that key, or a card-update from it whose delivery is `sent`.
 */
function reachedWith(tx: StoreTx, contact: Row<'contacts'>, fromKey: string): boolean {
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
    .some((row) => row.delivery === 'sent');
}

const isRevoked = (tx: StoreTx, row: Row<'contacts'>): boolean =>
  row.status === 'revoked' || tx.get('revoked_agents', { agent_evm: row.contact_id }) !== undefined;

// SEC-INVITE-CAPS: nothing to a contact that waits for the owner's Keep (sent once kept).
const waiting = (tx: StoreTx, row: Row<'contacts'>, fromKey: string): boolean =>
  row.status === 'active' &&
  row.pairing === 'complete' &&
  row.waiting_owner !== 1 &&
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
  if (row.waiting_owner === 1) return false;
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

/**
 * RELAY-CARD-MIGRATION: the contact routes of a card-update also name the legacy relays during the
 * transition, as many as fit in one wrap's relay limit. Owner routes are unchanged.
 */
export function withLegacyRelays(routes: readonly OutboxRoute[], now: number): OutboxRoute[] {
  const legacy = cardUpdateLegacyRelays(now);
  if (legacy.length === 0) return [...routes];
  return routes.map((route) => {
    if (route.role !== 'contact') return route;
    const relays = [...route.relays];
    for (const relay of legacy) {
      if (relays.length >= MAX_RELAYS_PER_WRAP) break;
      if (!relays.includes(relay)) relays.push(relay);
    }
    return { ...route, relays };
  });
}

/**
 * M1-7j (07 §4.3): the routes of the own owner and the own agent also name the leaving servers, as
 * many as fit in one wrap's relay limit. Only for card-updates; other routes are unchanged.
 */
export function withLeavingRelays(
  routes: readonly OutboxRoute[],
  ownKeys: ReadonlySet<string>,
  leaving: readonly string[],
  extra: readonly string[] = [],
): OutboxRoute[] {
  if (leaving.length === 0 && extra.length === 0) return [...routes];
  return routes.map((route) => {
    if (!ownKeys.has(route.recipient)) return route;
    const relays = [...route.relays];
    for (const relay of [...leaving, ...extra]) {
      if (relays.length >= MAX_RELAYS_PER_WRAP) break;
      if (!relays.includes(relay)) relays.push(relay);
    }
    return { ...route, relays };
  });
}

/** The own owner key and the own agent key of a card (64 lowercase hex, as routes name them). */
function ownKeysOf(signed: SignedCard): ReadonlySet<string> {
  return new Set([signed.card.ownerNostr.slice(2), signed.card.agentNostr.slice(2)]);
}

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
    // CARD-UPDATE-FAILED-STATE: a card-update stored by an earlier pass that no non-legacy relay has
    // accepted yet is published again now (its rows' own backoff still applies), so the "failed"
    // result of that pass drives this one instead of waiting for the outbox timer alone.
    for (const envelopeId of (await this.#unconfirmed(fromKey))
      .filter((u) => allowed(u.contactId, 0))
      .slice(0, MAX_CARD_UPDATES_PER_PASS)
      .map((u) => u.envelopeId)) {
      try {
        await this.#deps.outbox.publishEnvelope(envelopeId);
        if (await this.#acceptedOffLegacy(envelopeId)) sent += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    for (const contactId of dueIds
      .filter((id) => allowed(id, 0))
      .slice(0, MAX_CARD_UPDATES_PER_PASS)) {
      try {
        const outcome = await this.#send(contactId, payload, fromKey, allowed, catchUp);
        if (outcome === 'sent') sent += 1;
        else if (outcome === 'unconfirmed') failed += 1;
      } catch {
        failed += 1;
      }
    }
    if (sent > 0 || failed > 0) this.#ctx.log.info('card updates', { sent, failed });
    return { sent, failed };
  }

  /**
   * NET-OWNER-SET (08 §1 `GET /api/ui/network/progress`; 07 §4.3): after a change of the card, which
   * contacts the card-update sender has reached. A read of the stored rows only. Each active, paired
   * contact the sender would tell is `sent` once a relay accepted a message carrying the current card
   * (its pairing message from the current key, or a card-update from it whose delivery is `sent`),
   * else `waiting`. `changedAt` is when the current card was committed; null at the first card.
   * Contact IDs only: never a card, a list or a key (I-7).
   */
  async progress(): Promise<CardUpdateProgress> {
    const got = await readIdentity(this.#ctx);
    if (got === undefined || got.revoked || got.row.key_epoch === 0) {
      return Object.freeze({ changedAt: null, total: 0, sent: 0, waiting: 0, items: [] });
    }
    const changedAt = got.row.updated_at;
    const signed = await this.#deps.identity.signedCard();
    const fromKey = signed.card.agentNostr.slice(2);
    const items = await this.#ctx.store.transaction((tx) =>
      tx
        .select(
          'contacts',
          { status: 'active', pairing: 'complete' },
          { orderBy: [['contact_id', 'asc']] },
        )
        .filter((row) => row.waiting_owner !== 1 && !isRevoked(tx, row))
        .map((row) =>
          Object.freeze({
            contactId: row.contact_id,
            state: reachedWith(tx, row, fromKey) ? ('sent' as const) : ('waiting' as const),
          }),
        ),
    );
    const sent = items.filter((i) => i.state === 'sent').length;
    return Object.freeze({
      changedAt,
      total: items.length,
      sent,
      waiting: items.length - sent,
      items: Object.freeze(items),
    });
  }

  /** Stored card-updates of the current key still waiting for a first acceptance (`queued`), for active, paired contacts. */
  async #unconfirmed(
    fromKey: string,
  ): Promise<readonly { contactId: string; envelopeId: string }[]> {
    return this.#ctx.store.transaction((tx) =>
      tx
        .select(
          'envelopes',
          { direction: 'out', type: 'card-update', from_key: fromKey, delivery: 'queued' },
          { orderBy: [['created_at', 'asc']], limit: MAX_CARD_UPDATES_PER_PASS },
        )
        .filter((row) => {
          const contact = tx.get('contacts', { contact_id: row.contact_id ?? '' });
          return (
            contact !== undefined &&
            contact.status === 'active' &&
            contact.pairing === 'complete' &&
            contact.waiting_owner !== 1 &&
            !isRevoked(tx, contact)
          );
        })
        .map((row) => ({ contactId: row.contact_id ?? '', envelopeId: row.envelope_id })),
    );
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
  ): Promise<'sent' | 'unconfirmed' | false> {
    const { envelopes, outbox } = this.#deps;
    const { built, row } = await envelopes.prepare({ to: { contact: contactId }, payload });
    // The size cap of the same evaluation, on the built envelope (as for every other message).
    if (!allowed(contactId, encodeUtf8(row.envelope_json ?? '').length)) return false;
    // Built from the key the card names; a rotation in between makes it stale.
    if (row.from_key !== fromKey) {
      throw new CoreError('key_epoch_mismatch', 'The identity changed while sending. Try again.');
    }
    // M1-7j: the own copies also go to the leaving servers (the owner surface may still read them).
    // NET-ANNOUNCE-OPTOUT (D-158 (7), 07 §4.3): the legacy fan-out only while the opt-out is off.
    const signed = await this.#deps.identity.signedCard();
    const announce = await this.#deps.identity.announceDefault();
    const contactRoutes = await outbox.routes(await outbox.contactPeer(contactId));
    const routes = withLeavingRelays(
      announce ? withLegacyRelays(contactRoutes, nowOf(this.#ctx)) : contactRoutes,
      ownKeysOf(signed),
      await outbox.leavingRelays(),
    );
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
      // IR NET-ANNOUNCE-OPTOUT L2: an opt-out that committed after the routes were built stores
      // nothing (the next pass builds them again without the default servers).
      if (announce && optedOutTx(tx)) return false;
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
    return (await this.#acceptedOffLegacy(built.envelope.id)) ? 'sent' : 'unconfirmed';
  }

  /**
   * M1-7j (07 §4.3; D-65): the owner `card-update` for the current card. Stores it once per card
   * (recipients exactly the agent and its own owner) and publishes it to the own list, the leaving
   * servers and the release's default relay set; then, each time the interval has passed since the
   * last wrap (24 h while any leaving server runs, 7 days otherwise) and no wrap of it is pending,
   * publishes a new gift wrap of the same stored envelope as the next attempt. Built here from the
   * own stored card only; no MCP tool can create or pass it (I-4). Throws before anything is stored
   * when the agent cannot send.
   */
  async announceToOwner(): Promise<OwnerAnnounceResult> {
    const { identity, envelopes, outbox } = this.#deps;
    // NET-ANNOUNCE-OPTOUT: first, with the opt-out on, no pending retry keeps a default server (also
    // after a crash between the owner's `network.announce` and its clean-up). Store reads only.
    // IR L3: it fails closed: when the clean-up fails, the pass stops here (nothing new is built or
    // published) and the caller reports it; the next pass tries again.
    await this.withdrawFromDefaultServers();
    outbox.requireTransport();
    // IR L2: the choice the routes below are built for, checked again in the insert transaction.
    const announce = await identity.announceDefault();
    // IR-M1-7j L-2: whether anything is due is decided from store reads only, so a pass with nothing
    // due makes no KeyStore (keychain) call; the send check comes after.
    const signed = await identity.signedCard();
    const fromKey = signed.card.agentNostr.slice(2);
    const leaving = await outbox.leavingRelays();
    const interval =
      leaving.length > 0 ? OWNER_CARD_UPDATE_OVERLAP_SECONDS : OWNER_CARD_UPDATE_SECONDS;
    const now = nowOf(this.#ctx);
    const state = await this.#ownerState(fromKey);
    if (state.pending) return 'pending';
    if (state.envelopeId !== undefined && state.lastAcceptedAt !== undefined) {
      if (now >= state.lastAcceptedAt && now - state.lastAcceptedAt < interval) return 'not_due';
    }
    await identity.assertCanSend();
    // The new list, the leaving servers and, unless the owner opted out (`announce_default` false,
    // IR-M1-7j L-1; 07 §4.3 "Privacy"), the release's default set.
    const routes = withLeavingRelays(
      await outbox.routes(undefined),
      ownKeysOf(signed),
      leaving,
      announce ? DEFAULT_RELAYS : [],
    );
    if (state.envelopeId === undefined || state.envelopeJson === undefined) {
      const { built, row } = await envelopes.prepare({
        to: { owner: true },
        payload: cardUpdatePayloadOf(signed),
      });
      if (row.from_key !== fromKey) {
        throw new CoreError('key_epoch_mismatch', 'The identity changed while sending. Try again.');
      }
      const keys = routes.map((r) => r.recipient);
      if (
        keys.length !== built.recipientNostrKeys.length ||
        !built.recipientNostrKeys.every((k) => keys.includes(k))
      ) {
        throw new CoreError('key_epoch_mismatch', 'The identity changed while sending. Try again.');
      }
      const rows = await outbox.prepareRows(built.envelope, routes);
      const stored = await this.#ctx.store.transaction((tx) => {
        // Another process stored this card's owner card-update meanwhile: nothing stored.
        if (ownerCardUpdatesTx(tx, fromKey).length > 0) return false;
        if (announce && optedOutTx(tx)) return false; // IR L2
        tx.insert('envelopes', row);
        for (const r of rows) tx.insert('outbox', r);
        return true;
      });
      if (!stored) return 'pending';
      await this.#publish(built.envelope.id);
      this.#ctx.log.info('owner card update stored', { keyEpoch: signed.card.keyEpoch });
      return 'published';
    }
    // A new gift wrap of the same stored envelope: the next attempt of each recipient (07 §3.2).
    const envelopeId = state.envelopeId;
    const envelope = parseEnvelope(JSON.parse(state.envelopeJson) as unknown);
    const rows = (await outbox.prepareRows(envelope, routes)).map((r) => ({
      ...r,
      attempt: state.lastAttempt + 1,
    }));
    const stored = await this.#ctx.store.transaction((tx) => {
      const current = tx.select('outbox', { envelope_id: envelopeId });
      if (current.some((r) => r.state === 'pending')) return false;
      if (current.some((r) => r.attempt > state.lastAttempt)) return false;
      if (announce && optedOutTx(tx)) return false; // IR L2
      for (const r of rows) tx.insert('outbox', r);
      return true;
    });
    if (!stored) return 'pending';
    await this.#publish(envelopeId);
    return 'published';
  }

  /**
   * NET-ANNOUNCE-OPTOUT (D-158 (7); 07 §4.3 "Privacy"): with the opt-out on, the pending card-update
   * rows stop naming default or legacy servers that are on no own or contact route
   * (announce-optout.ts). Run after the owner's `network.announce` and by every owner announce pass.
   * Returns how many rows changed; 0 with the opt-out off.
   */
  withdrawFromDefaultServers(): Promise<number> {
    return withdrawFromDefaultServers(this.#ctx, this.#deps);
  }

  /** The stored owner card-update of the current key and its wraps (attempts, times, pending). */
  async #ownerState(fromKey: string): Promise<{
    readonly envelopeId: string | undefined;
    readonly envelopeJson: string | undefined;
    /**
     * When the last wrap that relays accepted (`sent`) was made. A wrap that ended `not_delivered`
     * does not count, so the next pass tries again at once (IR-M1-7j L-5): its rows had the
     * outbox's own backoff until give_up_at.
     */
    readonly lastAcceptedAt: number | undefined;
    readonly lastAttempt: number;
    readonly pending: boolean;
  }> {
    return this.#ctx.store.transaction((tx) => {
      const [latest] = ownerCardUpdatesTx(tx, fromKey);
      if (latest === undefined) {
        return {
          envelopeId: undefined,
          envelopeJson: undefined,
          lastAcceptedAt: undefined,
          lastAttempt: 0,
          pending: false,
        };
      }
      const wraps = tx.select('outbox', { envelope_id: latest.envelope_id });
      const sent = wraps.filter((r) => r.state === 'sent');
      return {
        envelopeId: latest.envelope_id,
        envelopeJson: latest.envelope_json ?? undefined,
        lastAcceptedAt: sent.length === 0 ? undefined : Math.max(...sent.map((r) => r.created_at)),
        lastAttempt: wraps.length === 0 ? 0 : Math.max(...wraps.map((r) => r.attempt)),
        pending: wraps.some((r) => r.state === 'pending'),
      };
    });
  }

  async #publish(envelopeId: string): Promise<void> {
    try {
      await this.#deps.outbox.publishEnvelope(envelopeId);
    } catch {
      // The rows stay pending; the outbox retries (07 §3.2).
    }
  }

  /** Whether a relay that is not a legacy relay acknowledged a contact wrap of this envelope. */
  async #acceptedOffLegacy(envelopeId: string): Promise<boolean> {
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select('outbox', { envelope_id: envelopeId, role: 'contact' }),
    );
    for (const row of rows) {
      try {
        const acks = JSON.parse(
          await open(this.#ctx, 'outbox', 'acks', [row.wrap_id], row.acks),
        ) as unknown;
        if (typeof acks !== 'object' || acks === null || Array.isArray(acks)) continue;
        if (Object.keys(acks).some((relay) => !LEGACY_READ_RELAYS.includes(relay))) return true;
      } catch {
        // An unreadable row proves nothing.
      }
    }
    return false;
  }
}

/** IR NET-ANNOUNCE-OPTOUT L2: whether the opt-out is on, read inside the insert transaction. */
function optedOutTx(tx: StoreTx): boolean {
  return tx.select('identity')[0]?.announce_default === 0;
}

/** The stored owner card-updates (owner channel: no contact) of one key, newest first. */
function ownerCardUpdatesTx(tx: StoreTx, fromKey: string): Row<'envelopes'>[] {
  return tx
    .select(
      'envelopes',
      { direction: 'out', type: 'card-update', from_key: fromKey },
      { orderBy: [['created_at', 'desc']] },
    )
    .filter((row) => row.contact_id === null);
}
