// REL051-CF1 (S2; 04 §2.9, §3.6; 07 §3 `pairings`, §3.2 `rate_counters`; 06 §2.1, §6; 08 §1;
// proposed, owner confirms at merge): an accept that waits says how long it has waited, and says
// "blocked" exactly when its completion would be refused; the owner's own ID names are not held to
// the role-word rule meant for other people's names; a second answer from the invite's own contact
// still spends that contact's rate.
//
// - R1-CLASS-01, -06: `contacts.connecting()` answers `startedAt` (the staged row's `created_at`, unix
//   seconds), so the app can say "still waiting" after a short time and "no answer" after a bounded
//   one, also after a restart (the time comes from the store, not the page).
// - R2-7: `blocked` is `!pairingAllowedTx` (R1-SEC-02, bound to the contact) or the staged key in
//   `blocked_keys`: a contact blocked and removed that rotated its key reads blocked too, as its
//   completion is refused.
// - R2-5: an own ID name "Assistant", "Agent", "Me", "User" or "Developer" (allowed in 0.5.0) is a
//   valid `agent.label`, loads as verified and may be chosen again; other people's names keep the
//   role-word rule (`restrictName`).
// - R2-6: an `invite_used` refusal filed under the sender's own contact counts toward its rate.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import {
  encodeBase64url,
  encodeHex,
  parseJson,
  randomBytes,
  type Envelope,
  type JsonObject,
} from '@4thtech-io/crypto';
import { createLogger } from '@4thtech-io/log';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { isOwnIdName, isRestrictedAlias, restrictName } from './names.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { giftWrapId, rotate, type TestAgent } from './testing/envelopes.js';

const clock = new FakeClock();
const ownerA = new MemoryOwnerKeyStore(seed(251), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(252), passphrase());

type Agent = TestAgent;

async function agent(n: number, owner: MemoryOwnerKeyStore, name: string): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore = new MemoryKeyStore(seed(n));
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
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
  return {
    client,
    store,
    cipher,
    keyStore,
    owner: owner as unknown as TestAgent['owner'],
    id: client.agentId,
  };
}

async function deliver(to: Agent, envelope: unknown) {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  if (received.status !== 'verified') return [received.report];
  return to.client.envelopes.processReceived();
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

async function accept(inviter: Agent, invitee: Agent, link?: string) {
  const url = link ?? (await inviter.client.pairing.createInvite()).inviteUrl;
  const accepted = await invitee.client.pairing.acceptInvite({ link: url, allowed: true });
  if (accepted.status !== 'pending') throw new Error('test: not accepted');
  return accepted;
}

async function pairFully(inviter: Agent, invitee: Agent) {
  const invite = await inviter.client.pairing.createInvite();
  const accepted = await accept(inviter, invitee, invite.inviteUrl);
  await deliver(inviter, accepted.handshake.envelope);
  await deliver(invitee, await lastAck(inviter));
  return invite;
}

let bo: Agent;
let me: Agent;
beforeEach(async () => {
  clock.t = 1_800_000_000;
  bo = await agent(41, ownerA, 'bo');
  me = await agent(42, ownerB, 'me');
});

describe('R1-CLASS-01/06: a waiting accept says when it began', () => {
  it('answers startedAt, the time the accept was staged, and keeps it after time passes', async () => {
    const at = clock.t;
    await accept(bo, me);
    clock.t += 180;
    const [row] = await me.client.contacts.connecting();
    expect(row?.startedAt).toBe(at);
    expect(row?.blocked).toBe(false);
  });
});

describe('R2-7: `blocked` follows the completion rule (pairingAllowedTx)', () => {
  it('a contact blocked, removed and then rotated reads blocked, and its answer completes nothing', async () => {
    await pairFully(bo, me);
    clock.t += 10;
    await me.client.contacts.block(bo.id);
    await me.client.contacts.remove(bo.id);
    clock.t += 10;
    // Bo's key changes: the fresh invite comes from a key `blocked_keys` does not hold.
    await rotate(bo);
    const accepted = await accept(bo, me);
    const [row] = await me.client.contacts.connecting();
    expect(row?.id).toBe(bo.id);
    expect(row?.blocked).toBe(true);
    await deliver(bo, accepted.handshake.envelope);
    await deliver(me, await lastAck(bo));
    expect(
      (await me.store.transaction((tx) => tx.get('contacts', { contact_id: bo.id })))?.status,
    ).toBe('removed');
  });

  it('a plain remove (no block) is not blocked: a fresh accept may finish', async () => {
    await pairFully(bo, me);
    clock.t += 10;
    await me.client.contacts.remove(bo.id);
    clock.t += 10;
    await rotate(bo);
    await accept(bo, me);
    expect((await me.client.contacts.connecting())[0]?.blocked).toBe(false);
  });
});

describe('R2-6: a second answer from the invite’s own contact spends its rate', () => {
  const rate = (x: Agent, id: string) =>
    x.store.transaction((tx) =>
      tx
        .select('rate_counters')
        .filter((r) => r.contact_id === id)
        .reduce((sum, r) => sum + r.count, 0),
    );

  it('counts the refused answer under that contact', async () => {
    const invite = await pairFully(bo, me);
    const before = await rate(bo, me.id);
    clock.t += 10;
    const again = await accept(bo, me, invite.inviteUrl);
    const reports = await deliver(bo, again.handshake.envelope);
    expect(reports.map((r) => r.outcome)).toEqual(['refused']);
    expect(await rate(bo, me.id)).toBe(before + 1);
  });
});

describe('R2-5: the owner’s own ID names are not held to the role-word rule', () => {
  const ROLE_NAMES = ['Assistant', 'Agent', 'Me', 'User', 'Developer', 'Contact Ana'];

  it.each(ROLE_NAMES)('%j is a valid own ID name, but still not a name from someone else', (n) => {
    expect(isOwnIdName(n)).toBe(true);
    expect(isRestrictedAlias(n)).toBe(false);
    expect(restrictName(n, 'AB12·CD34')).not.toBe(n);
  });

  it.each(['AgentLink', 'Agent1ink', 'Verified', 'Owner', '0wner', 'Work  agent', ''])(
    '%j stays refused as an own ID name (reserved words and look-alikes)',
    (n) => {
      expect(isOwnIdName(n)).toBe(false);
    },
  );

  async function signedLabel(x: Agent, label: string): Promise<string> {
    const body: JsonObject = {
      v: 1,
      agent: x.id,
      owner: encodeHex((await ownerB.getPublicKeys()).ownerNostr),
      op: 'agent.label',
      params: { agent: x.id, label },
      nonce: encodeBase64url(randomBytes(16)),
      issuedAt: clock.t,
      expiresAt: clock.t + 600,
    };
    const session = await ownerB.unlock(passphrase());
    try {
      return JSON.stringify({ body, sig: await session.signOwnerAction(body) });
    } finally {
      await session.close();
    }
  }

  it.each(ROLE_NAMES.slice(0, 5))(
    'an ID labelled %j (as 0.5.0 allowed) applies, loads verified and can be chosen again',
    async (label) => {
      expect(await me.client.ownerActions.apply(await signedLabel(me, label))).toEqual({
        status: 'applied',
        op: 'agent.label',
      });
      expect(await me.client.ownerActions.loadLabel()).toEqual({ status: 'verified', label });
      expect((await me.client.ownerActions.prepareLabel(label)).status).toBe('prepared');
    },
  );
});
