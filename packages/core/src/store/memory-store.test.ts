// MemoryStore against the Store contract of 07 §3.1 and §3.7 (M1-7a).
import { describe, expect, it } from 'vitest';
import { StoreConstraintError, StoreUsageError } from '../errors.js';
import { MemoryStore } from './memory-store.js';
import { TABLES, TABLE_NAMES, type Row, type Sealed } from './schema.js';
import { STORE_SCHEMA_VERSION } from '../constants.js';

const sealed = (s: string) => s as Sealed;

const seen = (id: string, t = 1): Row<'seen'> => ({ kind: 'wrap', id, first_seen_at: t });

const outbox = (over: Partial<Row<'outbox'>> = {}): Row<'outbox'> => ({
  wrap_id: 'w1',
  envelope_id: 'e1',
  recipient_key: 'k1',
  wrap_json: '{}',
  relays: sealed('r'),
  acks: sealed('a'),
  attempt: 1,
  role: 'contact',
  attempts: 0,
  next_attempt_at: 0,
  created_at: 0,
  give_up_at: 86_400,
  state: 'pending',
  reason: null,
  ...over,
});

const budgetState = (over: Partial<Row<'budget_state'>> = {}): Row<'budget_state'> => ({
  slot: 'current',
  ledger_epoch: 0,
  status: 'ok',
  newest_t: 0,
  since: 0,
  broken_at: null,
  ...over,
});

describe('MemoryStore: schema (07 §3, §3.1–§3.5)', () => {
  it('has every table of 07 §3 and G-9', () => {
    expect([...TABLE_NAMES].sort()).toEqual(
      [
        'identity',
        'contacts',
        'pairings',
        'invites',
        'envelopes',
        'files',
        'proofs',
        'receipts',
        'approvals',
        'policies',
        'sync_cursors',
        'outbox',
        'seen',
        'held_envelopes',
        'blocked_keys',
        'rate_counters',
        'publisher_lease',
        'outbox_staged',
        // W4-LIVE-STATUS (D-143; 07 §3.2, schema 10): the MCP session heartbeat.
        'mcp_sessions',
        'mcp_last_seen',
        // W4-PAUSE (D-143 (5); 07 §3.2, schema 11): the owner's pause of the agent.
        'agent_pause',
        'idempotency',
        'owner_action_nonces',
        'revoked_agents',
        // M1-9i-a (D-115; 07 §3.4): the owner-signed own storage, schema version 5.
        'own_storage',
        'local_owner_actions',
        'budget_ledger',
        'budget_state',
        'commitment_parts',
      ].sort(),
    );
    for (const name of TABLE_NAMES) {
      const spec = TABLES[name];
      for (const column of spec.primaryKey) expect(Object.keys(spec.columns)).toContain(column);
    }
  });

  it('reports the code schema version by default', () => {
    expect(new MemoryStore().schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(new MemoryStore({ schemaVersion: 7 }).schemaVersion).toBe(7);
  });

  it('own_storage (M1-9i-a, 07 §3.4): id, sealed signed_json, applied_at; at most one row', () => {
    expect(TABLES.own_storage).toEqual({
      columns: {
        id: { kind: 'id', nullable: false },
        signed_json: { kind: 'enc', nullable: false },
        applied_at: { kind: 'int', nullable: false },
      },
      primaryKey: ['id'],
      maxRows: 1,
    });
  });

  it('invites drop columns (W4-SHORT-INVITE, schema 8): sealed lookup ID and epoch, cancelled_at', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    expect(TABLES.invites.columns['drop_lookup_id']).toEqual({ kind: 'enc', nullable: true });
    expect(TABLES.invites.columns['drop_key_epoch']).toEqual({ kind: 'enc', nullable: true });
    expect(TABLES.invites.columns['cancelled_at']).toEqual({ kind: 'int', nullable: true });
  });

  it('local_owner_actions (U3-d, schema 7): the signed local owner actions, sealed', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
    expect(TABLES.local_owner_actions).toEqual({
      columns: {
        record: { kind: 'id', nullable: false },
        op: {
          kind: 'enum',
          nullable: false,
          values: ['agent.label', 'app.connect', 'app.disconnect'],
        },
        signed_json: { kind: 'enc', nullable: false },
        applied_at: { kind: 'int', nullable: false },
      },
      primaryKey: ['record'],
    });
  });

  it('contacts former name (W4-RENAME-REACHES-CONTACTS, schema 9): four nullable columns, appended last', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    expect(Object.keys(TABLES.contacts.columns).slice(-4)).toEqual([
      'former_name',
      'name_changed_at',
      'name_change_seen',
      'declared_name',
    ]);
    expect(TABLES.contacts.columns.declared_name).toEqual({ kind: 'enc', nullable: true });
    expect(TABLES.contacts.columns.former_name).toEqual({ kind: 'enc', nullable: true });
    expect(TABLES.contacts.columns.name_changed_at).toEqual({ kind: 'int', nullable: true });
    expect(TABLES.contacts.columns.name_change_seen).toEqual({ kind: 'flag', nullable: true });
  });

  it('files.saved_name (MSG-FILES-IO-b, schema 6): a nullable sealed column, appended last', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    expect(TABLES.files.columns.saved_name).toEqual({ kind: 'enc', nullable: true });
    expect(Object.keys(TABLES.files.columns).at(-1)).toBe('saved_name');
  });
});

