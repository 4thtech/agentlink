// Inbox sync and the fetch-only catch-up (M1-7h; 07 §2 `syncInbox`, §3.2 `seen`, `sync_cursors`,
// `rate_counters`, §4.2 "Sync", §4.3; 04 §3.1.1; 06 §2.0, §6; D-73).
//
// One pass, through the transport's sync (transport-nostr's SyncEngine: per-relay cursor with the
// 48 h look-back, paging, dedup by gift-wrap id before anything is opened):
// 1. Fetch and store. Each new envelope is deduplicated by its `envelopeHash` against the seen-set
//    (07 §4.2) and, if new, handed to `EnvelopeService.receive`: strict parse, signature (04 §3.1.1
//    steps 3 and 4), stored as `received` with its seen rows in one store transaction. So the
//    signature of one envelope is verified once: a later copy (another relay, another gift wrap of
//    the same envelope) is skipped on its seen row before any verification.
// 2. Admission bound (07 §3.2 `rate_counters`, the `received` cap). Each envelope stored as
//    `received` whose verified `from` is a contact's key (current or superseded) is admitted only
//    while the contact's counted hour plus its envelopes still waiting as `received` stay within
//    `contacts.rateLimitPerContactPerHour`; otherwise it is dropped (row deleted, seen rows kept), so
//    a flood from one contact never fills the `received` cap or delays another contact. Nothing is
//    counted here.
// 3. Process (`syncInbox` only): `EnvelopeService.processReceived` (steps 5 to 9, `card-update`
//    first, held rows; M1-7b, M1-7c). The rate counter is incremented there, in the transaction that
//    stores the contact's envelope, `ok` or `refused` (07 §3.2 "Transaction"; `countRateTx`, the
//    envelope pipeline's RateLimitHook), so envelopes from a contact's new key that arrive with its
//    card-update, and held envelopes it releases, are counted too (IR-M1-7h-1 F02). Then delivery
//    acks (02 F-23, behind a flag), then the new inbox items with their wrapper metadata.
//
// `subscribeInbox` (M1-9s; 06 §6, 07 §4.1) is the live form for the MCP background loop: the
// transport's `subscribe` hands each new wrap to the same step 1 and 2 handler as `syncInbox`
// (seen-set, envelopeHash, one store transaction, admission bound), and each stored envelope then
// runs step 3 in one serialized processing run (several arrivals coalesce into the next run). It
// shares the persistence object, so the engine, with `syncInbox` and `catchUp` (dedup when a wrap
// arrives through both). `close()` ends the transport subscription, waits for handlers and a
// processing run in flight, and touches the store no more; `closeSubscriptions` (client.close) ends
// every open one at once. The relays and keys are read when it opens: a change to either (a new
// own relay list, a key rotation) is picked up by the loop's fallback catch-up and the next open.
//
// `catchUp` (the M1-9 plan finding 3 addendum) runs steps 1 and 2 only and then counts from the
// store: no handshake, ack, card update, receipt or read mark, and no envelope is opened (06 §2.0:
// `agentlink_status` and `status --brief` are read-only in fact; their only effects are stored raw
// envelopes and relay AUTH).
//
// Relays (07 §4.3): the agent's own list, the only list where NIP-42 AUTH may be signed. Keys: the
// agent's Nostr key at every epoch, so envelopes sent to a superseded key still arrive (04 §2.6).
//
// I-5, I-7: nothing from an inbound envelope reaches a log line, an error or a report beyond its
// validated envelope ID and fixed codes. Logs carry counts only; relay URLs are never logged here.
import { encodeHex, encodeHex0x, envelopeHash } from '@4thtech-io/crypto';
import {
  MAX_SYNC_IDENTITIES,
  seenPruneBefore,
  type SeenKind,
  type SyncDisposition,
  type SyncIdentity,
  type SyncItem,
  type SyncPersistence,
  type SyncResult,
} from '@4thtech-io/transport-nostr';
import type { DeliveryAcks } from './acks.js';
import { RATE_BUCKET_SECONDS, RATE_WINDOW_SECONDS } from './constants.js';
import { screenInboundTx } from './contacts.js';
import { nowOf, type CoreContext } from './context.js';
import type { EnvelopeService, InboundReport } from './envelopes.js';
import { CoreError } from './errors.js';
import type { InboxCounts, InboxItem, InboxService } from './inbox.js';
import type { OutboxService } from './outbox.js';
import type { OwnerActions } from './owner-actions.js';
import { policyLimits } from './policy-engine.js';
import type { StoreTx } from './store/store.js';

