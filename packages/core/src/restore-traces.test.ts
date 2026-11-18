// RESTORE-TRACES (D-156; 04 §2.3.3 "After a restore"; 07 §3.5): what a restore leaves behind.
//
// - The spending history gets one entry per restore mark: `restore` when the ID was restored from a
//   backup, `update` when an update started the guard. It holds a time and a reason, never an amount,
//   so it can never read as a charge, and it never changes what the budget counts.
// - Inbound that arrives after a restore but was created before it (the same skew rule as the
//   guard) is kept as "received again after restore" for the conversation view.
// - Only the core writes either table; nothing behind an MCP tool does (I-4).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEntry } from './activity.js';
import { readBudgetLedger } from './budget.js';
import { STORE_SCHEMA_VERSION } from './constants.js';
import type { CoreContext } from './context.js';
import { RESTORE_GUARD_SECONDS, type RestoreMark } from './restore-guard.js';
import { recordRestoreTrace } from './restore-traces.js';
import { MemoryStore } from './store/memory-store.js';
import { TABLES } from './store/schema.js';
import { makeAgent, type TestAgent, type TestOwner } from './testing/envelopes.js';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';

const T0 = 1_800_000_000;

const ctxOver = (store: MemoryStore, restoreMark?: RestoreMark, now = T0): CoreContext =>
  ({
    store,
    now: () => now,
    ...(restoreMark === undefined ? {} : { restoreMark }),
  }) as unknown as CoreContext;

const markAt = (at: number, reason?: 'restore' | 'update'): RestoreMark => ({
  read: () => Promise.resolve(at),
  ...(reason === undefined ? {} : { reason: () => Promise.resolve(reason) }),
});

describe('schema (RESTORE-TRACES, after version 19)', () => {
  it('budget_restores: a time and a reason, no amount column', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
    const spec = TABLES.budget_restores;
    expect(spec.primaryKey).toEqual(['restored_at']);
    expect(Object.keys(spec.columns)).toEqual(['restored_at', 'reason', 'noted_at']);
    expect(spec.columns.reason).toEqual({
      kind: 'enum',
      nullable: false,
      values: ['restore', 'update'],
    });
    for (const column of Object.values(spec.columns)) expect(column.kind).not.toBe('usd');
  });

  it('restore_replays: an envelope ID and the restore it came after', () => {
    expect(TABLES.restore_replays.primaryKey).toEqual(['envelope_id']);
    expect(Object.keys(TABLES.restore_replays.columns)).toEqual(['envelope_id', 'restored_at']);
  });
});

describe('recordRestoreTrace: one spending-history entry per restore mark', () => {
  it('a restore writes one `restore` entry at the restore time, once', async () => {
    const store = new MemoryStore();
    const ctx = ctxOver(store, markAt(T0 - 60, 'restore'));
    await recordRestoreTrace(ctx);
    await recordRestoreTrace(ctx);
    const rows = await store.transaction((tx) => tx.select('budget_restores'));
    expect(rows).toEqual([{ restored_at: T0 - 60, reason: 'restore', noted_at: T0 }]);
  });

  it('an update that started the guard writes an `update` entry', async () => {
    const store = new MemoryStore();
    await recordRestoreTrace(ctxOver(store, markAt(T0, 'update')));
    const rows = await store.transaction((tx) => tx.select('budget_restores'));
    expect(rows.map((r) => r.reason)).toEqual(['update']);
  });

  it('a later restore adds a second entry; the first stays', async () => {
    const store = new MemoryStore();
    await recordRestoreTrace(ctxOver(store, markAt(T0 - 1_000)));
    await recordRestoreTrace(ctxOver(store, markAt(T0)));
    const rows = await store.transaction((tx) => tx.select('budget_restores'));
    expect(rows.map((r) => r.restored_at).sort()).toEqual([T0 - 1_000, T0]);
  });

  it('never restored, no mark, or an unreadable mark: nothing is written, nothing throws', async () => {
    const store = new MemoryStore();
    await recordRestoreTrace(ctxOver(store, markAt(0)));
    await recordRestoreTrace(ctxOver(store));
    await recordRestoreTrace(
      ctxOver(store, { read: () => Promise.reject(new Error('keychain')) }),
    );
    expect(await store.transaction((tx) => tx.select('budget_restores'))).toEqual([]);
  });

  it('a store that cannot be written does not throw (the guard itself never depends on it)', async () => {
    const broken = {
      transaction: () => Promise.reject(new Error('disk')),
    } as unknown as MemoryStore;
    await expect(recordRestoreTrace(ctxOver(broken, markAt(T0)))).resolves.toBeUndefined();
  });
});

describe('activity: the restore entry in the spending history', () => {
  let clock: FakeClock;
  let a: TestAgent;
  const asOwner = (o: MemoryOwnerKeyStore): TestOwner => o as unknown as TestOwner;

  beforeEach(async () => {
    clock = new FakeClock(T0);
    a = await makeAgent(
      clock,
      new MemoryKeyStore(seed(61)),
      asOwner(new MemoryOwnerKeyStore(seed(161), passphrase())),
      'Alpha',
    );
  });

  const list = async (): Promise<ActivityEntry[]> =>
    (await a.client.activity.list({ limit: 100 })).items as ActivityEntry[];

  it('is listed at the restore time with its reason and the end of the window, and no cost', async () => {
    await a.store.transaction((tx) => {
      tx.insert('budget_restores', { restored_at: T0 + 10, reason: 'restore', noted_at: T0 + 20 });
      tx.insert('budget_restores', { restored_at: T0 + 30, reason: 'update', noted_at: T0 + 30 });
    });
    const items = (await list()).filter((i) => i.kind === 'restore_guard');
    expect(items).toEqual([
      {
        kind: 'restore_guard',
        id: `restore_guard:${String(T0 + 30)}`,
        at: T0 + 30,
        reason: 'update',
        until: T0 + 30 + RESTORE_GUARD_SECONDS,
      },
      {
        kind: 'restore_guard',
        id: `restore_guard:${String(T0 + 10)}`,
        at: T0 + 10,
        reason: 'restore',
        until: T0 + 10 + RESTORE_GUARD_SECONDS,
      },
    ]);
    for (const item of items) expect(item).not.toHaveProperty('cost');
  });

  it('never counts toward the budget: the ledger the policy engine reads is unchanged', async () => {
    const before = await a.store.transaction((tx) => readBudgetLedger(tx));
    await a.store.transaction((tx) =>
      tx.insert('budget_restores', { restored_at: T0, reason: 'restore', noted_at: T0 }),
    );
    const after = await a.store.transaction((tx) => readBudgetLedger(tx));
    expect(after).toEqual(before);
  });
});
