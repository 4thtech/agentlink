// REL051-B1 (N2; S2; 04 §2.5.1 `contact.unblock`, §2.9; 07 §3.2 `blocked_keys`; 08 §1; proposed,
// owner confirms at merge): an accept that waits on a person the owner blocked.
//
// The case: the owner blocks Bo, then removes Bo (Bo's keys stay in `blocked_keys`, audit L2). Bo
// sends a fresh invite and the owner accepts it. Bo's answer is dropped, so the accept never finishes.
// - `contacts.connecting()` says so: `blocked` is true while the contact is blocked or its key is in
//   `blocked_keys`, false otherwise.
// - `contacts.cancelConnecting(id)` drops this agent's waiting accepts for that contact (the staged
//   invitee pairings only); an answer that arrives later completes nothing.
// - `contact.unblock` also unblocks a removed contact whose keys are blocked: it deletes those
//   `blocked_keys` rows and leaves the contact removed (its removal time unchanged), so the accept
//   made after the removal can finish when the answer arrives. A removed contact with no blocked key
//   is still `contact_unknown`.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { parseJson, type Envelope, type JsonObject } from '@4thtech-io/crypto';
import { createLogger } from '@4thtech-io/log';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { giftWrapId } from './testing/envelopes.js';

const clock = new FakeClock();
const ownerA = new MemoryOwnerKeyStore(seed(231), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(232), passphrase());

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly id: string;
  readonly owner: MemoryOwnerKeyStore;
}

