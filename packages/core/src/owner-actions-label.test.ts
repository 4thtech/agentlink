// U3-d (S2; D-138, U3-spec-04; 04 §2.5.1 `agent.label`; 08 §1 "Signed local owner actions"; 07 §3.4;
// proposed, owner confirms at merge): the owner names one agent with an owner-signed `agent.label`.
//
// - Authority is the owner signature alone (I-4): an object signed by another key, for another agent
//   (body or `params.agent`), replayed, expired or outliving L(op) = 600 s is refused and writes
//   nothing.
// - `label` must already be its own restricted form (06 §2.1, as `contact.rename` `alias`); anything
//   else is `label_invalid`, never normalised.
// - Stored and nonce-checked in the agent's store like `contact.check`: one transaction records the
//   nonce row and the signed object; the latest applied one is the label.
// - Re-verified on every load: a stored object that no longer verifies (edited, another owner's,
//   another agent's) is never shown as the label (07 §3.4 "Stored signed objects").
// - Local only: no envelope carries it.
import { encodeBase64url, encodeHex, randomBytes, type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import { makeAgent, type TestAgent } from './testing/envelopes.js';

const START = 1_800_000_000;
const clock = new FakeClock(START);
const ownerA = new MemoryOwnerKeyStore(seed(241), passphrase());
const stranger = new MemoryOwnerKeyStore(seed(249), passphrase());

async function agentOf(n: number): Promise<TestAgent> {
  clock.t = START;
  return makeAgent(clock, new MemoryKeyStore(seed(50 + n)), ownerA, `agent-${n}`);
}

async function signedLabel(
  agent: TestAgent,
  label: unknown,
  over: {
    owner?: MemoryOwnerKeyStore;
    agentId?: string;
    paramsAgent?: string;
    issuedAt?: number;
    life?: number;
    nonce?: string;
  } = {},
): Promise<string> {
  const owner = over.owner ?? ownerA;
  const issuedAt = over.issuedAt ?? clock.t;
  const body: JsonObject = {
    v: 1,
    agent: over.agentId ?? agent.id,
    owner: encodeHex((await owner.getPublicKeys()).ownerNostr),
    op: 'agent.label',
    params: { agent: over.paramsAgent ?? over.agentId ?? agent.id, label: label as string },
    nonce: over.nonce ?? encodeBase64url(randomBytes(16)),
    issuedAt,
    expiresAt: issuedAt + (over.life ?? 600),
  };
  const session = await owner.unlock(passphrase());
  try {
    return JSON.stringify({ body, sig: await session.signOwnerAction(body) });
  } finally {
    await session.close();
  }
}

const nonceRows = (agent: TestAgent) =>
  agent.store.transaction((tx) => tx.select('owner_action_nonces'));
const labelRows = (agent: TestAgent) =>
  agent.store.transaction((tx) => tx.select('local_owner_actions'));

describe('agent.label (U3-d; 04 §2.5.1)', () => {
  it('applies, stores the signed object with its nonce row, and loads as the label', async () => {
    const a = await agentOf(1);
    expect(await a.client.ownerActions.loadLabel()).toEqual({ status: 'none' });
    const outcome = await a.client.ownerActions.apply(await signedLabel(a, 'Work agent'));
    expect(outcome).toEqual({ status: 'applied', op: 'agent.label' });
    expect(await a.client.ownerActions.loadLabel()).toEqual({
      status: 'verified',
      label: 'Work agent',
    });
    expect((await nonceRows(a)).map((r) => r.op)).toEqual(['agent.label']);
    const rows = await labelRows(a);
    expect(rows.map((r) => r.record)).toEqual(['agent.label']);
    // Sealed at rest (07 §3.1): the label is the owner's own text.
    expect(String(rows[0]?.signed_json)).not.toContain('Work agent');
  });

  it('the latest applied label counts; the earlier one is replaced', async () => {
    const a = await agentOf(2);
    await a.client.ownerActions.apply(await signedLabel(a, 'First'));
    clock.t += 5;
    expect((await a.client.ownerActions.apply(await signedLabel(a, 'Second'))).status).toBe(
      'applied',
    );
    expect(await a.client.ownerActions.loadLabel()).toEqual({
      status: 'verified',
      label: 'Second',
    });
    expect(await labelRows(a)).toHaveLength(1);
  });

  for (const label of [
    '',
    'a'.repeat(33),
    ' Work',
    'Work  agent',
    'Work‮agent',
    'Work​agent',
    'Work\nagent',
    '<b>Work</b>',
    'Work (verified)',
    'Раypal',
  ]) {
    it(`refuses a label that is not its own restricted form: ${JSON.stringify(label)}`, async () => {
      const a = await agentOf(3);
      const outcome = await a.client.ownerActions.apply(await signedLabel(a, label));
      expect(outcome.status).toBe('refused');
      if (outcome.status === 'refused') {
        expect(['label_invalid', 'malformed']).toContain(outcome.reason);
      }
      expect(await nonceRows(a)).toEqual([]);
      expect(await labelRows(a)).toEqual([]);
    });
  }

  it('a label that passes the schema but is not restricted is label_invalid', async () => {
    const a = await agentOf(4);
    const outcome = await a.client.ownerActions.apply(await signedLabel(a, 'Work  agent'));
    expect(outcome).toMatchObject({
      status: 'refused',
      op: 'agent.label',
      reason: 'label_invalid',
    });
  });

  it('is bound to the agentId: another agent, or a params.agent that differs, is refused', async () => {
    const a = await agentOf(5);
    const b = await agentOf(6);
    // Signed for b, delivered to a.
    const forB = await signedLabel(b, 'Other');
    expect(await a.client.ownerActions.apply(forB)).toMatchObject({
      status: 'refused',
      reason: 'agent_mismatch',
    });
    // Body names a, params name b: never valid.
    const split = await signedLabel(a, 'Split', { paramsAgent: b.id });
    expect((await a.client.ownerActions.apply(split)).status).toBe('refused');
    expect(await labelRows(a)).toEqual([]);
    expect(await nonceRows(a)).toEqual([]);
  });

  it('refuses another owner, a replay, an expired object and one outliving 600 s', async () => {
    const a = await agentOf(7);
    expect(
      await a.client.ownerActions.apply(await signedLabel(a, 'X', { owner: stranger })),
    ).toMatchObject({ status: 'refused', reason: 'owner_mismatch' });
    expect(
      await a.client.ownerActions.apply(await signedLabel(a, 'X', { life: 601 })),
    ).toMatchObject({ status: 'refused', reason: 'lifetime_exceeded' });
    expect(
      await a.client.ownerActions.apply(await signedLabel(a, 'X', { issuedAt: clock.t - 700 })),
    ).toMatchObject({ status: 'refused', reason: 'expired' });
    const once = await signedLabel(a, 'Once');
    expect((await a.client.ownerActions.apply(once)).status).toBe('applied');
    expect(await a.client.ownerActions.apply(once)).toMatchObject({
      status: 'refused',
      reason: 'nonce_used',
    });
    expect(await nonceRows(a)).toHaveLength(1);
  });

  it('a stored object that no longer verifies is never shown (re-verified on load)', async () => {
    const a = await agentOf(8);
    const b = await agentOf(9);
    await a.client.ownerActions.apply(await signedLabel(a, 'Mine'));
    await b.client.ownerActions.apply(await signedLabel(b, 'Theirs'));
    // Copy b's sealed row into a's store: it is sealed for b's store and signed for b.
    const theirs = (await labelRows(b))[0];
    expect(theirs).toBeDefined();
    await a.store.transaction((tx) => {
      tx.delete('local_owner_actions', { record: 'agent.label' });
      tx.insert('local_owner_actions', theirs!);
    });
    expect(await a.client.ownerActions.loadLabel()).toEqual({ status: 'unverified' });
  });

  it('prepareLabel builds the unsigned body for this agent only, and refuses a bad label', async () => {
    const a = await agentOf(10);
    const prepared = await a.client.ownerActions.prepareLabel('Home agent');
    expect(prepared.status).toBe('prepared');
    if (prepared.status === 'prepared') {
      expect(prepared.op).toBe('agent.label');
      expect(prepared.body['agent']).toBe(a.id);
      expect(prepared.body['params']).toEqual({ agent: a.id, label: 'Home agent' });
      expect(Number(prepared.body['expiresAt']) - Number(prepared.body['issuedAt'])).toBe(600);
    }
    expect(await a.client.ownerActions.prepareLabel('Bad  label')).toEqual({
      status: 'refused',
      op: 'agent.label',
      reason: 'label_invalid',
    });
    expect(await nonceRows(a)).toEqual([]);
  });
});
