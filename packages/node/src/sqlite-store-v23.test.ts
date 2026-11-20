// NET-STATS: schema version 23 (after version 22, DEVICES-INTERIM; named by content, so it takes the
// next free number if another lane lands a version first).
// - `relay_stats`, a new table: per-server counters for the Message network view (07 §3.2). No
//   existing row changes; versions 1 to 22 keep their statements.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { STORE_SCHEMA_VERSION } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayMigrations } from './old-store.fixture.js';
import { MIGRATIONS, STORE_APPLICATION_ID } from './sqlite-schema.js';
import { SqliteStore } from './sqlite-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-v23-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const path = (): string => join(dir, 'store.sqlite');

describe('schema version 23 (NET-STATS)', () => {
  it('creates relay_stats only', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(23);
    expect(MIGRATIONS[22]?.version).toBe(23);
    const v23 = MIGRATIONS[22]?.statements ?? [];
    expect(v23.filter((s) => s.startsWith('CREATE TABLE')).map((s) => s.split('"')[1])).toEqual([
      'relay_stats',
    ]);
    expect(v23.every((s) => !s.startsWith('ALTER TABLE'))).toBe(true);
    expect(MIGRATIONS[0]?.statements.join('\n')).not.toContain('"relay_stats"');
  });

  it('migrates a version 22 file: rows kept, relay_stats empty and usable', async () => {
    const raw = new Database(path());
    replayMigrations(raw, 22);
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 22');
    raw
      .prepare(
        'INSERT INTO "install_state" ("slot", "install_id", "since", "other_seen_at") ' +
          "VALUES ('current', ?, 1, NULL)",
      )
      .run('a1'.repeat(16));
    raw.close();
    const store = await SqliteStore.open(path());
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(await store.transaction((tx) => tx.select('install_state'))).toHaveLength(1);
    expect(await store.transaction((tx) => tx.select('relay_stats'))).toEqual([]);
    await store.transaction((tx) =>
      tx.insert('relay_stats', {
        origin: 'wss://relay.example.org',
        since: 1,
        published_ok: 1,
        published_failed: 0,
        received: 0,
        last_ok_at: 1,
        last_error: null,
        last_error_at: null,
      }),
    );
    await expect(
      store.transaction((tx) =>
        tx.insert('relay_stats', {
          origin: 'wss://relay.example.org',
          since: 2,
          published_ok: 0,
          published_failed: 0,
          received: 0,
          last_ok_at: null,
          last_error: 'free text from a relay',
          last_error_at: null,
        } as never),
      ),
    ).rejects.toThrow();
    await store.close();
  });
});