async function agent(n: number, owner: MemoryOwnerKeyStore, name: string): Promise<Agent> {
  const store = new MemoryStore();
  const client = await AgentLinkClient.create({
    keyStore: new MemoryKeyStore(seed(n)),
    store,
    cipher: new TestStoreCipher(),
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    logger: createLogger({ name: 'core', level: 'error', sink: () => undefined }),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  return { client, store, id: client.agentId, owner };
}

async function deliver(to: Agent, envelope: unknown): Promise<void> {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  if (received.status === 'verified') await to.client.envelopes.processReceived();
}

async function lastAck(from: Agent): Promise<Envelope> {
  const rows = await from.store.transaction((tx) =>
    tx.select(
      'envelopes',
      { direction: 'out', type: 'handshake-ack' },
      { orderBy: [['created_at', 'desc']] },
    ),
  );
  const row = rows[0];
  if (row?.envelope_json == null) throw new Error('test: no ack');
  return parseJson(row.envelope_json) as unknown as Envelope;
}

/** `invitee` accepts an invite of `inviter`; returns the handshake to hand to the inviter. */
async function accept(inviter: Agent, invitee: Agent) {
  const invite = await inviter.client.pairing.createInvite();
  const accepted = await invitee.client.pairing.acceptInvite({
    link: invite.inviteUrl,
    allowed: true,
  });
  if (accepted.status !== 'pending') throw new Error('test: not accepted');
  return accepted;
}

async function pairFully(inviter: Agent, invitee: Agent): Promise<void> {
  const accepted = await accept(inviter, invitee);
  await deliver(inviter, accepted.handshake.envelope);
  await deliver(invitee, await lastAck(inviter));
}

async function signed(owner: MemoryOwnerKeyStore, body: unknown): Promise<string> {
  const session = await owner.unlock(passphrase());
  try {
    return JSON.stringify({ body, sig: await session.signOwnerAction(body as JsonObject) });
  } finally {
    await session.close();
  }
}

async function unblock(me: Agent, contact: string) {
  const prepared = await me.client.ownerActions.prepareContactUnblock(contact);
  if (prepared.status !== 'prepared') return prepared;
  return me.client.ownerActions.apply(await signed(me.owner, prepared.body));
}

const status = async (me: Agent, id: string) =>
  (await me.store.transaction((tx) => tx.get('contacts', { contact_id: id })))?.status;
const blockedKeys = (me: Agent) =>
  me.store.transaction((tx) => tx.select('blocked_keys').map((r) => r.from_key));
const invitee = (me: Agent) =>
  me.store.transaction((tx) => tx.select('pairings', { role: 'invitee' }));

let bo: Agent;
let me: Agent;
beforeEach(async () => {
  bo = await agent(31, ownerA, 'bo');
  me = await agent(32, ownerB, 'me');
  // Bo invites, I accept: we are contacts. Then I block Bo and remove Bo.
  await pairFully(bo, me);
  clock.t += 10;
  await me.client.contacts.block(bo.id);
  await me.client.contacts.remove(bo.id);
  clock.t += 10;
});

describe('N2: contacts.connecting says when the person is blocked here', () => {
  it('a fresh accept from a blocked-then-removed person is blocked, and never finishes', async () => {
    expect(await blockedKeys(me)).toHaveLength(1);
    const accepted = await accept(bo, me);
    const [row] = await me.client.contacts.connecting();
    expect(row?.id).toBe(bo.id);
    expect(row?.blocked).toBe(true);
    // Bo answers; the answer is dropped (the block holds) and the accept still waits.
    await deliver(bo, accepted.handshake.envelope);
    await deliver(me, await lastAck(bo));
    expect(await status(me, bo.id)).toBe('removed');
    expect((await me.client.contacts.connecting())[0]?.blocked).toBe(true);
  });

  it('a re-pair with a contact that is blocked (not removed) is blocked too', async () => {
    const other = await agent(33, new MemoryOwnerKeyStore(seed(233), passphrase()), 'ana');
    await pairFully(other, me);
    await me.client.contacts.block(other.id);
    clock.t += 10;
    await accept(other, me);
    const row = (await me.client.contacts.connecting()).find((r) => r.id === other.id);
    expect(row?.again).toBe(false);
    expect(row?.blocked).toBe(true);
  });

  it('an accept from someone not blocked is not blocked', async () => {
    const other = await agent(34, new MemoryOwnerKeyStore(seed(234), passphrase()), 'eva');
    await accept(other, me);
    const row = (await me.client.contacts.connecting()).find((r) => r.id === other.id);
    expect(row?.blocked).toBe(false);
  });
});

describe('N2: contacts.cancelConnecting drops a waiting accept', () => {
  it('cancels only the waiting accepts for that contact; a later answer completes nothing', async () => {
    const accepted = await accept(bo, me);
    expect(await me.client.contacts.cancelConnecting(bo.id)).toBe('cancelled');
    expect(await me.client.contacts.connecting()).toEqual([]);
    expect(await invitee(me)).toEqual([]);
    expect(await me.client.contacts.cancelConnecting(bo.id)).toBe('not_found');
    // Even unblocked, Bo's answer to the cancelled accept completes nothing.
    expect(await unblock(me, bo.id)).toEqual({ status: 'applied', op: 'contact.unblock' });
    await deliver(bo, accepted.handshake.envelope);
    await deliver(me, await lastAck(bo));
    expect(await status(me, bo.id)).toBe('removed');
  });

  it('refuses an unknown or malformed contact, changing nothing', async () => {
    await accept(bo, me);
    for (const id of [`0x${'9'.repeat(40)}`, 'bo', `0x${'A'.repeat(40)}`, '']) {
      expect(await me.client.contacts.cancelConnecting(id)).toBe('not_found');
    }
    expect(await invitee(me)).toHaveLength(1);
  });
});

describe('N2: contact.unblock for a removed contact whose keys are blocked', () => {
  it('prepares and applies: the keys are unblocked, the contact stays removed', async () => {
    const removedAt = (
      await me.store.transaction((tx) => tx.get('contacts', { contact_id: bo.id }))
    )?.updated_at;
    expect(await unblock(me, bo.id)).toEqual({ status: 'applied', op: 'contact.unblock' });
    expect(await blockedKeys(me)).toEqual([]);
    expect(await status(me, bo.id)).toBe('removed');
    expect(
      (await me.store.transaction((tx) => tx.get('contacts', { contact_id: bo.id })))?.updated_at,
    ).toBe(removedAt);
    // Once is enough: nothing is blocked any more.
    expect(await me.client.ownerActions.prepareContactUnblock(bo.id)).toMatchObject({
      status: 'refused',
      reason: 'contact_unknown',
    });
  });

  it('after the unblock, the waiting accept finishes when the answer arrives', async () => {
    const accepted = await accept(bo, me);
    expect(await unblock(me, bo.id)).toEqual({ status: 'applied', op: 'contact.unblock' });
    expect((await me.client.contacts.connecting())[0]?.blocked).toBe(false);
    await deliver(bo, accepted.handshake.envelope);
    await deliver(me, await lastAck(bo));
    expect(await status(me, bo.id)).toBe('active');
    expect(await me.client.contacts.connecting()).toEqual([]);
  });

  it('a removed contact with no blocked key is still unknown to unblock', async () => {
    const other = await agent(35, new MemoryOwnerKeyStore(seed(235), passphrase()), 'ivo');
    await pairFully(other, me);
    await me.client.contacts.remove(other.id);
    expect(await me.client.ownerActions.prepareContactUnblock(other.id)).toMatchObject({
      status: 'refused',
      reason: 'contact_unknown',
    });
  });
});
