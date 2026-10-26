// M2-3a: the Durable Object Store against the Store contract (07 §3.1, §3.7) and the sealed-column
// conformance of 07 §3 / §3.1 ("The sealed-column vectors of §3 are the Durable Object store's
// conformance suite"): every table round-trips with every `enc` column sealed under the store key,
// the raw storage holds no plaintext and only `v1.` sealed text in `enc` columns, another key does not
// open, and fixed sealed values made by the Node runtime's cipher open here, in their context only.
import { runInDurableObject } from 'cloudflare:test';
import {
  STORE_SCHEMA_VERSION,
  StoreConstraintError,
  StoreUsageError,
  TABLE_NAMES,
  createSqlSchemaStatements,
  rowKeyOf,
  type Row,
  type Sealed,
  type StoreValue,
  type TableName,
} from '@4thtech-io/core';
import { encodeUtf8, randomBytes } from '@4thtech-io/crypto';
import { createStoreColumnCipher } from '@4thtech-io/crypto/keystore';
import { describe, expect, it } from 'vitest';
import { createCloudSchemaStatements } from '../src/cloud-schema.js';
import { DurableObjectStore } from '../src/do-store.js';
import { freshAgent } from './helpers.js';
import { CANARY, encColumns, plaintextOf, sampleRow, singleRow, specOf } from './store-rows.js';
import type { TestAgentDO } from './worker.js';

const sealed = (s: string) => s as Sealed;

type Body<R> = (store: DurableObjectStore, state: DurableObjectState) => R | Promise<R>;
const inObject = <R>(body: Body<R>): Promise<R> =>
  runInDurableObject(freshAgent(), (instance: TestAgentDO, state: DurableObjectState) =>
    body(instance.testStore(), state),
  );

const seen = (id: string, t = 1): Row<'seen'> => ({ kind: 'wrap', id, first_seen_at: t });

const rowsPer = (table: TableName): number => (singleRow(table) ? 1 : 3);

describe('DurableObjectStore: schema (07 §3, §3.7)', () => {
  it('creates exactly core’s shared DDL plus the cloud-only tables, at the code’s schema version', async () => {
    await inObject((store, state) => {
      expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
      const sql = new Set(
        [
          ...state.storage.sql.exec('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL').raw(),
        ].map((r) => String(r[0])),
      );
      for (const statement of [...createSqlSchemaStatements(), ...createCloudSchemaStatements()]) {
        expect(sql.has(statement), statement.slice(0, 60)).toBe(true);
      }
      const version = state.storage.sql
        .exec('SELECT schema_version FROM deploy_state WHERE id = 1')
        .toArray();
      expect(version).toEqual([{ schema_version: STORE_SCHEMA_VERSION }]);
    });
  });

  it('opens again over the same storage without change (restart), keeping rows', async () => {
    await inObject(async (store, state) => {
      await store.transaction((tx) => tx.insert('seen', seen('a')));
      const again = DurableObjectStore.open(state.storage);
      expect(again.schemaVersion).toBe(STORE_SCHEMA_VERSION);
      expect(await again.transaction((tx) => tx.select('seen'))).toEqual([seen('a')]);
    });
  });

  it('refuses a newer stored schema version and an older one without a migration', async () => {
    await inObject((_store, state) => {
      state.storage.sql.exec(
        'UPDATE deploy_state SET schema_version = ?',
        STORE_SCHEMA_VERSION + 1,
      );
      expect(() => DurableObjectStore.open(state.storage)).toThrow(
        expect.objectContaining({ code: 'store_too_new' }),
      );
      state.storage.sql.exec(
        'UPDATE deploy_state SET schema_version = ?',
        STORE_SCHEMA_VERSION - 1,
      );
      expect(() => DurableObjectStore.open(state.storage)).toThrow(
        expect.objectContaining({ code: 'store_needs_migration' }),
      );
    });
  });

  it('refuses storage whose tables are not this schema', async () => {
    await inObject((_store, state) => {
      state.storage.sql.exec('CREATE TABLE "other" ("x" TEXT)');
      expect(() => DurableObjectStore.open(state.storage)).toThrow(
        expect.objectContaining({ code: 'store_foreign' }),
      );
    });
  });
});

