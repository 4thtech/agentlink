// STORE-CREATE-ONE-TX (07 §3.7): opening a store brings it to the current schema version in one
// write transaction, a new file and an older file alike.
// - A new file gets the whole schema in one commit (one per migration step before: 23 commits, each
//   a synced write, about 12 s on a Windows runner).
// - An older file is upgraded in one commit too, and a failing step rolls the whole upgrade back:
//   the file stays at its old version, never at a version in between.
// - The schema, pragmas and version are the same as the step-by-step migration gave.
// Commits are counted from the write-ahead log (the store runs in WAL mode): one commit frame per
// committed write transaction, read while the store is still open.
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { STORE_SCHEMA_VERSION } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayMigrations } from './old-store.fixture.js';
import { MIGRATIONS, STORE_APPLICATION_ID, type StoreMigration } from './sqlite-schema.js';
import { SqliteStore } from './sqlite-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-one-tx-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const path = (): string => join(dir, 'store.sqlite');
const noRoom = (): Promise<number> => Promise.resolve(0);

/**
 * The committed write transactions in the write-ahead log of `file`: frames of the log's current
 * generation (salts as in its header) whose "database size after commit" field is set.
 */
function walCommits(file: string): number {
  const wal = `${file}-wal`;
  if (!existsSync(wal)) return 0;
  const bytes = readFileSync(wal);
  if (bytes.length < 32) return 0;
  const pageSize = bytes.readUInt32BE(8);
  const salt1 = bytes.readUInt32BE(16);
  const salt2 = bytes.readUInt32BE(20);
  let commits = 0;
  for (let at = 32; at + 24 + pageSize <= bytes.length; at += 24 + pageSize) {
    if (bytes.readUInt32BE(at + 8) !== salt1 || bytes.readUInt32BE(at + 12) !== salt2) break;
    if (bytes.readUInt32BE(at + 4) !== 0) commits += 1;
  }
  return commits;
}

/** The schema objects of `file` and the pragmas the store sets, for comparing two files. */
function shape(file: string): unknown {
  const raw = new Database(file, { readonly: true });
  try {
    return {
      objects: raw
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all(),
      userVersion: raw.pragma('user_version', { simple: true }),
      applicationId: raw.pragma('application_id', { simple: true }),
      autoVacuum: raw.pragma('auto_vacuum', { simple: true }),
      journalMode: raw.pragma('journal_mode', { simple: true }),
    };
  } finally {
    raw.close();
  }
}

/** A version `version` file, as an earlier release left it (rollback journal, no auto_vacuum). */
function oldFile(file: string, version: number): void {
  const raw = new Database(file);
  replayMigrations(raw, version);
  raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
  raw.pragma(`user_version = ${String(version)}`);
  raw.close();
}

describe('STORE-CREATE-ONE-TX: one write transaction per open', () => {
  it('creates a new store in one commit', async () => {
    const store = await SqliteStore.open(path());
    try {
      expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
      expect(walCommits(path())).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('upgrades a version 14 store in one commit', async () => {
    oldFile(path(), 14);
    // No room for the one-time auto_vacuum switch: it would be a commit of its own after the upgrade.
    const store = await SqliteStore.open(path(), { freeBytes: noRoom });
    try {
      expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
      expect(walCommits(path())).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('writes nothing when the store is already current', async () => {
    await (await SqliteStore.open(path())).close();
    const store = await SqliteStore.open(path());
    try {
      expect(walCommits(path())).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('a new store has the schema, pragmas and version of the step-by-step migration', async () => {
    await (await SqliteStore.open(path())).close();
    const reference = join(dir, 'reference.sqlite');
    const raw = new Database(reference);
    raw.pragma('auto_vacuum = 2');
    raw.pragma('journal_mode = WAL');
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    replayMigrations(raw, MIGRATIONS.length);
    raw.pragma(`user_version = ${String(STORE_SCHEMA_VERSION)}`);
    raw.close();
    expect(shape(path())).toEqual(shape(reference));
  });

  it('an upgraded version 14 store has the schema of a new store', async () => {
    oldFile(path(), 14);
    await (await SqliteStore.open(path(), { freeBytes: noRoom })).close();
    const fresh = join(dir, 'fresh.sqlite');
    await (await SqliteStore.open(fresh)).close();
    const upgraded = shape(path()) as { autoVacuum: unknown };
    const created = shape(fresh) as { autoVacuum: unknown };
    // auto_vacuum differs only because the switch was skipped (no room); RET-2 covers it.
    expect({ ...upgraded, autoVacuum: 2 }).toEqual(created);
  });

  it('a failing step rolls the whole upgrade back to the old version', async () => {
    oldFile(path(), 14);
    const before = shape(path());
    const broken: StoreMigration[] = MIGRATIONS.map((m) =>
      m.version === 17 ? { version: 17, statements: [...m.statements, 'NOT SQL'] } : m,
    );
    await expect(
      SqliteStore.open(path(), { migrations: broken, freeBytes: noRoom }),
    ).rejects.toMatchObject({ code: 'store_failed' });
    const after = shape(path()) as { userVersion: unknown; journalMode: unknown };
    expect(after.userVersion).toBe(14);
    // Opening switched the file to WAL mode (not a schema change); nothing else moved.
    expect({ ...after, journalMode: (before as { journalMode: unknown }).journalMode }).toEqual(
      before,
    );
    // The intact old file then upgrades normally.
    const store = await SqliteStore.open(path(), { freeBytes: noRoom });
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    await store.close();
  });
});
