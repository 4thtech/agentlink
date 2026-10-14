// M1-8b acceptance (07 §3, §3.1): `enc` columns are ciphertext at rest under the store key, with AAD
// bound to table, column and row key. Scanning the raw database files finds none of the canary
// plaintexts; without the store key only the columns 07 §3 marks as clear are readable.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  TABLE_NAMES,
  rowKeyOf,
  type Sealed,
  type StoreValue,
  type TableName,
} from '@agentlink/core';
import {
  CryptoInputError,
  canonicalizeToBytes,
  encodeHex,
  randomBytes,
  sha256,
} from '@agentlink/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from './sqlite-store.js';
import { createAgentStoreCipher, type AgentStoreCipher } from './store-cipher.js';
import {
  CANARY,
  encColumns,
  plaintextOf,
  sampleRow,
  singleRow,
  specOf,
} from './store-rows.fixture.js';

let dir: string;
let path: string;
let storeKey: Uint8Array;
let cipher: AgentStoreCipher;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-enc-'));
  path = join(dir, 'agent.sqlite');
  storeKey = randomBytes(32);
  cipher = await createAgentStoreCipher(storeKey);
});
afterEach(async () => {
  cipher.close();
  await rm(dir, { recursive: true, force: true });
});

const rowsPer = (table: TableName): number => (singleRow(table) ? 1 : 3);

/** Fills every table with sample rows and returns the store, still open. */
async function filledStore(): Promise<SqliteStore> {
  const store = await SqliteStore.open(path);
  const rows = new Map<TableName, unknown[]>();
  for (const table of TABLE_NAMES) {
    const list: unknown[] = [];
    for (let i = 0; i < rowsPer(table); i += 1) list.push(await sampleRow(table, i, cipher));
    rows.set(table, list);
  }
  // Sealed before, written in one synchronous transaction (07 §3.1).
  await store.transaction((tx) => {
    for (const [table, list] of rows) for (const row of list) tx.insert(table, row as never);
  });
  return store;
}

async function rawFiles(): Promise<Buffer> {
  const names = await readdir(dir);
  const parts = await Promise.all(names.map((name) => readFile(join(dir, name))));
  return Buffer.concat(parts);
}

describe('SqliteStore with the store cipher: round trip per table', () => {
  it('stores and returns every table, and every enc column opens to its plaintext', async () => {
    const store = await filledStore();
    for (const table of TABLE_NAMES) {
      const spec = specOf(table);
      const rows = await store.transaction((tx) => tx.select(table));
      expect(rows, table).toHaveLength(rowsPer(table));
      for (const row of rows) {
        const values = row as unknown as Readonly<Record<string, StoreValue>>;
        const i = rows.indexOf(row);
        const expected = (await sampleRow(table, i, cipher)) as unknown as Record<
          string,
          StoreValue
        >;
        const rowKey = rowKeyOf(spec.primaryKey.map((k) => values[k] ?? null));
        for (const [column, c] of Object.entries(spec.columns)) {
          if (c.kind === 'enc') {
            const opened = await cipher.open({ table, column, rowKey }, values[column] as Sealed);
            expect(opened).toBe(plaintextOf(table, column, i));
          } else {
            expect(values[column], `${table}.${column}`).toEqual(expected[column]);
          }
        }
      }
    }
    await store.close();
  });
});

describe('SqliteStore at rest (07 §3 acceptance)', () => {
  it('leaves no canary plaintext and no store-key bytes in the database files (WAL included)', async () => {
    const store = await filledStore();
    // The open store still has its WAL: scan it as it is, then again after a checkpoint on close.
    const live = await rawFiles();
    expect(live.length).toBeGreaterThan(0);
    expect(live.includes(CANARY)).toBe(false);
    expect(live.includes(Buffer.from(storeKey))).toBe(false);
    await store.close();
    const closed = await rawFiles();
    expect(closed.includes(CANARY)).toBe(false);
    expect(closed.includes(Buffer.from(storeKey))).toBe(false);
    // The clear sample values are there, so the scan is reading the data.
    expect(closed.includes('seen.id.2')).toBe(true);
  });

  it('without the store key, reads only the clear columns; every enc value is sealed text', async () => {
    (await filledStore()).close();
    const raw = new Database(path, { readonly: true });
    for (const table of TABLE_NAMES) {
      const enc = new Set(encColumns(table));
      const rows = raw.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      expect(rows, table).toHaveLength(rowsPer(table));
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (enc.has(column)) {
            expect(String(value).startsWith('v1.'), `${table}.${column}`).toBe(true);
            expect(String(value)).not.toContain(CANARY);
          } else {
            expect(String(value)).not.toContain(CANARY);
          }
        }
      }
    }
    raw.close();
  });

  it('does not open with another store key (wrong-key failure)', async () => {
    const store = await filledStore();
    const other = await createAgentStoreCipher(randomBytes(32));
    const row = await store.transaction((tx) =>
      tx.get('contacts', { contact_id: 'contacts.contact_id.0' }),
    );
    const rowKey = rowKeyOf(['contacts.contact_id.0']);
    const error = await other
      .open({ table: 'contacts', column: 'name', rowKey }, row?.name as Sealed)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe('open_failed');
    other.close();
    await store.close();
  });

  it('does not open a value copied into another row or column', async () => {
    const store = await filledStore();
    const [a, b] = await store.transaction((tx) =>
      tx.select('contacts', {}, { orderBy: [['contact_id', 'asc']], limit: 2 }),
    );
    // A same-user writer swaps two contacts' names on disk.
    await store.transaction((tx) => {
      tx.update('contacts', { contact_id: a?.contact_id ?? '' }, { name: b?.name as Sealed });
    });
    const swapped = await store.transaction((tx) =>
      tx.get('contacts', { contact_id: a?.contact_id ?? '' }),
    );
    const key = rowKeyOf([a?.contact_id ?? null]);
    await expect(
      cipher.open({ table: 'contacts', column: 'name', rowKey: key }, swapped?.name as Sealed),
    ).rejects.toThrow(CryptoInputError);
    await expect(
      cipher.open({ table: 'contacts', column: 'relays', rowKey: key }, a?.name as Sealed),
    ).rejects.toThrow(CryptoInputError);
    await store.close();
  });

  it('keys the idempotency request digest with the index key, never a plain hash (07 §3.1)', async () => {
    const args = canonicalizeToBytes({ text: 'hello', to: 'denis' });
    const digest = await cipher.indexDigest(args);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(encodeHex(sha256(args)));
    const other = await createAgentStoreCipher(randomBytes(32));
    expect(await other.indexDigest(args)).not.toBe(digest);
    other.close();
  });
});