/** 06 §6: `agentlink_inbox` and `agentlink_status` catch up within 3 s. */
export const DEFAULT_SYNC_BUDGET_MS = 3_000;
/** The longest budget a caller may ask for. */
export const MAX_SYNC_BUDGET_MS = 60_000;

const HEX64 = /^[0-9a-f]{64}$/;

export interface SyncInboxOptions {
  /** Time budget for the fetch, in milliseconds (default 3 000, at most 60 000). */
  readonly budgetMs?: number;
}

/** How a fetch went: counts only (I-7). */
export interface FetchSummary {
  /** True when a relay did not finish (budget, failure, a bound): more may be waiting. */
  readonly partial: boolean;
  /** New envelopes stored as `received` in this pass. */
  readonly stored: number;
  /** Envelopes dropped by the per-contact rate limit, by contact (07 §3.2; activity feed). */
  readonly rateLimited: readonly { readonly contactId: string; readonly dropped: number }[];
}

export interface SyncInboxResult extends FetchSummary {
  /** New messages from contacts processed in this pass, with their wrapper metadata. */
  readonly items: readonly InboxItem[];
  /** The processing outcomes (fixed codes; 04 §3.1.1), for the activity feed. */
  readonly reports: readonly InboundReport[];
  /** The requests queue (unknown senders): a count only (06 §2.1). */
  readonly requests: number;
  /** Delivery acks stored for sending in this pass (02 F-23; 0 while the flag is off). */
  readonly acksSent: number;
}

/** What one processing run of a live subscription did (M1-9s): counts and fixed codes only. */
export interface InboxProcessed {
  /** Envelopes stored as `received` by the subscription since the previous run. */
  readonly stored: number;
  /** The processing outcomes of this run (fixed codes; 04 §3.1.1). */
  readonly reports: readonly InboundReport[];
}

export interface SubscribeInboxOptions {
  /**
   * Called after each processing run that follows stored envelopes. A throw is ignored. Never gets
   * inbound content beyond the reports' validated IDs and fixed codes.
   */
  readonly onProcessed?: (result: InboxProcessed) => void;
}

/** An open live subscription (M1-9s). */
export interface InboxSubscription {
  /** True once `close()` was called, or the client closed it. */
  readonly closed: boolean;
  /**
   * Ends the transport subscription (CLOSE on each relay, no reconnect), then waits for a handler
   * or processing run in flight. Idempotent; never rejects. Call it before the store closes.
   */
  close(): Promise<void>;
}

/** The admission limit of a live subscription is read again at most this often (seconds). */
const LIVE_LIMIT_REFRESH_SECONDS = 60;

/** The fetch-only catch-up's answer (M1-7h addendum): counts only. */
export interface CatchUpResult extends InboxCounts {
  readonly partial: boolean;
}

export interface SyncDeps {
  readonly envelopes: EnvelopeService;
  readonly outbox: OutboxService;
  readonly ownerActions: OwnerActions;
  readonly inbox: InboxService;
  readonly acks: DeliveryAcks;
}

/**
 * `sync_cursors` and `seen` (07 §3.2) for transport-nostr's SyncEngine. The engine reads the seen-set
 * by gift-wrap id; the core writes `seen` rows itself, inside the transaction that stores the item,
 * so `markSeen` is left out. An `envelope` lookup by the sender-chosen envelope id never matches:
 * core keys those rows on the envelopeHash (07 §3.2; IR-M1-7b-1 Q1).
 */
export class StoreSyncPersistence implements SyncPersistence {
  readonly #ctx: CoreContext;

  constructor(ctx: CoreContext) {
    this.#ctx = ctx;
  }

  getCursor(relay: string): Promise<number | undefined> {
    return this.#ctx.store.transaction(
      (tx) => tx.get('sync_cursors', { relay_url: relay })?.last_seen,
    );
  }

  async setCursor(relay: string, lastSeen: number): Promise<void> {
    if (!Number.isSafeInteger(lastSeen) || lastSeen < 0) return;
    await this.#ctx.store.transaction((tx) => {
      if (tx.update('sync_cursors', { relay_url: relay }, { last_seen: lastSeen }) === 0) {
        tx.insert('sync_cursors', { relay_url: relay, last_seen: lastSeen });
      }
    });
  }

  async isSeen(kind: SeenKind, id: string): Promise<boolean> {
    if (kind !== 'wrap' || !HEX64.test(id)) return false;
    return this.#ctx.store.transaction((tx) => tx.get('seen', { kind: 'wrap', id }) !== undefined);
  }
}

