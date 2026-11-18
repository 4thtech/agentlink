// SEC-INVITE-CAPS (S2; D-156; 06 §2.1, §3; 04 §2.5.1 `contact.keep`, §3.6; 07 §3): limits on the
// invites the AI makes, and a contact paired through one waits for the owner.
//
// - An AI-made invite (`createAiInvite`, the one the MCP tool calls): at most `maxOpen` open at once
//   (default 3), at most `perDay` made in any rolling 24 hours (default 5), and it expires after
//   `expiryHours` (default 24). Over a cap: `invite_limit` (InviteLimitError, which cap and when it
//   frees up), nothing stored. The owner sets the caps in the signed policy (`contacts.aiInvites`).
// - Invites the owner makes (`pairing.createInvite`, app and CLI) are neither limited nor counted.
// - A contact paired through an AI-made invite is `waitingForOwner` until the owner keeps it
//   (`contact.keep`, owner-signed). Meanwhile its messages arrive, but the agent sends it nothing:
//   no message or file, no terms, no proof or receipt (`contact_waiting_owner`,
//   `CONTACT_WAITING_OWNER`). Remove works as for any contact.
// - Contacts paired before (or through an owner invite) are kept (null in the store: kept).
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { parseJson, type Envelope, type JsonObject } from '@4thtech-io/crypto';
import { createLogger } from '@4thtech-io/log';
import { AI_INVITE_DEFAULTS, defaultPolicy, type Policy } from '@4thtech-io/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { CoreError, InviteLimitError } from './errors.js';
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
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

/** Publishing is faked: every relay acks (the wraps are real gift wraps). */
const transport: TransportFactory = (deps) => ({
  relayStatus: (relays) => Promise.resolve({ connected: relays.length, total: relays.length }),
  wrap: (envelope, recipients, keys) => wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
  publish: (_event, relays) =>
    Promise.resolve({
      results: relays.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
      acked: [...relays],
      sent: relays.length >= 2,
    } as PublishOutcome),
});

const HOUR = 3_600;
const DAY = 86_400;
const clock = new FakeClock();
const ownerA = new MemoryOwnerKeyStore(seed(231), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(232), passphrase());
const stranger = new MemoryOwnerKeyStore(seed(239), passphrase());

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
    policyMark: new MemoryPolicyMark(),
    transport,
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

async function ownerAction(
  who: Agent,
  op: string,
  params: JsonObject,
  signer: MemoryOwnerKeyStore = who.owner,
): Promise<string> {
  const body: JsonObject = {
    v: 1,
    agent: who.id,
    owner: await ownerHex(signer),
    op,
    params,
    nonce: newNonce(),
    issuedAt: clock.t,
    expiresAt: clock.t + 600,
  };
  return JSON.stringify(await signWith(signer, body));
}

let policyVersion = 0;
async function setPolicy(who: Agent, edit: (p: Policy) => void): Promise<void> {
  const policy = defaultPolicy();
  edit(policy);
  policyVersion += 1;
  const outcome = await who.client.ownerActions.apply(
    await ownerAction(who, 'policy.set', {
      version: policyVersion,
      policy: policy as unknown as JsonObject,
    }),
  );
  expect(outcome.status).toBe('applied');
}

async function deliver(to: Agent, envelope: unknown): Promise<void> {
  const received = await to.client.envelopes.receive({ envelope, giftWrapId: giftWrapId() });
  if (received.status === 'verified') await to.client.envelopes.processReceived();
}

async function lastOut(from: Agent, type: string): Promise<Envelope> {
  const rows = await from.store.transaction((tx) =>
    tx.select('envelopes', { direction: 'out', type }, { orderBy: [['created_at', 'desc']] }),
  );
  const row = rows[0];
  if (row?.envelope_json == null) throw new Error(`test: no ${type}`);
  return parseJson(row.envelope_json) as unknown as Envelope;
}

