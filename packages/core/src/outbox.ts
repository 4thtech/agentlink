// The outbox over the Store (07 §3.2 `outbox`, §4.2 "Delivery reliability", §4.3; M1-7k).
//
// - Routing (07 §4.3): each gift wrap goes to the list of the agent its recipient key concerns. The
//   counterparty's agent and owner keys go to the counterparty's list (the `relays` of its current
//   card, from the contact row or, for a staged pairing, the pairing row); the own owner and the own
//   agent go to the agent's own list (identity). When one owner key is both, its wrap goes to the
//   union. A list that cannot be read stops the send before the outbox write (fail closed).
// - Rows (07 §3.2): one per wrap, with the signed kind 1059 event, its relay list and acks sealed,
//   attempt 1, and give_up_at = min(now + 24 h, wrap created_at + 48 h + S) (G-49, D-71 (5)).
//   `role` is `contact` for the counterparty's agent key and `owner` for the owner keys; the
//   agent's own copy is `owner` too (it is not the contact's delivery; see the PR's spec gaps).
// - Persistence for transport-nostr's OutboxWorker, with a per-row claim so that one agent store
//   shared by several processes (the CLI and each harness's MCP server, 06 §6) has exactly one
//   publisher per pending row (M1-9 plan finding 4): listing a due row moves its next_attempt_at to
//   now + OUTBOX_CLAIM_SECONDS with a compare-and-set, inside the store transaction that reads it.
//   Another process does not see the row as due until the claim lapses, so a process that stalls or
//   dies mid-publish hands the row over within one retry interval (the first backoff is 30 s,
//   07 §4.2). The attempt write is a compare-and-set on `pending` and this process's claim, and
//   `isPending` re-checks the claim right before publishing, so a process that lost the claim
//   neither publishes nor reschedules the row. `sent` and `not_delivered` are a compare-and-set on
//   `pending` only (IR-M1-7k-1 F03): `sent` records a fact any process may have observed (2 OKs for
//   the same signed event), and `not_delivered` is reached before any publish, right after the
//   claim, so neither can undo another process's progress.
// - envelopes.delivery follows the `contact` rows of the latest attempt per key (07 §3.2 "States");
//   an envelope without a contact row (the owner channel) follows all of its rows.
// - Staged envelopes (IR-M1-7k-1 F01): only the pairing messages that M1-7c stages (a `handshake`
//   with its pairing row, a `handshake-ack` recorded on its contact) are wrapped and given rows
//   here, in a transaction that checks again that they still have none, so each is wrapped once and
//   its rows survive a restart. Nothing else that is `queued` (for example `envelopes.build`
//   output) is ever published: Talk messages get their rows only from `sendMessage`.
//
// Logs: the core's own lines carry counts only, never wrap_json, relay URLs, keys or envelope IDs
// (I-7). The RelayPool behind `nostrTransport` logs into the same logger and may name a skipped
// relay's host, never its address (07 §4.2; transport-nostr relay-pool.ts; IR-M1-7k-1 F05).
import {
  canonicalize,
  encodeHex,
  parseEnvelope,
  parseJson,
  type AgentCard,
  type Envelope,
} from '@agentlink/crypto';
import { isAllowedRelayUrl } from '@agentlink/types';
import {
  MAX_RELAYS_PER_WRAP,
  OutboxWorker,
  SYNC_LOOKBACK_SECONDS,
  SYNC_SKEW_SECONDS,
  type GiftWrap,
  type OutboxAttempt,
  type OutboxGiveUpReason,
  type OutboxPersistence,
  type OutboxRow,
  type OutboxSummary,
} from '@agentlink/transport-nostr';
import { agentNostrKey } from './card.js';
import { OUTBOX_GIVE_UP_SECONDS } from './constants.js';
import type { ContactBook } from './contacts.js';
import { nowOf, open, seal, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import type { IdentityService } from './identity.js';
import type { Row } from './store/schema.js';
import type { StoreTx } from './store/store.js';
import type { Transport, TransportFactory } from './transport.js';

/**
 * How long listing a due row claims it for this process (07 §3.2; M1-9 plan finding 4). Equal to
 * the first retry interval (07 §4.2), and longer than one publish (10 s connect + 10 s OK, M1-5b).
 */
export const OUTBOX_CLAIM_SECONDS = 30;
/** Rows claimed per listing: one worker batch, so no claimed row waits behind a slow batch. */
const DUE_BATCH = 8;
/** Listings per processDue pass (at most 512 rows). */
const MAX_BATCHES = 64;
/** The only types a core flow stages for the outbox (pairing, M1-7c; IR-M1-7k-1 F01). */
const STAGED_TYPES: readonly string[] = Object.freeze(['handshake', 'handshake-ack']);
/** Staged envelopes wrapped per pass. */
const STAGED_BATCH = 50;
/** A list received with a card holds at most 16 relays (07 §4.3). */
const MAX_LIST_RELAYS = 16;

/** One recipient key with its role and the relays its wrap goes to (07 §4.3). */
export interface OutboxRoute {
  readonly recipient: string;
  readonly role: 'contact' | 'owner';
  readonly relays: readonly string[];
}

/** The counterparty of an outbound envelope: its current card and its authenticated list. */
export interface OutboxPeer {
  readonly card: AgentCard;
  readonly relays: readonly string[];
}

/** A relay list as stored: 1 to 16 distinct URLs that pass the relay URL rule (04 §4). */
function checkList(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_LIST_RELAYS ||
    !value.every((r) => typeof r === 'string' && isAllowedRelayUrl(r)) ||
    new Set(value).size !== value.length
  ) {
    throw new CoreError('relays_invalid', 'A relay list could not be read.');
  }
  return value as string[];
}