describe('MemoryStore: constraints are enforced by the store (07 §3.7)', () => {
  it('refuses a duplicate primary key and keeps the first row', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => tx.insert('seen', seen('a', 1)));
    await expect(store.transaction((tx) => tx.insert('seen', seen('a', 2)))).rejects.toBeInstanceOf(
      StoreConstraintError,
    );
    const row = await store.transaction((tx) => tx.get('seen', { kind: 'wrap', id: 'a' }));
    expect(row?.first_seen_at).toBe(1);
  });

  it('enforces unique and partial unique constraints (outbox: one pending row per key)', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => tx.insert('outbox', outbox()));
    // A second pending row for the same (envelope_id, recipient_key) is refused.
    await expect(
      store.transaction((tx) => tx.insert('outbox', outbox({ wrap_id: 'w2', attempt: 2 }))),
    ).rejects.toBeInstanceOf(StoreConstraintError);
    // The same attempt number is refused even when not pending.
    await expect(
      store.transaction((tx) =>
        tx.insert('outbox', outbox({ wrap_id: 'w2', state: 'sent', wrap_json: null })),
      ),
    ).rejects.toBeInstanceOf(StoreConstraintError);
    // Once the first leaves pending, a new attempt may be pending.
    await store.transaction((tx) => {
      expect(
        tx.update('outbox', { wrap_id: 'w1' }, { state: 'not_delivered', reason: 'timeout' }),
      ).toBe(1);
      tx.insert('outbox', outbox({ wrap_id: 'w2', attempt: 2 }));
    });
    expect(await store.transaction((tx) => tx.count('outbox'))).toBe(2);
  });

  it('lets null columns never collide in a unique constraint (approvals.scope_key)', async () => {
    const store = new MemoryStore();
    const approval = (approval_id: string, scope_key: string | null): Row<'approvals'> => ({
      approval_id,
      action_json: sealed('x'),
      scope_json: null,
      answers_envelope_id: null,
      scope_key,
      source: 'owner',
      policy_hash: null,
      signed_decision: null,
      signed_cancel: null,
      summary: sealed('s'),
      status: 'pending',
      expires_at: 10,
      created_at: 1,
      decided_at: null,
    });
    await store.transaction((tx) => {
      tx.insert('approvals', approval('a1', null));
      tx.insert('approvals', approval('a2', null));
      tx.insert('approvals', approval('a3', 'scope'));
    });
    await expect(
      store.transaction((tx) => tx.insert('approvals', approval('a4', 'scope'))),
    ).rejects.toBeInstanceOf(StoreConstraintError);
  });

  it('refuses an enum value outside the list, a bad int, a bad usd, an empty id and extra or missing columns', async () => {
    const store = new MemoryStore();
    const bad: unknown[] = [
      { ...outbox(), state: 'lost' },
      { ...outbox(), attempt: -1 },
      { ...outbox(), attempt: 1.5 },
      { ...outbox(), attempt: 2 ** 53 },
      { ...outbox(), wrap_id: '' },
      { ...outbox(), extra: 'x' },
      (() => {
        const row: Record<string, unknown> = { ...outbox() };
        delete row['reason'];
        return row;
      })(),
      { ...outbox(), relays: null },
    ];
    for (const row of bad) {
      await expect(
        store.transaction((tx) => tx.insert('outbox', row as Row<'outbox'>)),
      ).rejects.toBeInstanceOf(StoreConstraintError);
    }
    const ledger = (reserved_usd: string): Row<'budget_ledger'> => ({
      entry_id: 'e',
      ledger_epoch: 0,
      t: 1,
      record_id: 'r',
      chain_id: 1,
      approval_id: null,
      reserved_usd,
      charged_usd: null,
      state: 'reserved',
      deadline: 5,
      replaces: null,
      settled_at: null,
    });
    await expect(
      store.transaction((tx) => tx.insert('budget_ledger', ledger('1.50'))),
    ).rejects.toBeInstanceOf(StoreConstraintError);
    await store.transaction((tx) => tx.insert('budget_ledger', ledger('1.5')));
    expect(await store.transaction((tx) => tx.count('outbox'))).toBe(0);
  });

  it('refuses an update that breaks a constraint, and changes nothing', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => {
      tx.insert('seen', seen('a'));
      tx.insert('seen', seen('b'));
    });
    await expect(
      store.transaction((tx) => tx.update('seen', { id: 'b' }, { id: 'a' })),
    ).rejects.toBeInstanceOf(StoreConstraintError);
    await expect(
      store.transaction((tx) => tx.update('seen', { id: 'b' }, { kind: 'other' as 'wrap' })),
    ).rejects.toBeInstanceOf(StoreConstraintError);
    const ids = await store.transaction((tx) => tx.select('seen').map((r) => r.id));
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('holds at most one row in a single-row table (budget_state)', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => tx.insert('budget_state', budgetState()));
    await expect(
      store.transaction((tx) => tx.insert('budget_state', budgetState())),
    ).rejects.toBeInstanceOf(StoreConstraintError);
  });
});

