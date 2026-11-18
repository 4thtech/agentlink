// SEC-RESTORE-GUARD (D-156): the restore mark as a KeyStore item next to the agent's other items,
// against an in-memory keychain double and the real inter-process lock (06 §6).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withInterProcessLock } from './inter-process-lock.js';
import { agentEraseAccounts, keychainAccount, type KeychainBackend } from './keychain.js';
import {
  RESTORE_MARK_ITEM,
  decodeRestoreMark,
  encodeRestoreMark,
  keychainRestoreMark,
} from './restore-mark.js';

class MemKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  fault: 'none' | 'read' | 'write' = 'none';
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    if (this.fault === 'read') throw new Error('native: read failed');
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    if (this.fault === 'write') throw new Error('native: write failed');
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

const AGENT = `0x${'ab'.repeat(20)}`;
const NOW = 1_800_000_000;
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-restore-mark-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function markOver(keychain: KeychainBackend, now = (): number => NOW) {
  return keychainRestoreMark(
    keychain,
    AGENT,
    (fn) => withInterProcessLock(join(dir, 'agent.sqlite.lock'), () => fn()),
    { now },
  );
}

describe('restore mark item', () => {
  it('is an agent item: its own account, and on the erase list', () => {
    expect(RESTORE_MARK_ITEM).toBe('restore-mark');
    const account = keychainAccount(AGENT, RESTORE_MARK_ITEM);
    expect(account).toBe(`${AGENT}:restore-mark`);
    expect(agentEraseAccounts(AGENT, [])).toContain(account);
  });

  it('encodes canonical ASCII decimal and decodes strictly', () => {
    expect(encodeRestoreMark(0)).toEqual(ascii('0'));
    expect(decodeRestoreMark(encodeRestoreMark(NOW))).toBe(NOW);
    for (const bad of ['', '01', '-1', '1.5', ' 1', '1e9', 'x', '12345678901234567']) {
      expect(() => decodeRestoreMark(ascii(bad))).toThrow();
    }
  });

  it('reads 0 for an ID created here, and the restore time after a restore', async () => {
    const keychain = new MemKeychain();
    const account = keychainAccount(AGENT, RESTORE_MARK_ITEM);
    keychain.items.set(account, encodeRestoreMark(0));
    expect(await markOver(keychain).read()).toBe(0);
    keychain.items.set(account, encodeRestoreMark(NOW - 60));
    expect(await markOver(keychain).read()).toBe(NOW - 60);
  });

  it('a missing item starts a guard window now and writes it (fail closed)', async () => {
    const keychain = new MemKeychain();
    expect(await markOver(keychain).read()).toBe(NOW);
    const stored = keychain.items.get(keychainAccount(AGENT, RESTORE_MARK_ITEM));
    expect(stored).toEqual(encodeRestoreMark(NOW));
  });

  it('a damaged item starts a guard window now and is replaced (fail closed)', async () => {
    const keychain = new MemKeychain();
    const account = keychainAccount(AGENT, RESTORE_MARK_ITEM);
    keychain.items.set(account, ascii('garbage'));
    expect(await markOver(keychain).read()).toBe(NOW);
    expect(keychain.items.get(account)).toEqual(encodeRestoreMark(NOW));
  });

  it('a mark in the future is kept (never lowered to now)', async () => {
    const keychain = new MemKeychain();
    const account = keychainAccount(AGENT, RESTORE_MARK_ITEM);
    keychain.items.set(account, encodeRestoreMark(NOW + 600));
    expect(await markOver(keychain).read()).toBe(NOW + 600);
  });

  it('an unreadable keychain, or a missing item that cannot be written, throws', async () => {
    const keychain = new MemKeychain();
    keychain.fault = 'read';
    await expect(markOver(keychain).read()).rejects.toThrow();
    keychain.fault = 'write';
    await expect(markOver(keychain).read()).rejects.toThrow();
  });

  it('the mark offers no way to lower or clear it', () => {
    const mark = markOver(new MemKeychain());
    expect(Object.keys(mark).sort()).toEqual(['read']);
    expect(Object.isFrozen(mark)).toBe(true);
  });
});
