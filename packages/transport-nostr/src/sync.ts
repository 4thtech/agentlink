// M1-5c: subscribe and sync (07 §4.2 "Sync", §3.2 `seen`, `sync_cursors`; 04 §3.1.1, §3.5; 06 §6).
//
// What it does: REQ {kinds: [1059], "#p": own keys, since} on each relay of a list, reads the stored
// events and (live) the new ones, opens each gift wrap (unwrapGiftWrap, M1-5a) and hands the strictly
// parsed envelope to the caller. What it does not do: choose the relays (core, per 07 §4.3), verify
// the envelope signature or process anything (04 §3.1.1 steps 4 to 9, core M1-7b), or write the
// store: the cursor and the seen-set are injected (SyncPersistence), implemented by core/node over
// `sync_cursors` and `seen`.
//
// Properties, each with a test:
// - Pages (IR-M1-5c-1 H-1): a relay may cap the stored events it returns per filter, newest first, and
//   then send EOSE. So a relay is read in pages (`limit`, `until`) walking back to `since`, and the
//   cursor moves only after the last page. A pass that stops early saves the page it reached
//   (optional `setResume`), and the next pass continues there, so a flood of junk cannot stall it.
// - Gaps (M1-5d, 07 §4.2): Nostr pages only by whole seconds, so a relay that holds more than its
//   cap of events in one second cannot return the rest of that second. A page at `until` = T that
//   holds only events at T, at least MIN_GAP_EVENTS and at least as many as any page of the walk
//   (a relay's cap is at least that), reports T as a gap with a fixed reason. The walk goes on and
//   the cursor still moves: reading the relay again cannot fetch that second, and the wraps are sent
//   to every relay of the list.
// - Closing gaps (M2-19, 07 §4.2): after the pages, a gap of relay R at T is closed when another
//   relay of the pass read T in full (positive evidence from its pages, never "no gap" alone), served every wrap R showed at T, and one bounded `ids` query on R returns every wrap that relay
//   served at T and R did not show. One query per gap, bounded ids, queries, time and memory; every
//   other gap stays in the result. Live subscriptions do not re-query.
// - Cursor (07 §4.2): per relay, `last_seen` is the local time the pass started, written only after
//   the relay reached EOSE and every event of the pass was handled. The next REQ asks for
//   `since = last_seen - 48 h - S` (NIP-59 randomises wrap times by up to 2 days; S = 300 s, 04 §2.5.1),
//   and a relay with no cursor is read 9 days back (07 §4.3). A relay that fails, times out or has an
//   event handled as `retry` keeps its old cursor.
// - Dedup (04 §3.1.1, IR-M1-5a-1 L-3): wraps are skipped by gift-wrap id, never by `envelope.id`
//   before verification (an unverified envelope's id is chosen by its sender). Core writes the
//   `seen` rows in its own transaction (07 §3.2), and its `envelope` rows hold the envelopeHash,
//   never the envelope id (04 §3.1.1 step 9; IR-M1-7b-1 Q1). The `envelopeSeen` hint below looks
//   up the envelope id, so it can only find a row written by the optional `markSeen` here (called
//   only after the handler's processed outcome, with the id only on `verified`; `retry` marks
//   nothing). It is never a reason to skip. Aligning the hint with core's keying is M1-5e. The same
//   wrap from 3 relays is delivered once, also when the copies arrive at the same time.
// - Junk (07 §3.2): a wrap that fails to open is not recorded in the seen-set; it is remembered only
//   in a bounded in-memory cache, keyed by id and signature, so a forged copy of a real wrap's id
//   cannot hide the real one.
// - Bounds on untrusted relays (I-5): the frame size limit is the pool's (128 KiB, before JSON.parse);
//   here the number of frames and of newly opened wraps per relay pass, the queue behind a slow
//   handler, and every in-memory cache are bounded.
// - Time budget (06 §6): sync() returns when every relay is done or the budget (3 s by default) ends,
//   flagged `partial`; relays that did not finish keep their cursor.
// - I-5, I-7: relay text and event content are never logged or returned. Logs carry counts and fixed
//   reasons, and name a relay by host only.
import {
  KeyStoreError,
  encodeHex,
  randomBytes,
  type Envelope,
  type EnvelopeKeys,
} from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';
import { isAllowedRelayUrl } from '@4thtech-io/types';
import { TransportError } from './errors.js';
import { unwrapGiftWrap } from './gift-wrap.js';
import type { Timers } from './relay-io.js';
import type { RelayFailure, RelayLink, RelayPool } from './relay-pool.js';

/** NIP-59 randomises wrap times by up to 2 days (04 §3.5), so a cursor is read back 48 h. */
export const SYNC_LOOKBACK_SECONDS = 172_800;
/** Clock skew `S` (04 §2.5.1). */
export const SYNC_SKEW_SECONDS = 300;
/** 07 §4.3 (G-24): the first sync on a relay with no cursor looks back 9 days. */
export const FIRST_SYNC_LOOKBACK_SECONDS = 9 * 86_400;
/** 06 §6: `agentlink_inbox` and `agentlink_status` catch up within 3 s. */
export const SYNC_BUDGET_MS = 3_000;
/** 07 §3.2: a seen row lives at least 7 days. */
export const SEEN_RETENTION_SECONDS = 604_800;
/** 07 §3.2: a cursor older than 30 days (the longest relay retention) is ignored for pruning. */
export const CURSOR_IGNORE_AFTER_SECONDS = 30 * 86_400;
/** At most this many relays in one sync or subscription (the pool's connection bound, 07 §4.3). */
export const MAX_SYNC_RELAYS = 64;
/** At most this many own keys (agent epochs and owner keys) in one REQ. */
export const MAX_SYNC_IDENTITIES = 64;
/** Frames one relay may send for one pass; above this the pass for that relay ends incomplete. */
export const MAX_FRAMES_PER_PASS = 50_000;
/** Wraps one relay may make us open (decrypt) in one pass; above this the pass ends incomplete. */
export const MAX_NEW_WRAPS_PER_PASS = 2_000;
/** Live: wraps one relay may make us open in one minute. */
export const MAX_LIVE_NEW_WRAPS_PER_MINUTE = 600;
/** Stored events asked for per page (strfry's own default result cap is 500). */
export const SYNC_PAGE_LIMIT = 500;
/**
 * Fewest events a page at one second must hold before that second is reported as a gap (M1-5d): a
 * relay that returns a single event per filter is not treated as capped.
 */
export const MIN_GAP_EVENTS = 2;
/** M2-19: `ids` re-queries one sync pass may send to close gaps, at most one per gap. */
export const MAX_GAP_REQUERIES_PER_PASS = 16;
/** M2-19: ids one gap's re-query may ask for. A gap with more missing ids is not queried. */
export const MAX_GAP_REQUERY_IDS = 64;
/** M2-19: how long one re-query may wait for its EOSE (it also ends with the pass budget). */
export const GAP_REQUERY_TIMEOUT_MS = 1_000;
/**
 * M2-19: wrap ids remembered per relay in a pass, by second, to close another relay's gap. A relay
 * that returns more is not used to close any gap in that pass.
 */
