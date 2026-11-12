// REL051-B2 (IR-REL051-B2-1; 04 §3.6): a recovery kit never carries an open invite's kept link.
// The store snapshot drops `invites.invite_link` before it is sealed, and the sealed value is not
// left on a free page of the snapshot file either; a store from before schema 14 is left as it is.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripInviteLinks } from './recovery-kit-export.js';
import { MIGRATIONS } from './sqlite-schema.js';
import { SqliteStore } from './sqlite-store.js';

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-kit-strip-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEPT = `sealed-link-${'Z'.repeat(64)}`;

describe('the kit snapshot drops kept invite links (REL051-B2)', () => {
  it('clears every invite_link and leaves no trace of it in the file; other columns stay', async () => {
    const file = join(dir, 'snapshot.sqlite');
    const store = await SqliteStore.open(file);
    await store.close();
    const raw = new Database(file);
    raw
      .prepare(
        'INSERT INTO "invites" ("invite_id", "proof_key", "expires_at", "created_at", "invite_link") ' +
          'VALUES (?, ?, 9999999999, 1, ?)',
      )
      .run('AAAAAAAAAAAAAAAAAAAAAA', 'proof', KEPT);
    raw.close();
    expect(readFileSync(file).includes(Buffer.from(KEPT))).toBe(true);

    stripInviteLinks(file);

    const after = new Database(file, { readonly: true });
    const rows = after.prepare('SELECT * FROM "invites"').all() as Record<string, unknown>[];
    after.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['invite_link']).toBeNull();
    expect(rows[0]?.['proof_key']).toBe('proof');
    expect(readFileSync(file).includes(Buffer.from(KEPT))).toBe(false);
  });

  it('leaves a store from before schema 14 (no column) unchanged', () => {
    const file = join(dir, 'old.sqlite');
    const raw = new Database(file);
    for (const m of MIGRATIONS.slice(0, 13)) {
      for (const statement of m.statements) raw.prepare(statement).run();
    }
    raw.close();
    expect(() => stripInviteLinks(file)).not.toThrow();
  });
});
