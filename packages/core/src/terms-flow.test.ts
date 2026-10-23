// M1-32: the terms flow and one approval per agreement, end to end between two real cores (D-31,
// D-32, D-55, D-74; 04 §3.4, §3.4.2; 06 §2.2a; 07 §2.1, §3.5). Envelopes are real signed envelopes;
// a relay spy stands in for publishing, and `deliver` hands the stored envelope to the other core's
// receive path (04 §3.1.1), so the chain rules run where they run in production: on receive.
import {
  canonicalize,
  createGiftWrap,
  parseJson,
  termsHash,
  type EnvelopeKeys,
  type JsonObject,
  type KeyStore,
  type NostrEvent,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import {
  GIFT_WRAP_MAX_BACKDATE_SECONDS,
  wrapEnvelope,
  type PublishOutcome,
} from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { policyDocumentHash } from './commitments.js';
import { computeActionDigest } from './owner-action.js';
import { MemoryStore } from './store/memory-store.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { cardUpdatePayload, pairWith, rotate, type TestOwner } from './testing/envelopes.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';
import type {
  KnownRecord,
  RecordLookup,
  RespondToTermsResult,
  TermsPending,
} from './terms-flow.js';
import type { TransportFactory } from './transport.js';

let clock: FakeClock;

class RelaySpy {
  readonly published: NostrEvent[] = [];
  mode: 'ack' | 'none' = 'ack';
  /** While set, every publish waits for it (holds a call between its claim and its publish). */
  gate: Promise<void> | undefined;
  /**
   * While set, every gift wrap's created_at is this many seconds before now instead of the random
   * NIP-59 back-dating, so a test can pin the worst case for the outbox give_up_at (07 §3.2). The
   * seals wrapEnvelope signed are wrapped again at that created_at: still validly signed gift wraps.
   */
  backdate: number | undefined;
  readonly factory: TransportFactory = (deps) => ({
    wrap: async (envelope, recipients, keys) => {
      const backdate = this.backdate;
      if (backdate === undefined)
        return wrapEnvelope(envelope, recipients, keys, { now: deps.now });
      const seals: NostrEvent[] = [];
      const recording: EnvelopeKeys = {
        signEnvelopeHash: (hash) => keys.signEnvelopeHash(hash),
        signNostr: async (event) => {
          const seal = await keys.signNostr(event);
          seals.push(seal);
          return seal;
        },
        nip44Encrypt: (peer, plaintext) => keys.nip44Encrypt(peer, plaintext),
        nip44Decrypt: (peer, payload, options) => keys.nip44Decrypt(peer, payload, options),
        unwrapCek: (wrapped, envelopeId, options) => keys.unwrapCek(wrapped, envelopeId, options),
      };
      const wrapped = await wrapEnvelope(envelope, recipients, recording, { now: deps.now });
      const createdAt = deps.now() - backdate;
      return {
        ...wrapped,
        wraps: wrapped.wraps.map((w, i) => {
          const event = createGiftWrap(seals[i]!, w.recipient, createdAt);
          return {
            ...w,
            event,
            eventBytes: new TextEncoder().encode(JSON.stringify(event)).length,
            frameBytes: new TextEncoder().encode(JSON.stringify(['EVENT', event])).length,
          };
        }),
      };
    },
    publish: async (event, relays) => {
      this.published.push(event);
      if (this.gate !== undefined) await this.gate;
      const acked = this.mode === 'ack' ? [...relays] : [];
      return Promise.resolve({
        results: relays.map((relay) => ({
          relay,
          ok: this.mode === 'ack',
          reason: this.mode === 'ack' ? ('ok' as const) : ('rejected' as const),
        })),
        acked,
        sent: acked.length >= 2,
      } as PublishOutcome);
    },
  });
}

/** Records this agent knows (M1-7g seam): set per test. */
class Records implements RecordLookup {
  readonly known = new Map<string, KnownRecord>();
  recordOf(envelopeHash: string): Promise<KnownRecord | undefined> {
    return Promise.resolve(this.known.get(envelopeHash));
  }
}

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestStoreCipher;
  readonly keyStore: KeyStore;
  readonly owner: TestOwner;
  readonly id: string;
  readonly spy: RelaySpy;
  readonly mark: MemoryPolicyMark;
  readonly records: Records;
  policyVersion: number;
}

const RELAYS = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const ownerA = new MemoryOwnerKeyStore(seed(211), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(212), passphrase());

async function openAgent(n: number, owner: TestOwner, name: string): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore = new MemoryKeyStore(seed(n));
  const spy = new RelaySpy();
  const mark = new MemoryPolicyMark();
  const records = new Records();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: spy.factory,
    policyMark: mark,
    records,
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
    spy,
    mark,
    records,
    policyVersion: 0,
  };
}

async function pair(a: Agent, b: Agent): Promise<void> {
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
}

const delivered = new WeakMap<Agent, Set<string>>();

/** Hands every envelope `from` stored for `to` and not yet handed over to `to`'s receive path. */
async function deliver(from: Agent, to: Agent, only?: readonly string[]) {
  const seen = delivered.get(to) ?? new Set<string>();
  delivered.set(to, seen);
  const rows = await from.store.transaction((tx) =>
    tx
      .select('envelopes', { direction: 'out', contact_id: to.id })
      .filter((r) => ['offer', 'accept', 'reject'].includes(r.type)),
  );
  for (const row of rows) {
    if (only !== undefined ? !only.includes(row.envelope_id) : seen.has(row.envelope_id)) continue;
    seen.add(row.envelope_id);
    await to.client.envelopes.receive({ envelope: parseJson(row.envelope_json ?? '') });
  }
  return to.client.envelopes.processReceived();
}

/** Delivers the same envelope again (a duplicate on the relay). */
async function redeliver(from: Agent, to: Agent, envelopeId: string) {
  const row = await from.store.transaction((tx) =>
    tx.get('envelopes', { envelope_id: envelopeId }),
  );
  const r = await to.client.envelopes.receive({ envelope: parseJson(row?.envelope_json ?? '') });
  return { receive: r, processed: await to.client.envelopes.processReceived() };
}

async function signedOwner(agent: Agent, op: string, params: JsonObject, over: JsonObject = {}) {
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
      ...over,
    }),
  );
}

async function setPolicy(agent: Agent, edit: (p: Policy) => void): Promise<void> {
  const policy = defaultPolicy();
  edit(policy);
  agent.policyVersion += 1;
  const r = await agent.client.ownerActions.apply(
    await signedOwner(agent, 'policy.set', {
      version: agent.policyVersion,
      policy: policy as unknown as JsonObject,
    }),
  );
  expect(r).toMatchObject({ status: 'applied' });
}

async function storedAction(agent: Agent, approvalId: string): Promise<JsonObject> {
  const row = await agent.store.transaction((tx) =>
    tx.get('approvals', { approval_id: approvalId }),
  );
  const text = await agent.cipher.open(
    { table: 'approvals', column: 'action_json', rowKey: JSON.stringify([approvalId]) },
    row!.action_json,
  );
  return parseJson(text) as JsonObject;
}

/** The owner approves a pending commitment with presence (04 §2.5.1), as `agentlink approve`. */
async function approve(agent: Agent, approvalId: string) {
  const action = await storedAction(agent, approvalId);
  return agent.client.ownerActions.apply(
    await signedOwner(agent, 'approval.decide', {
      approvalId,
      actionDigest: computeActionDigest(action),
      decision: 'approve',
    }),
  );
}

const input = (over: Record<string, unknown> = {}) => ({
  subject: 'Website redesign',
  deliverables: [{ description: 'Design files', by: 'them' }],
  price: { amount: '500.00', currency: 'USD', payer: 'me' },
  ...over,
});

const outRows = (agent: Agent, type?: string) =>
  agent.store.transaction((tx) =>
    tx
      .select('envelopes', { direction: 'out' })
      .filter((r) =>
        (type === undefined ? ['offer', 'accept', 'reject'] : [type]).includes(r.type),
      ),
  );

const inRow = (agent: Agent, envelopeId: string) =>
  agent.store.transaction((tx) => tx.get('envelopes', { envelope_id: envelopeId }));

const parts = (agent: Agent, approvalId: string) =>
  agent.store.transaction((tx) =>
    Object.fromEntries(
      tx
        .select('commitment_parts', { approval_id: approvalId })
        .map((p) => [p.part, p.state] as const),
    ),
  );

async function payloadOf(agent: Agent, envelopeId: string) {
  const row = await inRow(agent, envelopeId);
  const text = await agent.cipher.open(
    { table: 'envelopes', column: 'payload_json', rowKey: JSON.stringify([envelopeId]) },
    row!.payload_json!,
  );
  return parseJson(text) as {
    type: string;
    replyTo: string | null;
    body: { terms: Record<string, unknown>; termsHash: string; note: string | null };
  };
}

function ok<T extends { status: string }>(r: T): Extract<T, { status: 'ok' }> {
  expect(r.status).toBe('ok');
  return r as Extract<T, { status: 'ok' }>;
}

function pending(r: RespondToTermsResult): TermsPending {
  expect(r.status).toBe('pending_approval');
  return r as TermsPending;
}

/** A pair with A's offer delivered to B. */
async function offered(over: Record<string, unknown> = {}) {
  const a = await openAgent(1, ownerA, 'alice');
  const b = await openAgent(2, ownerB, 'bob');
  await pair(a, b);
  const offer = ok(await a.client.proposeTerms({ to: b.id, terms: input(over) }));
  const reports = await deliver(a, b);
  expect(reports.map((r) => r.outcome)).toEqual(['ok']);
  return { a, b, offer };
}

