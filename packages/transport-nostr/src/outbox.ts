// M1-5b: outbox delivery (07 §3.2 `outbox`, §4.2 "Delivery reliability", §4.3 "Sent").
//
// The core stores an outbound envelope and all of its outbox rows in one transaction, then calls
// processDue(). A row holds the signed kind 1059 event and the relay list that the core chose for
// its recipient key. This worker republishes that stored event, never a re-wrapped one, to exactly
// that list (a wrap is never published to a relay outside its row's list), and marks the row:
//   - `sent` once 2 relays of the list have returned OK (for `owner` rows as for `contact` rows);
//   - `not_delivered` (timeout) if that has not happened by give_up_at (created_at + 24 h);
//   - `not_delivered` (unreadable) if the row cannot be read; nothing is published for it.
// Between attempts it backs off (30 s, doubling, at most 1 h), and never past give_up_at.
//
// Persistence is injected (implemented by core/node over the `outbox` table, 07 §3.2), so a restart
// loses nothing: the next processDue() reads the pending rows again. Times are Unix seconds, the
// store's clock (07 §3.1). Logs carry counts only: never wrap_json, relay URLs or keys (I-7).
import { MIN_ACKS, MAX_RELAYS_PER_WRAP, type RelayPool } from './relay-pool.js';
import { verifyNostrEvent, parseJson, type NostrEvent } from '@agentlink/crypto';
import type { Logger } from '@agentlink/log';
import { isAllowedRelayUrl } from '@agentlink/types';

/** 07 §3.2: give_up_at = created_at + 86 400. */
export const OUTBOX_GIVE_UP_SECONDS = 86_400;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 3_600;
/** Rows published at the same time by one processDue() pass. */
const ROW_CONCURRENCY = 8;

/** One `outbox` row as the transport needs it (07 §3.2). */
export interface OutboxRow {
  /** The gift-wrap event id, 64 lowercase hex. */
  readonly wrapId: string;
  readonly envelopeId: string;
  /** The recipient's Nostr x-only key, the gift wrap's `p` tag. */
  readonly recipientKey: string;
  /** The signed kind 1059 event, as stored. */
  readonly wrapJson: string;
  /** The relay URLs this wrap goes to, chosen by the core per recipient key (07 §4.3). */
  readonly relays: readonly string[];
  /** Relay URL to the time (Unix seconds) of its first OK. */
  readonly acks: Readonly<Record<string, number>>;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly createdAt: number;
  readonly giveUpAt: number;
  readonly role: 'contact' | 'owner';
}

