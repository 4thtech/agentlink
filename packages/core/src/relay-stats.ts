// NET-STATS (07 §3.2 `relay_stats`; 08 §1 Message network; I-7): per-server counters for the app's
// Message network view, written by whichever process runs the delivery and sync passes (usually the
// AI app's `agentlink mcp`, the publisher-lease holder) so the app process can read them.
//
// - What is kept: per server origin (`wss://host[:port]`, never the path or query of the URL), how
//   many publishes it accepted and refused, how many wraps it served us, when it last answered well,
//   and the fixed class of its last fault. Counters only: no message, event or contact identifier.
// - Which servers: the agent's own list and the legacy read-only servers. A contact's servers are
//   never kept (which contact uses which server is not written to the store in plain).
// - Window: the counters cover a rolling day; a row whose window is over starts again at its next
//   write. Rows of servers no longer in the list are dropped on every write.
// - Cheap: a pass tallies in memory and writes once, in one transaction. A store fault never fails
//   the pass: the tally is dropped, nothing is logged but the fixed fact.
import { relayOrigin, type RelayFailure, type SyncRelayReason } from '@4thtech-io/transport-nostr';
import { LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import type { CoreContext } from './context.js';
import { nowOf } from './context.js';
import type { Row } from './store/schema.js';

/** The counters cover this rolling window (seconds). */
export const RELAY_STATS_WINDOW_SECONDS = 86_400;
/** At most this many rows (own list of at most 16 stored entries plus the legacy servers fit). */
export const MAX_RELAY_STATS_ROWS = 32;

/** The fault classes kept (relay-side faults only; a local stop such as the time budget is none). */
export type RelayErrorClass = NonNullable<Row<'relay_stats'>['last_error']>;

const ERROR_CLASSES: ReadonlySet<string> = new Set<RelayErrorClass>([
  'invalid_url',
  'blocked_address',
  'resolve_failed',
  'connect_failed',
  'connect_timeout',
  'too_large',
  'rejected',
  'ok_timeout',
  'auth_failed',
  'closed',
  'subscription_closed',
  'connection_lost',
  'too_many_events',
]);

const errorClass = (reason: string): RelayErrorClass | undefined =>
  ERROR_CLASSES.has(reason) ? (reason as RelayErrorClass) : undefined;

/** One server's counters as the view reads them. */
export interface RelayStatsView {
  readonly origin: string;
  /** Unix seconds: the start of the window the counters cover. */
  readonly since: number;
  readonly publishedOk: number;
  readonly publishedFailed: number;
  readonly received: number;
  readonly lastOkAt: number | null;
  readonly lastError: RelayErrorClass | null;
}

interface Delta {
  ok: number;
  failed: number;
  received: number;
  /** A good answer in this pass (publish OK, or a complete sync). */
  good: boolean;
  error: RelayErrorClass | undefined;
}

/** What one pass saw, per origin, in memory. Nothing here names a message or a contact. */
export class RelayTally {
  readonly #deltas = new Map<string, Delta>();

  #of(relay: string): Delta | undefined {
    if (typeof relay !== 'string') return undefined;
    const origin = relayOrigin(relay);
    if (origin === 'wss://invalid') return undefined;
    let d = this.#deltas.get(origin);
    if (d === undefined) {
      if (this.#deltas.size >= MAX_RELAY_STATS_ROWS * 4) return undefined; // bounded memory
      d = { ok: 0, failed: 0, received: 0, good: false, error: undefined };
      this.#deltas.set(origin, d);
    }
    return d;
  }

  /** The per-relay results of one publish (RelayPool.publish). */
  publish(
    results: readonly {
      readonly relay: string;
      readonly ok: boolean;
      readonly reason: 'ok' | RelayFailure;
    }[],
  ): void {
    for (const r of results) {
      const d = this.#of(r.relay);
      if (d === undefined) continue;
      if (r.ok) {
        d.ok += 1;
        d.good = true;
      } else {
        const cls = errorClass(r.reason);
        if (cls === undefined) continue; // a local refusal (pool full or closed): not the server's
        d.failed += 1;
        d.error = cls;
      }
    }
  }

  /** One wrap a server served us (a sync or live item). */
  received(relay: string): void {
    const d = this.#of(relay);
    if (d !== undefined) d.received += 1;
  }

  /** The per-relay results of one sync pass. */
  sync(
    results: readonly {
      readonly relay: string;
      readonly status: 'complete' | 'incomplete' | 'failed';
      readonly reason: SyncRelayReason;
    }[],
  ): void {
    for (const r of results) {
      if (r.status === 'complete') {
        const d = this.#of(r.relay);
        if (d !== undefined) d.good = true;
        continue;
      }
      const cls = errorClass(r.reason);
      if (cls === undefined) continue;
      const d = this.#of(r.relay);
      if (d !== undefined) d.error = cls;
    }
  }

  get empty(): boolean {
    return this.#deltas.size === 0;
  }

  /** The tallied origins and their deltas (for recordRelayStats). */
  entries(): IterableIterator<[string, Readonly<Delta>]> {
    return this.#deltas.entries();
  }
}

/**
 * Writes one pass's tally for the servers of `own` and the legacy servers, and drops the rows of
 * every other server, in one transaction. Never throws.
 */
export async function recordRelayStats(
  ctx: CoreContext,
  own: readonly string[],
  tally: RelayTally,
): Promise<void> {
  try {
    const tracked = new Set(
      [...own, ...LEGACY_READ_RELAYS].map(relayOrigin).filter((o) => o !== 'wss://invalid'),
    );
    const now = nowOf(ctx);
    await ctx.store.transaction((tx) => {
      for (const row of tx.select('relay_stats')) {
        if (!tracked.has(row.origin)) tx.delete('relay_stats', { origin: row.origin });
      }
      for (const [origin, d] of tally.entries()) {
        if (!tracked.has(origin)) continue;
        const row = tx.get('relay_stats', { origin });
        const fresh =
          row === undefined || now - row.since >= RELAY_STATS_WINDOW_SECONDS || now < row.since;
        const base = {
          since: fresh ? now : row.since,
          published_ok: (fresh ? 0 : row.published_ok) + d.ok,
          published_failed: (fresh ? 0 : row.published_failed) + d.failed,
          received: (fresh ? 0 : row.received) + d.received,
          last_ok_at: d.good ? now : (row?.last_ok_at ?? null),
          last_error: d.error ?? row?.last_error ?? null,
          last_error_at: d.error !== undefined ? now : (row?.last_error_at ?? null),
        };
        if (row === undefined) {
          if (tx.count('relay_stats') >= MAX_RELAY_STATS_ROWS) continue;
          tx.insert('relay_stats', { origin, ...base });
        } else {
          tx.update('relay_stats', { origin }, base);
        }
      }
    });
  } catch {
    ctx.log?.info('relay stats not recorded', {});
  }
}

/** Every kept row, by origin. Never throws: a store fault reads as none. */
export async function readRelayStats(ctx: CoreContext): Promise<readonly RelayStatsView[]> {
  try {
    const rows = await ctx.store.transaction((tx) => tx.select('relay_stats'));
    return rows
      .map((r) => ({
        origin: r.origin,
        since: r.since,
        publishedOk: r.published_ok,
        publishedFailed: r.published_failed,
        received: r.received,
        lastOkAt: r.last_ok_at,
        lastError: r.last_error,
      }))
      .sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * An opaque mark of the rows (for the app's live `network` event): it changes when a counter or time
 * changes. Numbers only, never an origin.
 */
export function relayStatsMark(rows: readonly RelayStatsView[]): string {
  let mark = `${rows.length}`;
  for (const r of rows) {
    mark += `:${r.since}.${r.publishedOk}.${r.publishedFailed}.${r.received}.${r.lastOkAt ?? '-'}.${
      r.lastError === null ? '-' : [...ERROR_CLASSES].indexOf(r.lastError)
    }`;
  }
  return mark;
}