const giveUpAt = (now: number, wrap: GiftWrap): number =>
  Math.min(
    now + OUTBOX_GIVE_UP_SECONDS,
    wrap.event.created_at + SYNC_LOOKBACK_SECONDS + SYNC_SKEW_SECONDS,
  );

type Delivery = NonNullable<Row<'envelopes'>['delivery']>;

/** Sets envelopes.delivery from its outbox rows (07 §3.2 "States"), inside the caller's transaction. */
function updateDelivery(tx: StoreTx, envelopeId: string): void {
  const latest = new Map<string, Row<'outbox'>>();
  for (const row of tx.select('outbox', { envelope_id: envelopeId })) {
    const seen = latest.get(row.recipient_key);
    if (seen === undefined || row.attempt > seen.attempt) latest.set(row.recipient_key, row);
  }
  const all = [...latest.values()];
  const contact = all.filter((r) => r.role === 'contact');
  const scope = contact.length > 0 ? contact : all;
  if (scope.length === 0) return;
  const delivery: Delivery = scope.some((r) => r.state === 'not_delivered')
    ? 'not_delivered'
    : scope.every((r) => r.state === 'sent')
      ? 'sent'
      : 'queued';
  tx.update('envelopes', { envelope_id: envelopeId, direction: 'out' }, { delivery });
}

/** OutboxPersistence over the Store, with the per-row claim described above. */
class StoreOutboxPersistence implements OutboxPersistence {
  readonly #ctx: CoreContext;
  readonly #envelopeId: string | undefined;
  /** wrap_id -> the next_attempt_at this process wrote when it claimed the row. */
  readonly #claims = new Map<string, number>();
  /** How many rows the last listDue claimed. */
  listed = 0;

  constructor(ctx: CoreContext, envelopeId?: string) {
    this.#ctx = ctx;
    this.#envelopeId = envelopeId;
  }