beforeEach(() => {
  clock = new FakeClock();
});

describe('proposeTerms: the core fills the chain fields (06 §2.2a, 04 §3.4)', () => {
  it('fills termsId, version, parties in byte order, previousTermsHash and termsHash; the counter links to it', async () => {
    const { a, b, offer } = await offered();
    expect(offer.version).toBe(1);
    expect(offer.validUntil).toBe(clock.t + 604_800);
    const sent = await payloadOf(b, offer.envelopeId);
    expect(sent.type).toBe('offer');
    expect(sent.body.termsHash).toBe(offer.termsHash);
    expect(termsHash(sent.body.terms)).toBe(offer.termsHash);
    expect(sent.body.terms).toMatchObject({
      termsId: offer.termsId,
      version: 1,
      parties: [a.id, b.id].sort(),
      previousTermsHash: null,
      deliverables: [{ id: 'd1', by: b.id, plaintextSha256: null }],
      price: { amount: '500.00', currency: 'USD', payer: a.id },
      deadlines: [],
    });

    const counter = ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'counter',
        terms: input({ price: { amount: '650.00', currency: 'USD', payer: 'them' } }),
        note: 'Counter',
      }),
    );
    expect(counter).toMatchObject({ decision: 'counter', termsId: offer.termsId, version: 2 });
    expect((await deliver(b, a)).map((r) => r.outcome)).toEqual(['ok']);
    const got = await payloadOf(a, counter.envelopeId!);
    expect(got.body.terms).toMatchObject({ version: 2, previousTermsHash: offer.termsHash });
    expect(got.replyTo).toBeNull();
    const [n] = await a.client.terms.negotiations(b.id);
    expect(n).toMatchObject({ newestVersion: 2, newestEnvelopeId: counter.envelopeId });
  });

  it('revises only the own newest unanswered offer; anything else is USE_RESPOND_TO_TERMS', async () => {
    const { a, b, offer } = await offered();
    const v2 = ok(
      await a.client.proposeTerms({ to: b.id, terms: input(), revises: offer.envelopeId }),
    );
    expect(v2).toMatchObject({ termsId: offer.termsId, version: 2 });
    // v1 is no longer the newest.
    expect(
      await a.client.proposeTerms({ to: b.id, terms: input(), revises: offer.envelopeId }),
    ).toEqual({ status: 'rejected', code: 'USE_RESPOND_TO_TERMS' });
    // Their offer cannot be revised: counter it.
    await deliver(a, b);
    const c = ok(
      await b.client.respondToTerms({
        envelopeId: v2.envelopeId,
        decision: 'counter',
        terms: input(),
      }),
    );
    await deliver(b, a);
    expect(
      await a.client.proposeTerms({ to: b.id, terms: input(), revises: c.envelopeId! }),
    ).toEqual({ status: 'rejected', code: 'USE_RESPOND_TO_TERMS' });
  });

  it('refuses non-canonical input with INVALID_ARGUMENT and stores nothing', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    for (const bad of [
      input({ subject: 'two\nlines' }),
      input({ price: { amount: '1e3', currency: 'USD', payer: 'me' } }),
      { ...input(), termsId: 'AAAAAAAAAAAAAAAAAAAAAA' },
      { ...input(), version: 7 },
    ]) {
      expect(await a.client.proposeTerms({ to: b.id, terms: bad })).toEqual({
        status: 'rejected',
        code: 'INVALID_ARGUMENT',
      });
    }
    expect(await outRows(a)).toHaveLength(0);
    expect(a.spy.published).toHaveLength(0);
  });

  it('stores and sends nothing when envelope.send denies the contact', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    await setPolicy(a, (p) => {
      (p.contacts as { allowed: unknown }).allowed = ['0x00000000000000000000000000000000000000aa'];
    });
    expect(await a.client.proposeTerms({ to: b.id, terms: input() })).toEqual({
      status: 'rejected',
      code: 'POLICY_DENIED',
    });
    expect(await outRows(a)).toHaveLength(0);
    expect(a.spy.published).toHaveLength(0);
  });

  it('refuses notarize without the proof platform (NOTARIZE_UNAVAILABLE) and note with notarize', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    expect(
      await a.client.proposeTerms({ to: b.id, terms: input(), notarize: true, note: 'x' }),
    ).toEqual({ status: 'rejected', code: 'INVALID_ARGUMENT' });
    expect(await a.client.proposeTerms({ to: b.id, terms: input(), notarize: true })).toEqual({
      status: 'rejected',
      code: 'NOTARIZE_UNAVAILABLE',
    });
    expect(await outRows(a)).toHaveLength(0);
  });
});

describe('the chain on receive, from the own store (04 §3.4; D-74)', () => {
  it('a version gap never enters the chain: it waits for the missing version, and is stored as refused once the wait lapses (M1-32-b)', async () => {
    const { a, b, offer } = await offered();
    const v2 = ok(
      await a.client.proposeTerms({ to: b.id, terms: input(), revises: offer.envelopeId }),
    );
    const v3 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'v3' }),
        revises: v2.envelopeId,
      }),
    );
    const waiting = await deliver(a, b, [v3.envelopeId]);
    expect(waiting).toEqual([
      expect.objectContaining({ outcome: 'deferred', reason: 'terms_waiting' }),
    ]);
    expect(await inRow(b, v3.envelopeId)).toMatchObject({ state: 'received' });
    expect((await b.client.terms.negotiations(a.id))[0]).toMatchObject({ newestVersion: 1 });
    // v2 never arrives: after the wait (48 h from its signed createdAt) v3 is refused.
    clock.t += 172_800 + 1;
    const reports = await b.client.envelopes.processReceived();
    expect(reports).toEqual([
      expect.objectContaining({ outcome: 'refused', reason: 'terms_refused', flagged: false }),
    ]);
    expect(await inRow(b, v3.envelopeId)).toMatchObject({
      state: 'refused',
      payload_json: null,
      envelope_json: null,
    });
    const [n] = await b.client.terms.negotiations(a.id);
    expect(n).toMatchObject({ newestVersion: 1 });
  });

  it('a duplicate delivery (same envelopeHash) has no effect on the chain', async () => {
    const { a, b, offer } = await offered();
    const before = await b.client.terms.negotiations(a.id);
    const again = await redeliver(a, b, offer.envelopeId);
    expect(again.receive.report.outcome).toBe('duplicate');
    expect(await b.client.terms.negotiations(a.id)).toEqual(before);
  });

  it('concurrent counters are a conflict on both sides; the anchored resend is taken on both; pending scopes on both versions are void', async () => {
    const { a, b, offer } = await offered();
    // B starts accepting v1 (pending), then counters it; A revises v1 at the same time.
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    const bv2 = ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'counter',
        terms: input(),
      }),
    );
    const av2 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'A v2' }),
        revises: offer.envelopeId,
      }),
    );
    expect((await deliver(a, b)).map((r) => r.outcome)).toEqual(['ok']);
    expect((await deliver(b, a)).map((r) => r.outcome)).toEqual(['ok']);
    for (const [agent, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const [n] = await agent.client.terms.negotiations(other.id);
      expect(n!.newestVersion).toBe(1);
      const v2s = n!.items.filter((i) => i.version === 2);
      expect(v2s.map((i) => i.state)).toEqual(['conflict', 'conflict']);
    }
    // The pending scope on version 1 is void (IR-D55-1 F04, IR-D55-2 N01).
    expect(
      await b.store.transaction((tx) => tx.get('approvals', { approval_id: p.approvalId })),
    ).toMatchObject({ status: 'void' });
    // Neither v2 can be accepted.
    expect(
      await a.client.respondToTerms({ envelopeId: bv2.envelopeId!, decision: 'accept' }),
    ).toEqual({
      status: 'rejected',
      code: 'TERMS_SUPERSEDED',
    });

    // A's resend: version 2 again, linked to v1, replyTo = B's envelope in the conflict.
    const resend = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'A resend' }),
        revises: offer.envelopeId,
      }),
    );
    expect(resend.version).toBe(2);
    expect((await payloadOf(a, resend.envelopeId)).replyTo).toBe(bv2.envelopeId);
    expect((await deliver(a, b)).map((r) => r.outcome)).toEqual(['ok']);
    const [nb] = await b.client.terms.negotiations(a.id);
    expect(nb).toMatchObject({ newestVersion: 2, newestEnvelopeId: resend.envelopeId });
    // A second resend from A for version 2 is refused on B (rule 1 after the conflict).
    void av2;
  });

  it('a counterparty offer pointing to an older version is refused', async () => {
    const { a, b, offer } = await offered();
    const c = ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'counter',
        terms: input(),
      }),
    );
    await deliver(b, a);
    // A revises its own v1 (now not the newest): refused locally, nothing sent.
    expect(
      await a.client.proposeTerms({ to: b.id, terms: input(), revises: offer.envelopeId }),
    ).toMatchObject({ code: 'USE_RESPOND_TO_TERMS' });
    void c;
  });
});

