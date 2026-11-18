// DEVICES-INTERIM: the per-install id as a KeyStore item next to the agent's other items
// (`<agentId>:install-id`), against an in-memory keychain double and the real inter-process lock.
// It labels this computer's budget rows and lets a store tell that it moved to another install;
// it is never sent anywhere and never part of a recovery kit.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTALL_ID_ITEM, keychainInstallId } from './install-id.js';
import { withInterProcessLock } from './inter-process-lock.js';
import { agentEraseAccounts, keychainAccount, type KeychainBackend } from './keychain.js';

class MemKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  fault: 'none' | 'read' | 'write' = 'none';
  writes = 0;
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    if (this.fault === 'read') throw new Error('native: read failed');
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    if (this.fault === 'write') throw new Error('native: write failed');
    this.writes += 1;
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

const AGENT = `0x${'ab'.repeat(20)}`;
const ID = /^[0-9a-f]{32}$/;
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-install-id-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const over = (keychain: KeychainBackend) =>
  keychainInstallId(keychain, AGENT, (fn) =>
    withInterProcessLock(join(dir, 'agent.sqlite.lock'), () => fn()),
  );

describe('install id item', () => {
  it('is an agent item: its own account, and on the erase list', () => {
    expect(INSTALL_ID_ITEM).toBe('install-id');
    const account = keychainAccount(AGENT, INSTALL_ID_ITEM);
    expect(account).toBe(`${AGENT}:install-id`);
    expect(agentEraseAccounts(AGENT, [])).toContain(account);
  });

  it('is created once (16 random bytes as 32 lowercase hex) and then read back unchanged', async () => {
    const keychain = new MemKeychain();
    const first = await over(keychain).read();
    expect(first).toMatch(ID);
    expect(keychain.items.get(`${AGENT}:install-id`)).toEqual(ascii(first));
    expect(await over(keychain).read()).toBe(first);
    expect(keychain.writes).toBe(1);
  });

  it('two installs get different ids', async () => {
    const one = await over(new MemKeychain()).read();
    const two = await over(new MemKeychain()).read();
    expect(one).not.toBe(two);
  });

  it('two processes racing on a missing item agree on one id (written under the lock)', async () => {
    const keychain = new MemKeychain();
    const [a, b] = await Promise.all([over(keychain).read(), over(keychain).read()]);
    expect(a).toBe(b);
    expect(keychain.writes).toBe(1);
  });

  it('a damaged item is replaced with a new id', async () => {
    const keychain = new MemKeychain();
    for (const bad of ['', 'AB'.repeat(16), 'a'.repeat(31), 'a'.repeat(33), 'zz'.repeat(16)]) {
      keychain.items.set(`${AGENT}:install-id`, ascii(bad));
      const id = await over(keychain).read();
      expect(id).toMatch(ID);
      expect(id).not.toBe(bad);
    }
  });

  it('a keychain that cannot be read or written rejects with a fixed sentence', async () => {
    const keychain = new MemKeychain();
    keychain.fault = 'read';
    await expect(over(keychain).read()).rejects.toThrow();
    keychain.fault = 'write';
    await expect(over(keychain).read()).rejects.toThrow(/computer/);
  });
});