describe('DurableObjectStore: the Store contract (07 §3.1, §3.7)', () => {
  it('refuses a duplicate key, a wrong type and a missing column, and keeps the first row', async () => {
    await inObject(async (store) => {
      await store.transaction((tx) => tx.insert('seen', seen('a')));
      await expect(store.transaction((tx) => tx.insert('seen', seen('a', 2)))).rejects.toThrow(
        StoreConstraintError,
      );
      await expect(
        store.transaction((tx) =>
          tx.insert('seen', { kind: 'other', id: 'b', first_seen_at: 1 } as never),
        ),
      ).rejects.toThrow(StoreConstraintError);
      await expect(
        store.transaction((tx) => tx.insert('seen', { kind: 'wrap', id: 'c' } as never)),
      ).rejects.toThrow(StoreConstraintError);
      expect(await store.transaction((tx) => tx.select('seen'))).toEqual([seen('a')]);
    });
  });

  it('enforces the SQL checks of a USD amount and single-row tables', async () => {
    await inObject(async (store) => {
      const state: Row<'budget_state'> = {
        slot: 'current',
        ledger_epoch: 0,
        status: 'ok',
        newest_t: 0,
        since: 0,
        broken_at: null,
      };
      await store.transaction((tx) => tx.insert('budget_state', state));
      await expect(
        store.transaction((tx) => tx.insert('budget_state', { ...state, slot: 'next' } as never)),
      ).rejects.toThrow();
    });
  });

  it('is all-or-nothing when the body throws, and keeps the rest when it catches a refusal', async () => {
    await inObject(async (store) => {
      await expect(
        store.transaction((tx) => {
          tx.insert('seen', seen('a'));
          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');
      expect(await store.transaction((tx) => tx.count('seen'))).toBe(0);
      await store.transaction((tx) => {
        tx.insert('seen', seen('b'));
        try {
          tx.insert('seen', seen('b'));
        } catch {
          // refused statement only
        }
        tx.insert('seen', seen('c'));
      });
      expect(await store.transaction((tx) => tx.count('seen'))).toBe(2);
    });
  });

  it('refuses an asynchronous body and a nested transaction, keeping nothing', async () => {
    await inObject(async (store) => {
      await expect(
        store.transaction((tx) => {
          tx.insert('seen', seen('a'));
          return Promise.resolve(1);
        }),
      ).rejects.toThrow(StoreUsageError);
      let nested: Promise<unknown> | undefined;
      await store.transaction(() => {
        nested = store.transaction(() => 1);
      });
      await expect(nested).rejects.toThrow(StoreUsageError);
      expect(await store.transaction((tx) => tx.count('seen'))).toBe(0);
    });
  });

  it('reports changed row counts for update and delete (compare-and-set)', async () => {
    await inObject(async (store) => {
      await store.transaction((tx) => {
        tx.insert('seen', seen('a', 1));
        tx.insert('seen', seen('b', 2));
      });
      expect(
        await store.transaction((tx) =>
          tx.update('seen', { id: 'a', first_seen_at: 1 }, { first_seen_at: 5 }),
        ),
      ).toBe(1);
      expect(
        await store.transaction((tx) =>
          tx.update('seen', { id: 'a', first_seen_at: 1 }, { first_seen_at: 6 }),
        ),
      ).toBe(0);
      expect(
        await store.transaction((tx) => tx.delete('seen', { first_seen_at: { lt: 10 } })),
      ).toBe(2);
    });
  });

  it('filters, orders and limits; null matches only null; rows are frozen copies', async () => {
    await inObject(async (store) => {
      await store.transaction((tx) => {
        for (const [id, t] of [
          ['a', 3],
          ['b', 1],
          ['c', 2],
        ] as const)
          tx.insert('seen', seen(id, t));
      });
      const rows = await store.transaction((tx) =>
        tx.select(
          'seen',
          { first_seen_at: { gte: 2 } },
          { orderBy: [['first_seen_at', 'asc']], limit: 5 },
        ),
      );
      expect(rows.map((r) => r.id)).toEqual(['c', 'a']);
      expect(Object.isFrozen(rows[0])).toBe(true);
      const inSet = await store.transaction((tx) =>
        tx.select('seen', { id: { in: ['a', 'b', 7 as never] } }),
      );
      expect(inSet).toHaveLength(2);
      expect(await store.transaction((tx) => tx.count('approvals', { scope_key: null }))).toBe(0);
    });
  });

  it('keeps revoked_agents rows and a revoked contact status final (second layer)', async () => {
    await inObject((_store, state) => {
      const triggers = state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        .toArray()
        .map((r) => r['name']);
      expect(triggers).toEqual(
        expect.arrayContaining(['revoked_agents__never_deleted', 'contacts__revoked_is_final']),
      );
    });
  });

  it('enforces the schema in SQLite itself, against a writer that bypasses the store', async () => {
    await inObject(async (store, state) => {
      await store.transaction((tx) => tx.insert('seen', seen('a')));
      expect(() => state.storage.sql.exec(`UPDATE seen SET id = '' WHERE id = 'a'`)).toThrow();
      expect(() => state.storage.sql.exec(`UPDATE seen SET kind = 'other'`)).toThrow();
      expect(() => state.storage.sql.exec(`UPDATE seen SET first_seen_at = 'x'`)).toThrow();
      expect(await store.transaction((tx) => tx.select('seen'))).toEqual([seen('a')]);
    });
  });

  it('refuses every call after close', async () => {
    await inObject(async (store) => {
      await store.close();
      await expect(store.transaction((tx) => tx.count('seen'))).rejects.toThrow(StoreUsageError);
    });
  });
});

describe('DurableObjectStore: sealed-column conformance (07 §3, §3.1)', () => {
  const storeKey = (): Uint8Array => new Uint8Array(32).map((_, i) => i);

  async function filled(store: DurableObjectStore) {
    const cipher = await createStoreColumnCipher(storeKey());
    const rows = new Map<TableName, unknown[]>();
    for (const table of TABLE_NAMES) {
      const list: unknown[] = [];
      for (let i = 0; i < rowsPer(table); i += 1) list.push(await sampleRow(table, i, cipher));
      rows.set(table, list);
    }
    await store.transaction((tx) => {
      for (const [table, list] of rows) for (const row of list) tx.insert(table, row as never);
    });
    return cipher;
  }

  it('round-trips every table; every enc column opens to its plaintext in its own context', async () => {
    await inObject(async (store) => {
      const cipher = await filled(store);
      for (const table of TABLE_NAMES) {
        const spec = specOf(table);
        const rows = await store.transaction((tx) => tx.select(table));
        expect(rows, table).toHaveLength(rowsPer(table));
        for (const [i, row] of rows.entries()) {
          const values = row as unknown as Readonly<Record<string, StoreValue>>;
          const rowKey = rowKeyOf(spec.primaryKey.map((k) => values[k] ?? null));
          for (const column of encColumns(table)) {
            const ctx = { table, column, rowKey };
            expect(await cipher.open(ctx, values[column] as string)).toBe(
              plaintextOf(table, column, i),
            );
          }
        }
      }
      cipher.close();
    });
  });

  it('holds no plaintext at rest: enc columns are `v1.` sealed text; another key does not open', async () => {
    await inObject(async (store, state) => {
      (await filled(store)).close();
      const other = await createStoreColumnCipher(randomBytes(32));
      for (const table of TABLE_NAMES) {
        const enc = new Set(encColumns(table));
        const rows = state.storage.sql.exec(`SELECT * FROM "${table}"`).toArray();
        expect(rows, table).toHaveLength(rowsPer(table));
        for (const row of rows) {
          for (const [column, value] of Object.entries(row)) {
            expect(String(value)).not.toContain(CANARY);
            if (enc.has(column)) {
              expect(String(value).startsWith('v1.'), `${table}.${column}`).toBe(true);
            }
          }
        }
      }
      const contact = state.storage.sql
        .exec('SELECT contact_id, name FROM contacts LIMIT 1')
        .toArray()[0];
      await expect(
        other.open(
          {
            table: 'contacts',
            column: 'name',
            rowKey: rowKeyOf([String(contact?.['contact_id'])]),
          },
          String(contact?.['name']),
        ),
      ).rejects.toThrow();
      other.close();
    });
  });

  // Fixed values sealed by the crypto package's cipher in Node (store key = bytes 0..31), committed
  // so that the Durable Object runtime opens the exact 07 §3.1 form: `v1.` + base64url(nonce ‖ ct ‖
  // tag), AAD JCS(["agentlink/v1/store-column", table, column, rowKey]).
  const VECTORS = [
    {
      table: 'contacts',
      column: 'name',
      rowKey: '["0x1111111111111111111111111111111111111111"]',
      plaintext: 'Ana',
      sealed: 'v1.SSZYNcLgk7PnZUwiiALaXsFP2zA4WxXi113FqSLp-A',
    },
    {
      table: 'envelopes',
      column: 'payload_json',
      rowKey: '["AAAAAAAAAAAAAAAAAAAAAA"]',
      plaintext: '{"type":"text","body":"héllo ✓"}',
      sealed:
        'v1.P-mnF-Lw2CRmw_dADSCkteS9vIytGUjtSA2j8zwD_yMtSZ5IQFPFQL2esSLh26-I-i0RsMILtjoHBSefnJrk',
    },
    {
      table: 'identity',
      column: 'name',
      rowKey: '["0x2222222222222222222222222222222222222222"]',
      plaintext: '',
      sealed: 'v1.M917J3O5D0ci_x9vBMqqHRCvEJ3pFJZOENfbPQ',
    },
  ] as const;

  it('opens the committed sealed values stored through the DO store, and only in their context', async () => {
    await inObject(async (store) => {
      const cipher = await createStoreColumnCipher(storeKey());
      const v = VECTORS[0];
      const contact = {
        ...(await sampleRow('contacts', 0, cipher)),
        contact_id: JSON.parse(v.rowKey)[0] as string,
        name: sealed(v.sealed),
      };
      // The row is otherwise sample data; re-seal its other enc columns for its own row key.
      for (const column of encColumns('contacts')) {
        if (column === 'name') continue;
        (contact as Record<string, unknown>)[column] = await cipher.seal(
          { table: 'contacts', column, rowKey: v.rowKey },
          'x',
        );
      }
      await store.transaction((tx) => tx.insert('contacts', contact as never));
      const stored = await store.transaction((tx) =>
        tx.get('contacts', { contact_id: contact.contact_id }),
      );
      expect(stored?.name).toBe(v.sealed);
      for (const vector of VECTORS) {
        const ctx = { table: vector.table, column: vector.column, rowKey: vector.rowKey };
        expect(await cipher.open(ctx, vector.sealed)).toBe(vector.plaintext);
        await expect(cipher.open({ ...ctx, column: 'other' }, vector.sealed)).rejects.toThrow();
        await expect(cipher.open({ ...ctx, rowKey: '["x"]' }, vector.sealed)).rejects.toThrow();
      }
      expect(await cipher.indexDigest(encodeUtf8('{"a":1}'))).toBe(
        '37e3fae71850b52bc6451f527824bb9f9788d12132f0fed83cc934223ec93c7e',
      );
      cipher.close();
    });
  });
});
