// RET-2 (D-148; 07 §3.8; 04 §4.2): schema version 15.
// - A version 14 store (the shape 0.5.0 to 0.5.2 write) migrates to version 15 losslessly: every
//   stored value of every table stays exactly as it was; `envelopes.deleted_at` is appended and null,
//   and the `saved_files` table is added empty (the core backfills it, it cannot seal in SQL).
// - `auto_vacuum=INCREMENTAL`: a new store has it from the start; an existing store is switched once
//   with a VACUUM under the ID's inter-process lock, only when the disk has at least twice the store's
//   size free and the lock is free; otherwise it is skipped (the store still opens) and tried again
//   on a later open.
// - `compact()` runs `PRAGMA incremental_vacuum` after a large delete (RET-3).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { STORE_SCHEMA_VERSION, TABLES, type ColumnSpec, type TableSpec } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withInterProcessLock } from './inter-process-lock.js';
import { MIGRATIONS, STORE_APPLICATION_ID } from './sqlite-schema.js';
import { SqliteStore } from './sqlite-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-ret2-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const path = (): string => join(dir, 'store.sqlite');

/** A valid value of `spec` for row `i` (distinct per row, so keys and unique columns differ). */
function valueOf(table: string, column: string, spec: ColumnSpec, i: number): string | number {
  switch (spec.kind) {
    case 'id':
      return `${table}-${column}-${String(i)}`;
    case 'text':
      return `text-${String(i)}`;
    case 'int':
      return 1_700_000_000 + i;
    case 'flag':
      return i % 2;
    case 'usd':
      return `${String(i + 1)}.5`;
    case 'json':
      return `{"i":${String(i)}}`;
    case 'enc':
      return `sealed-${table}-${column}-${String(i)}`;
    case 'enum':
      return (spec.values ?? [])[i % (spec.values?.length ?? 1)] as string;
  }
}

/** Builds a version 14 file the way 0.5.0 to 0.5.2 left it, with rows in every table. */
function v14Fixture(): Map<string, unknown[]> {
  const raw = new Database(path());
  raw.pragma('journal_mode = WAL');
  for (const m of MIGRATIONS.slice(0, 14)) {
    for (const statement of m.statements) raw.prepare(statement).run();
  }
  raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
  raw.pragma('user_version = 14');
  const tables = raw
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .pluck()
    .all() as string[];
  const before = new Map<string, unknown[]>();
  for (const table of tables) {
    const spec = (TABLES as Readonly<Record<string, TableSpec>>)[table] as TableSpec;
    const columns = (raw.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (let i = 0; i < 3; i += 1) {
      const values = columns.map((c) => {
        const col = spec.columns[c] as ColumnSpec;
        // A nullable column is null in the first row and set in the others.
        return col.nullable && i === 0 ? null : valueOf(table, c, col, i);
      });
      try {
        raw
          .prepare(
            `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) ` +
              `VALUES (${columns.map(() => '?').join(', ')})`,
          )
          .run(...values);
      } catch {
        // A single-row table, or an enum key with one value: fewer rows.
      }
    }
    before.set(table, raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());
  }
  raw.close();
  return before;
}

const pragma = (name: string): number => {
  const raw = new Database(path(), { readonly: true });
  try {
    return Number(raw.pragma(name, { simple: true }));
  } finally {
    raw.close();
  }
};

describe('schema version 15 (RET-2)', () => {
  it('is the code schema version, with one migration appended', () => {
    expect(STORE_SCHEMA_VERSION).toBe(15);
    expect(MIGRATIONS.at(-1)?.version).toBe(15);
    const v15 = MIGRATIONS[14]?.statements ?? [];
    expect(v15[0]).toMatch(/^ALTER TABLE "envelopes" ADD COLUMN "deleted_at" INTEGER /);
    expect(v15.filter((s) => s.startsWith('CREATE TABLE')).map((s) => s.split('"')[1])).toEqual([
      'saved_files',
    ]);
  });

  it('migrates a 0.5.0/0.5.2-shaped version 14 file to version 15 losslessly', async () => {
    const before = v14Fixture();
    expect(before.get('envelopes')).toHaveLength(3);
    expect(before.get('files')).toHaveLength(3);

    const store = await SqliteStore.open(path());
    expect(store.schemaVersion).toBe(15);
    await store.close();

    const raw = new Database(path(), { readonly: true });
    try {
      for (const [table, rows] of before) {
        const columns = Object.keys((rows[0] ?? {}) as object);
        if (columns.length === 0) continue;
        const after = raw
          .prepare(
            `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${table}" ORDER BY rowid`,
          )
          .all();
        expect(after, table).toEqual(rows);
      }
      expect(
        raw
          .prepare('SELECT count(*) FROM "envelopes" WHERE "deleted_at" IS NOT NULL')
          .pluck()
          .get(),
      ).toBe(0);
      expect(raw.prepare('SELECT count(*) FROM "saved_files"').pluck().get()).toBe(0);
    } finally {
      raw.close();
    }

    // Reopening changes nothing.
    const again = await SqliteStore.open(path());
    expect(again.schemaVersion).toBe(15);
    expect(await again.transaction((tx) => tx.count('envelopes'))).toBe(3);
    await again.close();
  });

  it('reads migrated rows through the store, with deleted_at null', async () => {
    v14Fixture();
    const store = await SqliteStore.open(path());
    const rows = await store.transaction((tx) => tx.select('envelopes'));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.deleted_at === null)).toBe(true);
    await store.close();
  });

  it('enforces the saved_files keys and types in SQLite', async () => {
    const store = await SqliteStore.open(path());
    const row = {
      envelope_id: 'e1',
      idx: 0,
      contact_id: 'c1',
      saved_name: 'sealed-name',
      size: 10,
      sha256: 'a'.repeat(64),
      dev: 'sealed-dev',
      ino: 'sealed-ino',
      saved_at: 5,
      trashed_at: null,
    } as never;
    await store.transaction((tx) => tx.insert('saved_files', row));
    await expect(store.transaction((tx) => tx.insert('saved_files', row))).rejects.toThrow();
    await expect(
      store.transaction((tx) =>
        tx.insert('saved_files', { ...(row as object), idx: 1, size: -1 } as never),
      ),
    ).rejects.toThrow();
    await store.close();
  });
});

