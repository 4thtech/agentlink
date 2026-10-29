// U3-e: the core side of removing an agent (04 §2.5 "Removing an agent", §2.5.1 `agent.revoke` and
// "The owner's revoked list", §3.4.1 `revoke`; D-58, D-138). The revoked-list entry is the signed
// `agent.revoke` itself and is re-verified (never trusted as a plain record); the `revoke` carriers
// are signed by the owner key (never the agent key), reach each contact through the outbox with a
// bounded wait, and the contact applies them; an undeliverable carrier is reported, never hidden.
import {
  canonicalize,
  encodeHex,
  verifyEnvelope,
  type EnvelopeKeys,
  type JsonObject,
  type KeyStore,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { unwrapGiftWrap, wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  REVOKE_DELIVERY_TIMEOUT_MS,
  buildAgentRevokeBody,
  verifyRevokedEntry,
} from './agent-removal.js';
import { AgentLinkClient } from './client.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import { ownerHex, signWith } from './testing/owner.js';
import type { TransportFactory } from './transport.js';

const RELAYS_A = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const RELAYS_B = Object.freeze(['wss://one.relay-beta.net', 'wss://two.relay-beta.net']);

let clock: FakeClock;

/** Records every publish; acks every relay, or none. */
class RelaySpy {
  readonly published: { event: NostrEvent; relays: string[] }[] = [];
  mode: 'ack' | 'none' = 'ack';
  readonly factory: TransportFactory = (deps) => ({
    wrap: (envelope, recipients, keys) =>
      wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
    publish: (event, relays) => {
      this.published.push({ event, relays: [...relays] });
      const ok = this.mode === 'ack';
      const acked = ok ? [...relays] : [];
      return Promise.resolve({
        results: relays.map((relay) => ({
          relay,
          ok,
          reason: ok ? ('ok' as const) : ('rejected' as const),
        })),
        acked,
        sent: acked.length >= 2,
      } as PublishOutcome);
    },
  });
}

const pTag = (event: NostrEvent): string =>
  (event.tags.find((t) => t[0] === 'p') as string[])[1] as string;

interface Agent extends TestAgent {
  readonly spy: RelaySpy;
}

async function openAgent(
  n: number,
  owner: TestOwner,
  name: string,
  relays: readonly string[],
): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore: KeyStore = new MemoryKeyStore(seed(n));
  const spy = new RelaySpy();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: spy.factory,
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays,
  });
  return { client, store, cipher, keyStore, owner, id: client.agentId, spy };
}

const ownerA = new MemoryOwnerKeyStore(seed(211), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(212), passphrase());
const otherOwner = new MemoryOwnerKeyStore(seed(213), passphrase());

async function pair(a: Agent, b: Agent): Promise<void> {
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
}

/** The signed `agent.revoke` of `a` as its exact text (what the revoked list holds). */
async function revokeText(a: Agent, owner: TestOwner = ownerA): Promise<string> {
  const body = await a.client.removal.prepareRevoke();
  return canonicalize((await signWith(owner, body)) as unknown as JsonObject);
}

beforeEach(() => {
  clock = new FakeClock();
});

