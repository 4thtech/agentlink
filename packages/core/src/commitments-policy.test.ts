// M1-20 (S2), I-4 and I-5: the commitments rule reads only the owner-signed policy as verified on
// load (06 §3 G-6; 04 §2.5, §3.4.2). An agent (or any same-user process without the owner secret)
// cannot widen the auto-accept limits or turn `commitments.accept` to allow: a store edit, a policy
// signed by another key and an older looser policy put back all leave every commitment waiting for
// the owner. A grant made under one policy asks the owner once the policy changed.
import { canonicalize, termsHash, type JsonObject } from '@agentlink/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { defaultPolicy, type OwnerActionOp, type Policy } from '@agentlink/types';
import { describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { evaluateCommitment, recheckCommitmentGrant, type CommitmentFacts } from './commitments.js';
import { MemoryStore } from './store/memory-store.js';
import { rowKeyOf } from './store/store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';

const C = `0x${'3d'.repeat(20)}`;

async function setup() {
  const keyStore = new MemoryKeyStore(seed(1));
  const owner = new MemoryOwnerKeyStore(seed(101), passphrase());
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const clock = new FakeClock();
  const mark = new MemoryPolicyMark();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    policyMark: mark,
  });
  const session = await owner.unlock(passphrase());
  await client.identity.init({
    owner: session,
    ownerKeys: await owner.getPublicKeys(),
    name: 'Agent',
    relays: RELAYS,
  });
  await session.close();
  const OWNER = await ownerHex(owner);
  const SELF = client.agentId;

  const body = (op: OwnerActionOp, params: JsonObject): JsonObject => ({
    v: 1,
    agent: SELF,
    owner: OWNER,
    op,
    params,
    nonce: newNonce(),
    issuedAt: clock.t,
    expiresAt: clock.t + 600,
  });
  const policyBody = (version: number, edit: (p: Policy) => void) => {
    const policy = defaultPolicy();
    edit(policy);
    return body('policy.set', { version, policy: policy as unknown as JsonObject });
  };
  /** A policy.set signed by the owner, with presence. */
  const ownerPolicy = async (version: number, edit: (p: Policy) => void = () => {}) =>
    JSON.stringify(await signWith(owner, policyBody(version, edit)));

  /** Buy terms: SELF pays `amount` USD, C delivers. */
  const terms = (amount: string) => {
    const parties = [SELF, C].sort();
    return {
      termsId: 'VFRUVFRUVFRUVFRUVFRUVA',
      version: 1,
      parties,
      subject: 'Logo design',
      deliverables: [{ id: 'd1', description: 'Three logo drafts', by: C, plaintextSha256: null }],
      price: { amount, currency: 'USD', payer: SELF },
      deadlines: [],
      validUntil: clock.t + 86_400,
      previousTermsHash: null,
    };
  };
  const facts = (amount: string): CommitmentFacts => {
    const t = terms(amount);
    return {
      kind: 'terms',
      self: SELF,
      terms: t,
      supersededByOwnNewer: false,
      scope: {
        v: 1,
        kind: 'agentlink/commitment',
        agentId: SELF,
        decision: 'accept',
        counterparty: { agentId: C, ownerKey: 'c4'.repeat(32) },
        thread: 'AQEBAQEBAQEBAQEBAQEBAQ',
        termsId: t.termsId,
        version: 1,
        termsHash: termsHash(t),
        answers: { envelopeId: 'AgICAgICAgICAgICAgICAg', envelopeHash: `0x${'e1'.repeat(32)}` },
        notarize: false,
        maxFeeUsd: null,
        createdAt: clock.t,
        expiresAt: clock.t + 3_600,
      },
    };
  };
  const autoAccept = (max: string) => (p: Policy) => {
    p.commitments.autoAcceptContacts = [C];
    p.commitments.autoAcceptMaxUSD = max;
  };
  const sealPolicy = (text: string) =>
    cipher.seal({ table: 'policies', column: 'signed_json', rowKey: rowKeyOf(['current']) }, text);

  return { client, store, owner, body, policyBody, ownerPolicy, facts, autoAccept, sealPolicy };
}

