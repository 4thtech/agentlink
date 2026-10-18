// M1-8b: opening an agent's store with the store key from its recorded KeyStore backend (07 §3,
// §9.1), against an in-memory keychain double.
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORE_SCHEMA_VERSION, rowKeyOf, type Sealed } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import { NodeKeyStoreError } from './errors.js';
import { createKeychainAgent } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';
import { SqliteStore } from './sqlite-store.js';

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  get(account: string): Promise<Uint8Array | null> {
    const value = this.items.get(account);
    return Promise.resolve(value === undefined ? null : Uint8Array.from(value));
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, Uint8Array.from(value));
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

let dir: string;
let keychain: MapKeychain;
let agentId: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-agent-store-'));
  keychain = new MapKeychain();
  agentId = await createKeychainAgent(keychain);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const context = { table: 'contacts', column: 'name', rowKey: rowKeyOf(['0x01']) } as const;

describe('openAgentStoreWith', () => {
  it('opens the store with a cipher under the agent store key, and reopens it to the same key', async () => {
    const path = join(dir, 'agent.sqlite');
    const first = await openAgentStoreWith('keychain', agentId, path, { keychain });
    expect(first.store.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    const sealedName = await first.cipher.seal(context, 'Denis');
    await first.close();
    const second = await openAgentStoreWith('keychain', agentId, path, { keychain });
    expect(await second.cipher.open(context, sealedName)).toBe('Denis');
    await second.close();
  });

  it('hands out a frozen store facade with no connection or SqliteStore instance (IR-M1-8b-1 L-1)', async () => {
    const opened = await openAgentStoreWith('keychain', agentId, join(dir, 'agent.sqlite'), {
      keychain,
    });
    expect(Object.isFrozen(opened.store)).toBe(true);
    expect(Object.keys(opened.store).sort()).toEqual([
      'close',
      'schemaVersion',
      'transaction',
      'withInterProcessLock',
    ]);
    expect(opened.store).not.toBeInstanceOf(SqliteStore);
    const loose = opened.store as unknown as Record<string, unknown>;
    for (const name of ['db', 'statement', 'run']) expect(loose[name], name).toBeUndefined();
    expect(await opened.store.transaction((tx) => tx.count('seen'))).toBe(0);
    expect(await opened.store.withInterProcessLock(() => 'held')).toBe('held');
    await opened.close();
  });

  it('fails to open values after the store key item changes (wrong key)', async () => {
    const path = join(dir, 'agent.sqlite');
    const first = await openAgentStoreWith('keychain', agentId, path, { keychain });
    const sealedName = await first.cipher.seal(context, 'Denis');
    await first.close();
    keychain.items.set(keychainAccount(agentId, 'store-key'), new Uint8Array(32).fill(7));
    const second = await openAgentStoreWith('keychain', agentId, path, { keychain });
    await expect(second.cipher.open(context, sealedName as Sealed)).rejects.toThrow();
    await second.close();
  });

  it('never writes the store key into the store files', async () => {
    const path = join(dir, 'agent.sqlite');
    const opened = await openAgentStoreWith('keychain', agentId, path, { keychain });
    await opened.close();
    const key = keychain.items.get(keychainAccount(agentId, 'store-key'));
    for (const name of await readdir(dir)) {
      expect((await readFile(join(dir, name))).includes(Buffer.from(key ?? []))).toBe(false);
    }
  });

  it('refuses a missing identity and an unknown or file backend, creating no store', async () => {
    const path = join(dir, 'agent.sqlite');
    const missing = await openAgentStoreWith('keychain', `0x${'1'.repeat(40)}`, path, {
      keychain,
    }).catch((e: unknown) => e);
    expect((missing as NodeKeyStoreError).code).toBe('identity_missing');
    const file = await openAgentStoreWith('file', agentId, path, { keychain }).catch(
      (e: unknown) => e,
    );
    expect((file as NodeKeyStoreError).code).toBe('backend_unavailable');
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a damaged store key item', async () => {
    keychain.items.set(keychainAccount(agentId, 'store-key'), new Uint8Array(16));
    const error = await openAgentStoreWith('keychain', agentId, join(dir, 'a.sqlite'), {
      keychain,
    }).catch((e: unknown) => e);
    expect((error as NodeKeyStoreError).code).toBe('store_key_invalid');
  });
});