/** The contact's counted envelopes in the sliding hour; stale buckets are deleted (07 §3.2). */
function usedTx(tx: StoreTx, contactId: string, now: number): number {
  const windowStart = now - RATE_WINDOW_SECONDS;
  tx.delete('rate_counters', { contact_id: contactId, bucket: { lte: windowStart } });
  return tx
    .select('rate_counters', { contact_id: contactId, bucket: { gt: windowStart } })
    .reduce((sum, row) => sum + row.count, 0);
}

/**
 * 07 §3.2 rate_counters, at processing: counts one envelope of `contactId` in the caller's
 * transaction (the one that stores it), or returns false when it would go above `limit`, so the
 * caller drops it. The envelope pipeline's RateLimitHook (IR-M1-7h-1 F02).
 */
export function countRateTx(tx: StoreTx, contactId: string, limit: number, now: number): boolean {
  if (usedTx(tx, contactId, now) >= limit) return false;
  const bucket = now - (now % RATE_BUCKET_SECONDS);
  const current = tx.get('rate_counters', { contact_id: contactId, bucket });
  if (current === undefined) {
    tx.insert('rate_counters', { contact_id: contactId, bucket, count: 1 });
  } else {
    tx.update('rate_counters', { contact_id: contactId, bucket }, { count: current.count + 1 });
  }
  return true;
}

/** Every Nostr key of a stored contact: the current one and the superseded ones (07 §3). */
function contactKeysTx(tx: StoreTx, contactId: string): string[] {
  const row = tx.get('contacts', { contact_id: contactId });
  if (row === undefined) return [];
  let listed: unknown;
  try {
    listed = JSON.parse(row.nostr_keys);
  } catch {
    listed = [];
  }
  const keys = Array.isArray(listed)
    ? listed.filter((k): k is string => typeof k === 'string' && HEX64.test(k))
    : [];
  return [...new Set([...keys, row.agent_nostr])];
}

/**
 * The admission bound at fetch time (07 §3.2; nothing is counted here): a newly stored `received`
 * envelope from a contact key is dropped when the contact's counted hour plus its envelopes waiting
 * as `received` (this one included) go above `limit`. It keeps a flood from one contact out of the
 * 1 000-row `received` cap, so other contacts are not delayed.
 */
function admitTx(
  tx: StoreTx,
  envelopeId: string,
  fromKey: string,
  limit: number,
  now: number,
): { readonly contactId: string; readonly dropped: boolean } | undefined {
  const screen = screenInboundTx(tx, fromKey);
  if (screen.action !== 'continue' || screen.sender.kind === 'unknown') return undefined;
  const contactId = screen.sender.contactId;
  const waiting = tx.count('envelopes', {
    state: 'received',
    direction: 'in',
    from_key: { in: contactKeysTx(tx, contactId) },
  });
  if (usedTx(tx, contactId, now) + waiting <= limit) return { contactId, dropped: false };
  // Dropped: not stored; its seen rows record the outcome (07 §3.2). A row another process has
  // already processed is no longer `received` and stays.
  const deleted = tx.delete('envelopes', {
    envelope_id: envelopeId,
    state: 'received',
    from_key: fromKey,
  });
  return { contactId, dropped: deleted > 0 };
}

/** A counter that cannot be read counts as being at the limit for that contact (07 §3.2). */
function dropReceivedTx(tx: StoreTx, envelopeId: string, fromKey: string): string | undefined {
  const screen = screenInboundTx(tx, fromKey);
  if (screen.action !== 'continue' || screen.sender.kind === 'unknown') return undefined;
  const deleted = tx.delete('envelopes', {
    envelope_id: envelopeId,
    state: 'received',
    from_key: fromKey,
  });
  return deleted > 0 ? screen.sender.contactId : undefined;
}

export class SyncService {
  readonly #ctx: CoreContext;
  readonly #deps: SyncDeps;
  readonly #persistence: StoreSyncPersistence;
  /** Open live subscriptions, so client.close() can end them (M1-9s). */
  readonly #live = new Set<{ end(): void }>();