describe('auto_vacuum=INCREMENTAL (RET-2, 04 §4.2 "Space on disk")', () => {
  it('a new store is incremental from the start', async () => {
    const store = await SqliteStore.open(path());
    await store.close();
    expect(pragma('auto_vacuum')).toBe(2);
  });

  it('an existing store is switched once, with a VACUUM, when there is room', async () => {
    v14Fixture();
    expect(pragma('auto_vacuum')).toBe(0);
    const store = await SqliteStore.open(path());
    await store.close();
    expect(pragma('auto_vacuum')).toBe(2);
  });

  it('is skipped while the disk has less than twice the store size free, and tried again later', async () => {
    v14Fixture();
    const tight = await SqliteStore.open(path(), { freeBytes: () => Promise.resolve(1024) });
    expect(tight.schemaVersion).toBe(15);
    await tight.close();
    expect(pragma('auto_vacuum')).toBe(0);
    const roomy = await SqliteStore.open(path(), {
      freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    });
    await roomy.close();
    expect(pragma('auto_vacuum')).toBe(2);
  });

  it('a free space that cannot be read skips it (fail safe)', async () => {
    v14Fixture();
    const store = await SqliteStore.open(path(), {
      freeBytes: () => Promise.reject(new Error('no statfs')),
    });
    expect(store.schemaVersion).toBe(15);
    await store.close();
    expect(pragma('auto_vacuum')).toBe(0);
  });

  it('runs only under the ID lock: while another process holds it, the switch is skipped', async () => {
    v14Fixture();
    await withInterProcessLock(`${path()}.lock`, async () => {
      const store = await SqliteStore.open(path(), { vacuumLockTimeoutMs: 50 });
      expect(store.schemaVersion).toBe(15);
      await store.close();
    });
    expect(pragma('auto_vacuum')).toBe(0);
  });

  it('compact() returns freed pages to the file system after a large delete', async () => {
    const store = await SqliteStore.open(path());
    await store.transaction((tx) => {
      for (let i = 0; i < 400; i += 1) {
        tx.insert('seen', {
          kind: 'envelope',
          id: `x${String(i)}${'y'.repeat(2000)}`,
          first_seen_at: i,
        });
      }
    });
    await store.transaction((tx) => tx.delete('seen', {}));
    const raw = (): number => {
      const db = new Database(path(), { readonly: true });
      try {
        return Number(db.pragma('freelist_count', { simple: true }));
      } finally {
        db.close();
      }
    };
    await store.compact();
    await store.close();
    expect(raw()).toBe(0);
  });
});