describe('buildAgentRevokeBody (04 §2.5.1 agent.revoke)', () => {
  it('builds the canonical retired revoke: expiresAt 0, a fresh nonce, nothing else', () => {
    const agent = `0x${'ab'.repeat(20)}`;
    const owner = 'cd'.repeat(32);
    const built = buildAgentRevokeBody({ agent, owner, issuedAt: 1_760_000_000 });
    expect(built.body).toMatchObject({
      v: 1,
      agent,
      owner,
      op: 'agent.revoke',
      params: { reason: 'retired' },
      issuedAt: 1_760_000_000,
      expiresAt: 0,
    });
    expect(built.jcs).toBe(canonicalize(built.body as never));
    expect(buildAgentRevokeBody({ agent, owner, issuedAt: 1 }).body.nonce).not.toBe(
      built.body.nonce,
    );
  });

  it('refuses a non-canonical agent or owner instead of normalising it', () => {
    const owner = 'cd'.repeat(32);
    expect(() =>
      buildAgentRevokeBody({ agent: `0x${'AB'.repeat(20)}`, owner, issuedAt: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      buildAgentRevokeBody({ agent: `0x${'ab'.repeat(20)}`, owner: `0x${owner}`, issuedAt: 1 }),
    ).toThrow(TypeError);
  });
});

describe('verifyRevokedEntry: the revoked list is the signed object, re-verified (review note a)', () => {
  it('accepts the exact signed text for its agent, under its own owner or the expected one', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const text = await revokeText(a);
    const own = verifyRevokedEntry(text, a.id);
    expect(own.ok).toBe(true);
    if (own.ok) expect(own.owner).toBe(await ownerHex(ownerA));
    expect(verifyRevokedEntry(text, a.id, `0x${await ownerHex(ownerA)}`).ok).toBe(true);
  });

  it('fails closed for another agent, another expected owner, a bad signature or a plain record', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const text = await revokeText(a);
    const parsed = JSON.parse(text) as { body: Record<string, unknown>; sig: string };
    expect(verifyRevokedEntry(text, `0x${'11'.repeat(20)}`).ok).toBe(false);
    expect(verifyRevokedEntry(text, a.id, `0x${await ownerHex(otherOwner)}`).ok).toBe(false);
    const badSig = canonicalize({ ...parsed, sig: '00'.repeat(64) } as never);
    expect(verifyRevokedEntry(badSig, a.id).ok).toBe(false);
    const edited = canonicalize({
      ...parsed,
      body: { ...parsed.body, params: { reason: 'other' } },
    } as never);
    expect(verifyRevokedEntry(edited, a.id).ok).toBe(false);
    expect(verifyRevokedEntry(JSON.stringify({ agentId: a.id, revokedAt: 1 }), a.id).ok).toBe(
      false,
    );
    // Strict text (D-128): a duplicated member name refuses even with a valid signature inside.
    const dup = text.replace('{"body":', '{"sig":"x","body":');
    expect(verifyRevokedEntry(dup, a.id).ok).toBe(false);
    expect(verifyRevokedEntry(undefined, a.id).ok).toBe(false);
    expect(verifyRevokedEntry('not json', a.id).ok).toBe(false);
  });

  it('refuses a signed owner action of another op for the same agent', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const body = (await a.client.removal.prepareRevoke()) as Record<string, unknown>;
    const other = {
      ...body,
      op: 'contact.remove',
      params: { contact: `0x${'22'.repeat(20)}` },
      expiresAt: (body['issuedAt'] as number) + 600,
    };
    const text = canonicalize((await signWith(ownerA, other as JsonObject)) as never);
    expect(verifyRevokedEntry(text, a.id).ok).toBe(false);
  });
});

