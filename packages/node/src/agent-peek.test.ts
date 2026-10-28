// U3-c: the read-only look at an agent's store for the Agents list (08 §1; 06 §6): the active
// contact count and Running from the lease row, clear columns only, read-only, never failing.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { peekAgentStore } from './agent-peek.js';

const NOW = 1_800_000_000;
let dir: string;
let path: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-u3c-peek-')));
  path = join(dir, 'store.sqlite');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(statuses: readonly string[], leaseUntil?: number): void {
  const db = new Database(path);
  db.exec('CREATE TABLE contacts (contact_id TEXT PRIMARY KEY, status TEXT, name BLOB)');
  db.exec('CREATE TABLE publisher_lease (name TEXT PRIMARY KEY, holder TEXT, lease_until INTEGER)');
  statuses.forEach((status, i) => {
    db.prepare('INSERT INTO contacts VALUES (?, ?, ?)').run(`c${String(i)}`, status, Buffer.from('x'));
  });
  if (leaseUntil !== undefined) {
    db.prepare('INSERT INTO publisher_lease VALUES (?, ?, ?)').run('subscriptions', 'h', leaseUntil);
  }
  db.close();
}

describe('peekAgentStore (U3-c)', () => {
  it('counts active contacts and reads a live lease as Running', () => {
    seed(['active', 'active', 'removed', 'blocked', 'revoked'], NOW + 30);
    expect(peekAgentStore(path, NOW)).toEqual({ contacts: 2, running: true });
  });

  it('a lapsed lease, a lease too far ahead and no lease row are not Running', () => {
    seed(['active'], NOW);
    expect(peekAgentStore(path, NOW)).toEqual({ contacts: 1, running: false });
    rmSync(path);
    seed([], NOW + 121);
    expect(peekAgentStore(path, NOW)).toEqual({ contacts: 0, running: false });
    rmSync(path);
    seed([]);
    expect(peekAgentStore(path, NOW)).toEqual({ contacts: 0, running: false });
  });

  it('answers undefined for a missing or unreadable store and writes nothing', () => {
    expect(peekAgentStore(join(dir, 'missing.sqlite'), NOW)).toBeUndefined();
    const db = new Database(path);
    db.exec('CREATE TABLE other (x)');
    db.close();
    const before = readFileSync(path);
    expect(peekAgentStore(path, NOW)).toBeUndefined();
    expect(readFileSync(path).equals(before)).toBe(true);
  });
});