/** B accepts the link and both sides complete the pairing. */
async function pairThrough(a: Agent, b: Agent, link: string): Promise<void> {
  const accepted = await b.client.pairing.acceptInvite({ link, allowed: true });
  if (accepted.status !== 'pending') throw new Error('test: not accepted');
  await deliver(a, accepted.handshake.envelope);
  await deliver(b, await lastOut(a, 'handshake-ack'));
}

const contactOf = async (who: Agent, id: string) =>
  (await who.client.contacts.list()).find((c) => c.id === id);

const limitOf = async (p: Promise<unknown>): Promise<InviteLimitError> => {
  try {
    await p;
  } catch (error) {
    if (error instanceof InviteLimitError) return error;
    throw error;
  }
  throw new Error('test: no refusal');
};

let a: Agent;
let b: Agent;
beforeEach(async () => {
  clock.t = 1_800_000_000;
  policyVersion = 0;
  a = await agent(61, ownerA, 'alice');
  b = await agent(62, ownerB, 'bob');
});

describe('AI-made invites: caps and expiry', () => {
  it('has the documented defaults: 3 open, 5 a day, 24 hours', () => {
    expect(AI_INVITE_DEFAULTS).toEqual({ maxOpen: 3, perDay: 5, expiryHours: 24 });
  });

  it('expires after 24 hours (an owner invite keeps 7 days)', async () => {
    const ai = await a.client.createAiInvite({});
    expect(ai.expiresAt).toBe(clock.t + 24 * HOUR);
    const owner = await a.client.pairing.createInvite();
    expect(owner.expiresAt).toBe(clock.t + 7 * DAY);
  });

  it('refuses the 4th open AI invite, stores nothing, and frees a slot when one is cancelled', async () => {
    for (let i = 0; i < 3; i += 1) await a.client.createAiInvite({});
    const before = await a.store.transaction((tx) => tx.select('invites').length);
    const refused = await limitOf(a.client.createAiInvite({}));
    expect(refused).toBeInstanceOf(CoreError);
    expect(refused.code).toBe('invite_limit');
    expect(refused.limit).toBe('open');
    expect(refused.max).toBe(3);
    expect(await a.store.transaction((tx) => tx.select('invites').length)).toBe(before);
    const [open] = await a.client.pairing.openInvites();
    expect(await a.client.pairing.cancelInvite(open!.inviteId)).toBe('cancelled');
    await expect(a.client.createAiInvite({})).resolves.toBeDefined();
  });

  it('refuses the 6th AI invite in a rolling 24 hours, used or cancelled ones included', async () => {
    for (let i = 0; i < 5; i += 1) {
      await a.client.createAiInvite({});
      if (i >= 2) {
        const [open] = await a.client.pairing.openInvites();
        await a.client.pairing.cancelInvite(open!.inviteId);
      }
      clock.t += 60;
    }
    const refused = await limitOf(a.client.createAiInvite({}));
    expect(refused.limit).toBe('daily');
    expect(refused.max).toBe(5);
    // Frees up 24 hours after the oldest of the five.
    expect(refused.resetAt).toBe(1_800_000_000 + DAY);
    clock.t = 1_800_000_000 + DAY;
    // Two are still open (the first two); the oldest left the window.
    await expect(a.client.createAiInvite({})).resolves.toBeDefined();
  });

  it('an expired AI invite no longer counts as open', async () => {
    for (let i = 0; i < 3; i += 1) await a.client.createAiInvite({});
    clock.t += 24 * HOUR;
    await expect(a.client.createAiInvite({})).resolves.toBeDefined();
  });

  it('owner invites are not limited and not counted', async () => {
    for (let i = 0; i < 8; i += 1) await a.client.pairing.createInvite();
    for (let i = 0; i < 3; i += 1) await a.client.createAiInvite({});
    expect((await limitOf(a.client.createAiInvite({}))).limit).toBe('open');
    // The owner can still make more while the AI is at its cap.
    await expect(a.client.pairing.createInvite()).resolves.toBeDefined();
    const rows = await a.store.transaction((tx) => tx.select('invites'));
    expect(rows.filter((r) => r.created_by === 'ai')).toHaveLength(3);
    expect(rows.filter((r) => r.created_by === 'owner')).toHaveLength(9);
  });

  it('follows the caps the owner signed in the policy (0 turns AI invites off)', async () => {
    await setPolicy(a, (p) => {
      p.contacts.aiInvites = { maxOpen: 1, perDay: 2, expiryHours: 2 };
    });
    const first = await a.client.createAiInvite({});
    expect(first.expiresAt).toBe(clock.t + 2 * HOUR);
    expect((await limitOf(a.client.createAiInvite({}))).max).toBe(1);
    await setPolicy(a, (p) => {
      p.contacts.aiInvites = { maxOpen: 0, perDay: 0, expiryHours: 24 };
    });
    expect((await limitOf(a.client.createAiInvite({}))).max).toBe(0);
    await expect(a.client.pairing.createInvite()).resolves.toBeDefined();
  });

  it('a policy without aiInvites (signed before it existed) reads as the defaults', async () => {
    await setPolicy(a, () => {});
    for (let i = 0; i < 3; i += 1) await a.client.createAiInvite({});
    expect((await limitOf(a.client.createAiInvite({}))).max).toBe(3);
  });
});

