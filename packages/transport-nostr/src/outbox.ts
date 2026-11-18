// M1-5b: outbox delivery (07 §3.2 `outbox`, §4.2 "Delivery reliability", §4.3 "Sent").
//
// The core stores an outbound envelope and all of its outbox rows in one transaction, then calls
// processDue(). A row holds the signed kind 1059 event and the relay list that the core chose for
// its recipient key. This worker republishes that stored event, never a re-wrapped one, to exactly
// that list (a wrap is never published to a relay outside its row's list), and marks the row:
//   - `sent` once 2 relays of the list have returned OK (for `owner` rows as for `contact` rows) and
//     the availability check has run (SEC-RELAY-READBACK, D-156 (7)): the relays that returned OK
//     are asked for the wrap by its id, each on a new connection without a login (RelayPool
//     checkServed). One that serves it: `sent`, availability `confirmed`. None can be asked (a login
//     wanted, no answer in time): `sent`, availability `unknown`. Otherwise, after one re-check
//     a moment later, the OKs of the relays that answered without it are dropped and the row goes
//     on as one with fewer than 2 OKs (backoff, republish, and `not_delivered` at give_up_at);
//   - `not_delivered` (timeout) if that has not happened by give_up_at, the earlier of created_at +
//     24 h and the wrap's own created_at + 48 h + S (G-49, D-71 (5)): a wrap is never published
//     where a receiver's sync (`lastSync - 48 h - S`) could no longer find it;
//   - `not_delivered` (unreadable) if the row cannot be read; nothing is published for it.
// Between attempts it backs off (30 s, doubling, at most 1 h), and never past give_up_at.
//
// Persistence is injected (implemented by core/node over the `outbox` table, 07 §3.2), so a restart
// loses nothing: the next processDue() reads the pending rows again. Times are Unix seconds, the
// store's clock (07 §3.1). Logs carry counts only: never wrap_json, relay URLs or keys (I-7).
import {
  MIN_ACKS,
  MAX_RELAYS_PER_WRAP,
  type ReadbackOutcome,
  type RelayPool,
} from './relay-pool.js';
import { verifyNostrEvent, parseJson, type NostrEvent } from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';
import { isAllowedRelayUrl } from '@4thtech-io/types';
import { SYNC_LOOKBACK_SECONDS, SYNC_SKEW_SECONDS } from './sync.js';

/** 07 §3.2: give_up_at = min(created_at + 86 400, wrap created_at + 48 h + S) (G-49); this is the first term. */
export const OUTBOX_GIVE_UP_SECONDS = 86_400;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 3_600;
/** Rows published at the same time by one processDue() pass. */
const ROW_CONCURRENCY = 8;
/**
 * SEC-RELAY-READBACK: when no relay served the wrap and at least one answered without it, the
 * relays that answered without it are asked once more after this wait (a relay may store a moment
 * after its OK).
 */
export const READBACK_RECHECK_MS = 1_000;

/**
 * SEC-RELAY-READBACK (D-156 (7)): how far a `sent` row's availability was confirmed. `confirmed`: a
 * relay that returned OK served the wrap back. `unknown`: none of them could be asked.
 */
export type OutboxAvailability = 'confirmed' | 'unknown';

/** Failures that make a relay unusable for this wrap (not a transient fault): 07 §4.3. */
const UNUSABLE: ReadonlySet<string> = new Set(['too_large', 'blocked_address', 'invalid_url']);

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
  /**
   * The three status writes are compare-and-set on `pending` (`... WHERE state = 'pending'`): they
   * change the row and return true only if it is still `pending`, and return false, changing
   * nothing, if a revoke or another writer has ended it since (07 §3.2). The worker never
   * overwrites a state it did not read as pending.
   */
  recordAttempt(wrapId: string, attempt: OutboxAttempt): Promise<boolean>;
  markSent(
    wrapId: string,
    acks: Readonly<Record<string, number>>,
    availability: OutboxAvailability,
  ): Promise<boolean>;
  markNotDelivered(wrapId: string, reason: OutboxGiveUpReason): Promise<boolean>;
}

/** What the worker uses of the pool. Without `checkServed` every `sent` row is availability `unknown`. */
export type OutboxPool = Pick<RelayPool, 'publish'> & Partial<Pick<RelayPool, 'checkServed'>>;

export interface OutboxWorkerOptions {
  readonly persistence: OutboxPersistence;
  readonly pool: OutboxPool;
  readonly logger?: Logger;
  /** Clock in Unix milliseconds (default: the wall clock). */
  readonly now?: () => number;
  /** Random source in [0, 1) for the backoff jitter (default: Math.random; not a security use). */
  readonly random?: () => number;
  /** Waits `ms` (default: the global setTimeout, read at call time so fake timers apply). */
  readonly sleep?: (ms: number) => Promise<void>;
}

