// RELAY-CARD-MIGRATION (S2; 04 §2.5, §2.6; 07 §4.3; I-4): "Update your contact details". The
// owner's gesture signs the agent's next card (keyEpoch + 1) with the migrated relay list, through
// RelayCardSession (exactly one card: this agent, owner, epoch, name and list), then core's
// card-update tells the contacts. Without an unlocked owner session nothing changes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, type ApprovalChannel } from '@4thtech-io/core';
import {
  agentCardRelaysHash,
  encodeHex0x,
  type KeyStore,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import { DEFAULT_RELAYS, LEGACY_READ_RELAYS } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import { epochKeysOf } from './key-epoch.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import { type KeychainBackend } from './keychain.js';
import { KeychainOwnerKeyStore, newOwnerSeed, storeOwnerSeed } from './owner-keystore.js';
import { RelayCardSession, signRelayMigration } from './owner-relay-migration.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
/** An install from before 0.5.13: a legacy relay and one the user added. */
const RELAYS = ['wss://nos.lol', 'wss://one.relay-alpha.net'];

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

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

interface World {
  readonly agentId: string;
  readonly client: AgentLinkClient;
  readonly store: AgentStore;
  readonly keyStore: KeyStore;
  readonly owner: KeychainOwnerKeyStore;
  readonly ownerKeys: OwnerPublicKeys;
  readonly code: Uint8Array;
}

let dir: string;
let keychain: MapKeychain;
const now = 1_800_000_000;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-relaymig-'));
  keychain = new MapKeychain();
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

async function world(): Promise<World> {
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith('keychain', agentId, join(dir, 'agent.sqlite'), {
    keychain,
  });
  closers.push(() => store.close());
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  closers.push(() => keyStore.close());
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => now,
    policyMark: store.policyMark,
  });
  const { seed, keys } = newOwnerSeed();
  const code = generateSecretCode();
  await storeOwnerSeed(keychain, seed, { secret: code, secretKind: 1 }, { kdf: KDF });
  const owner = await KeychainOwnerKeyStore.open(keychain, keys);
  closers.push(() => owner.close());
  const session = await owner.unlock({ kind: 'passphrase', secret: code.slice() });
  await client.identity.init({ owner: session, ownerKeys: keys, name: 'My agent', relays: RELAYS });
  await session.close();
  return { agentId, client, store, keyStore, owner, ownerKeys: keys, code };
}

const unlock = (w: World): Promise<OwnerSession> =>
  w.owner.unlock({ kind: 'passphrase', secret: w.code.slice() });

async function migrate(w: World, session?: OwnerSession) {
  const token = epochKeysOf(w.keyStore);
  if (token === undefined) throw new Error('test: no epoch keys');
  const own = session ?? (await unlock(w));
  let updates = 0;
  try {
    const outcome = await signRelayMigration(own, w.ownerKeys, {
      agent: w.agentId,
      client: {
        identity: w.client.identity,
        sendCardUpdates: () => {
          updates += 1;
          return Promise.resolve({ sent: 0, failed: 0 });
        },
        contacts: w.client.contacts,
      },
      epochKeys: token,
    });
    return { outcome, updates };
  } finally {
    await own.close();
  }
}

describe('signRelayMigration: one gesture signs the next card with the migrated list', () => {
  it('rotates to keyEpoch + 1 with the migrated list, keeps the name, then sends card-updates', async () => {
    const w = await world();
    const before = await w.client.identity.signedCard();
    const { outcome, updates } = await migrate(w);
    expect(outcome.status).toBe('migrated');
    const after = await w.client.identity.signedCard();
    expect(after.card.keyEpoch).toBe(before.card.keyEpoch + 1);
    expect(after.name).toBe(before.name);
    expect(after.relays).toContain('wss://one.relay-alpha.net');
    for (const legacy of LEGACY_READ_RELAYS) expect(after.relays).not.toContain(legacy);
    for (const r of DEFAULT_RELAYS) expect(after.relays).toContain(r);
    expect(updates).toBe(1);
    expect(await w.client.identity.sendState()).toBe('ready');
    // The notice clears: nothing left to update.
    expect(await w.client.identity.relayMigration()).toEqual({ status: 'current' });
  });

  it('refuses when there is nothing to update, before anything is signed', async () => {
    const w = await world();
    expect((await migrate(w)).outcome.status).toBe('migrated');
    const again = await migrate(w);
    expect(again.outcome).toMatchObject({ status: 'refused', reason: 'current' });
    expect((await w.client.identity.get())?.keyEpoch).toBe(1);
  });

  it('needs the owner gesture: a closed (locked) session changes nothing', async () => {
    const w = await world();
    const session = await unlock(w);
    await session.close();
    await expect(migrate(w, session)).rejects.toThrow();
    expect((await w.client.identity.get())?.keyEpoch).toBe(0);
    expect((await w.client.identity.relayMigration()).status).toBe('needed');
  });
});

describe('RelayCardSession: exactly one card, for this agent, epoch, name and list', () => {
  it('refuses a card with another relay list or epoch, and every other method', async () => {
    const w = await world();
    const inner = await unlock(w);
    const signed = await w.client.identity.signedCard();
    const relays = [...DEFAULT_RELAYS, 'wss://one.relay-alpha.net'];
    const wrapper = new RelayCardSession(inner, w.agentId, w.ownerKeys, {
      keyEpoch: 1,
      nameHash: signed.card.nameHash,
      relays,
    });
    const typed = (over: Record<string, unknown>) =>
      ({
        domain: { name: 'AgentLink', version: '1' },
        types: {},
        primaryType: 'AgentCard',
        message: {
          ...signed.card,
          keyEpoch: 1,
          relaysHash: encodeHex0x(agentCardRelaysHash(relays)),
          ...over,
        },
      }) as never;
    await expect(wrapper.sign712(typed({ relaysHash: signed.card.relaysHash }))).rejects.toThrow();
    await expect(wrapper.sign712(typed({ keyEpoch: 2 }))).rejects.toThrow();
    await expect(wrapper.signOwnerAction()).rejects.toThrow();
    expect(wrapper.signed).toBe(0);
    await wrapper.close();
    await inner.close();
  });
});
