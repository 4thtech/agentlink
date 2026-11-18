// SEC-RELAY-READBACK (D-156 (7); 07 §3.2): schema version 19 (after version 18, SEC-INVITE-CAPS).
// - `outbox.availability` and `envelopes.availability` (`confirmed` | `unknown`, nullable),
//   appended. Nothing is rewritten: every row stored before keeps null, which reads as it did.
// - Versions 1 to 18 keep their statements (version 1 is frozen without the two columns).
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
  dir = await mkdtemp(join(tmpdir(), 'agentlink-v19-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const path = (): string => join(dir, 'store.sqlite');
const WRAP = 'ab'.repeat(32);
const ENVELOPE = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('schema version 19 (SEC-RELAY-READBACK)', () => {
  it('appends outbox.availability and envelopes.availability', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
    const v19 = MIGRATIONS[18]?.statements ?? [];
    expect(MIGRATIONS[17]?.version).toBe(18);
    expect(MIGRATIONS[18]?.version).toBe(19);
    expect(v19).toHaveLength(2);
    expect(v19[0]).toMatch(/^ALTER TABLE "envelopes" ADD COLUMN "availability" TEXT /);
    expect(v19[1]).toMatch(/^ALTER TABLE "outbox" ADD COLUMN "availability" TEXT /);
    for (const s of v19) expect(s).toContain(`"availability" IS NULL OR`);
  });

  it('migrates a version 18 file: rows kept, availability null, new values enforced', async () => {
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 18)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 18');
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
    const [row] = await store.transaction((tx) => tx.select('outbox'));
    expect(row?.wrap_id).toBe(WRAP);
    expect(row?.availability).toBeNull();
    await expect(
      store.transaction((tx) =>
        tx.update('outbox', { wrap_id: WRAP }, { availability: 'unknown' }),
      ),
    ).resolves.toBe(1);
    await store.close();
    const check = new Database(path());
    expect(() => check.prepare(`UPDATE "outbox" SET "availability" = 'maybe'`).run()).toThrow();
    check.close();
  });
});