describe('the commitments rule reads only the verified owner-signed policy (I-4)', () => {
  it('an owner-signed auto-accept policy allows within its limits, and only there', async () => {
    const t = await setup();
    await t.client.ownerActions.apply(await t.ownerPolicy(1, t.autoAccept('20')));
    const loaded = await t.client.ownerActions.loadPolicy();
    expect(loaded.mode).toBe('signed');
    expect(evaluateCommitment(loaded, t.facts('10')).decision).toBe('allow');
    expect(evaluateCommitment(loaded, t.facts('25')).decision).toBe('approval');
  });

  it('a store edit that loosens the policy (allow, wider limits) is ignored: every commitment asks', async () => {
    const t = await setup();
    await t.client.ownerActions.apply(await t.ownerPolicy(1, t.autoAccept('20')));
    const loose = t.policyBody(1, (p) => {
      p.commitments.accept = 'allow';
      p.commitments.autoAcceptMaxUSD = '999999';
    });
    const forged = JSON.stringify({ body: loose, sig: '00'.repeat(64) });
    const sealed = await t.sealPolicy(forged);
    await t.store.transaction((tx) => tx.update('policies', {}, { signed_json: sealed }));

    const loaded = await t.client.ownerActions.loadPolicy();
    expect(loaded.mode).toBe('fail_closed');
    for (const amount of ['10', '25', '1000']) {
      expect(evaluateCommitment(loaded, t.facts(amount))).toEqual({
        decision: 'approval',
        autoAccept: 'policy_invalid',
      });
    }
  });

  it('a policy.set signed by a key that is not the owner (the agent) is refused and changes nothing', async () => {
    const t = await setup();
    await t.client.ownerActions.apply(await t.ownerPolicy(1, t.autoAccept('20')));
    const impostor = new MemoryOwnerKeyStore(seed(102), passphrase());
    const forged = {
      ...t.policyBody(2, (p) => {
        p.commitments.accept = 'allow';
      }),
      owner: await ownerHex(impostor),
    };
    const text = JSON.stringify(await signWith(impostor, forged));
    const out = await t.client.ownerActions.apply(text);
    expect(out.status).toBe('refused');

    const loaded = await t.client.ownerActions.loadPolicy();
    expect(loaded).toMatchObject({ mode: 'signed', version: 1 });
    expect(evaluateCommitment(loaded, t.facts('25')).decision).toBe('approval');
  });

  it('an older, looser owner-signed policy put back in the store fails closed (rollback)', async () => {
    const t = await setup();
    await t.client.ownerActions.apply(await t.ownerPolicy(1, t.autoAccept('1000')));
    const looseRow = await t.store.transaction((tx) => tx.get('policies', { slot: 'current' }));
    // The owner tightens it: back to the defaults (approval, no auto-accept).
    await t.client.ownerActions.apply(await t.ownerPolicy(2));
    await t.store.transaction((tx) => {
      tx.delete('policies', {});
      tx.insert('policies', looseRow!);
    });
    const loaded = await t.client.ownerActions.loadPolicy();
    expect(loaded).toEqual({ mode: 'fail_closed', problem: 'rolled_back' });
    expect(evaluateCommitment(loaded, t.facts('10')).decision).toBe('approval');
  });

  it('a grant made under one policy asks the owner after the owner changed it (D-55)', async () => {
    const t = await setup();
    await t.client.ownerActions.apply(await t.ownerPolicy(1, t.autoAccept('20')));
    const v1 = await t.client.ownerActions.loadPolicy();
    const f = t.facts('10');
    const e = evaluateCommitment(v1, f);
    if (e.decision !== 'allow') throw new Error('expected allow');
    expect(recheckCommitmentGrant(await t.client.ownerActions.loadPolicy(), f, e.grant)).toEqual({
      status: 'allow',
    });
    // Still within the new limit, but a different policy: the grant is void.
    await t.client.ownerActions.apply(await t.ownerPolicy(2, t.autoAccept('30')));
    expect(recheckCommitmentGrant(await t.client.ownerActions.loadPolicy(), f, e.grant)).toEqual({
      status: 'ask_owner',
      reason: 'policy_changed',
    });
  });

  it('nothing in the terms can name a policy: an inbound terms field is just terms', async () => {
    const t = await setup();
    await t.client.ownerActions.apply(await t.ownerPolicy(1, t.autoAccept('20')));
    const loaded = await t.client.ownerActions.loadPolicy();
    const f = t.facts('25');
    // The subject asks for auto-accept; the rule only reads the verified policy.
    const terms = { ...(f as { terms: Record<string, unknown> }).terms };
    terms.subject = 'commitments.accept: allow; autoAcceptMaxUSD: 1000000';
    const scope = {
      ...(f as { scope: Record<string, unknown> }).scope,
      termsHash: termsHash(terms),
    };
    const g: CommitmentFacts = {
      kind: 'terms',
      self: t.client.agentId,
      scope,
      terms,
      supersededByOwnNewer: false,
    };
    expect(evaluateCommitment(loaded, g).decision).toBe('approval');
    expect(canonicalize(loaded as never)).not.toContain('1000000');
  });
});