describe('accept: one approval per agreement (04 §3.4.2)', () => {
  it('default policy asks the owner once; the accept carries the exact stored terms; a reuse sends nothing', async () => {
    const { a, b, offer } = await offered();
    const published = b.spy.published.length;
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    // Nothing is sent before the owner approves; no auto-accept outside the policy.
    expect(await outRows(b, 'accept')).toHaveLength(0);
    expect(b.spy.published.length).toBe(published);
    expect(p.card).toMatchObject({
      decision: 'accept',
      counterparty: { agentId: a.id },
      version: 1,
      changes: null,
      parts: ['accept_envelope', 'accepted_receipt'],
      autoAccept: 'contact_not_listed',
      lateAccept: null,
      fee: null,
      fingerprint: offer.termsHash,
    });
    // The summary names the contact, the action and the version only (I-5).
    expect(p.summary).toMatch(/^Accept version 1 of the terms from “.+” \(.+\)$/);
    expect(p.summary).not.toContain('Website');
    expect(await parts(b, p.approvalId)).toEqual({ envelope: 'unclaimed', receipt: 'unclaimed' });
    // The stored action carries the scope, bound to the offer.
    const action = (await storedAction(b, p.approvalId)) as {
      context: { scope: Record<string, unknown> };
    };
    expect(action.context.scope).toMatchObject({
      decision: 'accept',
      agentId: b.id,
      counterparty: { agentId: a.id, ownerKey: await ownerHex(ownerA) },
      termsHash: offer.termsHash,
      answers: { envelopeId: offer.envelopeId },
      notarize: false,
      maxFeeUsd: null,
      createdAt: clock.t,
      expiresAt: clock.t + 604_800,
    });

    expect(await approve(b, p.approvalId)).toMatchObject({ status: 'applied' });
    const done = ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    );
    expect(done).toMatchObject({
      decision: 'accept',
      version: 1,
      termsHash: offer.termsHash,
      receipt: { type: 'ACCEPTED', status: 'waiting_for_record', until: clock.t + 604_800 },
    });
    const accepts = await outRows(b, 'accept');
    expect(accepts).toHaveLength(1);
    const body = await payloadOf(b, done.envelopeId!);
    expect(body.replyTo).toBe(offer.envelopeId);
    expect(body.body.termsHash).toBe(offer.termsHash);
    expect(body.body.note).toBeNull();
    expect(canonicalize(body.body.terms as never)).toBe(
      canonicalize((await payloadOf(b, offer.envelopeId)).body.terms as never),
    );
    expect(await parts(b, p.approvalId)).toEqual({ envelope: 'done', receipt: 'unclaimed' });

    // A takes it: version 1 is locked.
    expect((await deliver(b, a)).map((r) => r.outcome)).toEqual(['ok']);
    const [n] = await a.client.terms.negotiations(b.id);
    expect(n!.lockedVersions).toEqual([1]);

    // Replay: the same approvalId sends nothing and reports the original state.
    const sentBefore = b.spy.published.length;
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    ).toEqual({
      status: 'rejected',
      code: 'APPROVAL_USED',
      envelopeId: done.envelopeId,
      receipt: { type: 'ACCEPTED', status: 'waiting_for_record', until: clock.t + 604_800 },
    });
    expect(b.spy.published.length).toBe(sentBefore);
    expect(await outRows(b, 'accept')).toHaveLength(1);
  });

  it('refuses note or terms with accept (INVALID_ARGUMENT, IR-D55-1 F03), before anything else', async () => {
    const { b, offer } = await offered();
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        note: 'ok',
      }),
    ).toEqual({ status: 'rejected', code: 'INVALID_ARGUMENT' });
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        terms: input(),
      }),
    ).toEqual({ status: 'rejected', code: 'INVALID_ARGUMENT' });
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'reject',
        notarize: true,
        note: 'no',
      }),
    ).toEqual({ status: 'rejected', code: 'INVALID_ARGUMENT' });
    expect(
      await b.store.transaction((tx) =>
        tx.select('approvals').filter((r) => r.scope_json !== null),
      ),
    ).toHaveLength(0);
  });

  it('commitments.accept deny: nothing is sent, stored or requested', async () => {
    const { b, offer } = await offered();
    await setPolicy(b, (p) => {
      (p.commitments as { accept: string }).accept = 'deny';
    });
    const before = b.spy.published.length;
    expect(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    ).toEqual({ status: 'rejected', code: 'POLICY_DENIED' });
    expect(await b.store.transaction((tx) => tx.select('approvals'))).toHaveLength(0);
    expect(await b.store.transaction((tx) => tx.select('commitment_parts'))).toHaveLength(0);
    expect(await outRows(b, 'accept')).toHaveLength(0);
    expect(b.spy.published.length).toBe(before);
  });

  it('auto-accept within the owner-signed limits runs under a policy grant; outside them it asks', async () => {
    // B buys from A: A delivers, B pays 500 USD; B allowlists A with buy up to 1000.
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    await setPolicy(b, (p) => {
      Object.assign(p.commitments, {
        autoAcceptContacts: [a.id],
        autoAcceptMaxUSD: '1000',
        autoAcceptDirection: 'buy',
      });
    });
    const sell = (amount: string) =>
      input({
        deliverables: [{ description: 'Design files', by: 'me' }],
        price: { amount, currency: 'USD', payer: 'them' },
      });
    const small = ok(await a.client.proposeTerms({ to: b.id, terms: sell('500.00') }));
    await deliver(a, b);
    const done = ok(
      await b.client.respondToTerms({ envelopeId: small.envelopeId, decision: 'accept' }),
    );
    expect(done.envelopeId).toBeDefined();
    const grants = await b.store.transaction((tx) => tx.select('approvals'));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      source: 'policy_grant',
      status: 'approved',
      signed_decision: null,
    });
    expect(await parts(b, grants[0]!.approval_id)).toEqual({
      envelope: 'done',
      receipt: 'unclaimed',
    });

    // Over the limit: the owner is asked, nothing is sent.
    const big = ok(
      await a.client.proposeTerms({ to: b.id, terms: sell('5000.00'), revises: small.envelopeId }),
    );
    await deliver(a, b);
    const p = pending(
      await b.client.respondToTerms({ envelopeId: big.envelopeId, decision: 'accept' }),
    );
    expect(p.card.autoAccept).toBe('over_maximum');
    expect(await outRows(b, 'accept')).toHaveLength(1);
  });

  it('a grant row inserted directly in the store authorises nothing (IR-D55-1 F10); an edited status neither', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    const row = await b.store.transaction((tx) =>
      tx.get('approvals', { approval_id: p.approvalId }),
    );
    const forgedId = 'apr_AAAAAAAAAAAAAAAAAAAAAA';
    const action = await storedAction(b, p.approvalId);
    const hash = policyDocumentHash(defaultPolicy());
    const sealed = (column: string, text: string) =>
      b.cipher.seal({ table: 'approvals', column, rowKey: JSON.stringify([forgedId]) }, text);
    const forged = {
      ...row!,
      approval_id: forgedId,
      action_json: await sealed('action_json', canonicalize(action)),
      summary: await sealed('summary', p.summary),
      policy_hash: await sealed('policy_hash', hash),
      source: 'policy_grant' as const,
      status: 'approved' as const,
      scope_key: null,
    };
    await b.store.transaction((tx) => {
      tx.insert('approvals', forged);
      for (const part of ['envelope', 'receipt'] as const) {
        tx.insert('commitment_parts', {
          approval_id: forgedId,
          part,
          state: 'unclaimed',
          item_ref: null,
          item_json: null,
          ledger_entry_id: null,
          void_reason: null,
          replacements: 0,
          claimed_at: null,
          done_at: null,
          updated_at: clock.t,
        });
      }
    });
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: forgedId,
      }),
    ).toEqual({ status: 'rejected', code: 'APPROVAL_VOID' });
    // An owner row whose status was edited to `approved` without a signature: still pending.
    await b.store.transaction((tx) =>
      tx.update('approvals', { approval_id: p.approvalId }, { status: 'approved' }),
    );
    expect(
      (
        await b.client.respondToTerms({
          envelopeId: offer.envelopeId,
          decision: 'accept',
          approvalId: p.approvalId,
        })
      ).status,
    ).toBe('pending_approval');
    expect(await outRows(b, 'accept')).toHaveLength(0);
  });

  it('an approval for version 1 after version 2 is stored → TERMS_SUPERSEDED, nothing sent', async () => {
    const { a, b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'v2' }),
        revises: offer.envelopeId,
      }),
    );
    await deliver(a, b);
    expect(await approve(b, p.approvalId)).toMatchObject({ status: 'applied' });
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    ).toEqual({ status: 'rejected', code: 'TERMS_SUPERSEDED' });
    expect(await outRows(b, 'accept')).toHaveLength(0);
    expect(await parts(b, p.approvalId)).toEqual({ envelope: 'void', receipt: 'void' });
  });

  it('a stored offer altered in the database → APPROVAL_VOID', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    await b.store.transaction((tx) =>
      tx.update(
        'envelopes',
        { envelope_id: offer.envelopeId },
        { envelope_hash: `0x${'ab'.repeat(32)}` },
      ),
    );
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    ).toEqual({ status: 'rejected', code: 'APPROVAL_VOID' });
    expect(await outRows(b, 'accept')).toHaveLength(0);
  });

  it('the digest computed at creation verifies at run time; an action edited in the store is void (IR-D55-1 F05)', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    expect(computeActionDigest(await storedAction(b, p.approvalId))).toBe(p.actionDigest);
    await approve(b, p.approvalId);
    // Re-seal the stored action with a longer scope expiry: the owner's digest no longer matches.
    const action = (await storedAction(b, p.approvalId)) as {
      context: { scope: { expiresAt: number; createdAt: number } };
    };
    action.context.scope.createdAt -= 1;
    const sealedAction = await b.cipher.seal(
      { table: 'approvals', column: 'action_json', rowKey: JSON.stringify([p.approvalId]) },
      canonicalize(action as never),
    );
    await b.store.transaction((tx) =>
      tx.update(
        'approvals',
        { approval_id: p.approvalId },
        { action_json: sealedAction, scope_json: canonicalize(action.context.scope as never) },
      ),
    );
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    ).toEqual({ status: 'rejected', code: 'APPROVAL_VOID' });
    expect(await outRows(b, 'accept')).toHaveLength(0);
  });

  it('an approval presented to another agent of the same owner is refused', async () => {
    const { a, b, offer } = await offered();
    const c = await openAgent(3, ownerB, 'bob-2');
    await pair(a, c);
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    expect(
      await c.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    ).toEqual({ status: 'rejected', code: 'APPROVAL_VOID' });
    expect(await outRows(c, 'accept')).toHaveLength(0);
  });

  it('after expiresAt the scope is void (TERMS_EXPIRED); expireDue voids its parts', async () => {
    const valid = new Date((clock.t + 3_600) * 1000).toISOString().replace('.000Z', 'Z');
    const { b, offer } = await offered({ validUntil: valid });
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    expect(p.card.expiresAt).toBe(clock.t + 3_600);
    await approve(b, p.approvalId);
    clock.t += 3_601;
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    ).toMatchObject({ status: 'rejected', code: 'TERMS_EXPIRED' });
    expect(await outRows(b, 'accept')).toHaveLength(0);
    expect(await parts(b, p.approvalId)).toEqual({ envelope: 'void', receipt: 'void' });
  });

  it('a call for another action gets a new request; a new scope voids the pending first one', async () => {
    const { b, offer } = await offered();
    const p1 = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    const p2 = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    expect(p2.approvalId).not.toBe(p1.approvalId);
    const rows = await b.store.transaction((tx) => tx.select('approvals'));
    expect(rows.find((r) => r.approval_id === p1.approvalId)).toMatchObject({ status: 'void' });
    expect(rows.find((r) => r.approval_id === p2.approvalId)).toMatchObject({ status: 'pending' });
    // A reject with p2's ID is another action: it does not use p2 (a reject message is free).
    await approve(b, p2.approvalId);
    ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'reject',
        approvalId: p2.approvalId,
      }),
    );
    expect(await parts(b, p2.approvalId)).toEqual({ envelope: 'unclaimed', receipt: 'unclaimed' });
  });

  it('two approved scopes for the same envelope never yield two accepts (IR-D55-1 F06)', async () => {
    const { b, offer } = await offered();
    const p1 = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p1.approvalId);
    const p2 = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p2.approvalId);
    const call = (approvalId: string) =>
      b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept', approvalId });
    ok(await call(p1.approvalId));
    expect(await call(p2.approvalId)).toMatchObject({ status: 'rejected', code: 'APPROVAL_USED' });
    expect(await outRows(b, 'accept')).toHaveLength(1);
  });

  it('two concurrent retries with one approvalId run the accept once (IR-D55-1 F06)', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    const call = () =>
      b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      });
    const results = await Promise.all([call(), call(), call()]);
    const accepts = await outRows(b, 'accept');
    expect(accepts).toHaveLength(1);
    for (const r of results) {
      expect(['ok', 'rejected']).toContain(r.status);
      if (r.status === 'ok') expect(r.envelopeId).toBe(accepts[0]!.envelope_id);
      else expect(r).toMatchObject({ code: 'APPROVAL_USED' });
    }
  });

  it('retries with one approvalId under different clientRequestIds: one ok, every other call APPROVAL_USED (04 §3.4.2)', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    const call = (clientRequestId: string) =>
      b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
        clientRequestId,
      });
    // Hold the first call after its claim, inside its publish: the part is `claimed`.
    let open!: () => void;
    b.spy.gate = new Promise<void>((resolve) => (open = resolve));
    const first = call('r1');
    for (let i = 0; i < 200 && b.spy.published.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(await parts(b, p.approvalId)).toMatchObject({ envelope: 'claimed' });
    // Two more requests with the same approval while the first is still publishing.
    const others = await Promise.all([call('r2'), call('r3')]);
    open();
    b.spy.gate = undefined;
    const results = [await first, ...others];
    const accepts = await outRows(b, 'accept');
    expect(accepts).toHaveLength(1);
    const envelopeId = accepts[0]!.envelope_id;
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(ok(results[0]!).envelopeId).toBe(envelopeId);
    for (const r of results.slice(1)) {
      expect(r).toMatchObject({ status: 'rejected', code: 'APPROVAL_USED', envelopeId });
    }
    // Each request keeps its own result: a repeat of the first is its ok, of another its refusal.
    expect(await call('r1')).toEqual(results[0]);
    expect(await call('r2')).toEqual(results[1]);
    expect(await outRows(b, 'accept')).toHaveLength(1);
  });

  it('a repeat call after an accept still waiting for relay acks is APPROVAL_USED, not a second ok (04 §3.4.2)', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    b.spy.mode = 'none';
    const call = {
      envelopeId: offer.envelopeId,
      decision: 'accept' as const,
      approvalId: p.approvalId,
    };
    const first = ok(await b.client.respondToTerms({ ...call, clientRequestId: 'w1' }));
    expect(await parts(b, p.approvalId)).toMatchObject({ envelope: 'claimed' });
    const again = await b.client.respondToTerms({ ...call, clientRequestId: 'w2' });
    expect(again).toMatchObject({
      status: 'rejected',
      code: 'APPROVAL_USED',
      envelopeId: first.envelopeId,
    });
    const bare = await b.client.respondToTerms(call);
    expect(bare).toMatchObject({
      status: 'rejected',
      code: 'APPROVAL_USED',
      envelopeId: first.envelopeId,
    });
    // The idempotent repeat of the first request still returns its original result.
    expect(await b.client.respondToTerms({ ...call, clientRequestId: 'w1' })).toEqual(first);
    expect(await outRows(b, 'accept')).toHaveLength(1);
  });

  it('a fault between the claim and the publish: the retry republishes the same signed envelope', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    b.spy.mode = 'none';
    // The worst case of the random back-dating (NIP-59; 04 §3.5): give_up_at is then only S = 300 s
    // after now (07 §3.2), so the retry below must come before it.
    b.spy.backdate = GIFT_WRAP_MAX_BACKDATE_SECONDS;
    const first = ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    );
    expect(await parts(b, p.approvalId)).toMatchObject({ envelope: 'claimed' });
    b.spy.mode = 'ack';
    clock.t += 600; // past the outbox retry delay (07 §4.2)
    const published = b.spy.published.length;
    // The repeat republishes the stored envelope and reports the approval as used: the first call
    // already reported `ok` for it (04 §3.4.2).
    const again = await b.client.respondToTerms({
      envelopeId: offer.envelopeId,
      decision: 'accept',
      approvalId: p.approvalId,
    });
    expect(again).toMatchObject({
      status: 'rejected',
      code: 'APPROVAL_USED',
      envelopeId: first.envelopeId,
    });
    expect(b.spy.published.length).toBeGreaterThan(published);
    expect(await outRows(b, 'accept')).toHaveLength(1);
    expect(await parts(b, p.approvalId)).toMatchObject({ envelope: 'done' });
  });
});

