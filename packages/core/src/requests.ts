// The requests queue for unknown senders (02 F-65; 06 §3 `unknownSenders: queue`; 07 §3.2; M1-7e,
// M1-7e-2).
//
// A request is an `envelopes` row with `state = request`, `contact_id` null and `from_key` set,
// stored by the envelope pipeline (envelopes.ts). Limits: at most MAX_REQUESTS_PER_SENDER per unknown
// sender key and MAX_REQUESTS_TOTAL in total, counting unexpired `refused` rows from unknown keys too.
// The pipeline runs `requestsFullTx` in the store transaction that would store the row, so the count
// and the insert are one transaction. Over a limit the envelope is not stored (its seen rows stay),
// nothing is sent to the sender, and the owner sees one aggregated count (`queueRefusals`). Held
// envelopes have their own pool and are not counted here.
//
// Retention (D-72; IR-M1-7e-1 F01): a `refused` row from an unknown key counts only while it is
// younger than REFUSED_RETENTION_SECONDS on the local clock (`refused_at`, never the sender-chosen
// `createdAt`). A `refused_at` later than now + S, or none (a row stored before schema version 2),
// is expired too, so a clock moved back cannot keep refusals counted (IR-D-72-1 F05). The count
// ignores expired rows in the same transaction as the insert; `pruneRefusedTx` deletes them at the
// start of each processing pass. A contact's refused rows are never touched here.
//
// The owner's view and actions (D-72; 04 §2.9; 07 §3.2): count, list (IDs, sender key, type, time
// and the Accept flag; never the payload, I-5), accept, ignore, ignore all, block, unblock and the
// blocked list. Owner surfaces only (the CLI in an interactive terminal, the local UI, the desktop
// app), never an MCP tool (I-4); in M1 they need no owner presence (11 §6.2.1, IR-D-72-1 F02).
// Nothing here creates or changes a contact row or a pairing: a contact comes only from a completed
// pairing (04 §2.9). Each action is one store transaction.
import { CLOCK_SKEW_SECONDS } from '@agentlink/types';
import {
  MAX_REQUESTS_PER_SENDER,
  MAX_REQUESTS_TOTAL,
  REFUSED_RETENTION_SECONDS,
} from './constants.js';
import { nowOf, type CoreContext } from './context.js';
import type { InboundReport } from './envelopes.js';
import type { StoreTx } from './store/store.js';

/** The fixed reason of an envelope refused because the requests queue is full (07 §3.2). */
export const REQUESTS_FULL = 'requests_full' as const;

const NOSTR_KEY = /^[0-9a-f]{64}$/;

/** Queued requests from unknown keys (accepted or not: an accepted request keeps counting). */
const REQUESTS = { direction: 'in' as const, contact_id: null, state: 'request' as const };
/** Refused rows from unknown keys, whatever their age. */
const REFUSED_UNKNOWN = { direction: 'in' as const, contact_id: null, state: 'refused' as const };

/** Refused rows from unknown keys that still count at `now` (F01, F05). */
const liveRefused = (now: number) => ({
  ...REFUSED_UNKNOWN,
  refused_at: { gt: now - REFUSED_RETENTION_SECONDS, lte: now + CLOCK_SKEW_SECONDS },
});

/**
 * Inside the transaction that would store a row from unknown key `fromKey`: is a limit reached?
 * Counts requests and unexpired refusals from unknown keys (07 §3.2); expired ones never count, so
 * expiry never waits for pruning.
 */
export function requestsFullTx(tx: StoreTx, fromKey: string, now: number): boolean {
  const live = liveRefused(now);
  const perSender =
    tx.count('envelopes', { ...REQUESTS, from_key: fromKey }) +
    tx.count('envelopes', { ...live, from_key: fromKey });
  if (perSender >= MAX_REQUESTS_PER_SENDER) return true;
  return tx.count('envelopes', REQUESTS) + tx.count('envelopes', live) >= MAX_REQUESTS_TOTAL;
}

/**
 * Deletes the expired refused rows from unknown keys (start of each processing pass, 07 §3.2): at
 * or past the retention, later than now + S, or with no `refused_at`. Their seen rows stay. A
 * contact's refused rows are not matched. Returns the number of rows deleted.
 */
export function pruneRefusedTx(tx: StoreTx, now: number): number {
  return (
    tx.delete('envelopes', { ...REFUSED_UNKNOWN, refused_at: null }) +
    tx.delete('envelopes', {
      ...REFUSED_UNKNOWN,
      refused_at: { lte: now - REFUSED_RETENTION_SECONDS },
    }) +
    tx.delete('envelopes', { ...REFUSED_UNKNOWN, refused_at: { gt: now + CLOCK_SKEW_SECONDS } })
  );
}

/** Inside a transaction: is `fromKey` in the owner's blocked keys (07 §3.2 `blocked_keys`)? */
export function isBlockedTx(tx: StoreTx, fromKey: string): boolean {
  return tx.get('blocked_keys', { from_key: fromKey }) !== undefined;
}

/** How many envelopes in `reports` were refused because the queue was full: one activity line. */
export function queueRefusals(reports: readonly InboundReport[]): number {
  return reports.filter((r) => r.outcome === 'dropped' && r.reason === REQUESTS_FULL).length;
}

/** One queued request as the owner's surfaces list it: no inbound content (06 §2.1, I-5). */
export interface RequestEntry {
  /** The local handle for accept and block (the envelope `id`, unique in this store). */
  readonly envelopeId: string;
  /**
   * The unknown sender's Nostr key, 64 lowercase hex. Surfaces show "unknown sender" plus its sender
   * code (04 §2.9), never "Contact".
   */
  readonly fromKey: string;
  readonly type: string;
  /** The envelope's `createdAt` (sender-chosen, within the freshness window of 04 §3.1.1). */
  readonly createdAt: number;
  /** When the owner accepted it (local clock), or null. */
  readonly acceptedAt: number | null;
}

