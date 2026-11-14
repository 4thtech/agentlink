// WIN-BROKEN-ID: the keychain probe and the leftover erase of an ID whose key is missing.
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { describe, expect, it } from 'vitest';
import { agentIdentityMissing, agentSeedMissing, eraseBrokenAgentItems } from './broken-id.js';
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

describe('agentSeedMissing and keepStoreKey (WIN-BROKEN-ID r1)', () => {
  it('is true only when the seed itself is gone (a missing store key alone is not)', async () => {
    const k = new MapKeychain();
    const id = newId();
    k.items.set(keychainAccount(id, 'seed'), randomBytes(32));
    expect(await agentSeedMissing(k, id)).toBe(false);
    k.items.delete(keychainAccount(id, 'seed'));
    k.items.set(keychainAccount(id, 'store-key'), randomBytes(32));
    expect(await agentSeedMissing(k, id)).toBe(true);
  });

  it('set-aside keeps the store key, so the set-aside store stays readable', async () => {
    const k = new MapKeychain();
    const id = newId();
    k.items.set(keychainAccount(id, 'store-key'), randomBytes(32));
    k.items.set(keychainAccount(id, 'policy-version'), randomBytes(2));
    await eraseBrokenAgentItems(k, id, undefined, { keepStoreKey: true });
    expect([...k.items.keys()]).toEqual([keychainAccount(id, 'store-key')]);
  });
});

describe('eraseBrokenAgentItems never deletes the seed account (WIN-BROKEN-ID r2)', () => {
  it('a seed written between the check and the deletes is not erased', async () => {
    const id = newId();
    const deleted: string[] = [];
    const k = new MapKeychain();
    const spy: KeychainBackend = {
      get: (a) => k.get(a),
      set: (a, v) => k.set(a, v),
      delete: (a) => {
        deleted.push(a);
        return k.delete(a);
      },
    };
    await eraseBrokenAgentItems(spy, id);
    expect(deleted).not.toContain(keychainAccount(id, 'seed'));
    expect(deleted).toContain(keychainAccount(id, 'store-key'));
  });
});
