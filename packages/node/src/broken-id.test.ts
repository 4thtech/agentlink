// WIN-BROKEN-ID: the keychain probe and the leftover erase of an ID whose key is missing.
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import { agentIdentityMissing, eraseBrokenAgentItems } from './broken-id.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

const newId = (): string => `0x${encodeHex(randomBytes(20))}`;

describe('agentIdentityMissing (WIN-BROKEN-ID)', () => {
  it('is false with seed and store key, true when either is gone', async () => {
    const k = new MapKeychain();
    const id = newId();
    k.items.set(keychainAccount(id, 'seed'), randomBytes(32));
    k.items.set(keychainAccount(id, 'store-key'), randomBytes(32));
    expect(await agentIdentityMissing(k, id)).toBe(false);
    k.items.delete(keychainAccount(id, 'store-key'));
    expect(await agentIdentityMissing(k, id)).toBe(true);
    k.items.set(keychainAccount(id, 'store-key'), randomBytes(32));
    k.items.delete(keychainAccount(id, 'seed'));
    expect(await agentIdentityMissing(k, id)).toBe(true);
  });

  it('refuses an agent ID that is not the 04 §2.9 form', async () => {
    await expect(agentIdentityMissing(new MapKeychain(), 'owner')).rejects.toBeDefined();
  });
});

describe('eraseBrokenAgentItems (WIN-BROKEN-ID)', () => {
  it('erases the leftover agent items; owner items and other IDs stay', async () => {
    const k = new MapKeychain();
    const id = newId();
    const other = newId();
    for (const item of ['store-key', 'policy-version', 'key-epoch'] as const) {
      k.items.set(keychainAccount(id, item), randomBytes(4));
    }
    k.items.set('owner', randomBytes(8));
    k.items.set('owner-passkey', randomBytes(8));
    k.items.set(keychainAccount(other, 'seed'), randomBytes(32));
    await eraseBrokenAgentItems(k, id);
    expect([...k.items.keys()].sort()).toEqual(
      ['owner', 'owner-passkey', keychainAccount(other, 'seed')].sort(),
    );
  });

  it('refuses while the seed is here and erases nothing', async () => {
    const k = new MapKeychain();
    const id = newId();
    k.items.set(keychainAccount(id, 'seed'), randomBytes(32));
    k.items.set(keychainAccount(id, 'store-key'), randomBytes(32));
    await expect(eraseBrokenAgentItems(k, id)).rejects.toMatchObject({
      code: 'keystore_erase_failed',
    });
    expect(k.items.size).toBe(2);
  });
});