describe('AgentRemovalService (04 §2.5 steps 4 and 6)', () => {
  it('reads the facts removal needs: the agent, its owner, its active contacts, no storage', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    expect(await a.client.removal.facts()).toEqual({
      agentId: a.id,
      ownerNostr: `0x${await ownerHex(ownerA)}`,
      contacts: 0,
      storageIds: [],
    });
    await pair(a, b);
    expect((await a.client.removal.facts()).contacts).toBe(1);
  });

  it('prepares the own retired revoke, bound to the agent (the label never enters it)', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const body = await a.client.removal.prepareRevoke();
    expect(body).toMatchObject({
      agent: a.id,
      owner: await ownerHex(ownerA),
      op: 'agent.revoke',
      params: { reason: 'retired' },
      expiresAt: 0,
    });
    expect(JSON.stringify(body)).not.toContain('alice');
  });

  it('with no contacts, sends nothing and reports delivered', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const session = await ownerA.unlock(passphrase());
    try {
      expect(await a.client.removal.queueCarriers(await revokeText(a), session)).toEqual([]);
    } finally {
      await session.close();
    }
    expect(await a.client.removal.deliver([])).toBe('delivered');
    expect(a.spy.published).toHaveLength(0);
  });

  it('sends one owner-signed revoke per contact; the contact applies it and drops the agent', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    const text = await revokeText(a);
    const session = await ownerA.unlock(passphrase());
    let ids: readonly string[];
    try {
      ids = await a.client.removal.queueCarriers(text, session);
    } finally {
      await session.close();
    }
    expect(ids).toHaveLength(1);
    expect(await a.client.removal.deliver(ids)).toBe('delivered');

    const bAgent = encodeHex((await b.keyStore.getPublicBundle()).agentNostr);
    const forB = a.spy.published.find((p) => pTag(p.event) === bAgent);
    expect(forB?.relays).toEqual([...RELAYS_B]);
    const opened = await unwrapGiftWrap(forB?.event, b.keyStore as EnvelopeKeys);
    // The owner is the sender (04 §3.4.1): the envelope and its seal are the owner key's, never the
    // agent key's (the key table, 04 §3.1.1).
    const aOwner = await ownerHex(ownerA);
    const aAgent = encodeHex((await a.keyStore.getPublicBundle()).agentNostr);
    expect(opened.envelope.from).toBe(aOwner);
    expect(opened.envelope.from).not.toBe(aAgent);
    expect(verifyEnvelope(opened.envelope)).toBe(true);

    await b.client.envelopes.receive({ envelope: opened.envelope, giftWrapId: opened.giftWrapId });
    await b.client.envelopes.processReceived();
    const contact = await b.client.contacts.get(a.id);
    expect(contact.status).toBe('revoked');
    // The agent's own store does not apply its revoke: it is deleted right after.
    expect((await a.client.identity.get())?.revoked).toBe(false);
  });

  it('refuses a revoke for another agent, by another owner or not signed, before anything is stored', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    const session = await ownerA.unlock(passphrase());
    try {
      const foreign = await revokeText(b, ownerB);
      await expect(a.client.removal.queueCarriers(foreign, session)).rejects.toMatchObject({
        code: 'payload_invalid',
      });
      const own = await a.client.removal.prepareRevoke();
      const byOther = canonicalize(
        (await signWith(otherOwner, {
          ...own,
          owner: await ownerHex(otherOwner),
        } as JsonObject)) as never,
      );
      await expect(a.client.removal.queueCarriers(byOther, session)).rejects.toMatchObject({
        code: 'payload_invalid',
      });
      const body = await a.client.removal.prepareRevoke();
      await expect(
        a.client.removal.queueCarriers(
          canonicalize({ body, sig: '00'.repeat(64) } as never),
          session,
        ),
      ).rejects.toMatchObject({ code: 'payload_invalid' });
    } finally {
      await session.close();
    }
    const out = await a.store.transaction((tx) => tx.select('envelopes', { type: 'revoke' }));
    expect(out).toHaveLength(0);
    expect(a.spy.published).toHaveLength(0);
  });

  it('refuses carriers sealed by a session of another owner (the envelope would not verify)', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    const text = await revokeText(a);
    const wrong = await otherOwner.unlock(passphrase());
    try {
      await expect(a.client.removal.queueCarriers(text, wrong)).rejects.toMatchObject({
        code: 'owner_key_mismatch',
      });
    } finally {
      await wrong.close();
    }
    expect(a.spy.published).toHaveLength(0);
  });

  it('reports undeliverable when the relays do not take it within the bounded wait (never silent)', async () => {
    const a = await openAgent(1, ownerA, 'alice', RELAYS_A);
    const b = await openAgent(2, ownerB, 'bob', RELAYS_B);
    await pair(a, b);
    a.spy.mode = 'none';
    const session = await ownerA.unlock(passphrase());
    let ids: readonly string[];
    try {
      ids = await a.client.removal.queueCarriers(await revokeText(a), session);
    } finally {
      await session.close();
    }
    let t = 0;
    const slept: number[] = [];
    const outcome = await a.client.removal.deliver(ids, {
      nowMs: () => t,
      sleep: (ms) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    expect(outcome).toBe('undeliverable');
    expect(slept.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(REVOKE_DELIVERY_TIMEOUT_MS);
  });
});
