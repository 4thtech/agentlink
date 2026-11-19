// Guards the cost of building old-version store files in the migration tests. Each autocommit
// statement is its own transaction: on Windows runners (rollback journal created, synced and deleted
// per statement, scanned by antivirus) about 80 of them took 25 to 40 s, past the test timeout.
// The replay is one transaction, and every test builds its old file through replayMigrations.
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayMigrations } from './old-store.fixture.js';
import { MIGRATIONS } from './sqlite-schema.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-old-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** SQLite's file change counter (header offset 24): one per committed write transaction. */
const changeCounter = (file: string): number => readFileSync(file).readUInt32BE(24);

describe('replayMigrations (old-version store files for the migration tests)', () => {
  it('builds every version in one transaction', () => {
    const file = join(dir, 'old.sqlite');
    const raw = new Database(file);
    replayMigrations(raw, MIGRATIONS.length);
    raw.close();
    expect(changeCounter(file)).toBe(1);
    const check = new Database(file, { readonly: true });
    const tables = check
      .prepare("SELECT count(*) FROM sqlite_schema WHERE type = 'table'")
      .pluck()
      .get();
    check.close();
    expect(Number(tables)).toBeGreaterThan(0);
  });

  it('is the only place a test replays migration statements', () => {
    const replays = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.test.ts'))
      .filter((f) =>
        /\.statements\b[^\n]*\)\s*\w+\.prepare\(/.test(
          readFileSync(join(import.meta.dirname, f), 'utf8'),
        ),
      );
    expect(replays).toEqual([]);
  });
});
