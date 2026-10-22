// M1-11b-6: `ownerSetupAvailable`, the store-only check the CLI runs before it wires owner setup
// into the local approval server (IR-M1-11s-c-1 L-6: the file-KeyStore owner files count too). It
// reads no secret and unlocks nothing; any error answers false (the CLI then never wires setup).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeychainBackend } from './keychain.js';
import type { FirstAgentCard } from './owner-init.js';
import { defaultOwnerFiles, ownerSetupAvailableWith } from './owner-setup.js';

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  failing = false;
  get(account: string): Promise<Uint8Array | null> {
    if (this.failing) return Promise.reject(new Error('keychain locked'));
    const value = this.items.get(account);
    return Promise.resolve(value === undefined ? null : new Uint8Array(value));
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, new Uint8Array(value));
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(account));
  }
}

function firstCard(card: 'none' | 'present' | 'throws'): FirstAgentCard {
  return {
    agent: `0x${'ab'.repeat(20)}`,
    name: 'default',
    relays: ['wss://relay.example'],
    identity: {
      get: () =>
        card === 'throws'
          ? Promise.reject(new Error('store closed'))
          : Promise.resolve(card === 'none' ? undefined : ({} as never)),
      init: () => Promise.reject(new Error('not used')),
    } as unknown as FirstAgentCard['identity'],
  };
}

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentlink-owner-setup-available-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('ownerSetupAvailable (M1-11b-6)', () => {
  it('is true on a clean computer: no card, no owner item, no owner file', async () => {
    const files = defaultOwnerFiles(home);
    await expect(ownerSetupAvailableWith(new MapKeychain(), firstCard('none'), files)).resolves.toBe(
      true,
    );
  });

  it('is false when the agent card already names an owner', async () => {
    await expect(
      ownerSetupAvailableWith(new MapKeychain(), firstCard('present'), defaultOwnerFiles(home)),
    ).resolves.toBe(false);
  });

  it.each(['owner', 'owner-passkey', 'owner-next'])(
    'is false when the %s keychain item exists',
    async (account) => {
      const keychain = new MapKeychain();
      keychain.items.set(account, new Uint8Array([1, 2, 3]));
      await expect(
        ownerSetupAvailableWith(keychain, firstCard('none'), defaultOwnerFiles(home)),
      ).resolves.toBe(false);
    },
  );

  it.each(['owner.alko', 'owner.alkp'])(
    'is false when the file KeyStore holds %s (IR-M1-11s-c-1 L-6)',
    async (file) => {
      await mkdir(join(home, '.agentlink', 'keystore'), { recursive: true });
      await writeFile(join(home, '.agentlink', 'keystore', file), 'x');
      await expect(
        ownerSetupAvailableWith(new MapKeychain(), firstCard('none'), defaultOwnerFiles(home)),
      ).resolves.toBe(false);
    },
  );

  it('fails closed: a keychain or store error answers false', async () => {
    const keychain = new MapKeychain();
    keychain.failing = true;
    await expect(
      ownerSetupAvailableWith(keychain, firstCard('none'), defaultOwnerFiles(home)),
    ).resolves.toBe(false);
    await expect(
      ownerSetupAvailableWith(new MapKeychain(), firstCard('throws'), defaultOwnerFiles(home)),
    ).resolves.toBe(false);
  });
});