type Readback =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'missing'; readonly relays: readonly string[] };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      resolve,
      ms,
    );
  });

/** Why a row is stuck with fewer than 2 usable relays. Fixed strings, no relay name or address. */
export type OutboxNoticeReason = 'no_relay_large_enough' | 'too_few_usable_relays';

/** For the activity feed (07 §4.3): which row, and why it cannot reach 2 relays. */
export interface OutboxNotice {
  readonly wrapId: string;
  readonly reason: OutboxNoticeReason;
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
  /** Rows left pending because fewer than 2 of their relays are usable, with the reason (07 §4.3). */
  readonly notices: readonly OutboxNotice[];
}

type RowResult =
  | { kind: 'sent' }
  | { kind: 'retrying'; nextAttemptAt: number; notice?: OutboxNotice }
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

/** `acks` without the given relays. */
function withoutRelays(
  acks: Readonly<Record<string, number>>,
  drop: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [relay, at] of Object.entries(acks)) if (!drop.includes(relay)) out[relay] = at;
  return out;
}

export class OutboxWorker {
  private readonly persistence: OutboxPersistence;
  private readonly pool: OutboxPool;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Set<string>();

  constructor(options: OutboxWorkerOptions) {
    this.persistence = options.persistence;
    this.pool = options.pool;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.sleep = options.sleep ?? defaultSleep;
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
    const notices: OutboxNotice[] = [];
    for (let i = 0; i < due.length; i += ROW_CONCURRENCY) {
      const batch = due.slice(i, i + ROW_CONCURRENCY);
      const results = await Promise.all(batch.map((row) => this.processRow(row, nowSeconds)));
      for (const result of results) {
        if (result === undefined) failed += 1;
        else if (result.kind === 'sent') sent += 1;
        else if (result.kind === 'not_delivered') notDelivered += 1;
        else if (result.kind === 'retrying') {
          retrying += 1;
          if (result.notice !== undefined) notices.push(result.notice);
          nextAttemptAt =
            nextAttemptAt === undefined
              ? result.nextAttemptAt
              : Math.min(nextAttemptAt, result.nextAttemptAt);
        }
      }
    }
    this.logger?.info('outbox pass', { sent, retrying, notDelivered, failed });
    return { sent, retrying, notDelivered, failed, nextAttemptAt, notices };
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
    const created = row.createdAt;
    if (
      relays === undefined ||
      event === undefined ||
      !Number.isSafeInteger(created) ||
      !Number.isSafeInteger(row.giveUpAt) ||
      !Number.isSafeInteger(event.created_at)
    ) {
      return (await this.persistence.markNotDelivered(row.wrapId, 'unreadable'))
        ? { kind: 'not_delivered' }
        : { kind: 'skipped' };
    }
    // The stored give_up_at is not trusted (07 §3.2): the bound is recomputed here as
    // min(created_at + 24 h, the signed wrap's created_at + sync look-back + skew), so no copy is
    // ever published later than a receiver's sync (since = lastSync - 48 h - S) can still reach it.
    const giveUpAt = Math.min(
      row.giveUpAt,
      created + OUTBOX_GIVE_UP_SECONDS,
      event.created_at + SYNC_LOOKBACK_SECONDS + SYNC_SKEW_SECONDS,
    );
    const acks = this.listedAcks(row, relays);
    if (Object.keys(acks).length >= MIN_ACKS) {
      // a crash after the publish, before the mark: the stored OKs are checked like fresh ones
      const check = await this.readback(event.id, Object.keys(acks));
      if (check.kind !== 'missing') return this.finishSent(row.wrapId, acks, check.kind);
      return this.retry(row, relays, withoutRelays(acks, check.relays), nowSeconds, giveUpAt, {
        unusable: 0,
        tooLarge: false,
      });
    }
    if (nowSeconds >= giveUpAt) {
      return (await this.persistence.markNotDelivered(row.wrapId, 'timeout'))
        ? { kind: 'not_delivered' }
        : { kind: 'skipped' };
    }
    if (!(await this.persistence.isPending(row.wrapId))) return { kind: 'skipped' };

    // The stored event goes only to the relays of its row that have not acknowledged it yet.
    const remaining = relays.filter((relay) => acks[relay] === undefined);
    const merged: Record<string, number> = { ...acks };
    let unusable = 0;
    let tooLarge = false;
    if (remaining.length > 0) {
      const outcome = await this.pool.publish(event, remaining);
      for (const r of outcome.results) {
        if (r.reason === 'too_large') tooLarge = true;
        if (UNUSABLE.has(r.reason)) unusable += 1;
      }
      for (const relay of outcome.acked) {
        if (relays.includes(relay) && merged[relay] === undefined) merged[relay] = nowSeconds;
      }
    }
    let kept: Record<string, number> = merged;
    if (Object.keys(merged).length >= MIN_ACKS) {
      const check = await this.readback(event.id, Object.keys(merged));
      if (check.kind !== 'missing') return this.finishSent(row.wrapId, merged, check.kind);
      kept = withoutRelays(merged, check.relays);
    }
    return this.retry(row, relays, kept, nowSeconds, giveUpAt, { unusable, tooLarge });
  }

