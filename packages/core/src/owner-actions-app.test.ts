// U3-f (S2; D-138, U3-spec-04; 04 §2.5.1 `app.connect`, `app.disconnect`; 04 §2.5 "Writing AI app
// configs"; 08 §1 "Signed local owner actions"; proposed, owner confirms at merge): the owner connects
// an AI app to this agent, moves it here, or disconnects it, with an owner-signed local owner action.
//
// - Core prepares the unsigned body for this agent only (`agent` and `params.agent` are its agentId)
//   with a 600 s lifetime; the app id must be one of the fixed table and `changeId` 64 lowercase hex.
// - Authority is the owner signature alone (I-4): another owner's key, another agent, a replay, an
//   expired object or one outliving L(op) is refused and writes nothing.
// - Applied means: the nonce row and the signed object are recorded in one transaction (the record
//   of which AI app entries the owner wrote, one per app, the latest applied); it grants nothing.
//   The recomputed `changeId` is the owner surface's check (node), before this and before the write.
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
const CHANGE = 'ab'.repeat(32);

async function agentOf(n: number): Promise<TestAgent> {
  clock.t = START;
  return makeAgent(clock, new MemoryKeyStore(seed(70 + n)), ownerA, `agent-${n}`);
}

async function signedApp(
  agent: TestAgent,
  over: {
    op?: 'app.connect' | 'app.disconnect';
    app?: string;
    changeId?: string;
    owner?: MemoryOwnerKeyStore;
    agentId?: string;
    paramsAgent?: string;
    life?: number;
    nonce?: string;
  } = {},
): Promise<string> {
  const owner = over.owner ?? ownerA;
  const body: JsonObject = {
    v: 1,
    agent: over.agentId ?? agent.id,
    owner: encodeHex((await owner.getPublicKeys()).ownerNostr),
    op: over.op ?? 'app.connect',
    params: {
      app: over.app ?? 'claude-code',
      agent: over.paramsAgent ?? over.agentId ?? agent.id,
      changeId: over.changeId ?? CHANGE,
    },
    nonce: over.nonce ?? encodeBase64url(randomBytes(16)),
    issuedAt: clock.t,
    expiresAt: clock.t + (over.life ?? 600),
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
const records = (agent: TestAgent) =>
  agent.store.transaction((tx) => tx.select('local_owner_actions'));

describe('app.connect and app.disconnect (U3-f; 04 §2.5.1)', () => {
  it('applies, recording the nonce row and the signed object per app', async () => {
    const a = await agentOf(1);
    expect(await a.client.ownerActions.apply(await signedApp(a))).toEqual({
      status: 'applied',
      op: 'app.connect',
    });
    expect(await a.client.ownerActions.apply(await signedApp(a, { op: 'app.disconnect' }))).toEqual(
      { status: 'applied', op: 'app.disconnect' },
    );
    expect(await a.client.ownerActions.apply(await signedApp(a, { app: 'codex' }))).toEqual({
      status: 'applied',
      op: 'app.connect',
    });
    expect((await nonceRows(a)).map((r) => r.op)).toEqual([
      'app.connect',
      'app.disconnect',
      'app.connect',
    ]);
    const rows = await records(a);
    expect(rows.map((r) => [r.record, r.op]).sort()).toEqual([
      ['app:claude-code', 'app.disconnect'],
      ['app:codex', 'app.connect'],
    ]);
  });

  it('refuses another owner, another agent, a replay, an expired object and a long lifetime', async () => {
    const a = await agentOf(2);
    const b = await agentOf(3);
    const refusedWith = async (text: string) => {
      const outcome = await a.client.ownerActions.apply(text);
      expect(outcome.status).toBe('refused');
      return outcome.status === 'refused' ? outcome.reason : undefined;
    };
    expect(await refusedWith(await signedApp(a, { owner: stranger }))).toBeDefined();
    expect(await refusedWith(await signedApp(a, { agentId: b.id }))).toBeDefined();
    expect(await refusedWith(await signedApp(a, { paramsAgent: b.id }))).toBeDefined();
    expect(await refusedWith(await signedApp(a, { life: 601 }))).toBeDefined();
    expect(await refusedWith(await signedApp(a, { app: 'vscode' }))).toBeDefined();
    expect(await refusedWith(await signedApp(a, { changeId: 'AB'.repeat(32) }))).toBeDefined();
    const old = await signedApp(a);
    clock.t += 601;
    expect(await refusedWith(old)).toBeDefined();
    clock.t = START;
    expect(await nonceRows(a)).toEqual([]);
    expect(await records(a)).toEqual([]);
    const once = await signedApp(a);
    expect((await a.client.ownerActions.apply(once)).status).toBe('applied');
    expect(await refusedWith(once)).toBe('nonce_used');
  });

  it('prepares the unsigned body for this agent only', async () => {
    const a = await agentOf(4);
    const prepared = await a.client.ownerActions.prepareAppChange('app.connect', 'cursor', CHANGE);
    expect(prepared.status).toBe('prepared');
    if (prepared.status === 'prepared') {
      expect(prepared.body['op']).toBe('app.connect');
      expect(prepared.body['agent']).toBe(a.id);
      expect(prepared.body['params']).toEqual({ app: 'cursor', agent: a.id, changeId: CHANGE });
      expect(Number(prepared.body['expiresAt']) - Number(prepared.body['issuedAt'])).toBe(600);
    }
    const off = await a.client.ownerActions.prepareAppChange('app.disconnect', 'vscode', CHANGE);
    expect(off).toEqual({ status: 'refused', op: 'app.disconnect', reason: 'change_invalid' });
    const bad = await a.client.ownerActions.prepareAppChange('app.connect', 'codex', 'x');
    expect(bad).toEqual({ status: 'refused', op: 'app.connect', reason: 'change_invalid' });
    expect(await nonceRows(a)).toEqual([]);
  });
});