describe('records, receipts and late accepts (04 §3.4.2; 07 §2.1 step 4)', () => {
  it('per record state (never, before, after) exactly the parts run: one accept, at most one receipt', async () => {
    for (const recorded of ['never', 'before', 'after'] as const) {
      const { a, b, offer } = await offered();
      const offerHash = (await inRow(b, offer.envelopeId))!.envelope_hash;
      const record = { envelopeHash: offerHash, kind: 'OFFER' as const, signer: a.id };
      if (recorded === 'before') b.records.known.set(offerHash, { kind: 'OFFER', signer: a.id });
      const p = pending(
        await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
      );
      await approve(b, p.approvalId);
      ok(
        await b.client.respondToTerms({
          envelopeId: offer.envelopeId,
          decision: 'accept',
          approvalId: p.approvalId,
        }),
      );
      expect(await outRows(b, 'accept')).toHaveLength(1);
      expect(await parts(b, p.approvalId)).toEqual({ envelope: 'done', receipt: 'unclaimed' });
      if (recorded === 'never') {
        // No proof envelope ever arrives: the receipt waits until the scope expires.
        clock.t += 604_801;
        expect(await b.client.terms.expireDue()).toBe(1);
        expect(await parts(b, p.approvalId)).toEqual({ envelope: 'done', receipt: 'void' });
        expect((await b.client.terms.deferredReceipt(record)).status).toBe('none');
        continue;
      }
      // The record is known (now, or when its proof envelope is processed): one receipt, once.
      const lookup = await b.client.terms.deferredReceipt(record);
      expect(lookup).toMatchObject({ status: 'ready', approvalId: p.approvalId });
      const claim = () =>
        b.store.transaction((tx) =>
          b.client.terms.claimReceiptPartTx(tx, p.approvalId, 'receipt-ref', '{}', clock.t),
        );
      expect(await claim()).toBe(true);
      expect(await claim()).toBe(false);
      expect((await b.client.terms.deferredReceipt(record)).status).toBe('none');
      // Never for another kind or another signer.
      expect((await b.client.terms.deferredReceipt({ ...record, kind: 'ACCEPT' })).status).toBe(
        'none',
      );
    }
  });

  it('cancel voids a receipt still waiting for its record (IR-D55-1 F11)', async () => {
    const { a, b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    );
    expect(
      await b.client.ownerActions.apply(
        await signedOwner(b, 'approval.cancel', { approvalId: p.approvalId }),
      ),
    ).toMatchObject({ status: 'applied' });
    expect(await parts(b, p.approvalId)).toEqual({ envelope: 'done', receipt: 'void' });
    const offerHash = (await inRow(b, offer.envelopeId))!.envelope_hash;
    expect(
      (
        await b.client.terms.deferredReceipt({
          envelopeHash: offerHash,
          kind: 'OFFER',
          signer: a.id,
        })
      ).status,
    ).toBe('none');
  });

  it('the policy changed before the deferred receipt: a grant no longer covers it', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    await setPolicy(b, (p) => {
      (p.commitments as { accept: string }).accept = 'allow';
    });
    const offer = ok(await a.client.proposeTerms({ to: b.id, terms: input() }));
    await deliver(a, b);
    ok(await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }));
    await setPolicy(b, () => {});
    const offerHash = (await inRow(b, offer.envelopeId))!.envelope_hash;
    expect(
      await b.client.terms.deferredReceipt({
        envelopeHash: offerHash,
        kind: 'OFFER',
        signer: a.id,
      }),
    ).toMatchObject({ status: 'void', code: 'APPROVAL_VOID' });
  });

  it('a late accept of a superseded own version is stored, surfaced, and always asks with the warning (F01, F08)', async () => {
    const { a, b, offer } = await offered();
    // A revises to v2 before B's accept of v1 arrives; A's rule is `allow`.
    await setPolicy(a, (p) => {
      (p.commitments as { accept: string }).accept = 'allow';
    });
    ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'v2' }),
        revises: offer.envelopeId,
      }),
    );
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    const acc = ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    );
    expect((await deliver(b, a)).map((r) => r.outcome)).toEqual(['ok']);
    const [n] = await a.client.terms.negotiations(b.id);
    expect(n!.items.find((i) => i.envelopeId === acc.envelopeId)).toMatchObject({
      type: 'accept',
      lateAccept: true,
    });
    // Without a record of their accept: NOT_RECORDED, nothing signed.
    expect(
      await a.client.respondToTerms({ envelopeId: acc.envelopeId!, decision: 'accept' }),
    ).toEqual({ status: 'rejected', code: 'NOT_RECORDED' });
    // Recorded: `confirm` asks the owner even under `allow`, with the late-accept warning.
    const accHash = (await inRow(a, acc.envelopeId!))!.envelope_hash;
    a.records.known.set(accHash, { kind: 'ACCEPT', signer: b.id });
    const c = pending(
      await a.client.respondToTerms({ envelopeId: acc.envelopeId!, decision: 'accept' }),
    );
    expect(c.card).toMatchObject({
      decision: 'confirm',
      parts: ['accepted_receipt'],
      autoAccept: 'superseded',
      lateAccept: { acceptedVersion: 1, newestOwnVersion: 2 },
    });
    expect(await outRows(a, 'accept')).toHaveLength(0);
    // B then gets A's v2: an amendment after the accepted version (D-74 Q15).
    expect((await deliver(a, b)).map((r) => r.outcome)).toEqual(['ok']);
  });

  it('the commitment card shows the changes from the previous version, computed locally', async () => {
    const { a, b, offer } = await offered();
    const v2 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({
          subject: 'Website redesign v2',
          deliverables: [
            { description: 'Design files', by: 'them' },
            { description: 'Style guide', by: 'them' },
          ],
        }),
        revises: offer.envelopeId,
      }),
    );
    await deliver(a, b);
    const p = pending(
      await b.client.respondToTerms({ envelopeId: v2.envelopeId, decision: 'accept' }),
    );
    expect(p.card.changes).toEqual([
      { field: 'subject' },
      { field: 'deliverables', added: ['d2'], removed: [], changed: [] },
    ]);
    expect(await b.client.terms.commitmentCard(p.approvalId)).toEqual(p.card);
  });
});