  async listDue(nowSeconds: number): Promise<readonly OutboxRow[]> {
    const claimUntil = nowSeconds + OUTBOX_CLAIM_SECONDS;
    const envelopeId = this.#envelopeId;
    const claimed = await this.#ctx.store.transaction((tx) => {
      const due = tx.select(
        'outbox',
        {
          state: 'pending',
          next_attempt_at: { lte: nowSeconds },
          ...(envelopeId === undefined ? {} : { envelope_id: envelopeId }),
        },
        {
          orderBy: [
            ['next_attempt_at', 'asc'],
            ['wrap_id', 'asc'],
          ],
          limit: DUE_BATCH,
        },
      );
      return due.filter(
        (row) =>
          tx.update(
            'outbox',
            { wrap_id: row.wrap_id, state: 'pending', next_attempt_at: row.next_attempt_at },
            { next_attempt_at: claimUntil },
          ) === 1,
      );
    });
    this.listed = claimed.length;
    const out: OutboxRow[] = [];
    for (const row of claimed) {
      this.#claims.set(row.wrap_id, claimUntil);
      out.push(await this.#toRow(row));
    }
    return out;
  }

  /** A row the worker can check. One that does not open gets no relays: the worker then marks it
   * `not_delivered` (unreadable) and publishes nothing (07 §3.2 "On failure"). */
  async #toRow(row: Row<'outbox'>): Promise<OutboxRow> {
    const key = [row.wrap_id];
    let relays: readonly string[] = [];
    let acks: Record<string, number> = {};
    try {
      const listed = parseJson(await open(this.#ctx, 'outbox', 'relays', key, row.relays));
      const acked = parseJson(await open(this.#ctx, 'outbox', 'acks', key, row.acks));
      if (
        Array.isArray(listed) &&
        listed.every((r) => typeof r === 'string') &&
        typeof acked === 'object' &&
        acked !== null &&
        !Array.isArray(acked)
      ) {
        relays = listed as string[];
        acks = acked as Record<string, number>;
      }
    } catch {
      relays = [];
    }
    return {
      wrapId: row.wrap_id,
      envelopeId: row.envelope_id,
      recipientKey: row.recipient_key,
      wrapJson: row.wrap_json ?? '',
      relays,
      acks,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      createdAt: row.created_at,
      giveUpAt: row.give_up_at,
      role: row.role,
    };
  }

  /** Still pending and still claimed by this process: another process has not taken it over. */
  async isPending(wrapId: string): Promise<boolean> {
    const claim = this.#claims.get(wrapId);
    const row = await this.#ctx.store.transaction((tx) => tx.get('outbox', { wrap_id: wrapId }));
    return row?.state === 'pending' && claim !== undefined && row.next_attempt_at === claim;
  }

  async recordAttempt(wrapId: string, attempt: OutboxAttempt): Promise<boolean> {
    const claim = this.#claims.get(wrapId);
    if (claim === undefined) return false;
    const acks = await seal(this.#ctx, 'outbox', 'acks', [wrapId], canonicalize(attempt.acks));
    const n = await this.#ctx.store.transaction((tx) =>
      tx.update(
        'outbox',
        { wrap_id: wrapId, state: 'pending', next_attempt_at: claim },
        { acks, attempts: attempt.attempts, next_attempt_at: attempt.nextAttemptAt },
      ),
    );
    this.#claims.delete(wrapId);
    return n === 1;
  }

  async markSent(wrapId: string, acks: Readonly<Record<string, number>>): Promise<boolean> {
    const sealed = await seal(this.#ctx, 'outbox', 'acks', [wrapId], canonicalize(acks));
    return this.#finish(wrapId, { state: 'sent', acks: sealed });
  }

  markNotDelivered(wrapId: string, reason: OutboxGiveUpReason): Promise<boolean> {
    return this.#finish(wrapId, { state: 'not_delivered', reason });
  }

  /** Leaves `pending` (compare-and-set), drops wrap_json (07 §3.2 "Retention"), updates delivery. */
  async #finish(wrapId: string, patch: Partial<Row<'outbox'>>): Promise<boolean> {
    this.#claims.delete(wrapId);
    return this.#ctx.store.transaction((tx) => {
      const row = tx.get('outbox', { wrap_id: wrapId });
      if (row === undefined) return false;
      const n = tx.update(
        'outbox',
        { wrap_id: wrapId, state: 'pending' },
        { ...patch, wrap_json: null },
      );
      if (n !== 1) return false;
      updateDelivery(tx, row.envelope_id);
      return true;
    });
  }
}