/** What changes after one publish pass that did not reach 2 OKs. */
export interface OutboxAttempt {
  readonly acks: Readonly<Record<string, number>>;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

/** Why a row ends as `not_delivered` here. `revoked` is the core's (07 §3.2, revocation). */
export type OutboxGiveUpReason = 'timeout' | 'unreadable';

/**
 * Persistence for the outbox, implemented by core/node over the `outbox` table. Every method may
 * reject; the worker then leaves the row pending and tries again on the next pass.
 */
export interface OutboxPersistence {
  /** `pending` rows whose next_attempt_at is at or before `nowSeconds`. */
  listDue(nowSeconds: number): Promise<readonly OutboxRow[]>;
  /** True while the row is still `pending` (a revoke may have ended it since listDue). */
  isPending(wrapId: string): Promise<boolean>;
  recordAttempt(wrapId: string, attempt: OutboxAttempt): Promise<void>;
  markSent(wrapId: string, acks: Readonly<Record<string, number>>): Promise<void>;
  markNotDelivered(wrapId: string, reason: OutboxGiveUpReason): Promise<void>;
}

export interface OutboxWorkerOptions {
  readonly persistence: OutboxPersistence;
  readonly pool: Pick<RelayPool, 'publish'>;
  readonly logger?: Logger;
  /** Clock in Unix milliseconds (default: the wall clock). */
  readonly now?: () => number;
}

/** What one pass did, for the caller's scheduling and activity feed. */
export interface OutboxSummary {
  readonly sent: number;
  readonly retrying: number;
  readonly notDelivered: number;
  /** Rows that could not be processed because persistence failed; they stay pending. */
  readonly failed: number;
  /** The earliest next_attempt_at among rows left pending by this pass, in Unix seconds. */
  readonly nextAttemptAt: number | undefined;
}

type RowResult =
  | { kind: 'sent' }
  | { kind: 'retrying'; nextAttemptAt: number }
  | { kind: 'not_delivered' }
  | { kind: 'skipped' };

/** The stored event, if it is a well-formed signed gift wrap for this row; otherwise undefined. */
function readWrap(row: OutboxRow): NostrEvent | undefined {
  try {
    const parsed = parseJson(row.wrapJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const event = parsed as unknown as NostrEvent;
    if (event.kind !== 1059 || event.id !== row.wrapId || !verifyNostrEvent(event))
      return undefined;
    const hasRecipient = event.tags.some(
      (tag) => tag.length >= 2 && tag[0] === 'p' && tag[1] === row.recipientKey,
    );
    return hasRecipient ? event : undefined;
  } catch {
    return undefined;
  }
}

/** The row's relay list if it is 1 to 32 distinct URLs that pass the relay URL rule (04 §4). */
function readRelays(row: OutboxRow): readonly string[] | undefined {
  const relays: unknown = row.relays;
  if (!Array.isArray(relays) || relays.length === 0 || relays.length > MAX_RELAYS_PER_WRAP) {
    return undefined;
  }
  if (!relays.every((r) => typeof r === 'string' && isAllowedRelayUrl(r))) return undefined;
  return [...new Set(relays as string[])];
}

export class OutboxWorker {
  private readonly persistence: OutboxPersistence;
  private readonly pool: Pick<RelayPool, 'publish'>;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly inFlight = new Set<string>();

  constructor(options: OutboxWorkerOptions) {
    this.persistence = options.persistence;
    this.pool = options.pool;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
  }

  /** Delivers every pending row that is due. Call after the core's store transaction and on a timer. */
  async processDue(): Promise<OutboxSummary> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const due = await this.persistence.listDue(nowSeconds);
    let sent = 0;
    let retrying = 0;
    let notDelivered = 0;
    let failed = 0;
    let nextAttemptAt: number | undefined;
    for (let i = 0; i < due.length; i += ROW_CONCURRENCY) {
      const batch = due.slice(i, i + ROW_CONCURRENCY);
      const results = await Promise.all(batch.map((row) => this.processRow(row, nowSeconds)));
      for (const result of results) {
        if (result === undefined) failed += 1;
        else if (result.kind === 'sent') sent += 1;
        else if (result.kind === 'not_delivered') notDelivered += 1;
        else if (result.kind === 'retrying') {
          retrying += 1;
          nextAttemptAt =
            nextAttemptAt === undefined
              ? result.nextAttemptAt
              : Math.min(nextAttemptAt, result.nextAttemptAt);
        }
      }
    }
    this.logger?.info('outbox pass', { sent, retrying, notDelivered, failed });
    return { sent, retrying, notDelivered, failed, nextAttemptAt };
  }

  /** Undefined when persistence failed: the row stays pending. */
  private async processRow(row: OutboxRow, nowSeconds: number): Promise<RowResult | undefined> {
    if (this.inFlight.has(row.wrapId)) return { kind: 'skipped' };
    this.inFlight.add(row.wrapId);
    try {
      return await this.deliver(row, nowSeconds);
    } catch {
      return undefined; // persistence or pool fault: no detail is logged, the row retries next pass
    } finally {
      this.inFlight.delete(row.wrapId);
    }
  }

  private async deliver(row: OutboxRow, nowSeconds: number): Promise<RowResult> {
    const relays = readRelays(row);
    const event = relays === undefined ? undefined : readWrap(row);
    if (relays === undefined || event === undefined) {
      await this.persistence.markNotDelivered(row.wrapId, 'unreadable');
      return { kind: 'not_delivered' };
    }
    const acks = this.listedAcks(row, relays);
    if (Object.keys(acks).length >= MIN_ACKS) {
      await this.persistence.markSent(row.wrapId, acks); // a crash after the publish, before the mark
      return { kind: 'sent' };
    }
    if (nowSeconds >= row.giveUpAt) {
      await this.persistence.markNotDelivered(row.wrapId, 'timeout');
      return { kind: 'not_delivered' };
    }
    if (!(await this.persistence.isPending(row.wrapId))) return { kind: 'skipped' };

    // The stored event goes only to the relays of its row that have not acknowledged it yet.
    const remaining = relays.filter((relay) => acks[relay] === undefined);
    const merged: Record<string, number> = { ...acks };
    if (remaining.length > 0) {
      const outcome = await this.pool.publish(event, remaining);
      for (const relay of outcome.acked) {
        if (relays.includes(relay) && merged[relay] === undefined) merged[relay] = nowSeconds;
      }
    }
    if (Object.keys(merged).length >= MIN_ACKS) {
      await this.persistence.markSent(row.wrapId, merged);
      return { kind: 'sent' };
    }
    const attempts = row.attempts + 1;
    const delay = Math.min(BACKOFF_BASE_SECONDS * 2 ** (attempts - 1), BACKOFF_MAX_SECONDS);
    const nextAttemptAt = Math.min(nowSeconds + delay, row.giveUpAt);
    await this.persistence.recordAttempt(row.wrapId, { acks: merged, attempts, nextAttemptAt });
    return { kind: 'retrying', nextAttemptAt };
  }

  /** Stored acks, limited to relays that are still in the row's list. */
  private listedAcks(row: OutboxRow, relays: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const relay of relays) {
      const at = row.acks[relay];
      if (typeof at === 'number' && Number.isSafeInteger(at) && at >= 0) out[relay] = at;
    }
    return out;
  }
}