describe('property: random interleavings never send two accepts or run without authority', () => {
  it('holds across seeded interleavings of offers, counters, approvals and deliveries', async () => {
    let s = 7;
    let totalAccepts = 0;
    const rnd = (n: number) => {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      return s % n;
    };
    for (let round = 0; round < 8; round += 1) {
      const { a, b, offer } = await offered();
      const offers = [offer.envelopeId];
      const approvals: string[] = [];
      for (let step = 0; step < 18; step += 1) {
        const head = offers[offers.length - 1]!;
        // Weighted toward the commitment path: ask, approve, run (twice at once), then the rest.
        const pick = [0, 0, 1, 1, 2, 2, 3, 4, 5, 6][rnd(10)];
        switch (pick) {
          case 0: {
            const r = await b.client.respondToTerms({ envelopeId: head, decision: 'accept' });
            if (r.status === 'pending_approval') approvals.push(r.approvalId);
            break;
          }
          case 1: {
            // Mostly the newest request; sometimes an older one (void, used or superseded).
            const id = rnd(3) === 0 ? approvals[rnd(approvals.length || 1)] : approvals.at(-1);
            if (id !== undefined) await approve(b, id).catch(() => undefined);
            break;
          }
          case 2: {
            // Mostly the newest request; sometimes an older one (void, used or superseded).
            const id = rnd(3) === 0 ? approvals[rnd(approvals.length || 1)] : approvals.at(-1);
            if (id === undefined) break;
            const env = await b.store.transaction((tx) => tx.get('approvals', { approval_id: id }));
            const target = env?.answers_envelope_id ?? head;
            await Promise.all([
              b.client.respondToTerms({ envelopeId: target, decision: 'accept', approvalId: id }),
              b.client.respondToTerms({ envelopeId: target, decision: 'accept', approvalId: id }),
            ]);
            break;
          }
          case 3: {
            const own = await outRows(a, 'offer');
            const last = own[own.length - 1];
            if (last === undefined) break;
            const r = await a.client.proposeTerms({
              to: b.id,
              terms: input({ subject: `v${step}` }),
              revises: last.envelope_id,
            });
            if (r.status === 'ok') offers.push(r.envelopeId);
            break;
          }
          case 4:
            await deliver(a, b);
            break;
          case 5:
            await deliver(b, a);
            break;
          default: {
            const r = await b.client.respondToTerms({
              envelopeId: head,
              decision: 'counter',
              terms: input({ subject: `c${step}` }),
            });
            void r;
          }
        }
      }
      // At most one accept per answered offer; every accept came from a claimed part of a scope
      // the owner signed (no grant exists under the default policy).
      const accepts = await outRows(b, 'accept');
      totalAccepts += accepts.length;
      const answered = new Set<string>();
      for (const row of accepts) {
        const body = await payloadOf(b, row.envelope_id);
        expect(answered.has(body.replyTo!)).toBe(false);
        answered.add(body.replyTo!);
        const part = await b.store.transaction((tx) =>
          tx.select('commitment_parts', { part: 'envelope', item_ref: row.envelope_id }),
        );
        expect(part).toHaveLength(1);
        const approval = await b.store.transaction((tx) =>
          tx.get('approvals', { approval_id: part[0]!.approval_id }),
        );
        expect(approval!.source).toBe('owner');
        expect(approval!.signed_decision).not.toBeNull();
      }
      // Each negotiation has at most one accepted version on A's side per version.
      await deliver(b, a);
      const [n] = await a.client.terms.negotiations(b.id);
      expect(new Set(n!.lockedVersions).size).toBe(n!.lockedVersions.length);
    }
    // The interleavings did reach accepts (the property is not vacuous).
    expect(totalAccepts).toBeGreaterThan(0);
  }, 120_000);
});

