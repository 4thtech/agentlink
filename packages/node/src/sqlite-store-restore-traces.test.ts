// RESTORE-TRACES (D-156; 07 §3.5): the schema version after 19 that adds `budget_restores` (the
// restore entries of the spending history: a time and a reason, never an amount) and
// `restore_replays` (inbound received again after a restore). Two new tables, empty after the
// migration; nothing existing is rewritten. Named by content, not by number: another 0.5.13 lane may
// also add a version, so the number is whatever follows 19 when the lanes merge.
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
  dir = await mkdtemp(join(tmpdir(), 'agentlink-restore-traces-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const path = (): string => join(dir, 'store.sqlite');
const WRAP = 'ab'.repeat(32);
const ENVELOPE = 'AAAAAAAAAAAAAAAAAAAAAA';

const tracesIndex = (): number =>
  MIGRATIONS.findIndex((m) =>
    m.statements.some((s) => s.startsWith('CREATE TABLE "budget_restores"')),
  );

describe('schema: restore traces (after version 19)', () => {
  it('one migration after 19 creates budget_restores and restore_replays, nothing else', () => {
    const at = tracesIndex();
    expect(at).toBeGreaterThanOrEqual(19);
    expect(MIGRATIONS[at]?.version).toBeGreaterThan(19);
    const statements = MIGRATIONS[at]?.statements ?? [];
    expect(
      statements.filter((s) => s.startsWith('CREATE TABLE')).map((s) => s.split('"')[1]),
    ).toEqual(['budget_restores', 'restore_replays']);
    expect(statements.every((s) => !s.startsWith('ALTER TABLE'))).toBe(true);
    // No amount column: an entry can never read as a charge.
    expect(statements.join('\n')).not.toMatch(/usd/i);
  });

  it('migrates a version 19 file: rows kept, the new tables empty and enforced', async () => {
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 19)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 19');
    raw
      .prepare(
        'INSERT INTO "outbox" ("wrap_id", "envelope_id", "recipient_key", "relays", "acks", ' +
          '"attempt", "role", "attempts", "next_attempt_at", "created_at", "give_up_at", "state") ' +
          "VALUES (?, ?, ?, 'r', 'a', 1, 'contact', 1, 1, 1, 2, 'sent')",
      )
      .run(WRAP, ENVELOPE, 'cd'.repeat(32));
    raw.close();
    const store = await SqliteStore.open(path());
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect((await store.transaction((tx) => tx.select('outbox')))[0]?.wrap_id).toBe(WRAP);
    expect(await store.transaction((tx) => tx.select('budget_restores'))).toEqual([]);
    expect(await store.transaction((tx) => tx.select('restore_replays'))).toEqual([]);
    await store.transaction((tx) => {
      tx.insert('budget_restores', { restored_at: 10, reason: 'restore', noted_at: 11 });
      tx.insert('restore_replays', { envelope_id: ENVELOPE, restored_at: 10 });
    });
    await store.close();
    const check = new Database(path());
    const insert = (values: string) => () =>
      check
        .prepare(`INSERT INTO "budget_restores" ("restored_at", "reason", "noted_at") ${values}`)
        .run();
    expect(insert(`VALUES (12, 'charge', 1)`)).toThrow();
    expect(insert(`VALUES (10, 'update', 1)`)).toThrow();
    check.close();
  });
});
