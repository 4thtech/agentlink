// M1-7j (D-158 (5), (7); 07 §3): schema version 24 (after version 23, NET-STATS), in the
// single-transaction runner (STORE-CREATE-ONE-TX).
// - `identity.prev_relays` (`enc` `json`, null when empty) and `identity.announce_default` (a flag,
//   null read as the default, true), appended: the row stored before keeps null in both.
// - Versions 1 to 23 keep their statements (version 1 is frozen without the columns).
// - A recovery kit's store snapshot (recovery-kit-export.ts) keeps both columns, so a restore keeps
//   the leaving servers and the announce choice (04 §2.3.3).
import { copyFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { STORE_SCHEMA_VERSION } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayMigrations } from './old-store.fixture.js';
import { stripInviteLinks } from './recovery-kit-export.js';
import { MIGRATIONS, STORE_APPLICATION_ID } from './sqlite-schema.js';
import { SqliteStore } from './sqlite-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-v24-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const path = (): string => join(dir, 'store.sqlite');
const AGENT = `0x${'ab'.repeat(20)}`;

function insertIdentity(raw: Database.Database): void {
  raw
    .prepare(
      'INSERT INTO "identity" ("agent_id", "agent_card_json", "pending_card_json", "name", ' +
        '"relays", "key_epoch", "storage_prefix", "revoked_at", "created_at", "updated_at") ' +
        "VALUES (?, 'card', NULL, 'name', 'relays', 1, ?, NULL, 1, 1)",
    )
    .run(AGENT, 'cd'.repeat(16));
}

describe('schema version 24 (M1-7j)', () => {
  it('appends identity.prev_relays and identity.announce_default only', () => {
    expect(STORE_SCHEMA_VERSION).toBe(24);
    expect(MIGRATIONS[23]?.version).toBe(24);
    const v24 = MIGRATIONS[23]?.statements ?? [];
    expect(v24).toHaveLength(2);
    expect(v24[0]).toMatch(/^ALTER TABLE "identity" ADD COLUMN "prev_relays" TEXT /);
    expect(v24[1]).toMatch(/^ALTER TABLE "identity" ADD COLUMN "announce_default" INTEGER /);
    expect(MIGRATIONS[0]?.statements.join('\n')).not.toContain('"prev_relays"');
    expect(MIGRATIONS[0]?.statements.join('\n')).not.toContain('"announce_default"');
  });

  it('migrates a version 23 file: the identity row is kept with both columns null', async () => {
    const raw = new Database(path());
    replayMigrations(raw, 23);
    raw.pragma(`application_id = ${STORE_APPLICATION_ID}`);
    raw.pragma('user_version = 23');
    insertIdentity(raw);
    raw.close();
    const store = await SqliteStore.open(path());
    expect(store.schemaVersion).toBe(24);
    const [row] = await store.transaction((tx) => tx.select('identity'));
    expect(row?.agent_id).toBe(AGENT);
    expect(row?.prev_relays).toBeNull();
    expect(row?.announce_default).toBeNull();
    // A flag holds 0 or 1 only.
    await expect(
      store.transaction((tx) =>
        tx.update('identity', { agent_id: AGENT }, { announce_default: 2 as never }),
      ),
    ).rejects.toThrow();
    await store.close();
  });

  it('the kit snapshot keeps both columns, so a restore keeps them', async () => {
    const store = await SqliteStore.open(path());
    await store.close();
    const raw = new Database(path());
    insertIdentity(raw);
    raw
      .prepare('UPDATE "identity" SET "prev_relays" = ?, "announce_default" = 0')
      .run('sealed-prev');
    raw.close();
    const snapshot = join(dir, 'snapshot.sqlite');
    copyFileSync(path(), snapshot);
    stripInviteLinks(snapshot);
    const restored = await SqliteStore.open(snapshot);
    const [row] = await restored.transaction((tx) => tx.select('identity'));
    expect(row?.prev_relays).toBe('sealed-prev');
    expect(row?.announce_default).toBe(0);
    await restored.close();
  });
});
