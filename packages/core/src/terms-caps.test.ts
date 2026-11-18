// SEC-TERMS-CAPS (D-156; 06 §3 `outgoing`): the terms envelopes (`offer`, `accept`, `reject`) count
// toward the outgoing caps as `agentlink_send` messages do, in the transaction that stores them. Over
// a cap: SEND_LIMIT with the cap, its number and `retryAt`; nothing stored, claimed or published; the
// refusal is not kept under a clientRequestId, and an approved accept stays runnable later.
import { parseJson, type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLinkClient } from './client.js';
import { computeActionDigest } from './owner-action.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { pairWith, type TestOwner } from './testing/envelopes.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400;
let clock: FakeClock;

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestStoreCipher;
  readonly keyStore: MemoryKeyStore;
  readonly owner: TestOwner;
  readonly id: string;
  readonly published: { n: number };
  policyVersion: number;
}

const RELAYS = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const ownerA = new MemoryOwnerKeyStore(seed(231), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(232), passphrase());
const ownerC = new MemoryOwnerKeyStore(seed(233), passphrase());

async function openAgent(n: number, owner: TestOwner, name: string): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore = new MemoryKeyStore(seed(n));
  const published = { n: 0 };
  const factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (_event, relays) => {
      published.n += 1;
      return Promise.resolve({
        results: relays.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
        acked: [...relays],
        sent: true,
      } as PublishOutcome);
    },
  });
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: factory,
    policyMark: new MemoryPolicyMark(),
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
    owner,
    id: client.agentId,
    published,
    policyVersion: 0,
  };
}

async function pair(a: Agent, b: Agent): Promise<void> {
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
}

async function signedOwner(agent: Agent, op: string, params: JsonObject) {
  return JSON.stringify(
    await signWith(agent.owner, {
      v: 1,
      agent: agent.id,
      owner: await ownerHex(agent.owner),
      op,
      params,
      nonce: newNonce(),
      issuedAt: clock.t,
      expiresAt: clock.t + 600,
    }),
  );
}

/** Applies an owner-signed policy with these outgoing caps (the only way to change them, I-4). */
async function applyCaps(agent: Agent, caps: Partial<NonNullable<Policy['outgoing']>>) {
  const policy = defaultPolicy();
  policy.outgoing = { ...policy.outgoing!, ...caps };
  agent.policyVersion += 1;
  const r = await agent.client.ownerActions.apply(
    await signedOwner(agent, 'policy.set', {
      version: agent.policyVersion,
      policy: policy as unknown as JsonObject,
    }),
  );
  expect(r).toMatchObject({ status: 'applied' });
}

async function approve(agent: Agent, approvalId: string) {
  const row = await agent.store.transaction((tx) =>
    tx.get('approvals', { approval_id: approvalId }),
  );
  const text = await agent.cipher.open(
    { table: 'approvals', column: 'action_json', rowKey: JSON.stringify([approvalId]) },
    row!.action_json,
  );
  return agent.client.ownerActions.apply(
    await signedOwner(agent, 'approval.decide', {
      approvalId,
      actionDigest: computeActionDigest(parseJson(text) as JsonObject),
      decision: 'approve',
    }),
  );
}

/** Hands every terms envelope `from` stored for `to` to `to`'s receive path. */
async function deliver(from: Agent, to: Agent) {
  const rows = await from.store.transaction((tx) =>
    tx
      .select('envelopes', { direction: 'out', contact_id: to.id })
      .filter((r) => ['offer', 'accept', 'reject'].includes(r.type)),
  );
  for (const row of rows) {
    await to.client.envelopes.receive({ envelope: parseJson(row.envelope_json ?? '') });
  }
  return to.client.envelopes.processReceived();
}

const terms = (subject = 'Website redesign') => ({
  subject,
  deliverables: [{ description: 'Design files', by: 'them' }],
  price: { amount: '500.00', currency: 'USD', payer: 'me' },
});

const termsOut = (agent: Agent, type?: string) =>
  agent.store.transaction((tx) =>
    tx
      .select('envelopes', { direction: 'out' })
      .filter((r) =>
        (type === undefined ? ['offer', 'accept', 'reject'] : [type]).includes(r.type),
      ),
  );

const logged = (agent: Agent) => agent.store.transaction((tx) => tx.select('outgoing_log', {}));

const isoAt = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

beforeEach(() => {
  clock = new FakeClock();
});