export const MAX_LEARNED_IDS_PER_RELAY = 2_048;
/** Pages one relay may take in a pass (about 50 000 events at the page limit). */
export const MAX_PAGES_PER_PASS = 100;
/** A saved page position older than this is not resumed. */
export const SYNC_RESUME_MAX_AGE_SECONDS = 7 * 86_400;
/** Events waiting behind a slow handler, per relay. */
export const MAX_QUEUED_EVENTS = 2_048;
/** Characters of events (the whole event as JSON) waiting behind a slow handler, per relay (about 16 MiB). */
export const MAX_QUEUED_CHARS = 16_777_216;
/** Entries of each in-memory dedup cache (processed wraps, junk wraps). */
export const DEDUP_CACHE_ENTRIES = 8_192;
/** Live: the first wait before a lost relay is reached again, doubling up to the maximum. */
export const LIVE_RETRY_BASE_MS = 5_000;
export const LIVE_RETRY_MAX_MS = 300_000;
/** Live: the cursor moves at most this often. */
const LIVE_CURSOR_INTERVAL_SECONDS = 60;
const NOSTR_KIND_GIFT_WRAP = 1059;
const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const AUTH_REQUIRED = 'auth-required:';

/** One of our own Nostr keys: the `p` tag of a wrap that is for us. */
export interface SyncIdentity {
  /** The x-only key, 64 lowercase hex. */
  readonly pubkey: string;
  /** The key epoch to decrypt with (04 §2.7: picked from the wrap's `p` tag). Default: current. */
  readonly epoch?: number;
}

/** The two kinds of the `seen` table (07 §3.2). */
export type SeenKind = 'wrap' | 'envelope';

/**
 * Persistence for cursors and the seen-set, implemented by core/node over `sync_cursors` and `seen`
 * (07 §3.2). Every method may reject: a cursor that cannot be read means "no cursor" (a 9-day pass),
 * a seen-set that cannot be read means "empty" for that event (07 §3.2 "On failure"), a write that
 * fails only costs work later. Times are Unix seconds.
 */
export interface SyncPersistence {
  /** `sync_cursors.last_seen` of the relay, or undefined if it has none. */
  getCursor(relay: string): Promise<number | undefined>;
  setCursor(relay: string, lastSeen: number): Promise<void>;
  /**
   * True if `(kind, id)` is in `seen`. A read only: core writes the `seen` row inside its own store
   * transaction, together with the item it stores (07 §3.2), so two writers never disagree on
   * `first_seen_at`.
   */
  isSeen(kind: SeenKind, id: string): Promise<boolean>;
  /**
   * Optional; the default is to write nothing. Upserts `(kind, id)` with `first_seen_at` after the
   * handler reported the item's processed outcome. Leave it out when core writes `seen` itself (the
   * intended setup). An `envelope` row written here is keyed on the envelope id, which any sender
   * may choose (IR-M1-5c-1 L-6): never skip on it. Core's own `envelope` rows hold the envelopeHash
   * instead (07 §3.2; IR-M1-7b-1 Q1), so the two kinds of row never match (M1-5e aligns them).
   * Pruning follows `seenPruneBefore`.
   */
  markSeen?(kind: SeenKind, id: string, firstSeenAt: number): Promise<void>;
  /**
   * Optional: where a pass that was cut short (budget, a bound, a lost connection) stopped, so the
   * next pass continues there instead of reading the newest pages again (a flood of junk larger than
   * a pass cannot then stall a relay for good). Without these, every pass starts from the newest.
   */
  getResume?(relay: string): Promise<SyncResume | undefined>;
  /** `undefined` clears it. */
  setResume?(relay: string, resume: SyncResume | undefined): Promise<void>;
}

/** A saved page position: events newer than `until` were read and handled in the pass that began at `startedAt`. */
export interface SyncResume {
  readonly until: number;
  readonly startedAt: number;
}

/** What the handler gets for each new gift wrap. */
export interface SyncItem {
  /** Strictly parsed; its signature is NOT checked (04 §3.1.1 step 4 is core). */
  readonly envelope: Envelope;
  readonly giftWrapId: string;
  readonly giftWrapCreatedAt: number;
  /** The relay that served this copy. */
  readonly relay: string;
  /** The own key the wrap was addressed to. */
  readonly recipient: string;
  /**
   * A hint: `seen` has an `envelope` row equal to this envelope's id, which only the optional
   * `markSeen` writes (core's rows hold the envelopeHash, 07 §3.2, so with core writing `seen` this
   * is false). Unverified, so the sender chose the id: core must never skip or drop on it
   * (IR-M1-5a-1 L-3). Core step 9 compares `envelopeHash`.
   */
  readonly envelopeSeen: boolean;
}

/**
 * The handler's answer.
 * - `processed`: the item is durably stored or its final outcome recorded. The wrap id is marked seen.
 * - `verified`: as `processed`, and the envelope signature passed (04 §3.1.1 step 4), so the
 *   optional `markSeen` also gets an `envelope` row for its id (core keys its own rows on the
 *   envelopeHash, 07 §3.2).
 * - `retry`: not stored (for example the store was busy). Nothing is marked seen and the relay's
 *   cursor does not move, so the item comes again.
 */
export type SyncDisposition = 'processed' | 'verified' | 'retry';

export type EnvelopeHandler = (item: SyncItem) => Promise<SyncDisposition> | SyncDisposition;

/** Why a relay's pass is not complete. A fixed set: relay text never reaches a caller. */
export type SyncRelayReason =
  | 'ok'
  | RelayFailure
  | 'budget'
  | 'stopped'
  | 'auth_failed'
  | 'subscription_closed'
  | 'connection_lost'
  | 'too_many_events'
  | 'overflow'
  | 'keys_unavailable'
  | 'handler_retry';

export interface SyncRelayResult {
  readonly relay: string;
  /** `complete`: EOSE reached, every event handled, cursor moved. */
  readonly status: 'complete' | 'incomplete' | 'failed';
  readonly reason: SyncRelayReason;
}

/** Why a second of a relay may not have been read in full. A fixed set: relay text never reaches a caller. */
export type SyncGapReason = 'relay_cap';

/**
 * A second (`created_at`) a relay may hold more events in than it returns for one filter (M1-5d,
 * 07 §4.2). Nostr pages only by whole seconds, so the rest of that second cannot be fetched from
 * that relay; the same wraps are usually on the other relays of the list. Reading the relay again
 * does not help, so a gap neither holds the cursor nor makes the pass partial.
 */
export interface SyncGap {
  readonly relay: string;
  /** The second (Unix seconds, a wrap's randomised `created_at`), never a time the wrap was sent. */
  readonly second: number;
  readonly reason: SyncGapReason;
}

export interface SyncResult {
  /** True when any relay did not complete (budget, failure, retry): more may be waiting. */
  readonly partial: boolean;
  /**
   * Seconds that may not have been read in full on one relay (M1-5d) and that no bounded `ids`
   * re-query closed (M2-19). Omitted or empty: none. At most MAX_PAGES_PER_PASS per relay.
   */
  readonly gaps?: readonly SyncGap[];
  /** Items handed to the handler and reported processed. */
  readonly delivered: number;
  /** Wraps skipped because they were seen (any relay, this or an earlier pass). */
  readonly duplicates: number;
  /** Events dropped: not a valid gift wrap for us, or over a bound. Nothing about them is kept. */
  readonly dropped: number;
  /** Items the handler asked to see again. */
  readonly deferred: number;
  readonly relays: readonly SyncRelayResult[];
}