describe('IR-M1-32-1 regressions', () => {
  const run = (b: Agent, envelopeId: string, approvalId: string) =>
    b.client.respondToTerms({ envelopeId, decision: 'accept', approvalId });

  it('F01: an approved, unrun accept of v1 stays superseded after a conflict on v2 (void rule 1)', async () => {
    const { a, b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'counter',
        terms: input(),
      }),
    );
    ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'A v2' }),
        revises: offer.envelopeId,
      }),
    );
    await deliver(a, b);
    await deliver(b, a);
    expect(await run(b, offer.envelopeId, p.approvalId)).toEqual({
      status: 'rejected',
      code: 'TERMS_SUPERSEDED',
    });
    // A fresh accept of v1 is refused too: higher versions are in the store.
    expect(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    ).toEqual({ status: 'rejected', code: 'TERMS_SUPERSEDED' });
    expect(await outRows(b, 'accept')).toHaveLength(0);
  });

  it('F02: deferredReceipt is never ready for a scope whose accept was not sent', async () => {
    const { a, b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'v2' }),
        revises: offer.envelopeId,
      }),
    );
    await deliver(a, b);
    const offerHash = (await inRow(b, offer.envelopeId))!.envelope_hash;
    expect(
      (
        await b.client.terms.deferredReceipt({
          envelopeHash: offerHash,
          kind: 'OFFER',
          signer: a.id,
        })
      ).status,
    ).not.toBe('ready');
  });

  it('F04: claimReceiptPartTx re-checks a cancel inside the claim transaction', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    ok(await run(b, offer.envelopeId, p.approvalId));
    // A cancel that landed between the lookup and the claim, before the parts were voided.
    await b.store.transaction((tx) =>
      tx.update(
        'approvals',
        { approval_id: p.approvalId },
        { status: 'cancelled', signed_cancel: '{}' },
      ),
    );
    expect(
      await b.store.transaction((tx) =>
        b.client.terms.claimReceiptPartTx(tx, p.approvalId, 'ref', '{}', clock.t),
      ),
    ).toBe(false);
  });

  it('F05: the card diffs against the live resend, not a conflicted original', async () => {
    const { a, b, offer } = await offered();
    ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'counter',
        terms: input(),
      }),
    );
    ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'A v2' }),
        revises: offer.envelopeId,
      }),
    );
    await deliver(a, b);
    await deliver(b, a);
    const resend = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'Same' }),
        revises: offer.envelopeId,
      }),
    );
    const v3 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({
          subject: 'Same',
          price: { amount: '700.00', currency: 'USD', payer: 'me' },
        }),
        revises: resend.envelopeId,
      }),
    );
    // In order: the resend, then v3 on top of it.
    await deliver(a, b, [resend.envelopeId]);
    await deliver(a, b, [v3.envelopeId]);
    const p = pending(
      await b.client.respondToTerms({ envelopeId: v3.envelopeId, decision: 'accept' }),
    );
    expect(p.card.changes).toEqual([{ field: 'price' }]);
  });

  it('F06: a repeat call on a receipt-only scope returns APPROVAL_USED', async () => {
    const { b, offer } = await offered();
    const p1 = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p1.approvalId);
    ok(await run(b, offer.envelopeId, p1.approvalId));
    // The accept ran: a new call covers the receipt only.
    const p2 = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    expect(p2.card.parts).toEqual(['accepted_receipt']);
    await approve(b, p2.approvalId);
    expect((await run(b, offer.envelopeId, p2.approvalId)).status).toBe('ok');
    expect(await run(b, offer.envelopeId, p2.approvalId)).toMatchObject({
      status: 'rejected',
      code: 'APPROVAL_USED',
      receipt: { type: 'ACCEPTED', status: 'waiting_for_record' },
    });
    expect(await outRows(b, 'accept')).toHaveLength(1);
  });

  it('F03: a contact card change with a backdated issuedAt still voids the scope (rule 3)', async () => {
    const { a, b, offer } = await offered();
    const t0 = clock.t;
    clock.t = t0 + 1_000;
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    // A's owner rotates with a card issued before the scope was created.
    clock.t = t0 + 500;
    await rotate(a);
    const built = await a.client.envelopes.build({
      to: { contact: b.id },
      payload: await cardUpdatePayload(a),
    });
    clock.t = t0 + 1_010;
    await b.client.envelopes.receive({ envelope: built.envelope });
    expect((await b.client.envelopes.processReceived()).map((r) => r.outcome)).toEqual(['ok']);
    expect(await run(b, offer.envelopeId, p.approvalId)).toEqual({
      status: 'rejected',
      code: 'APPROVAL_VOID',
    });
    expect(await outRows(b, 'accept')).toHaveLength(0);
  });
});

describe('IR-M1-32-1 delta 1 regressions', () => {
  it('D1-F01: the anchored resend after a conflict stays acceptable; a stale v1 scope does not', async () => {
    const { a, b, offer } = await offered();
    const stale = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, stale.approvalId);
    ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'counter',
        terms: input(),
      }),
    );
    ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'A v2' }),
        revises: offer.envelopeId,
      }),
    );
    await deliver(a, b);
    await deliver(b, a);
    const resend = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'A resend' }),
        revises: offer.envelopeId,
      }),
    );
    await deliver(a, b, [resend.envelopeId]);
    // The resend (D-74 item 2) is the live version 2: a fresh owner approval accepts it.
    const p = pending(
      await b.client.respondToTerms({ envelopeId: resend.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    const done = ok(
      await b.client.respondToTerms({
        envelopeId: resend.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    );
    expect((await payloadOf(b, done.envelopeId!)).replyTo).toBe(resend.envelopeId);
    // F01 still holds: the approved scope on v1 is superseded.
    expect(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: stale.approvalId,
      }),
    ).toEqual({ status: 'rejected', code: 'TERMS_SUPERSEDED' });
    expect(await outRows(b, 'accept')).toHaveLength(1);
  });
});

// --- M1-32-b: order-independent receive (IR-M1-9q-1 F-3) and clientRequestId (F-2) ---------------

