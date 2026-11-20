// NET-OWNER-SET (S2; D-158 (2), (5), (6), (7); 04 §2.5, §2.6; 07 §4.3; I-4): the owner part of a
// server-list change, generalised from "Update your contact details". One presence gesture unlocks
// one owner session, which signs exactly the agent's next card (keyEpoch + 1, the same name, exactly
// the planned list) through RelayCardSession; the announce choice is stored with it; then core's
// card-update tells the contacts. Without an unlocked session nothing changes. Refusals come before
// anything is signed.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, LEAVING_SERVER_SECONDS, type ApprovalChannel } from '@4thtech-io/core';
import type { KeyStore, OwnerPublicKeys, OwnerSession } from '@4thtech-io/crypto';
import { generateSecretCode } from '@4thtech-io/crypto/keystore';
import { DEFAULT_RELAYS } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith } from './agent-store.js';
import { epochKeysOf } from './key-epoch.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import { type KeychainBackend } from './keychain.js';
import { KeychainOwnerKeyStore, newOwnerSeed, storeOwnerSeed } from './owner-keystore.js';
import { signServerChange, type ServerChangeOutcome } from './owner-relay-migration.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const START = ['wss://relay.primal.net', 'wss://offchain.pub'];
const own = (n: number, tag = 'own'): string[] =>
  Array.from({ length: n }, (_, i) => `wss://${tag}${i + 1}.example.org`);

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
  readonly keyStore: KeyStore;
  readonly owner: KeychainOwnerKeyStore;
  readonly ownerKeys: OwnerPublicKeys;
  readonly code: Uint8Array;
}

let dir: string;
let keychain: MapKeychain;
const T0 = 1_800_000_000;
let now = T0;
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-servers-'));
  keychain = new MapKeychain();
  now = T0;
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
  await client.identity.init({ owner: session, ownerKeys: keys, name: 'My agent', relays: START });
  await session.close();
  return { agentId, client, keyStore, owner, ownerKeys: keys, code };
}

const unlock = (w: World): Promise<OwnerSession> =>
  w.owner.unlock({ kind: 'passphrase', secret: w.code.slice() });

async function changeTo(
  w: World,
  relays: readonly string[],
  announceDefault = true,
  session?: OwnerSession,
): Promise<{ outcome: ServerChangeOutcome; updates: number }> {
  const epochKeys = epochKeysOf(w.keyStore);
  if (epochKeys === undefined) throw new Error('test: no epoch keys');
  const gesture = session ?? (await unlock(w));
  let updates = 0;
  try {
    const outcome = await signServerChange(gesture, w.ownerKeys, {
      agent: w.agentId,
      client: {
        identity: w.client.identity,
        sendCardUpdates: () => {
          updates += 1;
          return Promise.resolve({ sent: 0, failed: 0 });
        },
        contacts: w.client.contacts,
      },
      epochKeys,
      relays,
      announceDefault,
    });
    return { outcome, updates };
  } finally {
    await gesture.close();
  }
}

describe('signServerChange: one gesture signs the next card with exactly the planned list', () => {
  it('happy path: keyEpoch + 1, the same name, the list, the leaving servers, card-updates', async () => {
    const w = await world();
    const before = await w.client.identity.signedCard();
    const list = [...own(2), ...DEFAULT_RELAYS.slice(0, 2)];
    const { outcome, updates } = await changeTo(w, list);
    const after = await w.client.identity.signedCard();
    expect(after.card.keyEpoch).toBe(before.card.keyEpoch + 1);
    expect(after.name).toBe(before.name);
    expect(after.relays).toEqual(list);
    expect(updates).toBe(1);
    expect(await w.client.identity.sendState()).toBe('ready');
    // Whatever of START is not in the new list now leaves, read for 30 days.
    const leaving = (await w.client.identity.leavingServers()).map((e) => e.url);
    expect(leaving).toEqual(START.filter((url) => !list.includes(url)));
    expect(outcome).toEqual({
      status: 'changed',
      contacts: 0,
      leavingUntil: leaving.length === 0 ? null : now + LEAVING_SERVER_SECONDS,
    });
  });

  it('refused without presence: a closed (locked) session changes nothing', async () => {
    const w = await world();
    const session = await unlock(w);
    await session.close();
    await expect(changeTo(w, own(3), true, session)).rejects.toThrow();
    expect((await w.client.identity.get())?.keyEpoch).toBe(0);
    expect(await w.client.identity.relays()).toEqual(START);
  });

  it('the announce flag is stored with the card (rotate({announceDefault}))', async () => {
    const w = await world();
    expect(await w.client.identity.announceDefault()).toBe(true);
    expect((await changeTo(w, own(3), false)).outcome.status).toBe('changed');
    expect(await w.client.identity.announceDefault()).toBe(false);
  });

  it('reset to automatic is the same path with the default set, and clears the opt-out', async () => {
    const w = await world();
    await changeTo(w, own(3), false);
    now += 60;
    const { outcome } = await changeTo(w, DEFAULT_RELAYS, true);
    expect(outcome).toMatchObject({ status: 'changed', leavingUntil: now + LEAVING_SERVER_SECONDS });
    expect(await w.client.identity.relays()).toEqual(DEFAULT_RELAYS);
    expect(await w.client.identity.announceDefault()).toBe(true);
    expect((await w.client.identity.get())?.keyEpoch).toBe(2);
  });

  it('the same list is refused before anything is signed', async () => {
    const w = await world();
    expect((await changeTo(w, START)).outcome).toEqual({ status: 'refused', reason: 'same_list' });
    expect((await w.client.identity.get())?.keyEpoch).toBe(0);
  });

  it('past 16 leaving servers it is refused with the time it fits from, nothing signed', async () => {
    const w = await world();
    // START (2) leaves, then a1..a8 (8): 10 leaving. The next change would need 18.
    await changeTo(w, own(8, 'a'));
    now += 100;
    await changeTo(w, own(8, 'b'));
    now += 100;
    const { outcome } = await changeTo(w, own(8, 'c'));
    // Two entries must end first: START's two end at T0 + 30 days.
    expect(outcome).toEqual({
      status: 'refused',
      reason: 'too_many_previous',
      fitsAt: T0 + LEAVING_SERVER_SECONDS,
    });
    expect((await w.client.identity.get())?.keyEpoch).toBe(2);
    expect(await w.client.identity.relays()).toEqual(own(8, 'b'));
  });

  it('concurrent attempts: one wins, the other gets a clear refusal', async () => {
    const w = await world();
    const [x, y] = await Promise.all([changeTo(w, own(3, 'x')), changeTo(w, own(3, 'y'))]);
    const statuses = [x.outcome.status, y.outcome.status].sort();
    expect(statuses).toEqual(['changed', 'refused']);
    const loser = x.outcome.status === 'refused' ? x.outcome : y.outcome;
    expect(loser).toMatchObject({ status: 'refused', reason: 'rotation_pending' });
    expect((await w.client.identity.get())?.keyEpoch).toBe(1);
    const winner = x.outcome.status === 'changed' ? own(3, 'x') : own(3, 'y');
    expect(await w.client.identity.relays()).toEqual(winner);
    expect(await w.client.identity.sendState()).toBe('ready');
  });
});
