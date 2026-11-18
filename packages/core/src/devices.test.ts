// DEVICES-INTERIM (D-156 follow-up; 04 §2.3.3, 06 §3, 07 §3.5): until one ID can be used on several
// computers, AgentLink notices when the same ID is in use on another install and says so. The signal
// is one the app already receives: the agent's own sent copy (04 §3.2 entry 4) of an envelope this
// store never wrote. Nothing new goes on the wire; the install id stays on this computer and is
// written on each budget ledger row.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { checkAndReserveProof } from './budget.js';
import { AgentLinkClient } from './client.js';
import {
  OTHER_INSTALL_NOTICE_SECONDS,
  OTHER_INSTALL_SKEW_SECONDS,
  type InstallIdSource,
} from './devices.js';
import type { EffectivePolicy } from './policy-engine.js';
import type { RestoreMark } from './restore-guard.js';
import { MemoryStore } from './store/memory-store.js';
import { SINGLETON_SLOT } from './store/schema.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import {
  agentEnc,
  cardUpdatePayload,
  craft,
  giftWrapId,
  makeAgent,
  ownerEnc,
  agentSigner,
  ownerSigner,
  pairWith,
  rotate,
  textPayload,
  type TestAgent,
} from './testing/envelopes.js';

const INSTALL_A = 'a1'.repeat(16);
const INSTALL_B = 'b2'.repeat(16);
const ownerB = new MemoryOwnerKeyStore(seed(64), passphrase());

const installSource = (id: string): InstallIdSource & { reads: number } => {
  const source = {
    reads: 0,
    read: (): Promise<string> => {
      source.reads += 1;
      return Promise.resolve(id);
    },
  };
  return source;
};

async function agentWith(
  clock: FakeClock,
  options: {
    installId?: InstallIdSource;
    restoreMark?: RestoreMark;
    store?: MemoryStore;
    seedN?: number;
  } = {},
): Promise<TestAgent> {
  const keyStore = new MemoryKeyStore(seed(options.seedN ?? 61));
  const owner = new MemoryOwnerKeyStore(seed(62), passphrase());
  const store = options.store ?? new MemoryStore();
  const cipher = new TestStoreCipher();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    ...(options.installId === undefined ? {} : { installId: options.installId }),
    ...(options.restoreMark === undefined ? {} : { restoreMark: options.restoreMark }),
  });
  if (options.store === undefined) {
    await client.identity.init({
      owner: await owner.unlock(passphrase()),
      ownerKeys: await owner.getPublicKeys(),
      name: 'alice',
      relays: RELAYS,
    });
  }
  return { client, store, cipher, keyStore, owner, id: client.agentId };
}

/** An own envelope signed with this ID's keys that this store never wrote (another computer's). */
async function otherComputersCopy(agent: TestAgent): Promise<{ id: string; envelope: unknown }> {
  const { built } = await agent.client.envelopes.prepare({
    to: { owner: true },
    payload: await cardUpdatePayload(agent),
  });
  return { id: built.envelope.id, envelope: built.envelope };
}

async function deliver(agent: TestAgent, envelope: unknown): Promise<void> {
  const received = await agent.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  expect(received.status).toBe('verified');
  await agent.client.envelopes.processReceived();
}

/** A contact's text message to `self`, built with the contact's view of `self`'s current card. */
async function fromContact(self: TestAgent, contact: TestAgent): Promise<void> {
  const built = await contact.client.envelopes.build({
    to: { contact: self.id },
    payload: textPayload(),
  });
  await self.client.envelopes.receive({ envelope: built.envelope, giftWrapId: giftWrapId() });
  expect(await self.client.envelopes.processReceived()).toEqual([
    expect.objectContaining({ outcome: 'ok', contactId: contact.id }),
  ]);
}

