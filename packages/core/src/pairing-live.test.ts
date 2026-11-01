// W5-INVITE-FEEDBACK (08 §1 "Contacts and invites, live"; 04 §2.9 re-pair): what the local app reads
// to show both sides of an invite while it happens, with no reload.
//
// - `contacts.connecting()`: the invitee's accepts that wait for the inviter's answer (staged
//   `pairings`), as the name rule shows them, with their expiry, whether the handshake is still in
//   the outbox (`sent`), and whether the agent is already a paired contact (`again`, a re-pair).
//   Never a card, key, link or pairing ID.
// - `ContactView.pairedAt`: when the kept pairing's handshake was made, so a re-pair is visible.
// - `pairing.changeMark()`: an opaque digest of the plain columns that change when a contact or an
//   invite does; the host compares it and never sends it.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { parseJson, type Envelope } from '@4thtech-io/crypto';
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
const ownerA = new MemoryOwnerKeyStore(seed(211), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(212), passphrase());

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly id: string;
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
  return { client, store, id: client.agentId };
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

/** B accepts A's invite; returns the handshake to hand to A. */
async function accept(a: Agent, b: Agent) {
  const invite = await a.client.pairing.createInvite();
  const accepted = await b.client.pairing.acceptInvite({ link: invite.inviteUrl, allowed: true });
  if (accepted.status !== 'pending') throw new Error('test: not accepted');
  return { invite, accepted };
}

async function pairFully(a: Agent, b: Agent): Promise<void> {
  const { accepted } = await accept(a, b);
  await deliver(a, accepted.handshake.envelope);
  await deliver(b, await lastAck(a));
}

let a: Agent;
let b: Agent;
beforeEach(async () => {
  a = await agent(21, ownerA, 'alice');
  b = await agent(22, ownerB, 'bob');
});

describe('contacts.connecting (W5-INVITE-FEEDBACK)', () => {
  it('lists an accept that waits for the answer, then nothing once it completed', async () => {
    expect(await b.client.contacts.connecting()).toEqual([]);
    const { accepted } = await accept(a, b);
    const rows = await b.client.contacts.connecting();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(Object.keys(row ?? {}).sort()).toEqual(['again', 'display', 'expiresAt', 'id', 'sent']);
    expect(row?.id).toBe(a.id);
    expect(row?.display.name).toBe('alice');
    expect(row?.display.label).toBe('self-declared');
    expect(row?.again).toBe(false);
    // Nothing published it yet: the handshake waits in the outbox.
    expect(row?.sent).toBe(false);
    expect(row?.expiresAt).toBeGreaterThan(clock.t);
    // The inviter has no staged accept of its own.
    expect(await a.client.contacts.connecting()).toEqual([]);
    await deliver(a, accepted.handshake.envelope);
    await deliver(b, await lastAck(a));
    expect(await b.client.contacts.connecting()).toEqual([]);
  });

  it('says sent once the handshake left the outbox', async () => {
    const { accepted } = await accept(a, b);
    await b.store.transaction((tx) =>
      tx.update(
        'envelopes',
        { envelope_id: accepted.pairingId },
        { delivery: 'sent' },
      ),
    );
    expect((await b.client.contacts.connecting())[0]?.sent).toBe(true);
  });

  it('marks a re-pair with an existing contact (again), under the name the owner sees', async () => {
    await pairFully(a, b);
    clock.t += 10;
    await accept(a, b);
    const [row] = await b.client.contacts.connecting();
    expect(row?.again).toBe(true);
    const [shown] = await b.client.contacts.list();
    expect(row?.display.name).toBe(shown?.display.name);
  });

  it('leaves out an expired accept', async () => {
    await accept(a, b);
    clock.t += 30 * 86_400;
    expect(await b.client.contacts.connecting()).toEqual([]);
  });
});

describe('ContactView.pairedAt (W5-INVITE-FEEDBACK)', () => {
  it('is set on a paired contact and moves forward on a re-pair, on both sides', async () => {
    await pairFully(a, b);
    const first = (await a.client.contacts.list())[0]?.pairedAt;
    const firstB = (await b.client.contacts.list())[0]?.pairedAt;
    expect(typeof first).toBe('number');
    expect(firstB).toBe(first);
    clock.t += 60;
    await pairFully(a, b);
    const again = (await a.client.contacts.list())[0]?.pairedAt;
    expect(again).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY);
    expect((await b.client.contacts.list())[0]?.pairedAt).toBe(again);
    // Still one contact on each side: the re-pair updated it in place.
    expect(await a.client.contacts.list()).toHaveLength(1);
  });
});

describe('pairing.changeMark (W5-INVITE-FEEDBACK)', () => {
  it('is stable while nothing changes and moves on every contact or invite change', async () => {
    const marks = new Set<string>();
    const mark = async (x: Agent): Promise<string> => {
      const m = await x.client.pairing.changeMark();
      expect(typeof m).toBe('string');
      expect(m.length).toBeLessThanOrEqual(64);
      return m;
    };
    const start = await mark(a);
    expect(await mark(a)).toBe(start);
    marks.add(start);
    const invite = await a.client.pairing.createInvite();
    const created = await mark(a);
    expect(marks.has(created)).toBe(false);
    marks.add(created);
    const cancelled = await a.client.pairing.cancelInvite(invite.inviteId);
    expect(cancelled).toBe('cancelled');
    const afterCancel = await mark(a);
    expect(marks.has(afterCancel)).toBe(false);
    marks.add(afterCancel);

    const bStart = await mark(b);
    const { accepted } = await accept(a, b);
    const bStaged = await mark(b);
    expect(bStaged).not.toBe(bStart);
    const aOpen = await mark(a);
    await deliver(a, accepted.handshake.envelope);
    const aDone = await mark(a);
    expect(aDone).not.toBe(aOpen);
    await deliver(b, await lastAck(a));
    expect(await mark(b)).not.toBe(bStaged);
  });

  it('never holds a contact ID, an invite ID or a name in the clear', async () => {
    await pairFully(a, b);
    const invite = await a.client.pairing.createInvite();
    const m = await a.client.pairing.changeMark();
    expect(m).not.toContain(b.id.slice(2, 12));
    expect(m).not.toContain(invite.inviteId);
    expect(m).not.toContain('bob');
  });
});