/** One blocked key as the owner's Blocked list shows it (07 §3.2). */
export interface BlockedEntry {
  /** The handle for Unblock (IR-D-72-1 F03). */
  readonly fromKey: string;
  readonly blockedAt: number;
  /** The request it was blocked from: information only, never a handle (F03). */
  readonly viaEnvelopeId: string;
}

/** The outcome of Block: the number of rows removed, or why nothing changed. */
export type BlockResult =
  | { readonly status: 'blocked'; readonly removed: number }
  | { readonly status: 'request_not_found' | 'sender_is_contact' };

const isRowId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 64;

export class RequestsQueue {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  /** The number of queued requests (`agentlink_status` `requests`). */
  async count(): Promise<number> {
    return this.#ctx.store.transaction((tx) => tx.count('envelopes', REQUESTS));
  }

  /** Queued requests, oldest first. */
  async list(): Promise<RequestEntry[]> {
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select('envelopes', REQUESTS, {
        orderBy: [
          ['created_at', 'asc'],
          ['envelope_id', 'asc'],
        ],
      }),
    );
    return rows.map((r) => ({
      envelopeId: r.envelope_id,
      fromKey: r.from_key,
      type: r.type,
      createdAt: r.created_at,
      acceptedAt: r.request_accepted_at,
    }));
  }

  /**
   * Accept (D-72): marks that one `request` row readable to the agent, still wrapped as untrusted
   * (06 §2.1, §4). Nothing else changes: no contact, no pairing, no send path; the row keeps counting
   * toward the limits, and a later envelope from the key is a new request. Returns false when
   * `requestId` names no queued request.
   */
  async accept(requestId: string): Promise<boolean> {
    if (!isRowId(requestId)) return false;
    const now = nowOf(this.#ctx);
    return this.#ctx.store.transaction((tx) => {
      const row = tx.get('envelopes', { envelope_id: requestId });
      if (row?.state !== 'request' || row.contact_id !== null || row.direction !== 'in') {
        return false;
      }
      if (row.request_accepted_at === null) {
        tx.update(
          'envelopes',
          { ...REQUESTS, envelope_id: requestId, request_accepted_at: null },
          { request_accepted_at: now },
        );
      }
      return true;
    });
  }

  /**
   * Ignore (D-72): deletes every `request` and `refused` row from `fromKey` whose contact_id is
   * null. Their seen rows stay, so the same items are not fetched and shown again. Returns the
   * number of rows removed.
   */
  async ignore(fromKey: string): Promise<number> {
    if (typeof fromKey !== 'string' || !NOSTR_KEY.test(fromKey)) return 0;
    return this.#ctx.store.transaction(
      (tx) =>
        tx.delete('envelopes', { ...REQUESTS, from_key: fromKey }) +
        tx.delete('envelopes', { ...REFUSED_UNKNOWN, from_key: fromKey }),
    );
  }

  /** Ignore all (D-72): the same for every key, in one transaction. Returns the rows removed. */
  async ignoreAll(): Promise<number> {
    return this.#ctx.store.transaction(
      (tx) => tx.delete('envelopes', REQUESTS) + tx.delete('envelopes', REFUSED_UNKNOWN),
    );
  }

  /**
   * Block (D-72): adds the sender key of request `requestId` to `blocked_keys` and deletes its
   * `request`, unknown-key `refused` and held rows, in one transaction. From then on its envelopes
   * are dropped at 04 §3.1.1 step 5. A key that is now a contact's current key is not blocked here
   * (the contact's own status governs it, 07 §3.2).
   */
  async block(requestId: string): Promise<BlockResult> {
    if (!isRowId(requestId)) return { status: 'request_not_found' };
    const now = nowOf(this.#ctx);
    return this.#ctx.store.transaction((tx): BlockResult => {
      const row = tx.get('envelopes', { envelope_id: requestId });
      if (row?.state !== 'request' || row.contact_id !== null || row.direction !== 'in') {
        return { status: 'request_not_found' };
      }
      const key = row.from_key;
      if (tx.count('contacts', { agent_nostr: key }) > 0) return { status: 'sender_is_contact' };
      if (!isBlockedTx(tx, key)) {
        tx.insert('blocked_keys', { from_key: key, blocked_at: now, via_envelope_id: requestId });
      }
      const removed =
        tx.delete('envelopes', { ...REQUESTS, from_key: key }) +
        tx.delete('envelopes', { ...REFUSED_UNKNOWN, from_key: key }) +
        tx.delete('held_envelopes', { from_key: key });
      return { status: 'blocked', removed };
    });
  }

  /**
   * Unblock (D-72; IR-D-72-1 F03: by key, never by the sender-chosen envelope ID, which another key
   * can reuse once the row is gone). Deletes the `blocked_keys` row; nothing removed comes back.
   * Returns false when the key was not blocked.
   */
  async unblock(fromKey: string): Promise<boolean> {
    if (typeof fromKey !== 'string' || !NOSTR_KEY.test(fromKey)) return false;
    return this.#ctx.store.transaction(
      (tx) => tx.delete('blocked_keys', { from_key: fromKey }) === 1,
    );
  }

  /** The Blocked list, oldest first. */
  async listBlocked(): Promise<BlockedEntry[]> {
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select(
        'blocked_keys',
        {},
        {
          orderBy: [
            ['blocked_at', 'asc'],
            ['from_key', 'asc'],
          ],
        },
      ),
    );
    return rows.map((r) => ({
      fromKey: r.from_key,
      blockedAt: r.blocked_at,
      viaEnvelopeId: r.via_envelope_id,
    }));
  }
}