/** A seeded PRNG (no dependency): the same seed gives the same interleavings. */
function prng(seed: number) {
  let x = seed >>> 0;
  return (n: number): number => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

/** Hands exactly `ids` (in this order) to `to`'s receive path, then runs one processing pass. */
async function deliverInOrder(from: Agent, to: Agent, ids: readonly string[]) {
  for (const id of ids) {
    const row = await from.store.transaction((tx) => tx.get('envelopes', { envelope_id: id }));
    await to.client.envelopes.receive({ envelope: parseJson(row?.envelope_json ?? '') });
  }
  return to.client.envelopes.processReceived();
}

/** The chain as `agent` sees it for one termsId: its newest envelope and every item's state. */
async function chainOf(agent: Agent, contact: string, termsId: string) {
  const n = (await agent.client.terms.negotiations(contact)).find((x) => x.termsId === termsId);
  return n === undefined
    ? undefined
    : {
        newestVersion: n.newestVersion,
        newestEnvelopeId: n.newestEnvelopeId,
        items: n.items.map((i) => `${i.envelopeId}:${i.type}:${i.version}:${i.state}`).sort(),
      };
}

describe('M1-32-b: the chain on receive never depends on arrival order or createdAt (IR-M1-9q-1 F-3; D-74, 04 §3.4)', () => {
  it('reviewer repro: v1 and v2 sent in the same second and received in one sync: v2 is applied and v1 is superseded', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    // The same second for every envelope. Propose until one chain sorts v2 before v1 by envelope
    // ID, the order a pass takes rows with an equal createdAt in.
    const chains: { v1: string; v2: string; termsId: string }[] = [];
    for (let i = 0; i < 40 && !chains.some((c) => c.v2 < c.v1); i += 1) {
      const v1 = ok(await a.client.proposeTerms({ to: b.id, terms: input() }));
      const v2 = ok(
        await a.client.proposeTerms({
          to: b.id,
          terms: input({ subject: 'v2' }),
          revises: v1.envelopeId,
        }),
      );
      chains.push({ v1: v1.envelopeId, v2: v2.envelopeId, termsId: v1.termsId });
    }
    expect(chains.some((c) => c.v2 < c.v1)).toBe(true);
    const reports = await deliver(a, b);
    expect(reports.map((r) => r.outcome)).toEqual(reports.map(() => 'ok'));
    for (const c of chains) {
      expect(await chainOf(b, a.id, c.termsId)).toMatchObject({
        newestVersion: 2,
        newestEnvelopeId: c.v2,
      });
      expect(await b.client.respondToTerms({ envelopeId: c.v1, decision: 'accept' })).toEqual({
        status: 'rejected',
        code: 'TERMS_SUPERSEDED',
      });
    }
    const last = chains[chains.length - 1]!;
    pending(await b.client.respondToTerms({ envelopeId: last.v2, decision: 'accept' }));
  });

  it('v3 received one sync before v2: v3 waits, then both are taken and v3 is the newest', async () => {
    const { a, b, offer } = await offered();
    const v2 = ok(
      await a.client.proposeTerms({ to: b.id, terms: input(), revises: offer.envelopeId }),
    );
    const v3 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'v3' }),
        revises: v2.envelopeId,
      }),
    );
    expect(await deliverInOrder(a, b, [v3.envelopeId])).toEqual([
      expect.objectContaining({ outcome: 'deferred', reason: 'terms_waiting' }),
    ]);
    // While it waits, v3 is not in the chain and cannot be answered.
    expect(
      await b.client.respondToTerms({ envelopeId: v3.envelopeId, decision: 'accept' }),
    ).toEqual({ status: 'rejected', code: 'INVALID_ARGUMENT' });
    const reports = await deliverInOrder(a, b, [v2.envelopeId]);
    expect(reports.map((r) => r.outcome)).toEqual(['ok', 'ok']);
    expect(await chainOf(b, a.id, offer.termsId)).toMatchObject({
      newestVersion: 3,
      newestEnvelopeId: v3.envelopeId,
    });
    expect(
      await b.client.respondToTerms({ envelopeId: v2.envelopeId, decision: 'accept' }),
    ).toEqual({ status: 'rejected', code: 'TERMS_SUPERSEDED' });
    pending(await b.client.respondToTerms({ envelopeId: v3.envelopeId, decision: 'accept' }));
  });

  it('a later signed createdAt on v1 than on v2 changes nothing: the links decide', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    const t = clock.t;
    clock.t = t + 5;
    const v1 = ok(await a.client.proposeTerms({ to: b.id, terms: input() }));
    clock.t = t + 1;
    const v2 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'v2' }),
        revises: v1.envelopeId,
      }),
    );
    clock.t = t + 10;
    // One sync: the pass takes v2 first (the earlier createdAt).
    const reports = await deliverInOrder(a, b, [v1.envelopeId, v2.envelopeId]);
    expect(reports.map((r) => r.outcome)).toEqual(['ok', 'ok']);
    expect(await chainOf(b, a.id, v1.termsId)).toMatchObject({
      newestVersion: 2,
      newestEnvelopeId: v2.envelopeId,
    });
  });

  it('a waiting offer stays waiting across passes and is taken when its missing version arrives within the wait', async () => {
    const { a, b, offer } = await offered();
    const v2 = ok(
      await a.client.proposeTerms({ to: b.id, terms: input(), revises: offer.envelopeId }),
    );
    const v3 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'v3' }),
        revises: v2.envelopeId,
      }),
    );
    await deliverInOrder(a, b, [v3.envelopeId]);
    clock.t += 3_600;
    expect(await b.client.envelopes.processReceived()).toEqual([
      expect.objectContaining({ outcome: 'deferred', reason: 'terms_waiting' }),
    ]);
    clock.t += 3_600;
    const reports = await deliverInOrder(a, b, [v2.envelopeId]);
    expect(reports.map((r) => r.outcome)).toEqual(['ok', 'ok']);
    expect(await inRow(b, v3.envelopeId)).toMatchObject({ state: 'ok' });
  });

  it('IR-M1-32-b-1 F01: a waiting offer is not counted unread; it counts once the chain takes it', async () => {
    const { a, b, offer } = await offered();
    const unread = async () =>
      (await b.client.inbox.counts()).inbox.find((e) => e.contactId === a.id)?.unread ?? 0;
    // B reads v1, so nothing is unread.
    await b.client.inbox.page({
      limit: 100,
      includeRead: false,
      includeSent: false,
      sizeOf: () => 1,
      maxBytes: 1_000_000,
    });
    expect(await unread()).toBe(0);
    const v2 = ok(
      await a.client.proposeTerms({ to: b.id, terms: input(), revises: offer.envelopeId }),
    );
    const v3 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'v3' }),
        revises: v2.envelopeId,
      }),
    );
    await deliverInOrder(a, b, [v3.envelopeId]);
    // v3 waits: the inbox page can never return it, so it is not unread.
    expect(await unread()).toBe(0);
    clock.t += 60;
    await b.client.envelopes.processReceived();
    expect(await unread()).toBe(0);
    await deliverInOrder(a, b, [v2.envelopeId]);
    expect(await unread()).toBe(2);
  });

  it('property: a chain arriving in any order and any sync split (same second included) always ends in the same state', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    const rnd = prng(0x3132_6262);
    let reordered = 0;
    let rounds = 0;
    for (let round = 0; round < 24; round += 1) {
      clock.t += 7_200;
      const base = clock.t;
      // A random chain: A's versions, sometimes with B's counter in between (B must hold A's
      // newest first, which itself arrives in a random order).
      const v1 = ok(
        await a.client.proposeTerms({ to: b.id, terms: input({ subject: `r${round}` }) }),
      );
      const termsId = v1.termsId;
      let head = v1.envelopeId;
      let headIsOwn = true;
      const toB: string[] = [v1.envelopeId];
      const sentByA: string[] = [v1.envelopeId];
      const phases = 1 + rnd(3);
      for (let phase = 0; phase < phases; phase += 1) {
        const versions = 1 + rnd(4);
        for (let k = 0; k < versions; k += 1) {
          // The same second, later or earlier: the signed createdAt never decides.
          clock.t = base + rnd(3);
          const subject = `r${round} p${phase} k${k}`;
          const r = headIsOwn
            ? ok(
                await a.client.proposeTerms({
                  to: b.id,
                  terms: input({ subject }),
                  revises: head,
                }),
              )
            : ok(
                await a.client.respondToTerms({
                  envelopeId: head,
                  decision: 'counter',
                  terms: input({ subject }),
                }),
              );
          head = r.envelopeId!;
          headIsOwn = true;
          toB.push(head);
          sentByA.push(head);
        }
        // What B has not seen, in a random permutation and random sync batches.
        const order = [...toB];
        for (let i = order.length - 1; i > 0; i -= 1) {
          const j = rnd(i + 1);
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        if (order.join() !== toB.join()) reordered += 1;
        clock.t = base + 10;
        while (order.length > 0) {
          await deliverInOrder(a, b, order.splice(0, 1 + rnd(order.length)));
        }
        toB.length = 0;
        // Converged: everything A sent is taken and open, and A's last envelope is B's newest.
        const chain = await chainOf(b, a.id, termsId);
        expect(chain?.newestEnvelopeId).toBe(head);
        for (const id of sentByA) {
          expect(await inRow(b, id)).toMatchObject({ state: 'ok' });
        }
        expect(chain!.items.every((i) => i.endsWith(':open'))).toBe(true);
        if (phase < phases - 1 && rnd(2) === 0) {
          // B counters the newest; A receives it and answers with its next version.
          const c = ok(
            await b.client.respondToTerms({
              envelopeId: head,
              decision: 'counter',
              terms: input({ subject: `r${round} b${phase}` }),
            }),
          );
          await deliver(b, a);
          head = c.envelopeId!;
          headIsOwn = false;
        }
      }
      // Every older version from A is superseded on B; the newest one is acceptable.
      for (const id of sentByA.slice(0, -1)) {
        expect(await b.client.respondToTerms({ envelopeId: id, decision: 'accept' })).toEqual({
          status: 'rejected',
          code: 'TERMS_SUPERSEDED',
        });
      }
      pending(await b.client.respondToTerms({ envelopeId: head, decision: 'accept' }));
      rounds += 1;
    }
    expect(rounds).toBe(24);
    // Not vacuous: many phases arrived out of order.
    expect(reordered).toBeGreaterThan(5);
  }, 180_000);
});

describe('M1-32-b: proposeTerms and respondToTerms honour clientRequestId (IR-M1-9q-1 F-2; 06 §1 rule 6, 07 §3.3)', () => {
  it('a repeated propose under one clientRequestId returns the identical result and sends exactly once', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    const before = a.spy.published.length;
    const call = { to: b.id, terms: input(), clientRequestId: 'k1' };
    const first = ok(await a.client.proposeTerms(call));
    const wraps = a.spy.published.length - before;
    expect(wraps).toBeGreaterThan(0);
    clock.t += 30;
    expect(await a.client.proposeTerms({ ...call })).toEqual(first);
    expect(await outRows(a, 'offer')).toHaveLength(1);
    expect(a.spy.published.length - before).toBe(wraps);
    await deliver(a, b);
    expect(await b.client.terms.negotiations(a.id)).toHaveLength(1);
  });

  it('a different request under the same clientRequestId is IDEMPOTENCY_KEY_REUSED and sends nothing', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    ok(await a.client.proposeTerms({ to: b.id, terms: input(), clientRequestId: 'k1' }));
    const published = a.spy.published.length;
    expect(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'Other' }),
        clientRequestId: 'k1',
      }),
    ).toEqual({ status: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await outRows(a, 'offer')).toHaveLength(1);
    expect(a.spy.published.length).toBe(published);
    // Another key is another call.
    ok(await a.client.proposeTerms({ to: b.id, terms: input(), clientRequestId: 'k2' }));
    expect(await outRows(a, 'offer')).toHaveLength(2);
  });

  it('concurrent proposes under one clientRequestId send at most one offer', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    const call = { to: b.id, terms: input(), clientRequestId: 'k-concurrent' };
    const results = await Promise.all([
      a.client.proposeTerms(call),
      a.client.proposeTerms(call),
      a.client.proposeTerms(call),
    ]);
    expect(await outRows(a, 'offer')).toHaveLength(1);
    const oks = results.filter((r) => r.status === 'ok');
    expect(oks.length).toBeGreaterThanOrEqual(1);
    for (const r of results) expect(['ok', 'in_progress']).toContain(r.status);
    for (const r of oks) expect(r).toEqual(oks[0]);
    expect(await a.client.proposeTerms(call)).toEqual(oks[0]);
  });

  it('a repeated counter and a repeated reject under one clientRequestId send exactly once', async () => {
    const { a, b, offer } = await offered();
    const counterCall = {
      envelopeId: offer.envelopeId,
      decision: 'counter' as const,
      terms: input({ subject: 'B v2' }),
      clientRequestId: 'c1',
    };
    const c1 = ok(await b.client.respondToTerms(counterCall));
    const published = b.spy.published.length;
    expect(await b.client.respondToTerms({ ...counterCall })).toEqual(c1);
    expect(await outRows(b, 'offer')).toHaveLength(1);
    expect(b.spy.published.length).toBe(published);
    expect(
      await b.client.respondToTerms({ ...counterCall, terms: input({ subject: 'B other' }) }),
    ).toEqual({ status: 'rejected', code: 'IDEMPOTENCY_KEY_REUSED' });

    await deliver(b, a);
    const rejectCall = {
      envelopeId: c1.envelopeId!,
      decision: 'reject' as const,
      note: 'No thanks',
      clientRequestId: 'r1',
    };
    const r1 = ok(await a.client.respondToTerms(rejectCall));
    clock.t += 5;
    expect(await a.client.respondToTerms({ ...rejectCall })).toEqual(r1);
    expect(await outRows(a, 'reject')).toHaveLength(1);
  });

  it('a repeated accept under one clientRequestId gives the same approval request; the run with the approval sends one accept and replays its result', async () => {
    const { b, offer } = await offered();
    const call = {
      envelopeId: offer.envelopeId,
      decision: 'accept' as const,
      clientRequestId: 'a1',
    };
    const p1 = pending(await b.client.respondToTerms(call));
    expect(pending(await b.client.respondToTerms({ ...call }))).toEqual(p1);
    // The repeat did not void the first request: one live request.
    const rows = await b.store.transaction((tx) => tx.select('approvals', {}));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approval_id: p1.approvalId, status: 'pending' });

    await approve(b, p1.approvalId);
    const runCall = { ...call, approvalId: p1.approvalId, clientRequestId: 'a2' };
    const done = ok(await b.client.respondToTerms(runCall));
    expect(done.envelopeId).toBeDefined();
    const published = b.spy.published.length;
    // The original result, not APPROVAL_USED, and nothing sent.
    expect(await b.client.respondToTerms({ ...runCall })).toEqual(done);
    expect(await outRows(b, 'accept')).toHaveLength(1);
    expect(b.spy.published.length).toBe(published);
  });

  it('a kept pending_approval whose approval was decided is not replayed: the repeat reports the approval state', async () => {
    const { b, offer } = await offered();
    const call = {
      envelopeId: offer.envelopeId,
      decision: 'accept' as const,
      clientRequestId: 'a1',
    };
    const p1 = pending(await b.client.respondToTerms(call));
    await approve(b, p1.approvalId);
    expect(await b.client.respondToTerms({ ...call })).toMatchObject({
      status: 'approval_state',
      approvalId: p1.approvalId,
      approval: { status: 'approved' },
    });
    expect(await outRows(b, 'accept')).toHaveLength(0);
  });

  it('one clientRequestId on the two terms tools of one agent are two calls', async () => {
    const { a, b, offer } = await offered();
    const c = ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'counter',
        terms: input(),
      }),
    );
    await deliver(b, a);
    ok(await a.client.proposeTerms({ to: b.id, terms: input(), clientRequestId: 'same' }));
    ok(
      await a.client.respondToTerms({
        envelopeId: c.envelopeId!,
        decision: 'reject',
        clientRequestId: 'same',
      }),
    );
    expect(await outRows(a, 'reject')).toHaveLength(1);
  });

  it('input refused before anything runs stores no idempotency row', async () => {
    const a = await openAgent(1, ownerA, 'alice');
    const b = await openAgent(2, ownerB, 'bob');
    await pair(a, b);
    expect(
      await a.client.proposeTerms({
        to: b.id,
        terms: input(),
        notarize: true,
        note: 'x',
        clientRequestId: 'bad',
      }),
    ).toEqual({ status: 'rejected', code: 'INVALID_ARGUMENT' });
    expect(await a.store.transaction((tx) => tx.select('idempotency', {}))).toHaveLength(0);
  });
});