describe('a contact from an AI-made invite waits for the owner', () => {
  async function aiPaired(): Promise<void> {
    const invite = await a.client.createAiInvite({});
    await pairThrough(a, b, invite.inviteUrl);
  }

  it('is waiting on the inviter side only; an owner invite pairs a kept contact', async () => {
    await aiPaired();
    expect((await contactOf(a, b.id))?.waitingForOwner).toBe(true);
    expect((await contactOf(b, a.id))?.waitingForOwner).toBeUndefined();
    const c = await agent(63, stranger, 'carol');
    const owner = await a.client.pairing.createInvite();
    await pairThrough(a, c, owner.inviteUrl);
    expect((await contactOf(a, c.id))?.waitingForOwner).toBeUndefined();
  });

  it('their messages arrive; the agent sends nothing to them until the owner keeps them', async () => {
    await aiPaired();
    await b.client.sendMessage({ to: a.id, text: 'hello alice' });
    await deliver(a, await lastOut(b, 'text'));
    const inbound = await a.store.transaction((tx) =>
      tx.select('envelopes', { direction: 'in', type: 'text', state: 'ok' }),
    );
    expect(inbound).toHaveLength(1);

    const outBefore = await a.store.transaction((tx) => tx.select('outbox').length);
    await expect(a.client.sendMessage({ to: b.id, text: 'hi' })).rejects.toMatchObject({
      code: 'contact_waiting_owner',
    });
    await expect(
      a.client.proposeTerms({ to: b.id, terms: { subject: 'Logo' } }),
    ).rejects.toMatchObject({ code: 'contact_waiting_owner' });
    await expect(
      a.client.respondToTerms({ envelopeId: inbound[0]!.envelope_id, decision: 'reject' }),
    ).rejects.toMatchObject({ code: 'contact_waiting_owner' });
    expect(
      await a.client.acknowledge({ envelopeId: inbound[0]!.envelope_id, type: 'opened' }),
    ).toMatchObject({ status: 'rejected', code: 'CONTACT_WAITING_OWNER' });
    const ack = await a.store.transaction(
      (tx) => tx.select('envelopes', { direction: 'out', type: 'handshake-ack' })[0]!,
    );
    expect(await a.client.notarize({ envelopeId: ack.envelope_id })).toMatchObject({
      status: 'rejected',
      code: 'CONTACT_WAITING_OWNER',
    });
    expect(await a.store.transaction((tx) => tx.select('outbox').length)).toBe(outBefore);

    // Keep (owner-signed): the contact is an ordinary contact from now on.
    const keep = await a.client.ownerActions.apply(
      await ownerAction(a, 'contact.keep', { contact: b.id }),
    );
    expect(keep.status).toBe('applied');
    expect((await contactOf(a, b.id))?.waitingForOwner).toBeUndefined();
    await expect(a.client.sendMessage({ to: b.id, text: 'hi' })).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('the send is refused at commit too (a keep revoked between check and store)', async () => {
    await aiPaired();
    await a.client.ownerActions.apply(await ownerAction(a, 'contact.keep', { contact: b.id }));
    // Back to waiting (as a later AI re-pair after a removal would set it).
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: b.id }, { waiting_owner: 1 }),
    );
    await expect(a.client.sendMessage({ to: b.id, text: 'hi' })).rejects.toMatchObject({
      code: 'contact_waiting_owner',
    });
  });

  it('keep is refused unless signed by this owner, for a waiting contact', async () => {
    await aiPaired();
    expect(
      await a.client.ownerActions.apply(
        await ownerAction(a, 'contact.keep', { contact: b.id }, stranger),
      ),
    ).toMatchObject({ status: 'refused' });
    expect((await contactOf(a, b.id))?.waitingForOwner).toBe(true);
    const unknown = `0x${'ab'.repeat(20)}`;
    expect(
      await a.client.ownerActions.apply(await ownerAction(a, 'contact.keep', { contact: unknown })),
    ).toMatchObject({ status: 'refused', reason: 'contact_unknown' });
    expect(await a.client.ownerActions.prepareContactKeep(b.id)).toMatchObject({
      status: 'prepared',
      op: 'contact.keep',
    });
    await a.client.ownerActions.apply(await ownerAction(a, 'contact.keep', { contact: b.id }));
    expect(
      await a.client.ownerActions.apply(await ownerAction(a, 'contact.keep', { contact: b.id })),
    ).toMatchObject({ status: 'refused', reason: 'not_waiting' });
    expect(await a.client.ownerActions.prepareContactKeep(b.id)).toMatchObject({
      status: 'refused',
      reason: 'not_waiting',
    });
  });

  it('Remove works for a waiting contact', async () => {
    await aiPaired();
    const removed = await a.client.ownerActions.apply(
      await ownerAction(a, 'contact.remove', { contact: b.id }),
    );
    expect(removed.status).toBe('applied');
    expect(await contactOf(a, b.id)).toBeUndefined();
  });

  it('an AI re-pair keeps a contact the owner already kept; a removed one waits again', async () => {
    const owner = await a.client.pairing.createInvite();
    await pairThrough(a, b, owner.inviteUrl);
    clock.t += 10;
    await pairThrough(a, b, (await a.client.createAiInvite({})).inviteUrl);
    expect((await contactOf(a, b.id))?.waitingForOwner).toBeUndefined();
    await a.client.ownerActions.apply(await ownerAction(a, 'contact.remove', { contact: b.id }));
    clock.t += 10;
    await pairThrough(a, b, (await a.client.createAiInvite({})).inviteUrl);
    const row = await a.store.transaction((tx) => tx.get('contacts', { contact_id: b.id }));
    expect([row?.status, row?.waiting_owner]).toEqual(['active', 1]);
  });
});

