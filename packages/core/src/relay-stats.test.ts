// NET-STATS (07 §3.2 `relay_stats`; 08 §1 Message network; I-7): per-server counters for the app's
// Message network view. Counters only: no message, event or contact ever reaches the table; only the
// agent's own servers and the legacy read-only servers are kept, by origin (no path); the counters
// cover a rolling day window; failures are a fixed class, never relay text.
import { LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
import type { CoreContext } from './context.js';
import {
  MAX_RELAY_STATS_ROWS,
  RELAY_STATS_WINDOW_SECONDS,
  RelayTally,
  readRelayStats,
  recordRelayStats,
  relayStatsMark,
} from './relay-stats.js';
import { MemoryStore } from './store/memory-store.js';
import { TABLES } from './store/schema.js';

const T0 = 1_800_000_000;
const OWN = ['wss://a.example.org', 'wss://b.example.org:8443/private-path?x'];

const ctxAt = (store: MemoryStore, now: () => number): CoreContext =>
  ({ store, now }) as unknown as CoreContext;

describe('relay_stats schema (NET-STATS)', () => {
  it('holds counters and fixed classes only: no message, event or contact column', () => {
    const spec = TABLES.relay_stats;
    expect(spec.primaryKey).toEqual(['origin']);
    expect(Object.keys(spec.columns)).toEqual([
      'origin',
      'since',
      'published_ok',
      'published_failed',
      'received',
      'last_ok_at',
      'last_error',
      'last_error_at',
    ]);
    for (const column of Object.values(spec.columns)) {
      expect(['id', 'int', 'enum']).toContain(column.kind);
    }
    expect(spec.maxRows).toBe(MAX_RELAY_STATS_ROWS);
  });
});

describe('recordRelayStats (NET-STATS)', () => {
  it('counts publishes, failures and received wraps per own server, by origin', async () => {
    const store = new MemoryStore();
    const ctx = ctxAt(store, () => T0);
    const tally = new RelayTally();
    tally.publish([
      { relay: OWN[0] as string, ok: true, reason: 'ok' },
      { relay: OWN[1] as string, ok: false, reason: 'rejected' },
    ]);
    tally.received(OWN[0] as string);
    tally.received(OWN[0] as string);
    await recordRelayStats(ctx, OWN, tally);
    const rows = await readRelayStats(ctx);
    expect(rows).toEqual([
      {
        origin: 'wss://a.example.org',
        since: T0,
        publishedOk: 1,
        publishedFailed: 0,
        received: 2,
        lastOkAt: T0,
        lastError: null,
      },
      {
        origin: 'wss://b.example.org:8443',
        since: T0,
        publishedOk: 0,
        publishedFailed: 1,
        received: 0,
        lastOkAt: null,
        lastError: 'rejected',
      },
    ]);
    // Never the path or query of a relay URL.
    expect(JSON.stringify(await store.transaction((tx) => tx.select('relay_stats')))).not.toContain(
      'private-path',
    );
  });

  it('keeps nothing for a server outside the own and legacy lists (a contact server)', async () => {
    const store = new MemoryStore();
    const ctx = ctxAt(store, () => T0);
    const tally = new RelayTally();
    tally.publish([{ relay: 'wss://contact.example.net', ok: true, reason: 'ok' }]);
    tally.received(LEGACY_READ_RELAYS[0] as string);
    await recordRelayStats(ctx, OWN, tally);
    const origins = (await readRelayStats(ctx)).map((r) => r.origin);
    expect(origins).toEqual([LEGACY_READ_RELAYS[0]]);
  });

  it('records sync results: complete is ok, a relay fault is its class, a local stop is neither', async () => {
    const store = new MemoryStore();
    const ctx = ctxAt(store, () => T0);
    const tally = new RelayTally();
    tally.sync([
      { relay: OWN[0] as string, status: 'complete', reason: 'ok' },
      { relay: OWN[1] as string, status: 'failed', reason: 'connect_timeout' },
    ]);
    await recordRelayStats(ctx, OWN, tally);
    const before = await readRelayStats(ctx);
    expect(before.map((r) => [r.lastOkAt, r.lastError])).toEqual([
      [T0, null],
      [null, 'connect_timeout'],
    ]);
    const local = new RelayTally();
    local.sync([{ relay: OWN[0] as string, status: 'incomplete', reason: 'budget' }]);
    await recordRelayStats(ctx, OWN, local);
    expect(await readRelayStats(ctx)).toEqual(before);
  });

  it('restarts the counters once the day window is over', async () => {
    const store = new MemoryStore();
    let now = T0;
    const ctx = ctxAt(store, () => now);
    const tally = (): RelayTally => {
      const t = new RelayTally();
      t.publish([{ relay: OWN[0] as string, ok: true, reason: 'ok' }]);
      return t;
    };
    await recordRelayStats(ctx, OWN, tally());
    now = T0 + RELAY_STATS_WINDOW_SECONDS - 1;
    await recordRelayStats(ctx, OWN, tally());
    expect((await readRelayStats(ctx))[0]).toMatchObject({ since: T0, publishedOk: 2 });
    now = T0 + RELAY_STATS_WINDOW_SECONDS;
    await recordRelayStats(ctx, OWN, tally());
    expect((await readRelayStats(ctx))[0]).toMatchObject({
      since: now,
      publishedOk: 1,
      lastOkAt: now,
    });
  });

  it('drops the rows of servers no longer in the list', async () => {
    const store = new MemoryStore();
    const ctx = ctxAt(store, () => T0);
    const tally = new RelayTally();
    tally.received(OWN[0] as string);
    tally.received(OWN[1] as string);
    await recordRelayStats(ctx, OWN, tally);
    await recordRelayStats(ctx, [OWN[1] as string], new RelayTally());
    expect((await readRelayStats(ctx)).map((r) => r.origin)).toEqual(['wss://b.example.org:8443']);
  });

  it('keeps the stored counters when the own list is empty (could not be read)', async () => {
    const store = new MemoryStore();
    const ctx = ctxAt(store, () => T0);
    const tally = new RelayTally();
    tally.received(OWN[0] as string);
    await recordRelayStats(ctx, OWN, tally);
    const before = await readRelayStats(ctx);
    const next = new RelayTally();
    next.received(LEGACY_READ_RELAYS[0] as string);
    await recordRelayStats(ctx, [], next);
    expect(await readRelayStats(ctx)).toEqual(before);
  });

  it('never throws: a store fault leaves the pass as it was', async () => {
    const ctx = {
      store: { transaction: () => Promise.reject(new Error('busy')) },
      now: () => T0,
    } as unknown as CoreContext;
    const tally = new RelayTally();
    tally.received(OWN[0] as string);
    await expect(recordRelayStats(ctx, OWN, tally)).resolves.toBeUndefined();
    await expect(readRelayStats(ctx)).resolves.toEqual([]);
  });

  it('the mark changes when a counter changes, and only then', async () => {
    const store = new MemoryStore();
    const ctx = ctxAt(store, () => T0);
    const empty = relayStatsMark(await readRelayStats(ctx));
    const tally = new RelayTally();
    tally.received(OWN[0] as string);
    await recordRelayStats(ctx, OWN, tally);
    const one = relayStatsMark(await readRelayStats(ctx));
    expect(one).not.toBe(empty);
    expect(relayStatsMark(await readRelayStats(ctx))).toBe(one);
    expect(one).not.toContain('example');
  });
});
