// M1-11b-6: `ownerSetupAvailable`, the store-only check the CLI runs before it wires owner setup
// into the local approval server (IR-M1-11s-c-1 L-6: the file-KeyStore owner files count too). It
// reads no secret and unlocks nothing; any error answers false (the CLI then never wires setup).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeychainBackend } from './keychain.js';
import type { FirstAgentCard } from './owner-init.js';
import { defaultOwnerFiles, noOwnerAnywhere, ownerSetupAvailableWith } from './owner-setup.js';

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
    await expect(
      ownerSetupAvailableWith(new MapKeychain(), firstCard('none'), files),
    ).resolves.toBe(true);
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

  // M1-9i-c (#507) restore order (04 §2.3.3 steps 5 and 6): the agents (items, a store whose card
  // names the kit's owner, then config) are written before the owner seed. A restore that stopped in
  // between, or a store restored beside this agent, means an owner exists although no owner item
  // does yet: setup here would create a second, unrelated owner (D-78).
  it('is false when another agent folder exists on this computer (a restored or added agent)', async () => {
    await mkdir(join(home, '.agentlink', 'agents', 'restored'), { recursive: true });
    await expect(
      ownerSetupAvailableWith(new MapKeychain(), firstCard('none'), defaultOwnerFiles(home)),
    ).resolves.toBe(false);
  });

  it('is false while a restore left anything else in the agents folder (a quarantined store)', async () => {
    await mkdir(join(home, '.agentlink', 'agents', 'default'), { recursive: true });
    await writeFile(join(home, '.agentlink', 'agents', '.restore-0011223344556677.sqlite'), 'x');
    await expect(
      ownerSetupAvailableWith(new MapKeychain(), firstCard('none'), defaultOwnerFiles(home)),
    ).resolves.toBe(false);
  });

  it('is false when the file KeyStore holds anything (an imported agent file or its lock)', async () => {
    await mkdir(join(home, '.agentlink', 'keystore'), { recursive: true });
    await writeFile(join(home, '.agentlink', 'keystore', `0x${'cd'.repeat(20)}.alks`), 'x');
    await expect(
      ownerSetupAvailableWith(new MapKeychain(), firstCard('none'), defaultOwnerFiles(home)),
    ).resolves.toBe(false);
  });

  it("is still true with only this agent's own folder", async () => {
    await mkdir(join(home, '.agentlink', 'agents', 'default'), { recursive: true });
    await expect(
      ownerSetupAvailableWith(new MapKeychain(), firstCard('none'), defaultOwnerFiles(home)),
    ).resolves.toBe(true);
  });

  it('fails closed when the agents folder cannot be listed', async () => {
    await mkdir(join(home, '.agentlink'), { recursive: true });
    await writeFile(join(home, '.agentlink', 'agents'), 'not a folder');
    await expect(
      ownerSetupAvailableWith(new MapKeychain(), firstCard('none'), defaultOwnerFiles(home)),
    ).resolves.toBe(false);
  });

  it('the server re-check (noOwnerAnywhere) refuses with another agent too', async () => {
    await mkdir(join(home, '.agentlink', 'agents', 'restored'), { recursive: true });
    await expect(
      noOwnerAnywhere(new MapKeychain(), firstCard('none'), 1_000, defaultOwnerFiles(home)),
    ).resolves.toBe(false);
  });
});