export interface SyncOptions {
  /** The relays to read (chosen by core, 07 §4.3). 1 to 64 entries. */
  readonly relays: readonly string[];
  /** Own keys: `#p` of the REQ, and the epoch to decrypt each wrap with. */
  readonly identities: readonly SyncIdentity[];
  readonly onEnvelope: EnvelopeHandler;
  /** Time budget in milliseconds (default SYNC_BUDGET_MS). */
  readonly budgetMs?: number;
}

export interface SubscribeOptions {
  readonly relays: readonly string[];
  readonly identities: readonly SyncIdentity[];
  readonly onEnvelope: EnvelopeHandler;
}

export interface SyncEngineOptions {
  readonly pool: Pick<RelayPool, 'connect' | 'onFrame' | 'onRelayClose' | 'isClosed'>;
  readonly persistence: SyncPersistence;
  /** The recipient's KeyStore, or an OwnerSession on owner surfaces (owner copies). */
  readonly keys: EnvelopeKeys;
  readonly logger?: Logger;
  /** Clock in Unix milliseconds (default: the wall clock). */
  readonly now?: () => number;
  /** Timers (default: the global ones, read at call time so fake timers apply). */
  readonly timers?: Timers;
  /** Entries of each in-memory dedup cache (default DEDUP_CACHE_ENTRIES); tests lower it. */
  readonly dedupCacheEntries?: number;
  /** Wrap ids remembered per relay in a pass (default MAX_LEARNED_IDS_PER_RELAY); tests lower it. */
  readonly learnedIdsPerRelay?: number;
}

/**
 * Stops a live subscription (CLOSE on each relay, no reconnect). The promise resolves once every
 * event task still running for it (a handler call, a cursor write) has settled, so a caller can
 * close its store afterwards (M1-9s). Never rejects.
 */
export type Unsubscribe = () => Promise<void>;

/**
 * The earliest `first_seen_at` a seen row must still keep (07 §3.2 "Retention"): rows older than this
 * may be pruned. It is the older of 7 days ago and the earliest `since` a sync can still request, the
 * lowest cursor of the relays in use minus 48 h and S. A cursor older than 30 days is ignored, so a
 * relay that never answers cannot stop pruning.
 */
export function seenPruneBefore(nowSeconds: number, cursors: readonly number[]): number {
  let cutoff = nowSeconds - SEEN_RETENTION_SECONDS;
  for (const cursor of cursors) {
    if (!Number.isSafeInteger(cursor) || nowSeconds - cursor > CURSOR_IGNORE_AFTER_SECONDS)
      continue;
    cutoff = Math.min(cutoff, cursor - SYNC_LOOKBACK_SECONDS - SYNC_SKEW_SECONDS);
  }
  return Math.max(0, cutoff);
}

/** The `since` of a REQ (07 §4.2, §4.3). `cursor` is the stored `last_seen`, if any. */
export function syncSince(nowSeconds: number, cursor: number | undefined): number {
  if (cursor === undefined || !Number.isSafeInteger(cursor) || cursor < 0) {
    return Math.max(0, nowSeconds - FIRST_SYNC_LOOKBACK_SECONDS);
  }
  // A cursor from the future (a clock that went back, a corrupt row) is not trusted past now.
  return Math.max(0, Math.min(cursor, nowSeconds) - SYNC_LOOKBACK_SECONDS - SYNC_SKEW_SECONDS);
}

// --- internals --------------------------------------------------------------------------------

const defaultTimers: Timers = {
  setTimeout: (callback, ms) =>
    (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
      callback,
      ms,
    ),
  clearTimeout: (handle) =>
    (globalThis as unknown as { clearTimeout(handle: unknown): void }).clearTimeout(handle),
};

/** A set that forgets its oldest entry beyond `max`: memory stays bounded whatever a relay sends. */
class BoundedSet {
  private readonly items = new Set<string>();
  constructor(private readonly max: number) {}
  has(key: string): boolean {
    return this.items.has(key);
  }
  add(key: string): void {
    if (this.items.has(key)) this.items.delete(key);
    else if (this.items.size >= this.max)
      this.items.delete(this.items.values().next().value as string);
    this.items.add(key);
  }
  get size(): number {
    return this.items.size;
  }
}

type EventResult = 'delivered' | 'duplicate' | 'dropped' | 'retry' | 'bound' | 'keys_unavailable';

interface Counters {
  delivered: number;
  duplicates: number;
  dropped: number;
  deferred: number;
}

/** One sync call or live subscription: what its relays share. */
interface Run {
  readonly identities: readonly SyncIdentity[];
  readonly pubkeys: readonly string[];
  readonly onEnvelope: EnvelopeHandler;
  readonly counters: Counters;
  readonly live: boolean;
  stopped: boolean;
  stopReason: 'budget' | 'stopped';
  readonly hooks: Set<() => void>;
  /** Event tasks still running (handler calls, cursor writes), so a stop can wait for them. */
  readonly tasks: Set<Promise<void>>;
  /** sync(): seconds a relay may hold more events in than it returned (M1-5d). Live runs log them. */
  readonly gaps: SyncGap[];
  /** sync(): per relay, the wrap ids it served in this pass, by second (M2-19). Empty when live. */
  readonly learned: Map<string, Learned>;
}

/**
 * The wraps one relay served in a sync pass that opened or were already seen, by `created_at`
 * (M2-19). Bounded by `max` (MAX_LEARNED_IDS_PER_RELAY); past it `full` is set and the relay closes
 * no gap. `pages` records each page of the walk, so a second counts as read in full only on positive
 * evidence (IR-M2-19-1 H-1), and `untrusted` is set when the walk ended because the relay ignores
 * `until`.
 */
interface Learned {
  readonly since: number;
  readonly max: number;
  readonly bySecond: Map<number, Set<string>>;
  readonly pages: PageRecord[];
  count: number;
  full: boolean;
  untrusted: boolean;
}

/**
 * One page of a walk: its `until` (undefined: the first page), the oldest second of a wrap on it that
 * is for us and opened or was seen before (stray or junk frames never count, AUDIT-FABLE-M2-19-1
 * L-1), whether an event sat at `until` (the relay applies `until` inclusively), and its size.
 */
interface PageRecord {
  readonly until: number | undefined;
  readonly oldest: number | undefined;
  readonly sawAtUntil: boolean;
  readonly count: number;
}

/**
 * True when the walk of `learned` read second `t` in full (IR-M2-19-1 H-1, IR-M2-19-2 H-2). The one
 * piece of evidence: a page whose range holds `t` also held a verified wrap older than `t`, so a
 * newest-first cap cut that page below `t`. `t` equal to the page's `until` counts only when an
 * event sat at `until` on that page: a relay that applies `until` exclusively never served `t` there
 * (AUDIT-FABLE-M2-19-1 M-1). A page smaller than the largest is no proof (a lower cap can cut it).
 * `t` must lie above the walk's `since` (a walk may stop in the middle of its oldest second), and a
 * walk that ended because the relay ignores `until` proves nothing. Assumes the relay returns stored
 * events newest first and applies `until` inclusively (NIP-01); see 07 §4.2 for the residual.
 */
function readInFull(learned: Learned, t: number): boolean {
  if (learned.full || learned.untrusted || t <= learned.since) return false;
  return learned.pages.some(
    (page) =>
      (page.until === undefined || t < page.until || (t === page.until && page.sawAtUntil)) &&
      page.oldest !== undefined &&
      page.oldest < t,
  );
}