describe('terms count toward the outgoing caps (SEC-TERMS-CAPS, D-156)', () => {
  it('an offer over the per-contact cap is SEND_LIMIT; nothing stored or published', async () => {
    const a = await openAgent(41, ownerA, 'alice');
    const b = await openAgent(42, ownerB, 'bob');
    await pair(a, b);
    await applyCaps(a, { messagesPerContactPerDay: 2 });

    expect((await a.client.proposeTerms({ to: b.id, terms: terms('one') })).status).toBe('ok');
    expect((await a.client.proposeTerms({ to: b.id, terms: terms('two') })).status).toBe('ok');
    expect(await logged(a)).toHaveLength(2);
    const before = a.published.n;
    const refused = await a.client.proposeTerms({ to: b.id, terms: terms('three') });
    expect(refused).toMatchObject({
      status: 'rejected',
      code: 'SEND_LIMIT',
      limit: 'messages_contact',
      max: 2,
      retryAt: isoAt(clock.t + DAY),
    });
    expect(await termsOut(a, 'offer')).toHaveLength(2);
    expect(await logged(a)).toHaveLength(2);
    expect(a.published.n).toBe(before);
  });

  it('terms and messages share one count, per contact and per day', async () => {
    const a = await openAgent(43, ownerA, 'alice');
    const b = await openAgent(44, ownerB, 'bob');
    const c = await openAgent(45, ownerC, 'carol');
    await pair(a, b);
    await pair(a, c);
    await applyCaps(a, { messagesPerContactPerDay: 2, messagesPerDay: 3 });

    expect((await a.client.sendMessage({ to: b.id, text: 'hi' })).status).toBe('ok');
    expect((await a.client.proposeTerms({ to: b.id, terms: terms() })).status).toBe('ok');
    expect(await a.client.sendMessage({ to: b.id, text: 'again' })).toMatchObject({
      code: 'SEND_LIMIT',
      limit: 'messages_contact',
    });
    expect((await a.client.proposeTerms({ to: c.id, terms: terms() })).status).toBe('ok');
    expect(await a.client.proposeTerms({ to: c.id, terms: terms('more') })).toMatchObject({
      code: 'SEND_LIMIT',
      limit: 'messages_day',
      max: 3,
    });
    expect(await a.client.sendMessage({ to: c.id, text: 'x' })).toMatchObject({
      code: 'SEND_LIMIT',
      limit: 'messages_day',
    });
  });

  it('a reject and a counter count; over the cap they are SEND_LIMIT and send nothing', async () => {
    const a = await openAgent(46, ownerA, 'alice');
    const b = await openAgent(47, ownerB, 'bob');
    await pair(a, b);
    const offer = await a.client.proposeTerms({ to: b.id, terms: terms() });
    expect(offer.status).toBe('ok');
    await deliver(a, b);
    const envelopeId = (offer as { envelopeId: string }).envelopeId;
    await applyCaps(b, { messagesPerContactPerDay: 1 });
    expect((await b.client.sendMessage({ to: a.id, text: 'thinking' })).status).toBe('ok');

    const before = b.published.n;
    expect(await b.client.respondToTerms({ envelopeId, decision: 'reject' })).toMatchObject({
      status: 'rejected',
      code: 'SEND_LIMIT',
      limit: 'messages_contact',
      max: 1,
    });
    expect(
      await b.client.respondToTerms({
        envelopeId,
        decision: 'counter',
        terms: terms('counter'),
      }),
    ).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT' });
    expect(await termsOut(b)).toHaveLength(0);
    expect(b.published.n).toBe(before);

    clock.t += DAY + 1;
    expect((await b.client.respondToTerms({ envelopeId, decision: 'reject' })).status).toBe('ok');
    expect(await termsOut(b, 'reject')).toHaveLength(1);
    expect(await logged(b)).toHaveLength(1);
  });

  it('an approved accept over the cap is SEND_LIMIT, claims nothing, and runs once the window rolls', async () => {
    const a = await openAgent(48, ownerA, 'alice');
    const b = await openAgent(49, ownerB, 'bob');
    await pair(a, b);
    const offer = await a.client.proposeTerms({ to: b.id, terms: terms() });
    await deliver(a, b);
    const envelopeId = (offer as { envelopeId: string }).envelopeId;
    const asked = await b.client.respondToTerms({ envelopeId, decision: 'accept' });
    expect(asked.status).toBe('pending_approval');
    const approvalId = (asked as { approvalId: string }).approvalId;
    expect(await approve(b, approvalId)).toMatchObject({ status: 'applied' });
    await applyCaps(b, { messagesPerContactPerDay: 1 });
    expect((await b.client.sendMessage({ to: a.id, text: 'ok soon' })).status).toBe('ok');

    expect(
      await b.client.respondToTerms({ envelopeId, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'rejected', code: 'SEND_LIMIT', limit: 'messages_contact' });
    expect(await termsOut(b, 'accept')).toHaveLength(0);
    const part = await b.store.transaction((tx) =>
      tx.get('commitment_parts', { approval_id: approvalId, part: 'envelope' }),
    );
    expect(part?.state).toBe('unclaimed');

    clock.t += DAY + 1;
    const done = await b.client.respondToTerms({ envelopeId, decision: 'accept', approvalId });
    expect(done.status).toBe('ok');
    expect(await termsOut(b, 'accept')).toHaveLength(1);
  });

  it('SEND_LIMIT is not kept under the clientRequestId: the same key runs once a slot frees', async () => {
    const a = await openAgent(50, ownerA, 'alice');
    const b = await openAgent(51, ownerB, 'bob');
    await pair(a, b);
    await applyCaps(a, { messagesPerContactPerDay: 1 });
    expect((await a.client.sendMessage({ to: b.id, text: 'first' })).status).toBe('ok');
    const call = { to: b.id, terms: terms(), clientRequestId: 'terms-cap-retry-1' };
    expect(await a.client.proposeTerms(call)).toMatchObject({ code: 'SEND_LIMIT' });
    clock.t += DAY + 1;
    expect((await a.client.proposeTerms(call)).status).toBe('ok');
    expect(await termsOut(a, 'offer')).toHaveLength(1);
  });

  it('concurrent offers never both pass on one count', async () => {
    const a = await openAgent(52, ownerA, 'alice');
    const b = await openAgent(53, ownerB, 'bob');
    await pair(a, b);
    await applyCaps(a, { messagesPerContactPerDay: 1 });
    const results = await Promise.all([
      a.client.proposeTerms({ to: b.id, terms: terms('x') }),
      a.client.proposeTerms({ to: b.id, terms: terms('y') }),
      a.client.sendMessage({ to: b.id, text: 'z' }),
    ]);
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected' && 'code' in r && r.code === 'SEND_LIMIT'),
    ).toHaveLength(2);
    expect(await logged(a)).toHaveLength(1);
  });
});