describe('MemoryStore: transactions (07 §3.1)', () => {
  it('is all-or-nothing across tables when the body throws', async () => {
    const store = new MemoryStore();
    await expect(
      store.transaction((tx) => {
        tx.insert('seen', seen('a'));
        tx.insert('budget_state', budgetState());
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await store.transaction((tx) => tx.count('seen') + tx.count('budget_state'))).toBe(0);
  });

  it('keeps the rest of a transaction when the body catches a refused statement', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => {
      tx.insert('seen', seen('a'));
      expect(() => tx.insert('seen', seen('a'))).toThrow(StoreConstraintError);
      tx.insert('seen', seen('b'));
    });
    expect(await store.transaction((tx) => tx.count('seen'))).toBe(2);
  });

  it('refuses an asynchronous body and discards its writes', async () => {
    const store = new MemoryStore();
    await expect(
      store.transaction(async (tx) => {
        tx.insert('seen', seen('a'));
        await Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(StoreUsageError);
    expect(await store.transaction((tx) => tx.count('seen'))).toBe(0);
  });

  it('refuses use of a transaction handle after its body returned', async () => {
    const store = new MemoryStore();
    let leaked: Parameters<Parameters<MemoryStore['transaction']>[0]>[0] | undefined;
    await store.transaction((tx) => {
      leaked = tx;
    });
    expect(() => leaked?.count('seen')).toThrow(StoreUsageError);
  });

  it('serializes transactions: a compare-and-set succeeds exactly once under concurrency', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => tx.insert('budget_state', budgetState()));
    const attempts = Array.from({ length: 10 }, () =>
      store.transaction((tx) =>
        tx.update('budget_state', { slot: 'current', ledger_epoch: 0 }, { ledger_epoch: 1 }),
      ),
    );
    const changed = await Promise.all(attempts);
    expect(changed.filter((n) => n === 1)).toHaveLength(1);
    expect(changed.filter((n) => n === 0)).toHaveLength(9);
  });

  it('returns frozen copies, never live rows', async () => {
    const store = new MemoryStore();
    const input = seen('a');
    await store.transaction((tx) => tx.insert('seen', input));
    (input as { first_seen_at: number }).first_seen_at = 99;
    const row = await store.transaction((tx) => tx.get('seen', { kind: 'wrap', id: 'a' }));
    expect(row?.first_seen_at).toBe(1);
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('refuses every call after close', async () => {
    const store = new MemoryStore();
    await store.close();
    await expect(store.transaction((tx) => tx.count('seen'))).rejects.toBeInstanceOf(
      StoreUsageError,
    );
  });
});

describe('MemoryStore: queries', () => {
  it('filters with conditions, orders and limits', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => {
      for (const [id, t] of [
        ['c', 30],
        ['a', 10],
        ['b', 20],
        ['d', 20],
      ] as const) {
        tx.insert('seen', seen(id, t));
      }
    });
    const got = await store.transaction((tx) => ({
      lt: tx.select('seen', { first_seen_at: { lt: 20 } }).map((r) => r.id),
      range: tx
        .select('seen', { first_seen_at: { gte: 20, lte: 20 } }, { orderBy: [['id', 'desc']] })
        .map((r) => r.id),
      inList: tx.count('seen', { id: { in: ['a', 'c', 'z'] } }),
      ne: tx.count('seen', { id: { ne: 'a' } }),
      ordered: tx
        .select(
          'seen',
          {},
          {
            orderBy: [
              ['first_seen_at', 'asc'],
              ['id', 'asc'],
            ],
            limit: 3,
          },
        )
        .map((r) => r.id),
      deleted: tx.delete('seen', { first_seen_at: { gt: 25 } }),
      left: tx.count('seen'),
    }));
    expect(got).toEqual({
      lt: ['a'],
      range: ['d', 'b'],
      inList: 2,
      ne: 3,
      ordered: ['a', 'b', 'd'],
      deleted: 1,
      left: 3,
    });
  });

  it('matches null only by an explicit null', async () => {
    const store = new MemoryStore();
    await store.transaction((tx) => {
      tx.insert('outbox', outbox());
      tx.insert('outbox', outbox({ wrap_id: 'w2', attempt: 2, state: 'sent', reason: null }));
    });
    const n = await store.transaction((tx) => ({
      isNull: tx.count('outbox', { reason: null }),
      neTimeout: tx.count('outbox', { reason: { ne: 'timeout' } }),
    }));
    expect(n).toEqual({ isNull: 2, neTimeout: 0 });
  });
});
