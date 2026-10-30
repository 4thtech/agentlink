// M1-8b: the SQLite Store against the Store contract of 07 §3.1 and §3.7. The contract cases run
// against core's MemoryStore too, so the two implementations are checked for the same behaviour;
// the SQLite-only cases cover persistence, migrations, the schema enforced by SQLite itself, the
// lock wait and fail-closed reads.
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  MemoryStore,
  STORE_SCHEMA_VERSION,
  StoreConstraintError,
  StoreUsageError,
  TABLE_NAMES,
  type Row,
  type Store,
  type StoreTx,
} from '@4thtech-io/core';
import { encodeHex, encodeUtf8, sha256 } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  STORE_APPLICATION_ID,
  createSchemaStatements,
  type StoreMigration,
} from './sqlite-schema.js';
import { SqliteStore } from './sqlite-store.js';
import { NodeStoreError } from './store-errors.js';
import { sealed } from './store-rows.fixture.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

const ledger = (over: Partial<Row<'budget_ledger'>> = {}): Row<'budget_ledger'> => ({
  entry_id: 'l1',
  ledger_epoch: 0,
  t: 10,
  record_id: 'r1',
  chain_id: 1,
  approval_id: null,
  reserved_usd: '1.5',
  charged_usd: null,
  state: 'reserved',
  deadline: 100,
  replaces: null,
  settled_at: null,
  ...over,
});

const approval = (over: Partial<Row<'approvals'>> = {}): Row<'approvals'> => ({
  approval_id: 'a1',
  action_json: sealed('x'),
  scope_json: null,
  answers_envelope_id: null,
  scope_key: null,
  source: 'owner',
  policy_hash: null,
  signed_decision: null,
  signed_cancel: null,
  summary: sealed('s'),
  status: 'pending',
  expires_at: 100,
  created_at: 0,
  decided_at: null,
  ...over,
});

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

const IMPLEMENTATIONS: readonly (readonly [string, () => Promise<Store>])[] = [
  ['MemoryStore', () => Promise.resolve(new MemoryStore())],
  ['SqliteStore', () => SqliteStore.open(join(dir, 'agent.sqlite'))],
];

