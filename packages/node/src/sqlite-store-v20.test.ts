// DEVICES-INTERIM: schema version 20 (after version 19, SEC-RELAY-READBACK).
// - `budget_ledger.install_id` (nullable), appended: every row stored before keeps null.
// - `install_state`, a new one-row table: this computer's install id, since when this store is
//   this install's, and when a copy from another computer using this ID was last seen.
// - Versions 1 to 19 keep their statements (version 1 is frozen without the column).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { STORE_SCHEMA_VERSION } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, STORE_APPLICATION_ID } from './sqlite-schema.js';
import { SqliteStore } from './sqlite-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-v20-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const path = (): string => join(dir, 'store.sqlite');
const INSTALL = 'a1'.repeat(16);

describe('schema version 20 (DEVICES-INTERIM)', () => {
  it('appends budget_ledger.install_id and creates install_state', () => {
    expect(STORE_SCHEMA_VERSION).toBe(20);
    expect(MIGRATIONS[19]?.version).toBe(20);
    const v20 = MIGRATIONS[19]?.statements ?? [];
    expect(v20[0]).toMatch(/^ALTER TABLE "budget_ledger" ADD COLUMN "install_id" TEXT /);
    expect(v20.filter((s) => s.startsWith('CREATE TABLE')).map((s) => s.split('"')[1])).toEqual([
      'install_state',
    ]);
    // Version 1 stays frozen without the column.
    expect(MIGRATIONS[0]?.statements.join('\n')).not.toContain('"install_id"');
  });

  it('migrates a version 19 file: ledger rows kept with install_id null, install_state usable', async () => {
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 19)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 19');
    raw
      .prepare(
        'INSERT INTO "budget_ledger" ("entry_id", "ledger_epoch", "t", "record_id", "chain_id", ' +
          '"reserved_usd", "state", "deadline") VALUES (?, 1, 1, ?, 8453, ?, ?, 2)',
      )
      .run('e1', `0x${'1'.padStart(64, '0')}`, '0.1', 'reserved');
    raw.close();
    const store = await SqliteStore.open(path());
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    const [row] = await store.transaction((tx) => tx.select('budget_ledger'));
    expect(row?.entry_id).toBe('e1');
    expect(row?.install_id).toBeNull();
    await store.transaction((tx) =>
      tx.insert('install_state', {
        slot: 'current',
        install_id: INSTALL,
        since: 1,
        other_seen_at: null,
      }),
    );
    await expect(
      store.transaction((tx) =>
        tx.insert('install_state', {
          slot: 'current',
          install_id: INSTALL,
          since: 2,
          other_seen_at: null,
        }),
      ),
    ).rejects.toThrow();
    await store.close();
  });
});
