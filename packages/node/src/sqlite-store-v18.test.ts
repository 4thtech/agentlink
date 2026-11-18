// SEC-INVITE-CAPS (D-156; 07 §3): schema version 18 (after version 17, SEC-OUTBOUND-CAPS `outgoing_log`).
// - `invites.created_by` (`owner` | `ai`, nullable) and `contacts.waiting_owner` (flag, nullable),
//   appended. Nothing is rewritten: every invite made before reads as the owner's (null) and every
//   contact paired before is kept (null), so existing contacts are not affected.
// - Versions 1 to 16 keep their statements (version 1 is frozen without the two columns).
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
  dir = await mkdtemp(join(tmpdir(), 'agentlink-v18-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const path = (): string => join(dir, 'store.sqlite');
const CONTACT = '0x' + 'c1'.repeat(20);

describe('schema version 18 (SEC-INVITE-CAPS)', () => {
  it('appends invites.created_by, contacts.waiting_owner and ai_accepted_at, pairings.created_by', () => {
    expect(STORE_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
    const v18 = MIGRATIONS[17]?.statements ?? [];
    expect(MIGRATIONS[16]?.version).toBe(17);
    expect(MIGRATIONS[17]?.version).toBe(18);
    expect(v18).toHaveLength(4);
    expect(v18[0]).toMatch(/^ALTER TABLE "invites" ADD COLUMN "created_by" TEXT /);
    expect(v18[0]).toContain(`"created_by" IS NULL OR`);
    expect(v18[1]).toMatch(/^ALTER TABLE "contacts" ADD COLUMN "waiting_owner" INTEGER /);
    expect(v18[1]).toContain(`"waiting_owner" IS NULL OR`);
    expect(v18[2]).toMatch(/^ALTER TABLE "contacts" ADD COLUMN "ai_accepted_at" INTEGER /);
    expect(v18[3]).toMatch(/^ALTER TABLE "pairings" ADD COLUMN "created_by" TEXT /);
  });

  it('migrates a version 16 file through 17 (outgoing_log) to 18: invites read as the owner’s, contacts stay kept', async () => {
    const raw = new Database(path());
    for (const m of MIGRATIONS.slice(0, 16)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 16');
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
          "VALUES (?, 'n', 'counterparty', 'c', 'r', ?, 0, '[]', 'f', 0, 'active', 'complete', 0, 1, 1)",
      )
      .run(CONTACT, 'ab'.repeat(32));
    raw.close();
    const store = await SqliteStore.open(path());
    expect(store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    // Version 17 (SEC-OUTBOUND-CAPS) ran first: its table is there, empty.
    expect(await store.transaction((tx) => tx.select('outgoing_log'))).toEqual([]);
    const [invite] = await store.transaction((tx) => tx.select('invites'));
    expect(invite?.created_by).toBeNull();
    const [contact] = await store.transaction((tx) => tx.select('contacts'));
    expect(contact?.contact_id).toBe(CONTACT);
    expect(contact?.waiting_owner).toBeNull();
    expect(contact?.status).toBe('active');
    // The new values are enforced by SQLite itself.
    await expect(
      store.transaction((tx) =>
        tx.update('invites', { invite_id: 'AAAAAAAAAAAAAAAAAAAAAA' }, { created_by: 'ai' }),
      ),
    ).resolves.toBe(1);
    await store.close();
    const check = new Database(path());
    expect(() => check.prepare(`UPDATE "invites" SET "created_by" = 'someone'`).run()).toThrow();
    expect(() => check.prepare(`UPDATE "contacts" SET "waiting_owner" = 2`).run()).toThrow();
    check.close();
  });
});