interface RelayOutcome {
  readonly status: SyncRelayResult['status'];
  readonly reason: SyncRelayReason;
  /** Live: the subscription reached EOSE at least once, so the retry delay resets. */
  readonly reachedLive: boolean;
}

function host(relay: string): string {
  const m = /^wss:\/\/([^/:?#]*)/.exec(relay);
  return m?.[1] ?? 'invalid';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SyncEngine {
  private readonly pool: SyncEngineOptions['pool'];
  private readonly persistence: SyncPersistence;
  private readonly keys: EnvelopeKeys;
  private readonly logger: Logger | undefined;
  private readonly now: () => number;
  private readonly timers: Timers;
  /** Wrap ids (key `id`) opened and reported processed. Bounded; the persisted seen-set is the record. */
  private readonly processed: BoundedSet;
  /** Wraps (key `id:sig`) that did not open. Not persisted (07 §3.2). Bounded. */
  private readonly junk: BoundedSet;
  /** Wraps being opened right now (key `id:sig`), so the same wrap from two relays is handled once. */
  private readonly inflight = new Map<string, Promise<EventResult>>();
  /** Wrap ids a sync pass remembers per relay (M2-19). */
  private readonly learnedMax: number;

  constructor(options: SyncEngineOptions) {
    this.pool = options.pool;
    this.persistence = options.persistence;
    this.keys = options.keys;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? defaultTimers;
    const entries = options.dedupCacheEntries ?? DEDUP_CACHE_ENTRIES;
    this.processed = new BoundedSet(entries);
    this.junk = new BoundedSet(entries);
    const learnedMax = options.learnedIdsPerRelay ?? MAX_LEARNED_IDS_PER_RELAY;
    this.learnedMax =
      Number.isSafeInteger(learnedMax) && learnedMax > 0
        ? Math.min(learnedMax, MAX_LEARNED_IDS_PER_RELAY)
        : MAX_LEARNED_IDS_PER_RELAY;
  }

  /** Sizes of the in-memory dedup state, for tests and `doctor`. Each cache is bounded. */
  dedupStats(): { processed: number; junk: number; inflight: number } {
    return { processed: this.processed.size, junk: this.junk.size, inflight: this.inflight.size };
  }

  /**
   * One catch-up pass over `relays`, within the time budget (06 §6). Never rejects for a relay
   * problem: each relay's outcome is in the result.
   * @throws TransportError `invalid_relays` or `invalid_argument` for bad arguments.
   */
  async sync(options: SyncOptions): Promise<SyncResult> {
    const relays = this.checkRelays(options.relays);
    const budget = options.budgetMs ?? SYNC_BUDGET_MS;
    if (!Number.isSafeInteger(budget) || budget <= 0) {
      throw new TransportError('invalid_argument', 'sync: the budget must be a positive integer');
    }
    const run = this.newRun(options.identities, options.onEnvelope, false);
    const timer = this.timers.setTimeout(() => this.stop(run, 'budget'), budget);
    const stoppedFirst = new Promise<RelayOutcome>((resolve) => {
      run.hooks.add(() =>
        resolve({ status: 'incomplete', reason: run.stopReason, reachedLive: false }),
      );
    });
    const outcomes = await Promise.all(
      relays.map((relay) =>
        Promise.race([this.runRelay(relay, run), stoppedFirst]).catch((): RelayOutcome => ({
          status: 'failed',
          reason: 'connect_failed',
          reachedLive: false,
        })),
      ),
    );
    const results = relays.map((relay, i) => ({
      relay,
      status: (outcomes[i] as RelayOutcome).status,
      reason: (outcomes[i] as RelayOutcome).reason,
    }));
    // M2-19: inside the same budget, a bounded `ids` re-query closes a gap another relay covers.
    const { gaps, closed } = await this.closeGaps(run, results);
    this.timers.clearTimeout(timer);
    this.stop(run, 'stopped'); // ends nothing that is still running except stray subscriptions
    const partial = results.some((r) => r.status !== 'complete');
    this.logger?.info('sync pass', {
      relays: results.length,
      partial,
      delivered: run.counters.delivered,
      duplicates: run.counters.duplicates,
      dropped: run.counters.dropped,
      deferred: run.counters.deferred,
      gaps: gaps.length,
      gapsClosed: closed,
    });
    return { partial, ...run.counters, gaps, relays: results };
  }

  /**
   * Live subscription: reads the backlog like sync() and then stays open. A relay that is lost or
   * cannot be reached is tried again with a doubling delay (5 s up to 5 min). Stop it with the
   * returned function.
   * @throws TransportError `invalid_relays` or `invalid_argument` for bad arguments.
   */
  subscribe(options: SubscribeOptions): Unsubscribe {
    const relays = this.checkRelays(options.relays);
    const run = this.newRun(options.identities, options.onEnvelope, true);
    for (const relay of relays) void this.liveLoop(relay, run);
    return async () => {
      this.stop(run, 'stopped');
      await Promise.allSettled([...run.tasks]);
    };
  }

  // --- setup -----------------------------------------------------------------------------------

  private checkRelays(relays: readonly string[]): string[] {
    if (!Array.isArray(relays) || relays.length === 0 || relays.length > MAX_SYNC_RELAYS) {
      throw new TransportError('invalid_relays', 'sync: relay list must hold 1 to 64 relays');
    }
    return [...new Set(relays)];
  }

  private newRun(
    identities: readonly SyncIdentity[],
    onEnvelope: EnvelopeHandler,
    live: boolean,
  ): Run {
    if (
      !Array.isArray(identities) ||
      identities.length === 0 ||
      identities.length > MAX_SYNC_IDENTITIES
    ) {
      throw new TransportError('invalid_argument', 'sync: 1 to 64 own keys are required');
    }
    const copy: SyncIdentity[] = [];
    for (const identity of identities) {
      const epoch = identity?.epoch;
      if (
        !isRecord(identity) ||
        typeof identity.pubkey !== 'string' ||
        !HEX_32.test(identity.pubkey) ||
        (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 0))
      ) {
        throw new TransportError('invalid_argument', 'sync: an own key is not valid');
      }
      copy.push(
        epoch === undefined ? { pubkey: identity.pubkey } : { pubkey: identity.pubkey, epoch },
      );
    }
    if (typeof onEnvelope !== 'function') {
      throw new TransportError('invalid_argument', 'sync: a handler is required');
    }
    return {
      identities: copy,
      pubkeys: [...new Set(copy.map((i) => i.pubkey))],
      onEnvelope,
      counters: { delivered: 0, duplicates: 0, dropped: 0, deferred: 0 },
      live,
      stopped: false,
      stopReason: 'stopped',
      hooks: new Set(),
      tasks: new Set(),
      gaps: [],
      learned: new Map(),
    };
  }

  private stop(run: Run, reason: 'budget' | 'stopped'): void {
    if (run.stopped) return;
    run.stopped = true;
    run.stopReason = reason;
    for (const hook of [...run.hooks]) {
      try {
        hook();
      } catch {
        // a hook's fault does not stop the others
      }
    }
    run.hooks.clear();
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  // --- live ------------------------------------------------------------------------------------

  private async liveLoop(relay: string, run: Run): Promise<void> {
    let delay = LIVE_RETRY_BASE_MS;
    while (!run.stopped && !this.pool.isClosed) {
      let outcome: RelayOutcome;
      try {
        outcome = await this.runRelay(relay, run);
      } catch {
        outcome = { status: 'failed', reason: 'connect_failed', reachedLive: false };
      }
      if (run.stopped) return;
      if (outcome.reason === 'keys_unavailable') {
        this.logger?.warn('live relay paused', { reason: 'keys_unavailable', host: host(relay) });
      }
      if (outcome.reachedLive) delay = LIVE_RETRY_BASE_MS;
      await new Promise<void>((resolve) => {
        const handle = this.timers.setTimeout(() => {
          run.hooks.delete(wake);
          resolve();
        }, delay);
        const wake = (): void => {
          this.timers.clearTimeout(handle);
          resolve();
        };
        run.hooks.add(wake);
      });
      delay = Math.min(delay * 2, LIVE_RETRY_MAX_MS);
    }
  }

  // --- one relay -------------------------------------------------------------------------------

  /**
   * One subscription on one relay. Sync mode ends at EOSE (after every event is handled); live mode
   * ends when the connection is lost or the run is stopped. Never leaves a link pinned.
   */
  private async runRelay(relay: string, run: Run): Promise<RelayOutcome> {
    if (!isAllowedRelayUrl(relay))
      return { status: 'failed', reason: 'invalid_url', reachedLive: false };
    const now = this.nowSeconds();
    let cursor: number | undefined;
    try {
      cursor = await this.persistence.getCursor(relay);
    } catch {
      cursor = undefined; // an unreadable cursor: read the full first-sync window
    }
    // A pass that was cut short earlier continues at the page where it stopped (M-3). The window
    // (`since`) is recomputed from that pass's start, so the cursor it will write is that start too.
    let startedAt = now;
    let resumeUntil: number | undefined;
    const resume = await this.safeGetResume(relay);
    if (
      resume !== undefined &&
      Number.isSafeInteger(resume.until) &&
      Number.isSafeInteger(resume.startedAt) &&
      resume.startedAt <= now &&
      now - resume.startedAt <= SYNC_RESUME_MAX_AGE_SECONDS &&
      resume.until >= syncSince(resume.startedAt, cursor)
    ) {
      startedAt = resume.startedAt;
      resumeUntil = resume.until;
    }
    if (run.stopped) return { status: 'incomplete', reason: run.stopReason, reachedLive: false };
    const since = syncSince(startedAt, cursor);
    const link = await this.pool.connect(relay);
    if (typeof link === 'string') return { status: 'failed', reason: link, reachedLive: false };
    if (run.stopped) {
      link.release();
      return { status: 'incomplete', reason: run.stopReason, reachedLive: false };
    }
    return this.subscription(relay, run, link, startedAt, since, cursor, resumeUntil);
  }

  /**
   * Reads one relay: pages of stored events walking back from now to `since` (H-1), then, in live
   * mode, a live-only subscription. A relay may cap the stored events it returns per filter (newest
   * first, then EOSE), so one EOSE does not mean "all of it". Each page asks for `limit` events up
   * to `until` (inclusive); the walk goes on while a page holds an event older than the page before
   * it, so a relay that caps below our limit or ignores `limit` and `until` is read correctly too.
   * The cursor moves only after the last page is read and every event was handled.
   */
  private subscription(
    relay: string,
    run: Run,
    link: RelayLink,
    startedAt: number,
    since: number,
    cursor: number | undefined,
    resumeUntil: number | undefined,
  ): Promise<RelayOutcome> {
    const newSubId = (): string => `al-${encodeHex(randomBytes(6))}`;
    return new Promise<RelayOutcome>((resolve) => {
      let phase: 'backlog' | 'live' = 'backlog';
      let subId = newSubId();
      let pageUntil = resumeUntil; // the `until` of the page being read
      let pageOldest: number | undefined;
      // Ids of this page's events at `pageOldest`; the next page starts at that second (inclusive),
      // so it repeats them. They are skipped there, not counted or handled twice.
      let pageOldestIds: string[] = [];
      let skipIds = new Set<string>();
      // This page, relative to its `until`: did an event sit at it, and did one lie above it (a relay
      // that ignores `until`)?
      let sawAtUntil = false;
      // M2-19: the oldest in-window second of a verified wrap for us on this page (page evidence).
      let proofOldest: number | undefined;
      let sawNewer = false;
      // Events of this page inside the window and at or below its `until` (repeats included), and
      // the most any page of this walk returned: a relay's cap is at least that (M1-5d).
      let pageCount = 0;
      let maxPageCount = 0;
      let pages = 1;
      let eosePending = false;
      const pageRequest = (): string =>
        JSON.stringify([
          'REQ',
          subId,
          {
            kinds: [NOSTR_KIND_GIFT_WRAP],
            '#p': run.pubkeys,
            since,
            ...(pageUntil === undefined ? {} : { until: pageUntil }),
            limit: SYNC_PAGE_LIMIT,
          },
        ]);
      // Live: no stored events (limit 0). `since` stays, because a wrap's created_at is back-dated.
      const liveRequest = (): string =>
        JSON.stringify([
          'REQ',
          subId,
          { kinds: [NOSTR_KIND_GIFT_WRAP], '#p': run.pubkeys, since, limit: 0 },
        ]);
      let reqFrame = pageRequest();
      let finished = false;
      let reachedLive = false;
      let authTried = false;
      let hold = false; // an event was handled as `retry` or dropped for a bound: the cursor stays
      let frames = 0;
      let newWraps = 0;
      let windowStart = startedAt;
      let queued = 0;
      let queuedChars = 0;
      let lastCursorWrite = startedAt;
      let chain: Promise<void> = Promise.resolve();
      // M2-19: what this relay served in a sync pass, so another relay's gap can be closed.
      let learned: Learned | undefined;
      if (!run.live) {
        learned = {
          since,
          max: this.learnedMax,
          bySecond: new Map(),
          pages: [],
          count: 0,
          full: false,
          untrusted: false,
        };
        run.learned.set(relay, learned);
      }

      const finish = (outcome: Omit<RelayOutcome, 'reachedLive'>): void => {
        if (finished) return;
        finished = true;
        unFrame();
        unClose();
        run.hooks.delete(onStop);
        if (outcome.status !== 'complete' && phase === 'backlog' && pageUntil !== undefined) {
          // Pages above `pageUntil` were read and handled; the next pass continues here.
          void this.safeSetResume(relay, { until: pageUntil, startedAt });
        }
        if (link.isOpen()) link.send(JSON.stringify(['CLOSE', subId]));
        link.release();
        resolve({ ...outcome, reachedLive });
      };
      const onStop = (): void => finish({ status: 'incomplete', reason: run.stopReason });
      run.hooks.add(onStop);

      const writeCursor = async (at: number): Promise<void> => {
        // A stopped live subscription writes nothing more (M1-9s): its store may be closing.
        if (run.live && run.stopped) return;
        try {
          await this.persistence.setCursor(relay, Math.max(at, cursor ?? 0));
          lastCursorWrite = at;
        } catch {
          this.logger?.warn('cursor not saved', { host: host(relay) });
        }
      };

      const enqueue = (task: () => Promise<void>): void => {
        chain = chain.then(task).catch(() => undefined);
        const current = chain;
        run.tasks.add(current);
        void current.then(() => run.tasks.delete(current));
      };

      /** Runs after every event of the page was handled (it is chained behind them). */
      const afterEose = async (): Promise<void> => {
        if (finished || phase !== 'backlog') return;
        if (hold) {
          finish({ status: 'incomplete', reason: 'handler_retry' });
          return;
        }
        // Where the next page starts, or undefined when the window is read. A relay caps the events
        // it returns per filter, newest first, so a second that holds at least the cap returns the
        // same events again for `until` = that second (H-1b): step below it, giving up only the
        // overflow of that one second. If an event lies above `until`, the relay ignores `until`:
        // stop. More events than the relay's cap within one single second cannot all be fetched
        // (Nostr has no sub-second paging): that second is reported as a gap (M1-5d).
        maxPageCount = Math.max(maxPageCount, pageCount);
        if (learned !== undefined) {
          if (sawNewer) learned.untrusted = true;
          if (learned.pages.length < MAX_PAGES_PER_PASS) {
            learned.pages.push({
              until: pageUntil,
              oldest: proofOldest,
              sawAtUntil,
              count: pageCount,
            });
          } else {
            learned.full = true;
          }
        }
        if (
          pageUntil !== undefined &&
          !sawNewer &&
          (pageOldest === undefined || pageOldest === pageUntil) &&
          pageCount >= MIN_GAP_EVENTS &&
          pageCount >= maxPageCount
        ) {
          this.reportGap(relay, run, pageUntil);
        }
        const next = ((): { until: number; skip: readonly string[] } | undefined => {
          if (sawNewer) return undefined;
          if (pageOldest !== undefined) {
            if (pageOldest <= since) return undefined;
            // The first page of a walk is repeated from its oldest second (inclusive), because the
            // cap may have cut that second in the middle.
            if (pageUntil === undefined || pageOldest < pageUntil) {
              return { until: pageOldest, skip: pageOldestIds };
            }
          } else if (!(pageUntil !== undefined && sawAtUntil)) {
            return undefined;
          }
          // Nothing older than `pageUntil` came back: that second is all this page held.
          return pageUntil !== undefined && pageUntil - 1 >= since
            ? { until: pageUntil - 1, skip: [] }
            : undefined;
        })();
        if (next !== undefined) {
          if (pages >= MAX_PAGES_PER_PASS) {
            finish({ status: 'incomplete', reason: 'too_many_events' });
            return;
          }
          link.send(JSON.stringify(['CLOSE', subId]));
          pageUntil = next.until;
          skipIds = new Set(next.skip);
          pageOldest = undefined;
          proofOldest = undefined;
          pageOldestIds = [];
          sawAtUntil = false;
          sawNewer = false;
          pageCount = 0;
          pages += 1;
          eosePending = false;
          subId = newSubId();
          reqFrame = pageRequest();
          if (!link.send(reqFrame)) finish({ status: 'failed', reason: 'closed' });
          return;
        }
        await writeCursor(startedAt);
        await this.safeSetResume(relay, undefined);
        if (finished) return;
        if (!run.live) {
          finish({ status: 'complete', reason: 'ok' });
          return;
        }
        link.send(JSON.stringify(['CLOSE', subId]));
        phase = 'live';
        reachedLive = true;
        subId = newSubId();
        reqFrame = liveRequest();
        if (!link.send(reqFrame)) finish({ status: 'failed', reason: 'closed' });
      };

      const handle = async (event: unknown, arrivedAt: number): Promise<void> => {
        if (finished || run.stopped) return;
        // The bound on openings: a pass, or a minute of live traffic.
        if (run.live && reachedLive && arrivedAt - windowStart >= 60) {
          windowStart = arrivedAt;
          newWraps = 0;
        }
        const result = await this.handleEvent(event, relay, run, () => {
          newWraps += 1;
          const limit =
            run.live && reachedLive ? MAX_LIVE_NEW_WRAPS_PER_MINUTE : MAX_NEW_WRAPS_PER_PASS;
          return newWraps <= limit;
        });
        if (result === 'keys_unavailable') {
          finish({ status: 'failed', reason: 'keys_unavailable' });
          return;
        }
        if (
          learned !== undefined &&
          phase === 'backlog' &&
          (result === 'delivered' || result === 'duplicate') &&
          isRecord(event) &&
          event.kind === NOSTR_KIND_GIFT_WRAP &&
          pickIdentity(event.tags, run.identities) !== undefined
        ) {
          learn(learned, event);
          // This event's page is still the current one: the page's EOSE work is chained behind it.
          const at = event.created_at;
          if (
            typeof at === 'number' &&
            Number.isSafeInteger(at) &&
            at >= since &&
            (pageUntil === undefined || at <= pageUntil) &&
            (proofOldest === undefined || at < proofOldest)
          ) {
            proofOldest = at;
          }
        }
        if (result === 'retry') hold = true;
        if (result === 'bound') {
          hold = true; // events were left unread: the cursor stays
          if (!run.live || !reachedLive)
            finish({ status: 'incomplete', reason: 'too_many_events' });
          return;
        }
        if (
          run.live &&
          reachedLive &&
          !hold &&
          result === 'delivered' &&
          arrivedAt - lastCursorWrite >= LIVE_CURSOR_INTERVAL_SECONDS
        ) {
          // The arrival time, not now: later frames may still sit in the queue (L-1).
          await writeCursor(arrivedAt);
        }
      };

      const unFrame = this.pool.onFrame((from, frame) => {
        if (finished || from !== relay || frame[1] !== subId) return;
        switch (frame[0]) {
          case 'EVENT': {
            const event = frame[2];
            if (
              skipIds.size > 0 &&
              isRecord(event) &&
              typeof event.id === 'string' &&
              skipIds.has(event.id)
            ) {
              sawAtUntil = true;
              pageCount += 1; // the relay's cap counts it
              return; // the repeat of the previous page's last second
            }
            frames += 1;
            if (frames > MAX_FRAMES_PER_PASS && !(run.live && reachedLive)) {
              finish({ status: 'incomplete', reason: 'too_many_events' });
              return;
            }
            const size = eventWeight(event);
            if (queued >= MAX_QUEUED_EVENTS || queuedChars + size > MAX_QUEUED_CHARS) {
              // A slow handler behind a fast relay: stop reading rather than hold it all in memory.
              this.logger?.warn('relay stopped', { reason: 'overflow', host: host(relay) });
              finish({ status: 'incomplete', reason: 'overflow' });
              return;
            }
            if (phase === 'backlog' && isRecord(event)) {
              const at = event.created_at;
              if (typeof at === 'number' && pageUntil !== undefined) {
                if (at > pageUntil) sawNewer = true;
                else if (at === pageUntil) sawAtUntil = true;
              }
              if (
                typeof at === 'number' &&
                Number.isSafeInteger(at) &&
                at >= since &&
                (pageUntil === undefined || at <= pageUntil)
              ) {
                pageCount += 1;
              }
              if (
                typeof at === 'number' &&
                Number.isSafeInteger(at) &&
                at >= since &&
                (pageUntil === undefined || at <= pageUntil) &&
                (pageOldest === undefined || at < pageOldest)
              ) {
                if (pageOldest === undefined || at < pageOldest) pageOldestIds = [];
                pageOldest = at;
              }
              if (
                typeof at === 'number' &&
                at === pageOldest &&
                typeof event.id === 'string' &&
                pageOldestIds.length < 2 * SYNC_PAGE_LIMIT
              ) {
                pageOldestIds.push(event.id);
              }
            }
            queued += 1;
            queuedChars += size;
            const arrivedAt = this.nowSeconds();
            enqueue(async () => {
              try {
                await handle(event, arrivedAt);
              } finally {
                queued -= 1;
                queuedChars -= size;
              }
            });
            return;
          }
          case 'EOSE':
            if (phase === 'backlog' && !eosePending) {
              eosePending = true;
              enqueue(afterEose);
            }
            return;
          case 'CLOSED': {
            // Only a fixed prefix of the relay's text is read (NIP-01, NIP-42).
            const text = typeof frame[2] === 'string' ? frame[2] : '';
            if (text.startsWith(AUTH_REQUIRED) && !authTried) {
              authTried = true;
              void link.authenticate().then(
                (ok) => {
                  if (finished) return;
                  if (ok && link.send(reqFrame)) return;
                  finish({ status: 'failed', reason: 'auth_failed' });
                },
                () => finish({ status: 'failed', reason: 'auth_failed' }),
              );
              return;
            }
            finish({
              status: 'failed',
              reason: text.startsWith(AUTH_REQUIRED) ? 'auth_failed' : 'subscription_closed',
            });
            return;
          }
          default:
            return;
        }
      });
      const unClose = this.pool.onRelayClose((closed) => {
        if (closed !== relay || finished) return;
        // Events still queued are not handled after this: the cursor stays, and the loss is reported.
        finish(
          reachedLive || run.live
            ? { status: 'incomplete', reason: 'connection_lost' }
            : { status: 'failed', reason: 'connection_lost' },
        );
      });

      if (!link.send(reqFrame)) finish({ status: 'failed', reason: 'closed' });
    });
  }

  // --- one event -------------------------------------------------------------------------------

  /**
   * An untrusted event from a relay (I-5). `countOpening` is called when the wrap is about to be
   * opened and returns false when the relay is over its bound.
   */
  private async handleEvent(
    event: unknown,
    relay: string,
    run: Run,
    countOpening: () => boolean,
  ): Promise<EventResult> {
    const counters = run.counters;
    if (
      !isRecord(event) ||
      event.kind !== NOSTR_KIND_GIFT_WRAP ||
      typeof event.id !== 'string' ||
      !HEX_32.test(event.id) ||
      typeof event.sig !== 'string' ||
      !HEX_64.test(event.sig)
    ) {
      counters.dropped += 1;
      return 'dropped';
    }
    const id = event.id;
    const key = `${id}:${event.sig}`;
    if (this.junk.has(key)) {
      counters.dropped += 1;
      return 'dropped';
    }
    if (this.processed.has(id)) {
      counters.duplicates += 1;
      return 'duplicate';
    }
    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      // The same wrap from another relay, being handled now: take its outcome, so a `retry` also
      // holds this relay's cursor.
      const result = await pending;
      if (result === 'delivered') counters.duplicates += 1;
      return result === 'delivered' ? 'duplicate' : result;
    }
    const work = this.openAndDeliver(event, key, id, relay, run, countOpening);
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async openAndDeliver(
    event: Record<string, unknown>,
    key: string,
    id: string,
    relay: string,
    run: Run,
    countOpening: () => boolean,
  ): Promise<EventResult> {
    const counters = run.counters;
    // Cheapest first: our key, then the seen-set read, then the bound on openings (which counts
    // only wraps that are really opened, so wraps seen before do not use it up).
    const identity = pickIdentity(event.tags, run.identities);
    if (identity === undefined) {
      this.junk.add(key); // a relay served a wrap that is not for us
      counters.dropped += 1;
      return 'dropped';
    }
    if (await this.safeSeen('wrap', id)) {
      this.processed.add(id);
      counters.duplicates += 1;
      return 'duplicate';
    }
    if (!countOpening()) {
      counters.dropped += 1; // over the relay's bound: not recorded, comes again if it is real
      return 'bound';
    }
    let unwrapped: Awaited<ReturnType<typeof unwrapGiftWrap>>;
    try {
      unwrapped = await unwrapGiftWrap(
        event,
        this.keys,
        identity.epoch === undefined ? undefined : { epoch: identity.epoch },
      );
    } catch (error) {
      if (error instanceof KeyStoreError) return 'keys_unavailable';
      this.junk.add(key); // malformed or not ours: dropped, never logged from (07 §3.2)
      counters.dropped += 1;
      return 'dropped';
    }
    const item: SyncItem = Object.freeze({
      envelope: unwrapped.envelope,
      giftWrapId: unwrapped.giftWrapId,
      giftWrapCreatedAt: unwrapped.giftWrapCreatedAt,
      relay,
      recipient: identity.pubkey,
      envelopeSeen: await this.safeSeen('envelope', unwrapped.envelope.id),
    });
    let disposition: SyncDisposition;
    try {
      const answer = await run.onEnvelope(item);
      disposition = answer === 'processed' || answer === 'verified' ? answer : 'retry';
    } catch {
      disposition = 'retry'; // a handler fault: nothing is marked, the item comes again
    }
    if (disposition === 'retry') {
      counters.deferred += 1;
      return 'retry';
    }
    const mark = this.persistence.markSeen;
    // A stopped live subscription marks nothing more (M1-9s): its store may be closing.
    if (mark !== undefined && !(run.live && run.stopped)) {
      const at = this.nowSeconds();
      await this.safeMark('wrap', id, at);
      if (disposition === 'verified') await this.safeMark('envelope', unwrapped.envelope.id, at);
    }
    this.processed.add(id);
    counters.delivered += 1;
    return 'delivered';
  }

  private async safeSeen(kind: SeenKind, id: string): Promise<boolean> {
    try {
      return (await this.persistence.isSeen(kind, id)) === true;
    } catch {
      return false; // 07 §3.2: a seen-set that cannot be read is empty for this pass
    }
  }

  private async safeGetResume(relay: string): Promise<SyncResume | undefined> {
    try {
      return await this.persistence.getResume?.(relay);
    } catch {
      return undefined; // an unreadable position: start from the newest page
    }
  }

  // --- gaps (M2-19) ------------------------------------------------------------------------------

  /**
   * After the pass: a gap of relay R at second T is closed when another relay S of the same pass
   * completed, has no gap at T, read T in full on positive evidence (`readInFull`), served every wrap
   * R showed at T plus some R did not show, and one `ids` query on R for those (at most
   * MAX_GAP_REQUERY_IDS) returns every one of them. Then S read that second in full and R holds what
   * S holds there. One query per gap, at most
   * MAX_GAP_REQUERIES_PER_PASS per pass, inside the pass budget. Every other gap stays reported.
   */
  private async closeGaps(
    run: Run,
    results: readonly SyncRelayResult[],
  ): Promise<{ gaps: SyncGap[]; closed: number }> {
    const gaps = [...run.gaps];
    if (gaps.length === 0 || run.stopped) return { gaps, closed: 0 };
    const key = (relay: string, second: number): string => `${relay}\n${second}`;
    const gapKeys = new Set(gaps.map((g) => key(g.relay, g.second)));
    const complete = results.filter((r) => r.status === 'complete').map((r) => r.relay);
    const queries: Promise<{ key: string; closed: boolean }>[] = [];
    const queried = new Set<string>();
    for (const gap of gaps) {
      const k = key(gap.relay, gap.second);
      if (queried.has(k) || queries.length >= MAX_GAP_REQUERIES_PER_PASS) continue;
      const ownRecord = run.learned.get(gap.relay);
      // What R showed at T must be known to check that S holds all of it (IR-M2-19-1 H-1 (d)).
      if (ownRecord === undefined || ownRecord.full) continue;
      const own = ownRecord.bySecond.get(gap.second) ?? new Set<string>();
      let ids: string[] | undefined;
      for (const source of complete) {
        if (source === gap.relay || gapKeys.has(key(source, gap.second))) continue;
        const learned = run.learned.get(source);
        if (learned === undefined || !readInFull(learned, gap.second)) continue;
        const theirs = learned.bySecond.get(gap.second) ?? new Set<string>();
        if ([...own].some((id) => !theirs.has(id))) continue;
        const missing = [...theirs].filter((id) => !own.has(id));
        if (missing.length > 0 && missing.length <= MAX_GAP_REQUERY_IDS) {
          ids = missing.sort();
          break;
        }
      }
      if (ids === undefined) continue;
      queried.add(k);
      queries.push(
        this.requeryGap(gap.relay, run, gap.second, ids).then(
          (closed) => ({ key: k, closed }),
          () => ({ key: k, closed: false }),
        ),
      );
    }
    const closedKeys = new Set(
      (await Promise.all(queries)).filter((q) => q.closed).map((q) => q.key),
    );
    return {
      gaps: gaps.filter((g) => !closedKeys.has(key(g.relay, g.second))),
      closed: closedKeys.size,
    };
  }

  /**
   * One `ids` query on `relay` for wraps at `second` (M2-19). True when every asked id comes back as
   * a wrap at that second that opens or was already seen. The relay's answer is untrusted (I-5):
   * events not asked for are dropped, the frames are bounded, and nothing of it is logged.
   */
  private async requeryGap(
    relay: string,
    run: Run,
    second: number,
    ids: readonly string[],
  ): Promise<boolean> {
    if (run.stopped || !isAllowedRelayUrl(relay)) return false;
    const link = await this.pool.connect(relay);
    if (typeof link === 'string') return false;
    if (run.stopped) {
      link.release();
      return false;
    }
    const wanted = new Set(ids);
    const confirmed = new Set<string>();
    const subId = `al-${encodeHex(randomBytes(6))}`;
    const reqFrame = JSON.stringify([
      'REQ',
      subId,
      {
        ids: [...ids],
        kinds: [NOSTR_KIND_GIFT_WRAP],
        '#p': run.pubkeys,
        since: second,
        until: second,
        limit: ids.length,
      },
    ]);
    return new Promise<boolean>((resolve) => {
      let finished = false;
      let authTried = false;
      let eose = false;
      let frames = 0;
      let openings = 0;
      const pending: Promise<void>[] = [];
      const finish = (closed: boolean): void => {
        if (finished) return;
        finished = true;
        unFrame();
        unClose();
        run.hooks.delete(onStop);
        this.timers.clearTimeout(timeout);
        if (link.isOpen()) link.send(JSON.stringify(['CLOSE', subId]));
        link.release();
        resolve(closed);
      };
      const onStop = (): void => finish(false);
      run.hooks.add(onStop);
      const timeout = this.timers.setTimeout(() => finish(false), GAP_REQUERY_TIMEOUT_MS);
      const unFrame = this.pool.onFrame((from, frame) => {
        if (finished || from !== relay || frame[1] !== subId) return;
        switch (frame[0]) {
          case 'EVENT': {
            if (eose) return;
            frames += 1;
            if (frames > ids.length) {
              finish(false); // more than was asked for: not an honest answer
              return;
            }
            const event = frame[2];
            if (
              !isRecord(event) ||
              typeof event.id !== 'string' ||
              !wanted.has(event.id) ||
              event.created_at !== second
            ) {
              run.counters.dropped += 1;
              return;
            }
            const id = event.id;
            const task = this.handleEvent(event, relay, run, () => {
              openings += 1;
              return openings <= ids.length;
            }).then(
              (result) => {
                if (result === 'delivered' || result === 'duplicate') confirmed.add(id);
              },
              () => undefined,
            );
            pending.push(task);
            run.tasks.add(task);
            void task.then(() => run.tasks.delete(task));
            return;
          }
          case 'EOSE':
            if (eose) return;
            eose = true;
            void Promise.all(pending).then(() => finish(ids.every((id) => confirmed.has(id))));
            return;
          case 'CLOSED': {
            const text = typeof frame[2] === 'string' ? frame[2] : '';
            if (text.startsWith(AUTH_REQUIRED) && !authTried) {
              authTried = true;
              void link.authenticate().then(
                (ok) => {
                  if (finished) return;
                  if (!(ok && link.send(reqFrame))) finish(false);
                },
                () => finish(false),
              );
              return;
            }
            finish(false);
            return;
          }
          default:
            return;
        }
      });
      const unClose = this.pool.onRelayClose((closed) => {
        if (closed === relay) finish(false);
      });
      if (!link.send(reqFrame)) finish(false);
    });
  }

  /**
   * A second this relay may hold more events in than it returned (M1-5d). sync() returns it; a live
   * run logs it by host only, never the second (it is a wrap's created_at).
   */
  private reportGap(relay: string, run: Run, second: number): void {
    if (run.live) {
      this.logger?.warn('relay second over cap', { host: host(relay) });
      return;
    }
    run.gaps.push({ relay, second, reason: 'relay_cap' });
  }

  private async safeSetResume(relay: string, resume: SyncResume | undefined): Promise<void> {
    try {
      await this.persistence.setResume?.(relay, resume);
    } catch {
      this.logger?.warn('page position not saved', { host: host(relay) });
    }
  }

  private async safeMark(kind: SeenKind, id: string, at: number): Promise<void> {
    try {
      await this.persistence.markSeen?.(kind, id, at);
    } catch {
      this.logger?.warn('seen not saved', { kind });
    }
  }
}

/**
 * The size of an inbound event for the queue bound: the whole event as JSON (content, tags and any
 * other field), never less than 1. The event came out of JSON.parse, so it is plain data (IR-M1-5c-1 M-2).
 */
function eventWeight(event: unknown): number {
  try {
    return Math.max(1, JSON.stringify(event)?.length ?? 1);
  } catch {
    return MAX_QUEUED_CHARS; // cannot be measured: counts as the largest
  }
}

/**
 * Remembers a wrap a relay served in a sync pass, by second (M2-19). Only wraps that opened or were
 * already seen get here, so their id is 64 hex. Bounded: past `learned.max` ids the record
 * is marked full and closes no gap.
 */
function learn(learned: Learned, event: unknown): void {
  if (learned.full || !isRecord(event)) return;
  const at = event.created_at;
  const id = event.id;
  if (typeof id !== 'string' || typeof at !== 'number' || !Number.isSafeInteger(at)) return;
  if (at < learned.since) return;
  let ids = learned.bySecond.get(at);
  if (ids?.has(id) === true) return;
  if (learned.count >= learned.max) {
    learned.full = true;
    learned.bySecond.clear();
    return;
  }
  if (ids === undefined) {
    ids = new Set();
    learned.bySecond.set(at, ids);
  }
  ids.add(id);
  learned.count += 1;
}

/** The first own key named by a `p` tag of the wrap. The tags are untrusted: read defensively. */
function pickIdentity(
  tags: unknown,
  identities: readonly SyncIdentity[],
): SyncIdentity | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== 'p' || typeof tag[1] !== 'string') continue;
    const found = identities.find((i) => i.pubkey === tag[1]);
    if (found !== undefined) return found;
  }
  return undefined;
}