describe('migration: what was there before is kept', () => {
  it('a contact row with waiting_owner null is kept and sendable', async () => {
    const owner = await a.client.pairing.createInvite();
    await pairThrough(a, b, owner.inviteUrl);
    const row = await a.store.transaction((tx) => tx.get('contacts', { contact_id: b.id }));
    expect(row?.waiting_owner).toBeNull();
    await expect(a.client.sendMessage({ to: b.id, text: 'hi' })).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('an invite row with created_by null (made before) counts as the owner’s', async () => {
    const before = await a.client.pairing.createInvite();
    for (let i = 0; i < 2; i += 1) await a.client.pairing.createInvite();
    await a.store.transaction((tx) => {
      for (const r of tx.select('invites')) {
        tx.update('invites', { invite_id: r.invite_id }, { created_by: null });
      }
    });
    // Not counted against the AI's 3 open.
    for (let i = 0; i < 3; i += 1) await a.client.createAiInvite({});
    // Its pairing gives a kept contact.
    await pairThrough(a, b, before.inviteUrl);
    expect((await contactOf(a, b.id))?.waitingForOwner).toBeUndefined();
  });
});

// Fable review (IR-SEC-INVITE-CAPS): no ack, card-update or other automatic send to a waiting
// contact; the AI's own accepts under `acceptInvites: auto` count and wait; Activity lists Keep.
describe('review follow-ups', () => {
  async function aiPaired(): Promise<void> {
    const invite = await a.client.createAiInvite({});
    await pairThrough(a, b, invite.inviteUrl);
  }

  it('no received ack to a waiting contact; one once kept (M2)', async () => {
    await aiPaired();
    await b.client.sendMessage({ to: a.id, text: 'hello' });
    await deliver(a, await lastOut(b, 'text'));
    const [inbound] = await a.store.transaction((tx) =>
      tx.select('envelopes', { direction: 'in', type: 'text', state: 'ok' }),
    );
    const report = { outcome: 'ok', contactId: b.id, envelopeId: inbound!.envelope_id } as never;
    expect(await a.client.acks.sendFor([report])).toBe(0);
    await a.client.ownerActions.apply(await ownerAction(a, 'contact.keep', { contact: b.id }));
    expect(await a.client.acks.sendFor([report])).toBe(1);
  });

  it('an accept the AI starts on its own counts toward the daily cap, and its contact waits', async () => {
    await setPolicy(b, (p) => {
      p.contacts.acceptInvites = 'auto';
      p.contacts.aiInvites = { maxOpen: 3, perDay: 2, expiryHours: 24 };
    });
    await b.client.createAiInvite({});
    const invite = await a.client.pairing.createInvite();
    const accepted = await b.client.acceptInviteByAi(invite.inviteUrl);
    if (accepted.status !== 'pending') throw new Error('test: not accepted');
    // Staged: 1 AI invite + 1 AI accept = the cap of 2.
    expect((await limitOf(b.client.createAiInvite({}))).limit).toBe('daily');
    await deliver(a, accepted.handshake.envelope);
    await deliver(b, await lastOut(a, 'handshake-ack'));
    expect((await contactOf(b, a.id))?.waitingForOwner).toBe(true);
    const row = await b.store.transaction((tx) => tx.get('contacts', { contact_id: a.id }));
    expect(row?.ai_accepted_at).toBe(clock.t);
    // Completed, it still counts (from the contact row now).
    expect((await limitOf(b.client.createAiInvite({}))).limit).toBe('daily');
    const c = await agent(64, stranger, 'carol');
    await expect(
      b.client.acceptInviteByAi((await c.client.pairing.createInvite()).inviteUrl),
    ).rejects.toBeInstanceOf(InviteLimitError);
  });

  it('an owner-approved accept gives a kept contact', async () => {
    const invite = await a.client.pairing.createInvite();
    await pairThrough(a, b, invite.inviteUrl);
    expect((await contactOf(b, a.id))?.waitingForOwner).toBeUndefined();
  });

  it('Activity lists the Keep', async () => {
    await aiPaired();
    clock.t += 5;
    await a.client.ownerActions.apply(await ownerAction(a, 'contact.keep', { contact: b.id }));
    const feed = await a.client.activity.list({ limit: 100 });
    expect(feed.items.find((e) => e.kind === 'contact_kept')).toMatchObject({
      contactId: b.id,
    });
  });
});