describe('DEVICES-INTERIM: this ID in use on another computer', () => {
  it('the notice constants are a week and the clock-skew allowance', () => {
    expect(OTHER_INSTALL_NOTICE_SECONDS).toBe(7 * 86_400);
    expect(OTHER_INSTALL_SKEW_SECONDS).toBe(300);
  });

  it('a fresh install has its id from the first open and sees no other computer', async () => {
    const clock = new FakeClock();
    const opened = clock.t;
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    clock.t += 600;
    expect(await a.client.devices.state()).toEqual({
      otherInUse: false,
      otherSeenAt: null,
    });
    const row = await a.store.transaction((tx) =>
      tx.get('install_state', { slot: SINGLETON_SLOT }),
    );
    expect(row).toMatchObject({ install_id: INSTALL_A, since: opened, other_seen_at: null });
    // Surfaces get a flag and a time only, never the install id.
    expect(Object.keys(await a.client.devices.state()).sort()).toEqual([
      'otherInUse',
      'otherSeenAt',
    ]);
  });

  it('a copy made seconds after the first open counts (since is the open, not first use)', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    clock.t += 10;
    await deliver(a, (await otherComputersCopy(a)).envelope);
    expect(await a.client.devices.state()).toEqual({ otherInUse: true, otherSeenAt: clock.t });
  });

  it('only a copy signed by this ID’s agent key counts: a contact’s message marks nothing', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    const b = await makeAgent(clock, new MemoryKeyStore(seed(63)), ownerB, 'bob');
    await pairWith(clock, a, b);
    await pairWith(clock, b, a);
    clock.t += 60;
    // Signed by b's agent key, so it is b's message (outcome ok), never a sent copy of this ID.
    const built = await b.client.envelopes.build({ to: { contact: a.id }, payload: textPayload() });
    const received = await a.client.envelopes.receive({
      envelope: built.envelope,
      giftWrapId: giftWrapId(),
    });
    expect(received.status).toBe('verified');
    expect(await a.client.envelopes.processReceived()).toEqual([
      expect.objectContaining({ outcome: 'ok', contactId: b.id }),
    ]);
    // Signed by this ID's owner key (not the agent key): not a sent copy either.
    const ownerCopy = await craft({
      signer: await ownerSigner(a.owner),
      entries: [{ pk: await agentEnc(a) }, { pk: await ownerEnc(a.owner) }],
      payload: await cardUpdatePayload(a),
      createdAt: clock.t,
    });
    await a.client.envelopes.receive({ envelope: ownerCopy, giftWrapId: giftWrapId() });
    const reports = await a.client.envelopes.processReceived();
    expect(reports.map((r) => r.outcome)).not.toContain('sent_copy');
    expect(await a.client.devices.state()).toEqual({ otherInUse: false, otherSeenAt: null });
  });

  it('a sent copy this store never wrote, made after this install started, marks another computer', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    await a.client.devices.state(); // the install starts now
    clock.t += 3_600;
    const copy = await otherComputersCopy(a);
    clock.t += 30;
    await deliver(a, copy.envelope);
    expect(await a.client.devices.state()).toEqual({
      otherInUse: true,
      otherSeenAt: clock.t - 30,
    });
    // The copy itself is stored as sent, as before.
    const row = await a.store.transaction((tx) => tx.get('envelopes', { envelope_id: copy.id }));
    expect(row).toMatchObject({ direction: 'out', state: 'ok' });
  });

  it('this computer’s own sent copy (the row is held) is a duplicate and marks nothing', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    await a.client.devices.state();
    clock.t += 3_600;
    const built = await a.client.envelopes.build({
      to: { owner: true },
      payload: await cardUpdatePayload(a),
    });
    const received = await a.client.envelopes.receive({
      envelope: built.envelope,
      giftWrapId: giftWrapId(),
    });
    expect(received).toMatchObject({ status: 'processed', report: { outcome: 'duplicate' } });
    await a.client.envelopes.processReceived();
    expect((await a.client.devices.state()).otherInUse).toBe(false);
  });

  it('a copy made before this install opened the store (an older copy on the relays) marks nothing', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    const copy = await otherComputersCopy(a);
    clock.t += 10;
    // This store opened by another install (a restored snapshot): its since is now.
    const here = await agentWith(clock, { installId: installSource(INSTALL_B), store: a.store });
    await deliver(here, copy.envelope);
    expect((await here.client.devices.state()).otherInUse).toBe(false);
  });

  it('a copy made before a restore marks nothing (the backup did not hold it)', async () => {
    const clock = new FakeClock();
    const restoredAt = clock.t + 7_200;
    const a = await agentWith(clock, {
      installId: installSource(INSTALL_A),
      restoreMark: { read: () => Promise.resolve(restoredAt) },
    });
    await a.client.devices.state();
    clock.t += 3_600;
    const before = await otherComputersCopy(a);
    clock.t = restoredAt + 60;
    await deliver(a, before.envelope);
    expect((await a.client.devices.state()).otherInUse).toBe(false);
    clock.t = restoredAt + OTHER_INSTALL_SKEW_SECONDS + 60;
    const after = await otherComputersCopy(a);
    await deliver(a, after.envelope);
    expect((await a.client.devices.state()).otherInUse).toBe(true);
  });

  it('a restore mark that cannot be read marks nothing (a notice, never a guess)', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, {
      installId: installSource(INSTALL_A),
      restoreMark: { read: () => Promise.reject(new Error('keychain')) },
    });
    await a.client.devices.state();
    clock.t += 3_600;
    await deliver(a, (await otherComputersCopy(a)).envelope);
    expect((await a.client.devices.state()).otherInUse).toBe(false);
  });

  it('the notice ends a week after the last copy once a contact still writes to this computer’s current keys', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    const b = await makeAgent(clock, new MemoryKeyStore(seed(63)), ownerB, 'bob');
    await pairWith(clock, a, b);
    await pairWith(clock, b, a);
    await a.client.devices.state();
    clock.t += 3_600;
    await deliver(a, (await otherComputersCopy(a)).envelope);
    const seenAt = clock.t;
    // A contact's message from inside the week shows nothing about later: the notice holds.
    clock.t = seenAt + OTHER_INSTALL_NOTICE_SECONDS - 60;
    await fromContact(a, b);
    clock.t = seenAt + OTHER_INSTALL_NOTICE_SECONDS - 1;
    expect((await a.client.devices.state()).otherInUse).toBe(true);
    clock.t = seenAt + OTHER_INSTALL_NOTICE_SECONDS;
    expect((await a.client.devices.state()).otherInUse).toBe(true);
    // A contact still writes to this computer's current keys after the week: the ID's card did not
    // move on elsewhere, so the quiet week means the other computer stopped. The notice ends.
    clock.t += 60;
    await fromContact(a, b);
    expect(await a.client.devices.state()).toEqual({
      otherInUse: false,
      otherSeenAt: seenAt,
    });
  });

  it('after a week with nothing that shows this computer’s keys are current, the notice holds (fail closed)', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    await a.client.devices.state();
    clock.t += 3_600;
    await deliver(a, (await otherComputersCopy(a)).envelope);
    const seenAt = clock.t;
    clock.t = seenAt + 30 * 86_400;
    expect(await a.client.devices.state()).toEqual({ otherInUse: true, otherSeenAt: seenAt });
  });

  it('the other computer moved this ID to a newer key epoch: its copies never open here, and the notice holds', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    await a.client.devices.state();
    // The same ID on another computer (same keys, its own store).
    const other = await agentWith(clock, { installId: installSource(INSTALL_B) });
    expect(other.id).toBe(a.id);
    clock.t += 3_600;
    await deliver(a, (await otherComputersCopy(other)).envelope);
    const seenAt = clock.t;
    expect((await a.client.devices.state()).otherInUse).toBe(true);
    // The other computer rotates (as the owner's contact-details update does) and keeps sending.
    await rotate(other);
    clock.t += 86_400;
    const newer = await otherComputersCopy(other);
    await a.client.envelopes.receive({ envelope: newer.envelope, giftWrapId: giftWrapId() });
    const reports = await a.client.envelopes.processReceived();
    // Never accepted here as a message or as a sent copy: what is accepted does not widen.
    expect(reports.map((r) => r.outcome)).not.toContain('sent_copy');
    expect(
      await a.store.transaction((tx) => tx.get('envelopes', { envelope_id: newer.id })),
    ).toBeUndefined();
    clock.t = seenAt + 8 * 86_400;
    expect(await a.client.devices.state()).toEqual({ otherInUse: true, otherSeenAt: seenAt });
  });

  it('a contact writing to a newer key of this ID never ends the notice here', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    const b = await makeAgent(clock, new MemoryKeyStore(seed(63)), ownerB, 'bob');
    await pairWith(clock, a, b);
    await a.client.devices.state();
    clock.t += 3_600;
    await deliver(a, (await otherComputersCopy(a)).envelope);
    const seenAt = clock.t;
    clock.t = seenAt + OTHER_INSTALL_NOTICE_SECONDS + 60;
    // Addressed to another enc key of this ID's (the other computer's newer card): not for this
    // agent, so it is never stored and shows nothing.
    const elsewhere = await craft({
      signer: await agentSigner(b.keyStore),
      entries: [{ pk: await agentEnc(b) }, { pk: await ownerEnc(a.owner) }],
      payload: textPayload(),
      createdAt: clock.t,
    });
    await a.client.envelopes.receive({ envelope: elsewhere, giftWrapId: giftWrapId() });
    await a.client.envelopes.processReceived();
    expect((await a.client.devices.state()).otherInUse).toBe(true);
  });

  it('a store that came from another install (a restored snapshot) starts afresh here', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource(INSTALL_A) });
    await a.client.devices.state();
    clock.t += 3_600;
    await deliver(a, (await otherComputersCopy(a)).envelope);
    expect((await a.client.devices.state()).otherInUse).toBe(true);
    clock.t += 600;
    // The same store opened by an install with another id: since moves, the old sighting is not
    // this computer's.
    const moved = await agentWith(clock, {
      installId: installSource(INSTALL_B),
      store: a.store,
    });
    expect(await moved.client.devices.state()).toEqual({
      otherInUse: false,
      otherSeenAt: null,
    });
    const row = await a.store.transaction((tx) =>
      tx.get('install_state', { slot: SINGLETON_SLOT }),
    );
    expect(row).toMatchObject({ install_id: INSTALL_B, since: clock.t });
  });

  it('without an install id source (tests, other hosts) there is no install and no notice', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock);
    clock.t += 3_600;
    await deliver(a, (await otherComputersCopy(a)).envelope);
    expect(await a.client.devices.state()).toEqual({
      otherInUse: false,
      otherSeenAt: null,
    });
  });

  it('an install id that is not 32 lowercase hex is never stored', async () => {
    const clock = new FakeClock();
    const a = await agentWith(clock, { installId: installSource('not-an-id') });
    expect(await a.client.devices.state()).toEqual({ otherInUse: false, otherSeenAt: null });
    const row = await a.store.transaction((tx) =>
      tx.get('install_state', { slot: SINGLETON_SLOT }),
    );
    expect(row).toBeUndefined();
  });

  it('the install id is read from its source once per client', async () => {
    const clock = new FakeClock();
    const source = installSource(INSTALL_A);
    const a = await agentWith(clock, { installId: source });
    await a.client.devices.state();
    await a.client.devices.state();
    expect(source.reads).toBe(1);
  });
});