describe.each(IMPLEMENTATIONS)('%s: the Store contract (07 §3.1, §3.7)', (_name, make) => {
  let store: Store;
  beforeEach(async () => {
    store = await make();
  });
  afterEach(async () => {
    await store.close();
  });

  it('reports the code schema version', () => {
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
  });

  it('refuses a duplicate primary key and keeps the first row', async () => {
    await store.transaction((tx) => tx.insert('seen', seen('a', 1)));
    expect(
      await rejects(store.transaction((tx) => tx.insert('seen', seen('a', 2)))),
    ).toBeInstanceOf(StoreConstraintError);
    expect(await store.transaction((tx) => tx.get('seen', { kind: 'wrap', id: 'a' }))).toEqual(
      seen('a', 1),
    );
  });

  it('enforces unique and partial unique constraints (outbox: one pending row per key)', async () => {
    await store.transaction((tx) => tx.insert('outbox', outbox()));
    expect(
      await rejects(store.transaction((tx) => tx.insert('outbox', outbox({ wrap_id: 'w2' })))),
    ).toBeInstanceOf(StoreConstraintError);
    expect(
      await rejects(
        store.transaction((tx) =>
          tx.insert('outbox', outbox({ wrap_id: 'w2', attempt: 1, state: 'sent' })),
        ),
      ),
    ).toBeInstanceOf(StoreConstraintError);
    await store.transaction((tx) =>
      tx.insert('outbox', outbox({ wrap_id: 'w2', attempt: 2, state: 'sent', wrap_json: null })),
    );
    expect(await store.transaction((tx) => tx.count('outbox'))).toBe(2);
  });

  it('lets null columns never collide in a unique constraint (approvals.scope_key)', async () => {
    await store.transaction((tx) => {
      tx.insert('approvals', approval({ approval_id: 'a1' }));
      tx.insert('approvals', approval({ approval_id: 'a2' }));
      tx.insert('approvals', approval({ approval_id: 'a3', scope_key: 'k' }));
      tx.insert('approvals', approval({ approval_id: 'a4', scope_key: 'k', status: 'denied' }));
    });
    expect(
      await rejects(
        store.transaction((tx) =>
          tx.insert('approvals', approval({ approval_id: 'a5', scope_key: 'k' })),
        ),
      ),
    ).toBeInstanceOf(StoreConstraintError);
  });

  it('refuses wrong values: enum, int, usd, empty id, flag, number for text, extra or missing columns', async () => {
    const bad: (() => void)[] = [];
    const attempts: [string, unknown][] = [
      ['enum', { ...budgetState(), status: 'weird' }],
      ['negative int', { ...budgetState(), newest_t: -1 }],
      ['fractional int', { ...budgetState(), newest_t: 1.5 }],
      ['int too large', { ...budgetState(), newest_t: 2 ** 53 }],
      ['int as text', { ...budgetState(), newest_t: '5' }],
      ['null in a non-null column', { ...budgetState(), since: null }],
      ['extra column', { ...budgetState(), extra: 1 }],
      ['missing column', { slot: 'current', ledger_epoch: 0, status: 'ok', newest_t: 0, since: 0 }],
    ];
    for (const [label, row] of attempts) {
      const error = await rejects(
        store.transaction((tx) => tx.insert('budget_state', row as Row<'budget_state'>)),
      );
      expect(error, label).toBeInstanceOf(StoreConstraintError);
    }
    for (const usd of [
      '1.50',
      '01',
      '1.',
      '.5',
      '-1',
      '1e3',
      '1234567890',
      '0.1234567',
      ' 1',
      '',
    ]) {
      const error = await rejects(
        store.transaction((tx) => tx.insert('budget_ledger', ledger({ reserved_usd: usd }))),
      );
      expect(error, `usd ${JSON.stringify(usd)}`).toBeInstanceOf(StoreConstraintError);
    }
    const others: [string, () => Promise<unknown>][] = [
      ['empty id', () => store.transaction((tx) => tx.insert('seen', seen('')))],
      [
        'number for id',
        () => store.transaction((tx) => tx.insert('seen', { ...seen('x'), id: 5 } as never)),
      ],
      [
        'bad flag',
        () =>
          store.transaction((tx) =>
            tx.insert('rate_counters', { contact_id: 'c', bucket: 0, count: 0, extra: 1 } as never),
          ),
      ],
    ];
    for (const [label, run] of others)
      expect(await rejects(run()), label).toBeInstanceOf(StoreConstraintError);
    expect(bad).toHaveLength(0);
    expect(await store.transaction((tx) => tx.count('budget_state'))).toBe(0);
    expect(await store.transaction((tx) => tx.count('budget_ledger'))).toBe(0);
  });

  it('accepts canonical USD amounts', async () => {
    const amounts = ['0', '5', '0.5', '999999999.999999', '10', '1.000001', '100.25'];
    await store.transaction((tx) => {
      amounts.forEach((usd, i) =>
        tx.insert(
          'budget_ledger',
          ledger({ entry_id: `l${i}`, record_id: `r${i}`, reserved_usd: usd }),
        ),
      );
    });
    expect(await store.transaction((tx) => tx.count('budget_ledger'))).toBe(amounts.length);
  });

  it('refuses an update that breaks a constraint, and changes nothing', async () => {
    await store.transaction((tx) => {
      tx.insert('seen', seen('a'));
      tx.insert('seen', seen('b'));
    });
    expect(
      await rejects(store.transaction((tx) => tx.update('seen', { id: 'b' }, { id: 'a' }))),
    ).toBeInstanceOf(StoreConstraintError);
    expect(
      await rejects(store.transaction((tx) => tx.update('seen', {}, { first_seen_at: -1 }))),
    ).toBeInstanceOf(StoreConstraintError);
    const rows = await store.transaction((tx) =>
      tx.select('seen', {}, { orderBy: [['id', 'asc']] }),
    );
    expect(rows).toEqual([seen('a'), seen('b')]);
  });

  it('holds at most one row in a single-row table (budget_state)', async () => {
    await store.transaction((tx) => tx.insert('budget_state', budgetState()));
    expect(
      await rejects(store.transaction((tx) => tx.insert('budget_state', budgetState()))),
    ).toBeInstanceOf(StoreConstraintError);
  });

  it('is all-or-nothing across tables when the body throws', async () => {
    await expect(
      store.transaction((tx) => {
        tx.insert('seen', seen('a'));
        tx.insert('budget_state', budgetState());
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await store.transaction((tx) => tx.count('seen') + tx.count('budget_state'))).toBe(0);
  });

  it('keeps the rest of a transaction when the body catches a refused statement', async () => {
    await store.transaction((tx) => {
      tx.insert('seen', seen('a'));
      try {
        tx.insert('seen', seen('a'));
      } catch {
        // refused; the transaction goes on
      }
      tx.insert('seen', seen('b'));
    });
    expect(await store.transaction((tx) => tx.count('seen'))).toBe(2);
  });

  it('refuses an asynchronous body and discards its writes', async () => {
    const error = await rejects(
      store.transaction((tx) => {
        tx.insert('seen', seen('a'));
        return Promise.resolve(1);
      }),
    );
    expect(error).toBeInstanceOf(StoreUsageError);
    expect(await store.transaction((tx) => tx.count('seen'))).toBe(0);
  });

  it('refuses use of a transaction handle after its body returned', async () => {
    let leaked: Parameters<Parameters<Store['transaction']>[0]>[0] | undefined;
    await store.transaction((tx) => {
      leaked = tx;
    });
    expect(() => leaked?.count('seen')).toThrow(StoreUsageError);
  });

  it('serializes transactions: a compare-and-set succeeds exactly once under concurrency', async () => {
    await store.transaction((tx) => tx.insert('budget_state', budgetState()));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.transaction((tx) =>
          tx.update('budget_state', { slot: 'current', newest_t: 0 }, { newest_t: i + 1 }),
        ),
      ),
    );
    expect(results.filter((n) => n === 1)).toHaveLength(1);
    expect(results.filter((n) => n === 0)).toHaveLength(19);
  });

  it('returns frozen copies, never live rows', async () => {
    await store.transaction((tx) => tx.insert('seen', seen('a')));
    const row = await store.transaction((tx) => tx.get('seen', { kind: 'wrap', id: 'a' }));
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.keys(row ?? {})).toEqual(['kind', 'id', 'first_seen_at']);
  });

  it('filters with conditions, orders and limits', async () => {
    await store.transaction((tx) => {
      for (let i = 0; i < 6; i += 1) tx.insert('seen', seen(`id${i}`, i * 10));
    });
    const run = <R>(fn: (tx: StoreTx) => R): Promise<R> => store.transaction(fn);
    expect(
      (await run((tx) => tx.select('seen', { first_seen_at: { gte: 20, lt: 50 } })))
        .map((r) => r.id)
        .sort(),
    ).toEqual(['id2', 'id3', 'id4']);
    expect(
      (
        await run((tx) => tx.select('seen', {}, { orderBy: [['first_seen_at', 'desc']], limit: 2 }))
      ).map((r) => r.id),
    ).toEqual(['id5', 'id4']);
    expect(await run((tx) => tx.count('seen', { id: { in: ['id1', 'id3', 'nope'] } }))).toBe(2);
    expect(await run((tx) => tx.count('seen', { id: { ne: 'id1' } }))).toBe(5);
    expect(await run((tx) => tx.count('seen', { id: { in: [] } }))).toBe(0);
    expect(await run((tx) => tx.count('seen', { first_seen_at: { lte: '30' as never } }))).toBe(0);
    expect(await run((tx) => tx.count('seen', { id: 5 as never }))).toBe(0);
    expect(await run((tx) => tx.count('seen', { first_seen_at: {} }))).toBe(6);
    expect(await run((tx) => tx.delete('seen', { first_seen_at: { lt: 20 } }))).toBe(2);
    expect(await run((tx) => tx.update('seen', { id: 'id5' }, {}))).toBe(1);
    await expect(run((tx) => tx.count('seen', { nope: 1 } as never))).rejects.toBeInstanceOf(
      StoreUsageError,
    );
  });

  it('matches null only by an explicit null; operators never match null', async () => {
    await store.transaction((tx) => {
      tx.insert('outbox', outbox({ wrap_id: 'w1', reason: null }));
      tx.insert(
        'outbox',
        outbox({ wrap_id: 'w2', recipient_key: 'k2', state: 'not_delivered', reason: 'timeout' }),
      );
    });
    expect(await store.transaction((tx) => tx.count('outbox', { reason: null }))).toBe(1);
    expect(await store.transaction((tx) => tx.count('outbox', { reason: { ne: 'revoked' } }))).toBe(
      1,
    );
    expect(
      (
        await store.transaction((tx) => tx.select('outbox', {}, { orderBy: [['reason', 'asc']] }))
      ).map((r) => r.wrap_id),
    ).toEqual(['w1', 'w2']);
  });

  it('refuses every call after close', async () => {
    await store.close();
    expect(await rejects(store.transaction((tx) => tx.count('seen')))).toBeInstanceOf(
      StoreUsageError,
    );
  });
});

