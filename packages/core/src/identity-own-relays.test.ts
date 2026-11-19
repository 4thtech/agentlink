// D-157 (2) (07 §4.3 "Counts"; S2 path: owner rotation): the agent's own relay list holds 2 to 8.
// - init refuses an own list outside 2 to 8, before anything is stored;
// - rotate refuses a changed list outside 2 to 8, before anything is signed;
// - a list stored before the bound (above 8) still opens, and a rotation that keeps it (a rename)
//   still works; moving it to a list of 8 works.
import { canonicalize, type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { MemoryStore } from './store/memory-store.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { MemoryPolicyMark } from './testing/owner.js';

const clock = new FakeClock();
const list = (n: number, prefix = 'o'): string[] =>
  Array.from({ length: n }, (_, i) => `wss://${prefix}${i}.example.org`);

async function setup(n: number) {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n), { nowSeconds: () => clock.now() });
  const owner = new MemoryOwnerKeyStore(seed(n + 100), passphrase());
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    policyMark: new MemoryPolicyMark(),
  });
  const init = async (relays: readonly string[]) =>
    client.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name: `agent${n}`,
      relays,
    });
  const rotate = async (input: { relays?: readonly string[]; name?: string }) =>
    client.identity.rotate({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      epochControl: (owner as unknown as { epochControl(k: KeyStore): never }).epochControl(
        keyStore,
      ),
      ...input,
    });
  return { client, store, cipher, init, rotate };
}

describe('the own relay list bound (D-157 (2))', () => {
  it('init refuses 9 own relays (and 1), and accepts 8', async () => {
    const a = await setup(301);
    await expect(a.init(list(9))).rejects.toMatchObject({ code: 'relays_invalid' });
    await expect(a.init(list(1))).rejects.toMatchObject({ code: 'relays_invalid' });
    expect(await a.store.transaction((tx) => tx.count('identity'))).toBe(0);
    await a.init(list(8));
    expect(await a.client.identity.relays()).toEqual(list(8));
  });

  it('rotate refuses a changed list of 9 before anything is signed, and accepts 8', async () => {
    const a = await setup(302);
    await a.init(list(4));
    const before = await a.client.identity.signedCard();
    await expect(a.rotate({ relays: list(9, 'n') })).rejects.toMatchObject({
      code: 'relays_invalid',
    });
    expect((await a.client.identity.signedCard()).card.keyEpoch).toBe(before.card.keyEpoch);
    await a.rotate({ relays: list(8, 'n') });
    expect(await a.client.identity.relays()).toEqual(list(8, 'n'));
  });

  it('a list stored above 8 still opens; a rename keeps it; it can move to 8', async () => {
    const a = await setup(303);
    await a.init(list(4));
    // A list stored before the bound (the card bound was 16): written as the store holds it.
    const agentId = a.client.agentId;
    const sealed = await a.cipher.seal(
      { table: 'identity', column: 'relays', rowKey: rowKeyOf([agentId]) },
      canonicalize(list(10)),
    );
    await a.store.transaction((tx) =>
      tx.update('identity', { agent_id: agentId }, { relays: sealed }),
    );
    expect(await a.client.identity.relays()).toEqual(list(10));
    // A rotation that keeps the list (a rename) is not refused by the own-list bound.
    await a.rotate({ name: 'renamed agent' });
    expect(await a.client.identity.relays()).toEqual(list(10));
    // Passing the same stored list is no change either.
    await a.rotate({ relays: list(10) });
    // A changed list above 8 is refused; 8 is accepted.
    await expect(a.rotate({ relays: list(9, 'm') })).rejects.toMatchObject({
      code: 'relays_invalid',
    });
    await a.rotate({ relays: list(8, 'm') });
    expect(await a.client.identity.relays()).toEqual(list(8, 'm'));
  });
});
