// The requests queue for unknown senders (02 F-65; 06 §3 `unknownSenders: queue`; 07 §3.2; M1-7e).
//
// A request is an `envelopes` row with `state = request`, `contact_id` null and `from_key` set,
// stored by the envelope pipeline (envelopes.ts). Limits: at most MAX_REQUESTS_PER_SENDER per unknown
// sender key and MAX_REQUESTS_TOTAL in total, counting `refused` rows from unknown keys too. The
// pipeline runs `requestsFullTx` in the store transaction that would store the row, so the count and
// the insert are one transaction. Over a limit the envelope is not stored (its seen rows stay),
// nothing is sent to the sender, and the owner sees one aggregated count (`queueRefusals`). Held
// envelopes have their own pool and are not counted here.
//
// The owner's view: count, list (IDs, sender key, type and time; never the payload, I-5) and
// ignore. Nothing here creates a contact: a contact comes only from a completed pairing (04 §2.9).
import { MAX_REQUESTS_PER_SENDER, MAX_REQUESTS_TOTAL } from './constants.js';
import type { CoreContext } from './context.js';
import type { InboundReport } from './envelopes.js';
import type { StoreTx } from './store/store.js';

/** The fixed reason of an envelope refused because the requests queue is full (07 §3.2). */
export const REQUESTS_FULL = 'requests_full' as const;

const NOSTR_KEY = /^[0-9a-f]{64}$/;

/** Rows that count toward the limits: stored requests and refusals from unknown keys. */
const FROM_UNKNOWN = {
  direction: 'in' as const,
  contact_id: null,
  state: { in: ['request', 'refused'] as ('request' | 'refused')[] },
};

/** Inside the transaction that would store a row from unknown key `fromKey`: is a limit reached? */
export function requestsFullTx(tx: StoreTx, fromKey: string): boolean {
  if (tx.count('envelopes', { ...FROM_UNKNOWN, from_key: fromKey }) >= MAX_REQUESTS_PER_SENDER) {
    return true;
  }
  return tx.count('envelopes', FROM_UNKNOWN) >= MAX_REQUESTS_TOTAL;
}

/** How many envelopes in `reports` were refused because the queue was full: one activity line. */
export function queueRefusals(reports: readonly InboundReport[]): number {
  return reports.filter((r) => r.outcome === 'dropped' && r.reason === REQUESTS_FULL).length;
}

/** One queued request as the owner's surfaces list it: no inbound content (06 §2.1, I-5). */
export interface RequestEntry {
  readonly envelopeId: string;
  /** The unknown sender's Nostr key, 64 lowercase hex: the surfaces derive "Contact XXXX·XXXX". */
  readonly fromKey: string;
  readonly type: string;
  /** The envelope's `createdAt` (sender-chosen, within the freshness window of 04 §3.1.1). */
  readonly createdAt: number;
}

const QUEUED = { state: 'request' as const, contact_id: null, direction: 'in' as const };

export class RequestsQueue {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  /** The number of queued requests (`agentlink_status` `requests`). */
  async count(): Promise<number> {
    return this.#ctx.store.transaction((tx) => tx.count('envelopes', QUEUED));
  }

  /** Queued requests, oldest first. */
  async list(): Promise<RequestEntry[]> {
    const rows = await this.#ctx.store.transaction((tx) =>
      tx.select('envelopes', QUEUED, {
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
    }));
  }

  /**
   * Ignores every queued request from `fromKey`: the rows are deleted, their seen rows stay, so the
   * same items are not fetched and shown again. Owner surfaces only (the CLI and the local UI); no
   * MCP tool reaches it. Returns the number of requests removed.
   */
  async ignore(fromKey: string): Promise<number> {
    if (typeof fromKey !== 'string' || !NOSTR_KEY.test(fromKey)) return 0;
    return this.#ctx.store.transaction((tx) =>
      tx.delete('envelopes', { ...QUEUED, from_key: fromKey }),
    );
  }
}
