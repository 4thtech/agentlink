// REL051-RET1: the read-only storage look (storage-usage.ts). Sizes match a fixture, nothing is
// written, a missing or damaged store answers undefined.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_INBOX_ENTRIES, peekStorageUsage, scanInbox } from './storage-usage.js';

let dir: string;
let store: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-ret1-')));
  store = join(dir, 'store.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(withSavedName = true): void {
  const db = new Database(store);
  db.exec(
    'CREATE TABLE envelopes (envelope_id TEXT PRIMARY KEY, contact_id TEXT, ' +
      'envelope_json TEXT, payload_json BLOB)',
  );
  db.exec(
    withSavedName
      ? 'CREATE TABLE files (envelope_id TEXT, idx INTEGER, size INTEGER, saved_name BLOB)'
      : 'CREATE TABLE files (envelope_id TEXT, idx INTEGER, size INTEGER)',
  );
  const env = db.prepare('INSERT INTO envelopes VALUES (?, ?, ?, ?)');
  env.run('e1', 'ca', 'x'.repeat(100), Buffer.alloc(50));
  env.run('e2', 'ca', 'y'.repeat(10), null);
  env.run('e3', 'cb', 'z'.repeat(7), Buffer.alloc(3));
  env.run('e4', null, 'w'.repeat(5), null);
  if (withSavedName) {
    const file = db.prepare('INSERT INTO files VALUES (?, ?, ?, ?)');
    file.run('e1', 0, 1000, Buffer.from('n'));
    file.run('e2', 0, 500, Buffer.from('n'));
    file.run('e3', 0, 9999, null); // not saved: not counted
  }
  db.close();
}

describe('peekStorageUsage', () => {
  it('sums stored bytes per person and the saved files still indexed', async () => {
    seed();
    const usage = await peekStorageUsage(store);
    expect(usage).toBeDefined();
    const by = new Map(usage?.perContact.map((p) => [p.contactId, p]));
    expect(by.get('ca')).toMatchObject({ messageBytes: 160, fileCount: 2, fileBytes: 1500 });
    expect(by.get('cb')).toMatchObject({ messageBytes: 10, fileCount: 0, fileBytes: 0 });
    expect(by.get(null)).toMatchObject({ messageBytes: 5 });
    expect(usage).toMatchObject({ messageBytes: 175, fileCount: 2, fileBytes: 1500 });
    expect(usage?.storeBytes).toBe(statSync(store).size);
    expect(usage?.walBytes).toBe(0);
  });

  it('reads a store from before saved names as no saved files', async () => {
    seed(false);
    const usage = await peekStorageUsage(store);
    expect(usage).toMatchObject({ messageBytes: 175, fileCount: 0, fileBytes: 0 });
  });

  it('answers undefined for a missing or damaged store and never throws', async () => {
    expect(await peekStorageUsage(join(dir, 'none.sqlite'))).toBeUndefined();
    writeFileSync(store, 'not a database at all, just text');
    expect(await peekStorageUsage(store)).toBeUndefined();
  });

  it('does not write to the store', async () => {
    seed();
    const before = statSync(store).mtimeMs;
    await peekStorageUsage(store);
    expect(statSync(store).mtimeMs).toBe(before);
  });
});

describe('scanInbox', () => {
  it('counts regular files directly in the folder and skips links and folders', async () => {
    const inbox = join(dir, 'Inbox');
    mkdirSync(inbox);
    mkdirSync(join(inbox, 'sub'));
    writeFileSync(join(inbox, 'a.txt'), Buffer.alloc(300));
    writeFileSync(join(inbox, 'b.bin'), Buffer.alloc(200));
    writeFileSync(join(dir, 'outside'), Buffer.alloc(9999));
    symlinkSync(join(dir, 'outside'), join(inbox, 'link'));
    expect(await scanInbox(inbox)).toEqual({ files: 2, bytes: 500, truncated: false });
  });

  it('answers undefined when the folder cannot be read', async () => {
    expect(await scanInbox(join(dir, 'nothing'))).toBeUndefined();
  });

  it('has a bound', () => {
    expect(MAX_INBOX_ENTRIES).toBeGreaterThan(0);
  });
});