describe('DEVICES-INTERIM: budget rows carry the install id (07 §3.5)', () => {
  const NOW = 1_800_000_000;
  const policy = defaultPolicy();
  policy.proofs.perActionMaxUSD = '1';
  policy.proofs.hardMaxPerActionUSD = '1000';
  policy.proofs.hardDailyUSD = '1000';
  const effective: EffectivePolicy = { mode: 'signed', policy, version: 1 };

  async function storeWith(install: string | undefined): Promise<MemoryStore> {
    const store = new MemoryStore();
    await store.transaction((tx) => {
      tx.insert('budget_state', {
        slot: SINGLETON_SLOT,
        ledger_epoch: 1,
        status: 'ok',
        newest_t: NOW - 1000,
        since: NOW - 1000,
        broken_at: null,
      });
      if (install !== undefined) {
        tx.insert('install_state', {
          slot: SINGLETON_SLOT,
          install_id: install,
          since: NOW - 1000,
          other_seen_at: null,
        });
      }
    });
    return store;
  }

  const reserve = (store: MemoryStore) =>
    store.transaction((tx) =>
      checkAndReserveProof(tx, {
        effective,
        action: { kind: 'proof', feeUsd: '0.1', maxFeeUsd: '0.1', counterparty: null },
        now: NOW,
        reservation: {
          entryId: 'e0001',
          recordId: `0x${'1'.padStart(64, '0')}`,
          chainId: 8453,
          approvalId: null,
          deadline: NOW + 3600,
        },
        ownerApproved: false,
      }),
    );

  it('a reserved row names this install', async () => {
    const store = await storeWith(INSTALL_A);
    expect((await reserve(store)).reserved).toBe(true);
    const [row] = await store.transaction((tx) => tx.select('budget_ledger'));
    expect(row?.install_id).toBe(INSTALL_A);
  });

  it('a store without an install keeps null (rows from before version 20 read the same)', async () => {
    const store = await storeWith(undefined);
    expect((await reserve(store)).reserved).toBe(true);
    const [row] = await store.transaction((tx) => tx.select('budget_ledger'));
    expect(row?.install_id).toBeNull();
  });
});