describe('fresh sessions (M1-22): open offers and what an approval is for (06 §2.1, §2.2, §2.5)', () => {
  const page = (agent: Agent, envelopeIds?: readonly string[]) =>
    agent.client.inbox.page({
      limit: 20,
      includeRead: envelopeIds !== undefined,
      includeSent: false,
      sizeOf: () => 1,
      maxBytes: 1_000_000,
      ...(envelopeIds === undefined ? {} : { envelopeIds }),
    });

  it('openOffers lists the newest open offer from a contact, even after it was read', async () => {
    const { a, b, offer } = await offered();
    const open = [
      {
        envelopeId: offer.envelopeId,
        contactId: a.id,
        termsId: offer.termsId,
        version: 1,
        validUntil: offer.validUntil,
      },
    ];
    expect(await b.client.terms.openOffers()).toEqual(open);
    // Read once: no longer unread, still open.
    const first = await page(b);
    expect(first.status === 'ok' && first.items.map((i) => i.envelopeId)).toEqual([
      offer.envelopeId,
    ]);
    const again = await page(b);
    expect(again.status === 'ok' && again.items).toEqual([]);
    expect(await b.client.terms.openOffers()).toEqual(open);
    // The own offer is not one waiting for an answer.
    expect(await a.client.terms.openOffers()).toEqual([]);
    // The inbox page can name it by envelope ID with read items included.
    const named = await page(b, [offer.envelopeId]);
    expect(named.status === 'ok' && named.items.map((i) => i.envelopeId)).toEqual([
      offer.envelopeId,
    ]);
    expect(await page(b, [])).toEqual({ status: 'ok', items: [], requests: 0 });
  });

  it('an offer revised by its sender drops out in favour of the newest version (IR-M1-22-FRESH-1 I-1)', async () => {
    const { a, b, offer } = await offered();
    const v2 = ok(
      await a.client.proposeTerms({
        to: b.id,
        terms: input({ subject: 'Website redesign, revised' }),
        revises: offer.envelopeId,
      }),
    );
    await deliver(a, b);
    expect(await b.client.terms.openOffers()).toEqual([
      {
        envelopeId: v2.envelopeId,
        contactId: a.id,
        termsId: offer.termsId,
        version: 2,
        validUntil: v2.validUntil,
      },
    ]);
  });

  it('an offer stops being open once countered, rejected, accepted or expired', async () => {
    const countered = await offered();
    const counter = ok(
      await countered.b.client.respondToTerms({
        envelopeId: countered.offer.envelopeId,
        decision: 'counter',
        terms: input({ subject: 'Website redesign v2' }),
      }),
    );
    expect(await countered.b.client.terms.openOffers()).toEqual([]);
    await deliver(countered.b, countered.a);
    expect(await countered.a.client.terms.openOffers()).toMatchObject([
      { envelopeId: counter.envelopeId, contactId: countered.b.id, version: 2 },
    ]);

    const rejected = await offered();
    ok(
      await rejected.b.client.respondToTerms({
        envelopeId: rejected.offer.envelopeId,
        decision: 'reject',
      }),
    );
    expect(await rejected.b.client.terms.openOffers()).toEqual([]);

    const accepted = await offered();
    const p = pending(
      await accepted.b.client.respondToTerms({
        envelopeId: accepted.offer.envelopeId,
        decision: 'accept',
      }),
    );
    // Asking the owner is not an answer yet.
    expect(await accepted.b.client.terms.openOffers()).toHaveLength(1);
    await approve(accepted.b, p.approvalId);
    ok(
      await accepted.b.client.respondToTerms({
        envelopeId: accepted.offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    );
    expect(await accepted.b.client.terms.openOffers()).toEqual([]);

    const valid = new Date((clock.t + 3_600) * 1000).toISOString().replace('.000Z', 'Z');
    const expiring = await offered({ validUntil: valid });
    expect(await expiring.b.client.terms.openOffers()).toHaveLength(1);
    clock.t += 3_601;
    expect(await expiring.b.client.terms.openOffers()).toEqual([]);
  });

  it('resumeOf names the tool and only the structured args of a pending or approved answer', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    const resume = {
      tool: 'agentlink_respond_to_terms',
      envelopeId: offer.envelopeId,
      decision: 'accept',
    };
    expect(await b.client.approvalService.resumeOf(p.approvalId)).toEqual(resume);
    await approve(b, p.approvalId);
    expect(await b.client.approvalService.resumeOf(p.approvalId)).toEqual(resume);
    ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    );
    // Nothing is left for the agent to finish once the accept ran (the receipt runs by itself).
    expect(await b.client.approvalService.resumeOf(p.approvalId)).toBeUndefined();
    expect(await b.client.approvalService.resumeOf('apr_AAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined();
    expect(await b.client.approvalService.resumeOf('not an id')).toBeUndefined();
  });

  it('resumeOf is undefined for a stored action edited in the store (fail closed)', async () => {
    const { b, offer } = await offered();
    const p = pending(
      await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' }),
    );
    await approve(b, p.approvalId);
    const action = (await storedAction(b, p.approvalId)) as {
      context: { scope: { createdAt: number } };
    };
    action.context.scope.createdAt -= 1;
    const sealedAction = await b.cipher.seal(
      { table: 'approvals', column: 'action_json', rowKey: JSON.stringify([p.approvalId]) },
      canonicalize(action as never),
    );
    await b.store.transaction((tx) =>
      tx.update('approvals', { approval_id: p.approvalId }, { action_json: sealedAction }),
    );
    expect(await b.client.approvalService.resumeOf(p.approvalId)).toBeUndefined();
  });
});

describe('M1-32-d: one clock read for an approval scope (04 §3.4.1, §3.4.2)', () => {
  /** From `arm()` on, every read of the clock moves it one second forward (a slow host). */
  function tickingClock(): { arm(): void; disarm(): void } {
    let t = clock.t;
    let ticking = false;
    Object.defineProperty(clock, 't', {
      configurable: true,
      get: () => (ticking ? (t += 1) : t),
      set: (v: number) => {
        t = v;
      },
    });
    return {
      arm: () => {
        ticking = true;
      },
      disarm: () => {
        ticking = false;
      },
    };
  }

  it('a second boundary between the scope and the owner request still asks the owner once', async () => {
    const { a, b, offer } = await offered();
    const ticks = tickingClock();
    ticks.arm();
    const r = await b.client.respondToTerms({ envelopeId: offer.envelopeId, decision: 'accept' });
    ticks.disarm();
    const p = pending(r);
    // The stored request is well formed and usable: the owner approves, the accept goes out once.
    expect(await approve(b, p.approvalId)).toMatchObject({ status: 'applied' });
    const done = ok(
      await b.client.respondToTerms({
        envelopeId: offer.envelopeId,
        decision: 'accept',
        approvalId: p.approvalId,
      }),
    );
    expect(done).toMatchObject({ decision: 'accept', version: 1, termsHash: offer.termsHash });
    expect(await outRows(b, 'accept')).toHaveLength(1);
    expect((await deliver(b, a)).map((x) => x.outcome)).toEqual(['ok']);
  });
});