  constructor(ctx: CoreContext, deps: SyncDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.#persistence = new StoreSyncPersistence(ctx);
  }

  /**
   * Fetches, stores and processes (07 §2 `syncInbox`): returns the new messages from contacts.
   * Idempotent across restarts: the cursor moves only after a relay was read to its end, the
   * seen-set and the stored envelopes deduplicate, and a crash leaves rows `received` for the next
   * pass (07 §3.2). A fetch that fails still processes what is stored.
   */
  async syncInbox(options: SyncInboxOptions = {}): Promise<SyncInboxResult> {
    const budgetMs = readBudget(options.budgetMs);
    const fetched = await this.#fetch(budgetMs);
    const reports = await this.#deps.envelopes.processReceived();
    // Rate-limit drops at processing time (07 §3.2) join the fetch-time ones, by contact.
    const limited = new Map(fetched.rateLimited.map((r) => [r.contactId, r.dropped]));
    for (const r of reports) {
      if (r.outcome === 'dropped' && r.reason === 'rate_limited' && r.contactId !== undefined) {
        limited.set(r.contactId, (limited.get(r.contactId) ?? 0) + 1);
      }
    }
    const rateLimited = [...limited]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([contactId, dropped]) => ({ contactId, dropped }));
    const acksSent = await this.#deps.acks.sendFor(reports);
    const newIds = reports
      .filter((r) => r.outcome === 'ok' && r.contactId !== undefined && r.envelopeId !== undefined)
      .map((r) => r.envelopeId as string);
    const items = await this.#deps.inbox.items(newIds);
    await this.#prune();
    const { requests } = await this.#deps.inbox.counts();
    this.#ctx.log.info('inbox sync', {
      stored: fetched.stored,
      processed: reports.length,
      items: items.length,
      acks: acksSent,
      partial: fetched.partial,
    });
    return { ...fetched, rateLimited, items, reports, requests, acksSent };
  }

  /**
   * The fetch-only catch-up for read-only callers (`agentlink_status`, `status --brief`; M1-9c,
   * M1-9l; 06 §2.0): fetches and stores, then counts by sender against the existing contacts. It
   * processes nothing: no handshake, ack, card update, receipt or read mark.
   */
  async catchUp(options: SyncInboxOptions = {}): Promise<CatchUpResult> {
    const fetched = await this.#fetch(readBudget(options.budgetMs));
    const counts = await this.#deps.inbox.counts();
    return { partial: fetched.partial, ...counts };
  }

  /**
   * Opens a live subscription for the background loop (M1-9s; 06 §6, 07 §4.1): each new wrap on
   * the own relays goes through the same receive path as `syncInbox` (steps 1 and 2), and stored
   * envelopes are then processed (step 3, delivery acks) in one serialized run at a time. Only the
   * publisher-lease holder calls it (06 §6, D-73); CLI commands never do.
   * @throws CoreError `transport_unavailable` without a transport that can subscribe, or when the
   *   subscription cannot be opened (no own relays, no keys).
   */
  async subscribeInbox(options: SubscribeInboxOptions = {}): Promise<InboxSubscription> {
    const { outbox, ownerActions } = this.#deps;
    const transport = outbox.requireTransport();
    if (transport.subscribe === undefined) {
      throw new CoreError('transport_unavailable', 'Live delivery is not available in this setup.');
    }
    const subscribe = transport.subscribe.bind(transport);
    // The own list (07 §4.3), as for a fetch; routes() marks it as the only list for AUTH.
    const routes = await outbox.routes(undefined);
    const relays = [...new Set(routes.flatMap((r) => r.relays))];
    const identities = await this.#identities();
    const ctx = this.#ctx;
    const log = ctx.log;

    let closed = false;
    let limit: { value: number; at: number } | undefined;
    const limitNow = async (): Promise<number> => {
      const now = nowOf(ctx);
      if (limit === undefined || now - limit.at >= LIVE_LIMIT_REFRESH_SECONDS || now < limit.at) {
        const value = policyLimits(await ownerActions.loadPolicy()).rateLimitPerContactPerHour;
        limit = { value, at: now };
      }
      return limit.value;
    };

    // Step 3, one run at a time; arrivals during a run make one more run after it.
    let stored = 0;
    let dirty = false;
    let processing: Promise<void> | undefined;
    const runProcessing = async (): Promise<void> => {
      while (dirty && !closed) {
        dirty = false;
        const batch = stored;
        stored = 0;
        let reports: InboundReport[];
        try {
          reports = await this.#deps.envelopes.processReceived();
          await this.#deps.acks.sendFor(reports);
        } catch {
          // Rows stay `received` for the next run or pass (07 §3.2); fixed message only (I-7).
          log.warn('live processing failed', {});
          continue;
        }
        log.info('live inbox', { stored: batch, processed: reports.length });
        try {
          options.onProcessed?.({ stored: batch, reports });
        } catch {
          // the caller's notifier changes nothing here
        }
      }
    };
    const kick = (): void => {
      dirty = true;
      if (processing !== undefined || closed) return;
      processing = runProcessing().finally(() => {
        processing = undefined;
        if (dirty && !closed) kick();
      });
    };

    const inflight = new Set<Promise<SyncDisposition>>();
    const onEnvelope = (item: SyncItem): Promise<SyncDisposition> => {
      // After close nothing touches the store: the wrap is left for the next pass (not marked seen).
      if (closed) return Promise.resolve('retry');
      const run = (async (): Promise<SyncDisposition> => {
        const limitValue = await limitNow();
        // Closed while the limit was read: leave the wrap for the next pass, store nothing.
        if (closed) return 'retry';
        const outcome = await this.#handle(item, limitValue);
        if (outcome.stored) {
          stored += 1;
          kick();
        }
        return outcome.disposition;
      })().catch((): SyncDisposition => 'retry');
      inflight.add(run);
      void run.finally(() => inflight.delete(run));
      return run;
    };

    let unsubscribe: () => Promise<void> | void;
    try {
      unsubscribe = subscribe({ relays, identities, persistence: this.#persistence, onEnvelope });
    } catch {
      log.warn('live subscription failed', { relays: relays.length });
      throw new CoreError('transport_unavailable', 'Live delivery is not available in this setup.');
    }
    // The transport's drain: its event tasks (handler calls, cursor writes) still running.
    let drained: Promise<unknown> = Promise.resolve();
    const entry = {
      end: (): void => {
        if (closed) return;
        closed = true;
        this.#live.delete(entry);
        try {
          drained = Promise.resolve(unsubscribe()).catch(() => undefined);
        } catch {
          // the transport's stop does not throw; nothing more to end here
        }
      },
    };
    this.#live.add(entry);
    log.info('live subscription open', { relays: relays.length });
    return {
      get closed() {
        return closed;
      },
      close: async (): Promise<void> => {
        entry.end();
        await Promise.allSettled([...inflight, processing, drained]);
      },
    };
  }

  /** Ends every open live subscription (client.close; M1-9s). Synchronous; never throws. */
  closeSubscriptions(): void {
    for (const entry of [...this.#live]) entry.end();
  }

  /** Steps 1 and 2 of the header: fetch, deduplicate, verify once, store, rate-limit. */
  async #fetch(budgetMs: number): Promise<FetchSummary> {
    const { outbox, ownerActions } = this.#deps;
    const transport = outbox.requireTransport();
    if (transport.sync === undefined) {
      throw new CoreError('transport_unavailable', 'Syncing is not available in this setup.');
    }
    // The own list (07 §4.3). routes() also marks it as the only list where AUTH may be signed.
    const routes = await outbox.routes(undefined);
    const relays = [...new Set(routes.flatMap((r) => r.relays))];
    const identities = await this.#identities();
    const limit = policyLimits(await ownerActions.loadPolicy()).rateLimitPerContactPerHour;

    let stored = 0;
    const dropped = new Map<string, number>();
    const onEnvelope = async (item: SyncItem): Promise<SyncDisposition> => {
      const outcome = await this.#handle(item, limit);
      if (outcome.stored) stored += 1;
      if (outcome.rateLimited !== undefined) {
        dropped.set(outcome.rateLimited, (dropped.get(outcome.rateLimited) ?? 0) + 1);
      }
      return outcome.disposition;
    };
    let result: SyncResult | undefined;
    try {
      result = await transport.sync({
        relays,
        identities,
        persistence: this.#persistence,
        onEnvelope,
        budgetMs,
      });
    } catch {
      // A transport refusal (arguments, keys) is a failed fetch, never a thrown sync: what is
      // already stored is still processed and counted.
      this.#ctx.log.warn('inbox fetch failed', { relays: relays.length });
      result = undefined;
    }
    const rateLimited = [...dropped]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([contactId, n]) => ({ contactId, dropped: n }));
    if (rateLimited.length > 0) {
      this.#ctx.log.info('rate limit dropped envelopes', {
        contacts: rateLimited.length,
        dropped: rateLimited.reduce((s, r) => s + r.dropped, 0),
      });
    }
    return { partial: result === undefined || result.partial, stored, rateLimited };
  }

  /** One fetched envelope: seen by its hash, or verified and stored once, then rate-limited. */
  async #handle(
    item: SyncItem,
    limit: number,
  ): Promise<{
    readonly disposition: SyncDisposition;
    readonly stored: boolean;
    readonly rateLimited?: string;
  }> {
    const ctx = this.#ctx;
    const wrapId = item.giftWrapId;
    // 07 §4.2: dedup by envelopeHash. A seen row for this hash was written only after its
    // signature passed (EnvelopeService.receive), so a later copy is skipped before any check.
    let hashHex: string | undefined;
    try {
      hashHex = encodeHex0x(envelopeHash(item.envelope));
    } catch {
      hashHex = undefined;
    }
    if (hashHex !== undefined && HEX64.test(wrapId)) {
      const hash = hashHex;
      try {
        const now = nowOf(ctx);
        const seen = await ctx.store.transaction((tx) => {
          if (tx.get('seen', { kind: 'envelope', id: hash }) === undefined) return false;
          if (tx.get('seen', { kind: 'wrap', id: wrapId }) === undefined) {
            tx.insert('seen', { kind: 'wrap', id: wrapId, first_seen_at: now });
          }
          return true;
        });
        if (seen) return { disposition: 'processed', stored: false };
      } catch {
        // 07 §3.2: a seen-set that cannot be read is empty for this pass; step 9 still dedups.
      }
    }
    const received = await this.#deps.envelopes.receive({
      envelope: item.envelope,
      giftWrapId: wrapId,
    });
    if (received.status !== 'verified' || received.report.envelopeId === undefined) {
      return { disposition: received.status, stored: false };
    }
    const envelopeId = received.report.envelopeId;
    const fromKey = item.envelope.from;
    try {
      const now = nowOf(ctx);
      const rate = await ctx.store.transaction((tx) =>
        admitTx(tx, envelopeId, fromKey, limit, now),
      );
      if (rate?.dropped === true) {
        return { disposition: 'verified', stored: false, rateLimited: rate.contactId };
      }
    } catch {
      const contactId = await ctx.store
        .transaction((tx) => dropReceivedTx(tx, envelopeId, fromKey))
        .catch(() => undefined);
      if (contactId !== undefined) {
        return { disposition: 'verified', stored: false, rateLimited: contactId };
      }
    }
    return { disposition: 'verified', stored: true };
  }

  /** The agent's Nostr key at every epoch, newest first, at most MAX_SYNC_IDENTITIES. */
  async #identities(): Promise<SyncIdentity[]> {
    const keyStore = this.#ctx.keyStore;
    const current = await keyStore.getPublicBundle();
    const out: SyncIdentity[] = [];
    for (let epoch = current.keyEpoch; epoch >= 0 && out.length < MAX_SYNC_IDENTITIES; epoch -= 1) {
      const bundle =
        epoch === current.keyEpoch ? current : await keyStore.getPublicBundle({ epoch });
      out.push({ pubkey: encodeHex(bundle.agentNostr), epoch });
    }
    return out;
  }

  /**
   * Seen rows and rate buckets past their retention (07 §3.2), in their own transaction. Never
   * fails the sync.
   */
  async #prune(): Promise<void> {
    try {
      const now = nowOf(this.#ctx);
      await this.#ctx.store.transaction((tx) => {
        const cursors = tx.select('sync_cursors').map((c) => c.last_seen);
        const before = seenPruneBefore(now, cursors);
        tx.delete('seen', { first_seen_at: { lt: before } });
        tx.delete('rate_counters', { bucket: { lte: now - RATE_WINDOW_SECONDS } });
      });
    } catch {
      this.#ctx.log.warn('sync pruning failed', {});
    }
  }
}

function readBudget(budgetMs: number | undefined): number {
  if (budgetMs === undefined) return DEFAULT_SYNC_BUDGET_MS;
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > MAX_SYNC_BUDGET_MS) {
    throw new CoreError('sync_budget_invalid', 'The sync time budget is not valid.');
  }
  return budgetMs;
}
