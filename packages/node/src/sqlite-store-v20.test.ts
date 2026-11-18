// DELIVERY-DETAILS: schema version 20 (after version 19, SEC-RELAY-READBACK).
// - `relays_accepted` and `relays_available` (nullable integers: counts only, never a relay
//   address) appended to `envelopes` and `outbox`. Nothing is rewritten: every row stored before
//   keeps null, which shows no counts.
// - Versions 1 to 19 keep their statements.
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
const WRAP = 'ab'.repeat(32);
const ENVELOPE = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('schema version 20 (DELIVERY-DETAILS)', () => {
  it('appends the two count columns to envelopes and outbox', () => {
    expect(STORE_SCHEMA_VERSION).toBe(20);
    const v20 = MIGRATIONS[19]?.statements ?? [];
    expect(MIGRATIONS[18]?.version).toBe(19);
    expect(MIGRATIONS[19]?.version).toBe(20);
    expect(v20).toHaveLength(4);
    expect(v20[0]).toMatch(/^ALTER TABLE "envelopes" ADD COLUMN "relays_accepted" INTEGER /);
    expect(v20[1]).toMatch(/^ALTER TABLE "envelopes" ADD COLUMN "relays_available" INTEGER /);
    expect(v20[2]).toMatch(/^ALTER TABLE "outbox" ADD COLUMN "relays_accepted" INTEGER /);
    expect(v20[3]).toMatch(/^ALTER TABLE "outbox" ADD COLUMN "relays_available" INTEGER /);
  });

  it('migrates a version 19 file: rows kept, counts null, whole numbers enforced', async () => {
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 19)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 19');
    raw
      .prepare(
        'INSERT INTO "outbox" ("wrap_id", "envelope_id", "recipient_key", "relays", "acks", ' +
          '"attempt", "role", "attempts", "next_attempt_at", "created_at", "give_up_at", "state", ' +
          "\"availability\") VALUES (?, ?, ?, 'r', 'a', 1, 'contact', 1, 1, 1, 2, 'sent', 'confirmed')",
      )
      .run(WRAP, ENVELOPE, 'cd'.repeat(32));
    raw.close();
    const store = await SqliteStore.open(path());
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    const [row] = await store.transaction((tx) => tx.select('outbox'));
    expect(row?.wrap_id).toBe(WRAP);
    expect(row?.availability).toBe('confirmed');
    expect(row?.relays_accepted).toBeNull();
    expect(row?.relays_available).toBeNull();
    await expect(
      store.transaction((tx) =>
        tx.update('outbox', { wrap_id: WRAP }, { relays_accepted: 3, relays_available: 2 }),
      ),
    ).resolves.toBe(1);
    const [after] = await store.transaction((tx) => tx.select('outbox'));
    expect(after).toMatchObject({ relays_accepted: 3, relays_available: 2 });
    await store.close();
    const check = new Database(path());
    expect(() => check.prepare(`UPDATE "outbox" SET "relays_accepted" = 'many'`).run()).toThrow();
    expect(() => check.prepare(`UPDATE "outbox" SET "relays_available" = -1`).run()).toThrow();
    check.close();
  });
});