  private async finishSent(
    wrapId: string,
    acks: Readonly<Record<string, number>>,
    availability: OutboxAvailability,
  ): Promise<RowResult> {
    return (await this.persistence.markSent(wrapId, acks, availability))
      ? { kind: 'sent' }
      : { kind: 'skipped' };
  }

  /**
   * SEC-RELAY-READBACK (D-156 (7)): asks the relays that returned OK for the wrap by its id. The
   * first that serves it confirms; when none can be asked the answer is `unknown`; when some answered
   * without it and none served it, those are asked once more after READBACK_RECHECK_MS, and the ones
   * still without it are returned. Bounded by the pool's own per-check limit.
   */
  private async readback(eventId: string, acked: readonly string[]): Promise<Readback> {
    const check = this.pool.checkServed?.bind(this.pool);
    if (check === undefined || acked.length === 0) return { kind: 'unknown' };
    const first = await this.askAll(check, eventId, acked);
    if (first.served) return { kind: 'confirmed' };
    if (first.missing.length === 0) return { kind: 'unknown' };
    await this.sleep(READBACK_RECHECK_MS);
    const second = await this.askAll(check, eventId, first.missing);
    if (second.served) return { kind: 'confirmed' };
    // A relay that answered without the wrap and then could not be asked again still counts as
    // missing: it never served it.
    const stillMissing = first.missing.filter(
      (relay) => second.missing.includes(relay) || !second.answered.includes(relay),
    );
    return { kind: 'missing', relays: stillMissing };
  }

  /** Asks every relay at once; resolves at the first `served`, else once all have answered. */
  private askAll(
    check: (relay: string, eventId: string) => Promise<ReadbackOutcome>,
    eventId: string,
    relays: readonly string[],
  ): Promise<{ served: boolean; missing: string[]; answered: string[] }> {
    return new Promise((resolve) => {
      const missing: string[] = [];
      const answered: string[] = [];
      let pending = relays.length;
      let done = false;
      const settle = (relay: string, outcome: ReadbackOutcome): void => {
        if (done) return;
        pending -= 1;
        if (outcome === 'served') {
          done = true;
          resolve({ served: true, missing, answered });
          return;
        }
        if (outcome === 'missing') {
          missing.push(relay);
          answered.push(relay);
        }
        if (pending === 0) {
          done = true;
          resolve({ served: false, missing, answered });
        }
      };
      for (const relay of relays) {
        let asked: Promise<ReadbackOutcome>;
        try {
          asked = check(relay, eventId);
        } catch {
          asked = Promise.resolve('unchecked');
        }
        asked.then(
          (outcome) => settle(relay, outcome),
          () => settle(relay, 'unchecked'),
        );
      }
    });
  }

  /** Records one attempt that did not end the row, with the next backoff step. */
  private async retry(
    row: OutboxRow,
    relays: readonly string[],
    merged: Readonly<Record<string, number>>,
    nowSeconds: number,
    giveUpAt: number,
    seen: { readonly unusable: number; readonly tooLarge: boolean },
  ): Promise<RowResult> {
    const { unusable, tooLarge } = seen;
    const attempts = row.attempts + 1;
    const base = Math.min(BACKOFF_BASE_SECONDS * 2 ** (attempts - 1), BACKOFF_MAX_SECONDS);
    // Jitter of up to 25 % on top, so many rows queued together do not retry in step; never past give_up_at.
    const r = this.random();
    const jitter = Math.floor(base * 0.25 * (Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0));
    const nextAttemptAt = Math.min(nowSeconds + base + jitter, giveUpAt);
    const recorded = await this.persistence.recordAttempt(row.wrapId, {
      acks: merged,
      attempts,
      nextAttemptAt,
    });
    if (!recorded) return { kind: 'skipped' };
    const usable = relays.length - unusable;
    const notice: OutboxNotice | undefined =
      usable < MIN_ACKS
        ? {
            wrapId: row.wrapId,
            reason: tooLarge ? 'no_relay_large_enough' : 'too_few_usable_relays',
          }
        : undefined;
    return notice === undefined
      ? { kind: 'retrying', nextAttemptAt }
      : { kind: 'retrying', nextAttemptAt, notice };
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