/** The outbox of one client: routing, rows, staged envelopes and delivery passes. */
export class OutboxService {
  readonly #ctx: CoreContext;
  readonly #identity: IdentityService;
  readonly #contacts: ContactBook;
  readonly #transport: Transport | undefined;
  /** The agent's own relays, the only ones where NIP-42 AUTH may be signed (07 §4.3). */
  #ownRelays: ReadonlySet<string> = new Set();

  constructor(
    ctx: CoreContext,
    identity: IdentityService,
    contacts: ContactBook,
    transport: TransportFactory | undefined,
  ) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#contacts = contacts;
    this.#transport =
      transport === undefined
        ? undefined
        : transport({
            keys: ctx.keyStore,
            now: () => nowOf(ctx),
            mayAuthenticate: (url) => this.#ownRelays.has(url),
            logger: ctx.log,
          });
  }

  /** The transport, or `transport_unavailable` before anything is stored. Internal (send.ts). */
  requireTransport(): Transport {
    if (this.#transport === undefined) {
      throw new CoreError('transport_unavailable', 'Sending is not available in this setup.');
    }
    return this.#transport;
  }

  /** The counterparty of a contact: its current card and its list (contact row, `enc`). */
  async contactPeer(contactId: string): Promise<OutboxPeer> {
    const view = await this.#contacts.get(contactId);
    const row = await this.#ctx.store.transaction((tx) =>
      tx.get('contacts', { contact_id: contactId }),
    );
    if (row === undefined) {
      throw new CoreError('contact_not_found', 'That contact was not found.');
    }
    let relays: unknown;
    try {
      relays = parseJson(await open(this.#ctx, 'contacts', 'relays', [contactId], row.relays));
    } catch {
      throw new CoreError('relays_invalid', 'A relay list could not be read.');
    }
    return { card: view.card, relays: checkList(relays) };
  }

  /**
   * The route of every recipient key (07 §4.3), in 04 §3.2 order: the counterparty's agent and
   * owner, then the own owner and the own agent. Without a peer: the owner channel (own owner and
   * own agent). Throws, before anything is stored, if any list cannot be read.
   */
  async routes(peer: OutboxPeer | undefined): Promise<OutboxRoute[]> {
    const own = await this.#identity.signedCard();
    const ownRelays = checkList(own.relays);
    this.#ownRelays = new Set(ownRelays);
    const bundle = await this.#ctx.keyStore.getPublicBundle();
    const routes = new Map<string, { role: 'contact' | 'owner'; relays: string[] }>();
    const add = (key: string, role: 'contact' | 'owner', relays: readonly string[]): void => {
      const seen = routes.get(key);
      if (seen === undefined) {
        routes.set(key, { role, relays: [...relays] });
        return;
      }
      if (role === 'contact') seen.role = 'contact';
      for (const relay of relays) if (!seen.relays.includes(relay)) seen.relays.push(relay);
    };
    if (peer !== undefined) {
      const relays = checkList(peer.relays);
      add(agentNostrKey(peer.card), 'contact', relays);
      add(peer.card.ownerNostr.slice(2), 'owner', relays);
    }
    add(own.card.ownerNostr.slice(2), 'owner', ownRelays);
    add(encodeHex(bundle.agentNostr), 'owner', ownRelays);
    const out: OutboxRoute[] = [];
    for (const [recipient, route] of routes) {
      if (route.relays.length > MAX_RELAYS_PER_WRAP) {
        throw new CoreError('relays_invalid', 'A relay list could not be read.');
      }
      out.push({ recipient, role: route.role, relays: route.relays });
    }
    return out;
  }

  /** Wraps `envelope` once per route (07 §4.1) and seals the outbox rows. Stores nothing. */
  async prepareRows(envelope: Envelope, routes: readonly OutboxRoute[]): Promise<Row<'outbox'>[]> {
    const transport = this.requireTransport();
    const wrapped = await transport.wrap(
      envelope,
      routes.map((r) => r.recipient),
      this.#ctx.keyStore,
    );
    const now = nowOf(this.#ctx);
    const byKey = new Map(routes.map((r) => [r.recipient, r]));
    const rows: Row<'outbox'>[] = [];
    for (const wrap of wrapped.wraps) {
      const route = byKey.get(wrap.recipient);
      if (route === undefined) {
        throw new CoreError('relays_invalid', 'A relay list could not be read.');
      }
      const wrapId = wrap.event.id;
      rows.push({
        wrap_id: wrapId,
        envelope_id: envelope.id,
        recipient_key: wrap.recipient,
        wrap_json: JSON.stringify(wrap.event),
        relays: await seal(
          this.#ctx,
          'outbox',
          'relays',
          [wrapId],
          canonicalize([...route.relays]),
        ),
        acks: await seal(this.#ctx, 'outbox', 'acks', [wrapId], '{}'),
        attempt: 1,
        role: route.role,
        attempts: 0,
        next_attempt_at: now,
        created_at: now,
        give_up_at: giveUpAt(now, wrap),
        state: 'pending',
        reason: null,
      });
    }
    if (rows.length !== routes.length) {
      throw new CoreError('relays_invalid', 'A relay list could not be read.');
    }
    return rows;
  }

  /**
   * One delivery pass: gives staged envelopes their rows, then publishes every due row (07 §4.2).
   * Call it after a send, after a sync and on a timer. Safe in several processes at once.
   */
  async processDue(): Promise<OutboxSummary> {
    this.requireTransport();
    await this.enqueueStaged();
    return this.#run(undefined);
  }

  /** Publishes the due rows of one envelope (the first publish of a send). */
  publishEnvelope(envelopeId: string): Promise<OutboxSummary> {
    return this.#run(envelopeId);
  }

  async #run(envelopeId: string | undefined): Promise<OutboxSummary> {
    const transport = this.requireTransport();
    try {
      this.#ownRelays = new Set(checkList((await this.#identity.signedCard()).relays));
    } catch {
      this.#ownRelays = new Set(); // no readable own list: no AUTH anywhere (07 §4.3)
    }
    const persistence = new StoreOutboxPersistence(this.#ctx, envelopeId);
    const worker = new OutboxWorker({
      persistence,
      pool: transport,
      now: () => nowOf(this.#ctx) * 1000,
    });
    let sent = 0;
    let retrying = 0;
    let notDelivered = 0;
    let failed = 0;
    let nextAttemptAt: number | undefined;
    for (let i = 0; i < MAX_BATCHES; i += 1) {
      const s = await worker.processDue();
      sent += s.sent;
      retrying += s.retrying;
      notDelivered += s.notDelivered;
      failed += s.failed;
      if (s.nextAttemptAt !== undefined) {
        nextAttemptAt =
          nextAttemptAt === undefined ? s.nextAttemptAt : Math.min(nextAttemptAt, s.nextAttemptAt);
      }
      if (persistence.listed < DUE_BATCH) break;
    }
    if (sent + retrying + notDelivered + failed > 0) {
      this.#ctx.log.info('outbox pass', { sent, retrying, notDelivered, failed });
    }
    return { sent, retrying, notDelivered, failed, nextAttemptAt };
  }

  /**
   * Gives every staged pairing message its wraps and rows (IR-M1-7k-1 F01). Only envelopes that a
   * vetted core flow staged are publishable here: a `handshake` whose pairing row (pairing ID =
   * envelope ID, role `invitee`) still exists, and a `handshake-ack` that is its contact's recorded
   * `handshake_ack_envelope_id` (M1-7c). `envelopes.build` refuses both types, so its output (and
   * any other `queued` row) never becomes publishable: Talk messages get their rows only through
   * `sendMessage`, store-first, after the policy check. A staged message whose pairing or contact
   * is gone, or whose stored envelope is unreadable, is marked `not_delivered` (permanent); a
   * transient fault (an unreadable own list, a KeyStore or store error) leaves it `queued` for the
   * next pass (IR-M1-7k-1 F02). Returns the number of envelopes enqueued.
   */
  async enqueueStaged(): Promise<number> {
    // A revoked agent, or one whose rotation is unfinished, signs nothing (04 §2.6, 07 §3.4).
    if ((await this.#identity.sendState()) !== 'ready') return 0;
    const staged = await this.#ctx.store.transaction((tx) =>
      tx
        .select(
          'envelopes',
          { direction: 'out', delivery: 'queued', type: { in: [...STAGED_TYPES] } },
          {
            orderBy: [
              ['created_at', 'asc'],
              ['envelope_id', 'asc'],
            ],
          },
        )
        .filter((row) => tx.count('outbox', { envelope_id: row.envelope_id }) === 0)
        .slice(0, STAGED_BATCH),
    );
    let enqueued = 0;
    let dropped = 0;
    let failed = 0;
    for (const row of staged) {
      let rows: Row<'outbox'>[] | 'drop';
      try {
        rows = await this.#stagedRows(row);
      } catch {
        failed += 1; // transient: stays queued, the next pass tries again
        continue;
      }
      if (rows === 'drop') {
        dropped += await this.#ctx.store.transaction((tx) => {
          if (tx.count('outbox', { envelope_id: row.envelope_id }) !== 0) return 0;
          return tx.update(
            'envelopes',
            { envelope_id: row.envelope_id, direction: 'out', delivery: 'queued' },
            { delivery: 'not_delivered' },
          );
        });
        continue;
      }
      const ready = rows;
      enqueued += await this.#ctx.store.transaction((tx) => {
        const current = tx.get('envelopes', { envelope_id: row.envelope_id });
        if (
          current?.direction !== 'out' ||
          current.delivery !== 'queued' ||
          current.envelope_hash !== row.envelope_hash ||
          current.type !== row.type ||
          tx.count('outbox', { envelope_id: row.envelope_id }) !== 0
        ) {
          return 0; // another process enqueued it first, or it changed: wrapped once only
        }
        for (const r of ready) tx.insert('outbox', r);
        return 1;
      });
    }
    if (enqueued + dropped + failed > 0) {
      this.#ctx.log.info('outbox staged', { enqueued, dropped, failed });
    }
    return enqueued;
  }

  /**
   * The rows of one staged pairing message, `drop` when it can never be routed (permanent), or a
   * throw for a transient fault. The counterparty comes from the pairing row (`handshake`) or the
   * contact row whose recorded ack this is (`handshake-ack`).
   */
  async #stagedRows(row: Row<'envelopes'>): Promise<Row<'outbox'>[] | 'drop'> {
    let envelope: Envelope;
    try {
      if (row.envelope_json === null) return 'drop';
      envelope = parseEnvelope(parseJson(row.envelope_json, { integersOnly: true }));
    } catch {
      return 'drop';
    }
    if (envelope.id !== row.envelope_id) return 'drop';
    const contactId = row.contact_id;
    const found = await this.#ctx.store.transaction((tx) => ({
      pairing: tx.get('pairings', { pairing_id: row.envelope_id }),
      contact: contactId === null ? undefined : tx.get('contacts', { contact_id: contactId }),
    }));
    let peer: OutboxPeer;
    if (row.type === 'handshake') {
      if (contactId !== null || found.pairing?.role !== 'invitee') return 'drop';
      const staged = await this.#contacts.readStaged(row.envelope_id);
      if (staged === undefined) return 'drop';
      peer = { card: staged.card, relays: staged.relays };
    } else if (row.type === 'handshake-ack') {
      const contact = found.contact;
      if (
        contact === undefined ||
        contact.handshake_ack_envelope_id !== row.envelope_id ||
        contact.status !== 'active'
      ) {
        return 'drop';
      }
      peer = await this.contactPeer(contact.contact_id);
    } else {
      return 'drop';
    }
    return this.prepareRows(envelope, await this.routes(peer));
  }
}