describe('SqliteStore: file, schema and migrations (07 §3.7)', () => {
  const path = (): string => join(dir, 'agent.sqlite');

  it('persists across reopen, in WAL mode, with owner-only file permissions', async () => {
    const store = await SqliteStore.open(path());
    await store.transaction((tx) => tx.insert('seen', seen('a')));
    await store.close();
    const again = await SqliteStore.open(path());
    expect(await again.transaction((tx) => tx.get('seen', { kind: 'wrap', id: 'a' }))).toEqual(
      seen('a'),
    );
    expect(SqliteStore.readSetting(again, 'journal_mode')).toBe('wal');
    expect(SqliteStore.readSetting(again, 'synchronous')).toBe(2);
    // M1-7f-2 (IR-M1-7f-2-1 L1): deleted rows, file keys among them, are zeroed on disk.
    expect(SqliteStore.readSetting(again, 'secure_delete')).toBe(1);
    // IR-M1-8b-1 L-3: the WAL (while the store is open) and the lock file are owner-only too.
    await again.transaction((tx) => tx.insert('seen', seen('b')));
    await again.withInterProcessLock(() => undefined);
    if (process.platform !== 'win32') {
      for (const file of [path(), `${path()}-wal`, `${path()}-shm`, `${path()}.lock`]) {
        expect((await stat(file)).mode & 0o777, file).toBe(0o600);
      }
    }
    await again.close();
    if (process.platform !== 'win32') {
      expect((await stat(path())).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps its connection private: no raw handle or statement method on the instance (IR-M1-8b-1 L-1)', async () => {
    const store = await SqliteStore.open(path());
    const loose = store as unknown as Record<string, unknown>;
    for (const name of ['db', 'statement', 'run']) expect(loose[name], name).toBeUndefined();
    expect(Object.keys(store)).toEqual([]);
    await store.close();
  });

  it('creates every table of the logical schema, STRICT, with the second-layer triggers', async () => {
    (await SqliteStore.open(path())).close();
    const raw = new Database(path(), { readonly: true });
    const tables = raw
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual([...TABLE_NAMES].sort());
    const strict = raw.prepare('PRAGMA table_list').all() as {
      name: string;
      strict: number;
    }[];
    for (const t of strict.filter((r) => TABLE_NAMES.includes(r.name as never))) {
      expect(t.strict, t.name).toBe(1);
    }
    expect(Number(raw.pragma('user_version', { simple: true }))).toBe(STORE_SCHEMA_VERSION);
    raw.close();
  });

  it('pins every schema version: a TABLES change needs a new migration, never an edit of one', () => {
    // If this fails, the logical schema changed. Freeze the earlier statements as they were and
    // add a migration with the next version instead (07 §3.7: forward migrations only).
    const digestOf = (i: number) =>
      encodeHex(sha256(encodeUtf8(MIGRATIONS[i]?.statements.join(';\n') ?? '')));
    expect(STORE_SCHEMA_VERSION).toBe(9);
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Version 1 (G-9) is unchanged by D-72.
    expect(digestOf(0)).toMatchInlineSnapshot(
      `"6a2a36755c97cca746bdfe0b166c409cf1a067b1fd526011470446c0bb7dfd1b"`,
    );
    // Version 2 (D-72, M1-7e-2): envelopes.refused_at, envelopes.request_accepted_at, blocked_keys.
    expect(MIGRATIONS[1]?.statements).toMatchInlineSnapshot(`
      [
        "ALTER TABLE "envelopes" ADD COLUMN "refused_at" INTEGER CHECK ("refused_at" IS NULL OR (typeof("refused_at") = 'integer' AND "refused_at" BETWEEN 0 AND 9007199254740991))",
        "ALTER TABLE "envelopes" ADD COLUMN "request_accepted_at" INTEGER CHECK ("request_accepted_at" IS NULL OR (typeof("request_accepted_at") = 'integer' AND "request_accepted_at" BETWEEN 0 AND 9007199254740991))",
        "CREATE TABLE "blocked_keys" (
        "from_key" TEXT NOT NULL CHECK (typeof("from_key") = 'text' AND length("from_key") > 0),
        "blocked_at" INTEGER NOT NULL CHECK (typeof("blocked_at") = 'integer' AND "blocked_at" BETWEEN 0 AND 9007199254740991),
        "via_envelope_id" TEXT NOT NULL CHECK (typeof("via_envelope_id") = 'text' AND length("via_envelope_id") > 0),
        PRIMARY KEY ("from_key")
      ) STRICT",
      ]
    `);
    // Version 2 is unchanged by version 3.
    expect(digestOf(1)).toMatchInlineSnapshot(
      `"fedd589fba4ecf879e17a9b7c085c401507ed18e951abcdb3a0cf31c63f2591b"`,
    );
    // Version 3 (M1-7k-b): publisher_lease (07 §3.2, 06 §6) and outbox_staged (IR-M1-7k-1 F08).
    expect(MIGRATIONS[2]?.statements).toMatchInlineSnapshot(`
      [
        "CREATE TABLE "publisher_lease" (
        "name" TEXT NOT NULL CHECK (typeof("name") = 'text' AND length("name") > 0),
        "holder" TEXT NOT NULL CHECK (typeof("holder") = 'text' AND length("holder") > 0),
        "lease_until" INTEGER NOT NULL CHECK (typeof("lease_until") = 'integer' AND "lease_until" BETWEEN 0 AND 9007199254740991),
        PRIMARY KEY ("name")
      ) STRICT",
        "CREATE TABLE "outbox_staged" (
        "envelope_id" TEXT NOT NULL CHECK (typeof("envelope_id") = 'text' AND length("envelope_id") > 0),
        "failures" INTEGER NOT NULL CHECK (typeof("failures") = 'integer' AND "failures" BETWEEN 0 AND 9007199254740991),
        "failed_at" INTEGER NOT NULL CHECK (typeof("failed_at") = 'integer' AND "failed_at" BETWEEN 0 AND 9007199254740991),
        PRIMARY KEY ("envelope_id")
      ) STRICT",
      ]
    `);
    // Version 3 is unchanged by version 4.
    expect(digestOf(2)).toMatchInlineSnapshot(
      `"e1ed945ccd595fde33376a7b00fbd31990cfe23411b175b297a5e7c145370e73"`,
    );
    // Version 4 (M1-1g-i): files.delete_after, the files.deleteAfter in effect at send time.
    expect(MIGRATIONS[3]?.statements).toMatchInlineSnapshot(`
      [
        "ALTER TABLE "files" ADD COLUMN "delete_after" TEXT CHECK ("delete_after" IS NULL OR (typeof("delete_after") = 'text' AND "delete_after" IN ('expiry', 'receipt')))",
      ]
    `);
    // Version 4 is unchanged by version 5.
    expect(digestOf(3)).toBe('8f5a5443d158b4f4a350163b4082e384791e0d411ceba6659aee97309e76f727');
    // Version 5 (M1-9i-a, D-115; 07 §3.4): own_storage, at most one row.
    expect(MIGRATIONS[4]?.statements).toEqual([
      'CREATE TABLE "own_storage" (\n' +
        '  "id" TEXT NOT NULL CHECK (typeof("id") = \'text\' AND length("id") > 0),\n' +
        '  "signed_json" TEXT NOT NULL CHECK (typeof("signed_json") = \'text\' AND length("signed_json") > 0),\n' +
        '  "applied_at" INTEGER NOT NULL CHECK (typeof("applied_at") = \'integer\' AND "applied_at" BETWEEN 0 AND 9007199254740991),\n' +
        '  PRIMARY KEY ("id")\n' +
        ') STRICT',
      'CREATE TRIGGER "own_storage__max_rows" BEFORE INSERT ON "own_storage" ' +
        'WHEN (SELECT count(*) FROM "own_storage") >= 1 ' +
        "BEGIN SELECT RAISE(ABORT, 'row count'); END",
    ]);
    // Version 5 is unchanged by version 6.
    expect(digestOf(4)).toBe('6de80ea7a048be2256f821237238cd80b6027b67d12c515511efb0467c705f9e');
    // Version 6 (MSG-FILES-IO-b): files.saved_name, the sealed name fetchFile saved the file under.
    expect(MIGRATIONS[5]?.statements).toEqual([
      'ALTER TABLE "files" ADD COLUMN "saved_name" TEXT CHECK ("saved_name" IS NULL OR ' +
        '(typeof("saved_name") = \'text\' AND length("saved_name") > 0))',
    ]);
    // Version 6 is unchanged by version 7.
    expect(digestOf(5)).toBe(
      encodeHex(
        sha256(
          encodeUtf8(
            'ALTER TABLE "files" ADD COLUMN "saved_name" TEXT CHECK ("saved_name" IS NULL OR ' +
              '(typeof("saved_name") = \'text\' AND length("saved_name") > 0))',
          ),
        ),
      ),
    );
    // Version 7 (U3-d, D-138): the new table local_owner_actions only; existing rows untouched.
    const v7 = MIGRATIONS[6]?.statements ?? [];
    expect(v7.length).toBeGreaterThan(0);
    expect(v7.every((st) => st.includes('"local_owner_actions"'))).toBe(true);
    expect(v7[0]).toMatch(/^CREATE TABLE "local_owner_actions" \(/);
    expect(digestOf(6)).toBe('4a2c345f5568856e05a29aeef0996efa642dbdeb2c50fe09bffb894ef709a32a');
    // Version 8 (W4-SHORT-INVITE, D-139): three nullable invites columns, appended.
    const v8 = MIGRATIONS[7]?.statements ?? [];
    expect(v8.map((st) => /^ALTER TABLE "invites" ADD COLUMN "(\w+)" /.exec(st)?.[1])).toEqual([
      'drop_lookup_id',
      'drop_key_epoch',
      'cancelled_at',
    ]);
    expect(digestOf(7)).toBe('ff5840bf7d82d7a4c9a78f4e79f2bec15e4556122cf366296522dbc84db3c57f');
    // Version 9 (W4-RENAME-REACHES-CONTACTS, D-141): four nullable contacts columns, appended.
    const v9 = MIGRATIONS[8]?.statements ?? [];
    expect(v9).toHaveLength(4);
    expect(v9.every((st) => st.startsWith('ALTER TABLE "contacts" ADD COLUMN'))).toBe(true);
    expect(v9.map((st) => /ADD COLUMN "([a-z_]+)"/.exec(st)?.[1])).toEqual([
      'former_name',
      'name_changed_at',
      'name_change_seen',
      'declared_name',
    ]);
    expect(digestOf(8)).toBe('1966a9af7c3f60389de97963606d0b694e5b7d5489aec1554cd5f4efd817726a');
  });

  it('migrates a version 7 file to version 8 (W4-SHORT-INVITE): invites kept, drop columns null', async () => {
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 7)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 7');
    raw
      .prepare(
        'INSERT INTO "invites" ("invite_id", "proof_key", "expires_at", "created_at") ' +
          'VALUES (?, ?, 2, 1)',
      )
      .run('AAAAAAAAAAAAAAAAAAAAAA', 'x');
    raw.close();
    const v8 = await SqliteStore.open(path());
    // Opening migrates forward to the current version (9 since D-141); version 8's columns are there.
    expect(v8.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    const [row] = await v8.transaction((tx) => tx.select('invites'));
    expect(row?.drop_lookup_id).toBeNull();
    expect(row?.drop_key_epoch).toBeNull();
    expect(row?.cancelled_at).toBeNull();
    await v8.close();
  });

  it('migrates a version 8 file to version 9 (D-141): contacts and invites kept, the former-name columns null', async () => {
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 8)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 8');
    raw
      .prepare(
        'INSERT INTO "invites" ("invite_id", "proof_key", "expires_at", "created_at") ' +
          'VALUES (?, ?, 2, 1)',
      )
      .run('AAAAAAAAAAAAAAAAAAAAAA', 'x');
    raw
      .prepare(
        'INSERT INTO "contacts" ("contact_id", "name", "name_source", "agent_card_json", "relays", ' +
          '"agent_nostr", "key_epoch", "nostr_keys", "owner_fingerprint", "verified", "status", ' +
          '"pairing", "safety_code_checked", "created_at", "updated_at") ' +
          "VALUES ('c1', 'n', 'counterparty', 'a', 'r', 'k1', 0, '[\"k1\"]', 'f', 0, 'active', " +
          "'complete', 0, 1, 1)",
      )
      .run();
    raw.close();
    const v9 = await SqliteStore.open(path());
    expect(v9.schemaVersion).toBe(9);
    const [row] = await v9.transaction((tx) => tx.select('contacts'));
    expect(row?.contact_id).toBe('c1');
    expect(row?.former_name).toBeNull();
    expect(row?.name_changed_at).toBeNull();
    expect(row?.name_change_seen).toBeNull();
    await v9.transaction((tx) =>
      tx.update(
        'contacts',
        { contact_id: 'c1' },
        { former_name: sealed('o'), name_change_seen: 0 },
      ),
    );
    const [after] = await v9.transaction((tx) => tx.select('contacts'));
    expect(after?.name_change_seen).toBe(0);
    expect(await v9.transaction((tx) => tx.select('invites'))).toHaveLength(1);
    await v9.close();
    // Idempotent: the user_version runner applies nothing on a second open; the rows stay as written.
    const again = await SqliteStore.open(path());
    expect(again.schemaVersion).toBe(9);
    const [kept] = await again.transaction((tx) => tx.select('contacts'));
    expect(kept?.name_change_seen).toBe(0);
    expect(await again.transaction((tx) => tx.select('invites'))).toHaveLength(1);
    await again.close();
  });

  it('migrates a version 6 file to version 7 (U3-d): every row kept, local_owner_actions added', async () => {
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 6)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 6');
    raw
      .prepare(
        'INSERT INTO "owner_action_nonces" ("nonce", "op", "action_hash", "issued_at", ' +
          '"expires_at", "applied_at") VALUES (?, ?, ?, 1, 2, 1)',
      )
      .run('AAAAAAAAAAAAAAAAAAAAAA', 'policy.set', 'ab'.repeat(32));
    raw.close();
    const v7 = await SqliteStore.open(path());
    // Opening migrates forward to the current version (9 since D-141); version 7's table is there.
    expect(v7.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(await v7.transaction((tx) => tx.select('owner_action_nonces'))).toHaveLength(1);
    expect(await v7.transaction((tx) => tx.select('local_owner_actions'))).toEqual([]);
    await v7.transaction((tx) =>
      tx.insert('local_owner_actions', {
        record: 'agent.label',
        op: 'agent.label',
        signed_json: sealed('s'),
        applied_at: 1,
      }),
    );
    // One row per record; an op outside the three is refused by the column check.
    expect(
      await rejects(
        v7.transaction((tx) =>
          tx.insert('local_owner_actions', {
            record: 'agent.label',
            op: 'agent.label',
            signed_json: sealed('t'),
            applied_at: 2,
          }),
        ),
      ),
    ).toBeDefined();
    expect(
      await rejects(
        v7.transaction((tx) =>
          tx.insert('local_owner_actions', {
            record: 'app:codex',
            op: 'policy.set' as never,
            signed_json: sealed('u'),
            applied_at: 2,
          }),
        ),
      ),
    ).toBeDefined();
    await v7.close();
  });

  it('migrates a version 5 file to version 6 (MSG-FILES-IO-b): files rows kept with saved_name null', async () => {
    // A file as the version 5 code left it: the frozen v1 to v5 statements and user_version 5.
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 5)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 5');
    const insert = raw.prepare(
      `INSERT INTO "files" ("envelope_id", "idx", "name", "size", "sha256", "locator", "url", ` +
        `"file_key", "expires_at", "deleted_at", "delete_after") ` +
        `VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 9, NULL, ?)`,
    );
    insert.run('e1', 0, sealed('n1'), 5, 'h1', sealed('l1'), sealed('k1'), 'receipt');
    insert.run('e1', 1, sealed('n2'), 6, 'h2', sealed('l2'), sealed('k2'), null);
    insert.run('e2', 0, sealed('n3'), 7, 'h3', sealed('l3'), sealed('k3'), 'expiry');
    raw.close();

    const v6 = await SqliteStore.open(path());
    expect(v6.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    const rows = await v6.transaction((tx) => tx.select('files'));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.envelope_id, r.idx, r.size, r.delete_after, r.saved_name])).toEqual([
      ['e1', 0, 5, 'receipt', null],
      ['e1', 1, 6, null, null],
      ['e2', 0, 7, 'expiry', null],
    ]);
    expect(rows[0]?.file_key).toBe(sealed('k1'));
    await v6.transaction((tx) =>
      tx.update('files', { envelope_id: 'e1', idx: 0 }, { saved_name: sealed('saved') }),
    );
    expect(
      (await v6.transaction((tx) => tx.get('files', { envelope_id: 'e1', idx: 0 })))?.saved_name,
    ).toBe(sealed('saved'));
    // An empty value is not a sealed value (07 §3.1).
    expect(
      await rejects(
        v6.transaction((tx) =>
          tx.update('files', { envelope_id: 'e1', idx: 1 }, { saved_name: '' as never }),
        ),
      ),
    ).toBeDefined();
    await v6.close();
  });

  it('an older build refuses a version 6 file and leaves it as it is (forward-only, no rollback)', async () => {
    const current = await SqliteStore.open(path());
    expect(current.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    await current.close();
    // The version 5 code: the migrations up to 5 only.
    const error = await rejects(SqliteStore.open(path(), { migrations: MIGRATIONS.slice(0, 5) }));
    expect((error as NodeStoreError).code).toBe('store_too_new');
    const raw = new Database(path(), { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(STORE_SCHEMA_VERSION);
    expect(
      raw
        .prepare("SELECT count(*) FROM pragma_table_info('files') WHERE name = 'saved_name'")
        .pluck()
        .get(),
    ).toBe(1);
    raw.close();
  });

  it('migrates a version 4 file to version 5 (M1-9i-a): rows kept, own_storage added (one row)', async () => {
    // A file as the version 4 code left it: the frozen v1 to v4 statements and user_version 4.
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 4)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 4');
    raw
      .prepare(
        `INSERT INTO "owner_action_nonces" ("nonce", "op", "action_hash", "issued_at", ` +
          `"expires_at", "applied_at") VALUES ('n1', 'policy.set', 'h', 1, 2, 1)`,
      )
      .run();
    raw.close();
    const v5 = await SqliteStore.open(path());
    expect(v5.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(await v5.transaction((tx) => tx.count('owner_action_nonces'))).toBe(1);
    expect(await v5.transaction((tx) => tx.count('own_storage'))).toBe(0);
    const row = (id: string) => ({ id, signed_json: sealed('s'), applied_at: 5 });
    await v5.transaction((tx) => tx.insert('own_storage', row('0123456789abcdef')));
    // At most one own storage per agent in M1 (07 §3.4).
    expect(
      await rejects(v5.transaction((tx) => tx.insert('own_storage', row('fedcba9876543210')))),
    ).toBeInstanceOf(StoreConstraintError);
    await v5.close();
    const fresh = await SqliteStore.open(join(dir, 'fresh.db'));
    expect(fresh.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    await fresh.close();
  });

  it('migrates a version 3 file to version 4 (M1-1g-i): files rows kept with delete_after null', async () => {
    // A file as the version 3 code left it: the frozen v1 to v3 statements and user_version 3.
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 3)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 3');
    raw
      .prepare(
        `INSERT INTO "files" ("envelope_id", "idx", "name", "size", "sha256", "locator", "url", ` +
          `"file_key", "expires_at", "deleted_at") VALUES ` +
          `('e1', 0, 'n', 5, 'h', 'l', NULL, 'k', 60, NULL)`,
      )
      .run();
    raw.close();
    const v4 = await SqliteStore.open(path());
    expect(v4.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    // No value was recorded at send time: null, which retention reads as "keep until expiry".
    expect(
      await v4.transaction((tx) => tx.get('files', { envelope_id: 'e1', idx: 0 })),
    ).toMatchObject({ size: 5, deleted_at: null, delete_after: null });
    await v4.transaction((tx) =>
      tx.update('files', { envelope_id: 'e1', idx: 0 }, { delete_after: 'receipt' }),
    );
    expect(
      await rejects(
        v4.transaction((tx) =>
          tx.update('files', { envelope_id: 'e1', idx: 0 }, { delete_after: 'never' as never }),
        ),
      ),
    ).toBeInstanceOf(StoreConstraintError);
    await v4.close();
    const fresh = await SqliteStore.open(join(dir, 'fresh.db'));
    expect(fresh.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    await fresh.close();
  });

  it('migrates a version 2 file to version 3 (M1-7k-b): rows kept, publisher_lease and outbox_staged added', async () => {
    // A file as the version 2 code left it: the frozen v1 and v2 statements and user_version 2.
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 2)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 2');
    raw
      .prepare(
        `INSERT INTO "envelopes" ("envelope_id", "envelope_hash", "thread_id", "direction", ` +
          `"contact_id", "from_key", "type", "state", "refused_reason", "created_at", ` +
          `"envelope_json", "payload_json", "read_at", "delivery", "refused_at", ` +
          `"request_accepted_at") VALUES ` +
          `('e1', 'h1', 't1', 'out', NULL, 'k1', 'handshake', 'ok', NULL, 5, ` +
          `NULL, NULL, NULL, 'queued', NULL, NULL)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO "blocked_keys" ("from_key", "blocked_at", "via_envelope_id") VALUES (?, ?, ?)`,
      )
      .run('k2', 6, 'e0');
    raw.close();
    const v3 = await SqliteStore.open(path());
    expect(v3.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(await v3.transaction((tx) => tx.get('envelopes', { envelope_id: 'e1' }))).toMatchObject({
      type: 'handshake',
      delivery: 'queued',
    });
    expect(await v3.transaction((tx) => tx.count('blocked_keys'))).toBe(1);
    await v3.transaction((tx) => {
      tx.insert('publisher_lease', { name: 'subscriptions', holder: 'h', lease_until: 60 });
      tx.insert('outbox_staged', { envelope_id: 'e1', failures: 1, failed_at: 65 });
    });
    // One lease row per name: a second holder cannot insert beside it.
    expect(
      await rejects(
        v3.transaction((tx) =>
          tx.insert('publisher_lease', { name: 'subscriptions', holder: 'g', lease_until: 70 }),
        ),
      ),
    ).toBeInstanceOf(StoreConstraintError);
    await v3.close();
    const fresh = await SqliteStore.open(join(dir, 'fresh.db'));
    expect(fresh.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    await fresh.close();
  });

  it('migrates a version 1 file to version 2 (D-72): rows kept, new columns null, blocked_keys added', async () => {
    // A file as the version 1 code left it: the frozen v1 statements and user_version 1.
    const raw = new Database(path());
    for (const statement of MIGRATIONS[0]?.statements ?? []) raw.prepare(statement).run();
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 1');
    raw
      .prepare(
        `INSERT INTO "envelopes" ("envelope_id", "envelope_hash", "thread_id", "direction", ` +
          `"contact_id", "from_key", "type", "state", "refused_reason", "created_at", ` +
          `"envelope_json", "payload_json", "read_at", "delivery") VALUES ` +
          `('e1', 'h1', 't1', 'in', NULL, 'k1', 'text', 'refused', 'owner_entry_missing', 5, ` +
          `NULL, NULL, NULL, NULL)`,
      )
      .run();
    raw.close();
    // Opening runs versions 2, 3 (M1-7k-b, new tables only), 4 (M1-1g-i, a nullable column) and 5
    // (M1-9i-a, a new table).
    const v2 = await SqliteStore.open(path());
    expect(v2.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(await v2.transaction((tx) => tx.get('envelopes', { envelope_id: 'e1' }))).toMatchObject({
      state: 'refused',
      refused_at: null,
      request_accepted_at: null,
    });
    await v2.transaction((tx) =>
      tx.insert('blocked_keys', { from_key: 'k1', blocked_at: 7, via_envelope_id: 'e1' }),
    );
    expect(await v2.transaction((tx) => tx.count('blocked_keys'))).toBe(1);
    await v2.close();
    // A fresh file through every migration is the same schema as the migrated one.
    const fresh = await SqliteStore.open(join(dir, 'fresh.db'));
    expect(fresh.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    await fresh.close();
  });

  it('migrates forward from the previous schema version', async () => {
    const v1 = await SqliteStore.open(path());
    await v1.transaction((tx) => tx.insert('seen', seen('kept')));
    await v1.close();
    const next: StoreMigration = {
      version: STORE_SCHEMA_VERSION + 1,
      statements: ['CREATE INDEX "seen__by_time" ON "seen" ("first_seen_at")'],
    };
    const migrated = await SqliteStore.open(path(), { migrations: [...MIGRATIONS, next] });
    expect(migrated.schemaVersion).toBe(STORE_SCHEMA_VERSION + 1);
    expect(await migrated.transaction((tx) => tx.count('seen'))).toBe(1);
    const check = new Database(path(), { readonly: true });
    expect(
      check
        .prepare("SELECT count(*) FROM sqlite_schema WHERE name = 'seen__by_time'")
        .pluck()
        .get(),
    ).toBe(1);
    check.close();
    await migrated.close();
    // The code at the current version refuses the newer file, and leaves it as it is (no
    // downgrade).
    const error = await rejects(SqliteStore.open(path()));
    expect((error as NodeStoreError).code).toBe('store_too_new');
    const raw = new Database(path(), { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(STORE_SCHEMA_VERSION + 1);
    raw.close();
  });

  it('rolls a failed migration back entirely', async () => {
    const broken: StoreMigration = {
      version: 1,
      statements: [...createSchemaStatements(), 'NOT SQL'],
    };
    expect(await rejects(SqliteStore.open(path(), { migrations: [broken] }))).toBeInstanceOf(
      NodeStoreError,
    );
    const raw = new Database(path(), { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(0);
    expect(
      raw.prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table'").pluck().get(),
    ).toBe(0);
    raw.close();
    const fine = await SqliteStore.open(path());
    expect(fine.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    await fine.close();
  });

  it('refuses a file that is not an AgentLink store', async () => {
    const other = join(dir, 'other.sqlite');
    const raw = new Database(other);
    raw.exec('CREATE TABLE notes (x TEXT)');
    raw.close();
    expect(((await rejects(SqliteStore.open(other))) as NodeStoreError).code).toBe('store_foreign');
    const junk = join(dir, 'junk.sqlite');
    await writeFile(junk, 'this is not a database file at all, just some text bytes.'.repeat(20));
    expect(((await rejects(SqliteStore.open(junk))) as NodeStoreError).code).toBe('store_foreign');
  });

  it('refuses a store whose tables are not the schema (a dropped column)', async () => {
    (await SqliteStore.open(path())).close();
    const raw = new Database(path());
    raw.exec('ALTER TABLE "seen" DROP COLUMN "first_seen_at"');
    raw.close();
    expect(((await rejects(SqliteStore.open(path()))) as NodeStoreError).code).toBe(
      'store_foreign',
    );
  });

  it('refuses an in-memory path', async () => {
    expect(await rejects(SqliteStore.open(':memory:'))).toBeInstanceOf(StoreUsageError);
  });

  it('enforces the schema in SQLite itself, against a writer that bypasses the store', async () => {
    const store = await SqliteStore.open(path());
    await store.close();
    const raw = new Database(path());
    const attempts = [
      `INSERT INTO "seen" VALUES ('wrap', '', 1)`,
      `INSERT INTO "seen" VALUES ('other', 'x', 1)`,
      `INSERT INTO "seen" VALUES ('wrap', 'x', -1)`,
      `INSERT INTO "seen" VALUES ('wrap', 'x', 9007199254740992)`,
      `INSERT INTO "seen" VALUES ('wrap', 'x', 'soon')`,
      `INSERT INTO "budget_ledger" VALUES ('e', 0, 1, 'r', 1, NULL, '1.50', NULL, 'reserved', 1, NULL, NULL)`,
      `INSERT INTO "budget_state" VALUES ('other', 0, 'ok', 0, 0, NULL)`,
    ];
    for (const sql of attempts) {
      expect(() => raw.exec(sql), sql).toThrow(/constraint|cannot store/i);
    }
    raw.close();
  });

  it('checks USD amounts in SQL exactly as the 04 §2.4.1 form', async () => {
    // The canonical form, as @4thtech-io/types isUsdAmount (packages/node may not import types).
    const USD = /^(0|[1-9][0-9]{0,8})(\.[0-9]{0,5}[1-9])?$/;
    (await SqliteStore.open(path())).close();
    const raw = new Database(path());
    const insert = raw.prepare(
      `INSERT INTO "budget_ledger" VALUES (?, 0, 1, ?, 1, NULL, ?, NULL, 'reserved', 1, NULL, NULL)`,
    );
    const alphabet = '0123456789.';
    let seed = 7;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const candidates = [
      '0',
      '00',
      '0.0',
      '0.05',
      '1.000001',
      '1.0000001',
      '999999999',
      '1000000000',
    ];
    for (let i = 0; i < 3000; i += 1) {
      let s = '';
      const length = 1 + (next() % 14);
      for (let j = 0; j < length; j += 1) s += alphabet[next() % alphabet.length];
      candidates.push(s);
    }
    candidates.forEach((usd, i) => {
      let accepted = true;
      try {
        insert.run(`e${i}`, `r${i}`, usd);
      } catch {
        accepted = false;
      }
      expect(accepted, JSON.stringify(usd)).toBe(USD.test(usd));
    });
    raw.close();
  });

  it('keeps revoked_agents rows and a revoked contact status final (second layer, 07 §3.7)', async () => {
    const store = await SqliteStore.open(path());
    await store.transaction((tx) =>
      tx.insert('revoked_agents', {
        agent_evm: '0x01',
        nostr_keys: '[]',
        signed_json: null,
        reason: null,
        source: 'registry',
        chain_id: '1',
        registry_ref: 'r',
        applied_at: 1,
      }),
    );
    expect(
      await rejects(store.transaction((tx) => tx.delete('revoked_agents', {}))),
    ).toBeInstanceOf(StoreConstraintError);
    const contact: Row<'contacts'> = {
      contact_id: 'c1',
      name: sealed('n'),
      name_source: 'counterparty',
      agent_card_json: sealed('c'),
      relays: sealed('r'),
      agent_nostr: 'k1',
      key_epoch: 0,
      nostr_keys: '["k1"]',
      owner_fingerprint: 'f',
      verified: 0,
      status: 'revoked',
      pairing: 'complete',
      handshake_envelope_id: null,
      handshake_ack_envelope_id: null,
      code_commit: null,
      nonce_b: null,
      safety_check: null,
      safety_code_checked: 0,
      created_at: 0,
      updated_at: 0,
      former_name: null,
      name_changed_at: null,
      name_change_seen: null,
      declared_name: null,
    };
    await store.transaction((tx) => tx.insert('contacts', contact));
    expect(
      await rejects(
        store.transaction((tx) =>
          tx.update('contacts', { contact_id: 'c1' }, { status: 'active' }),
        ),
      ),
    ).toBeInstanceOf(StoreConstraintError);
    expect(
      await store.transaction((tx) =>
        tx.update('contacts', { contact_id: 'c1' }, { updated_at: 5 }),
      ),
    ).toBe(1);
    expect(await store.transaction((tx) => tx.count('revoked_agents'))).toBe(1);
    await store.close();
  });

  it('fails closed on a stored value outside its type, never returning it as absent', async () => {
    const store = await SqliteStore.open(path());
    await store.transaction((tx) => tx.insert('seen', seen('a')));
    await store.close();
    // A same-user writer that also drops the CHECK (writable_schema) is out of scope (G-1); here the
    // reader still refuses a bad value that reaches the row.
    const raw = new Database(path());
    raw.pragma('ignore_check_constraints = ON');
    raw.exec(`UPDATE "seen" SET "first_seen_at" = 9007199254740993 WHERE "id" = 'a'`);
    raw.close();
    const reopened = await SqliteStore.open(path());
    const error = await rejects(reopened.transaction((tx) => tx.select('seen')));
    expect((error as NodeStoreError).code).toBe('store_unreadable');
    await reopened.close();
  });

  it('waits for the write lock asynchronously, then reports store_busy past the limit', async () => {
    const store = await SqliteStore.open(path(), { lockTimeoutMs: 300 });
    const holder = new Database(path());
    holder.exec('BEGIN IMMEDIATE');
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    const error = await rejects(store.transaction((tx) => tx.insert('seen', seen('a'))));
    clearInterval(timer);
    expect((error as NodeStoreError).code).toBe('store_busy');
    expect(ticks).toBeGreaterThan(5); // the event loop kept running while it waited
    const later = store.transaction((tx) => tx.insert('seen', seen('b')));
    setTimeout(() => holder.exec('COMMIT'), 50);
    await later;
    holder.close();
    expect(await store.transaction((tx) => tx.count('seen'))).toBe(1);
    await store.close();
  });

  it('refuses a nested transaction from inside a body', async () => {
    const store = await SqliteStore.open(path());
    let nested: Promise<unknown> | undefined;
    await store.transaction((tx) => {
      tx.insert('seen', seen('a'));
      nested = store.transaction((inner) => inner.insert('seen', seen('b')));
    });
    expect(await rejects(nested as Promise<unknown>)).toBeInstanceOf(StoreUsageError);
    expect(await store.transaction((tx) => tx.count('seen'))).toBe(1);
    await store.close();
  });
});
