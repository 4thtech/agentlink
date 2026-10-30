// W4-PAUSE (S2; D-143 (5); 04 §2.5 "Live status and Pause", §2.5.1 `agent.resume`; 06 §6 "Paused
// agents"; 07 §3.2 `agent_pause`; proposed, owner confirms at merge).
//
// - Pause writes one `agent_pause` row and signs nothing; a second pause changes nothing.
// - Fail closed: a pause row that cannot be read makes the agent behave as paused.
// - While paused, the core's relay and sending paths refuse with `agent_paused` before any effect:
//   no fetch, no catch-up, no subscription, no send, no file fetch, and no idempotency result is
//   kept, so the same call works after resume.
// - Resume is the owner-signed `agent.resume` {agent}: it needs a pause row (`not_paused` otherwise,
//   nonce unused), is bound to this agent and this owner, is single use by its nonce, lives at most
//   600 s, and deletes the row in the transaction that records its nonce.
import { encodeBase64url, encodeHex, randomBytes, type JsonObject } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { describe, expect, it } from 'vitest';
import { AgentPause } from './agent-pause.js';
import { STORE_SCHEMA_VERSION } from './constants.js';
import { CoreError } from './errors.js';
import { TABLES } from './store/schema.js';
import { MemoryStore } from './store/memory-store.js';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import { makeAgent, type TestAgent } from './testing/envelopes.js';

const START = 1_800_000_000;
const clock = new FakeClock(START);
const ownerA = new MemoryOwnerKeyStore(seed(241), passphrase());
const stranger = new MemoryOwnerKeyStore(seed(249), passphrase());

async function agentOf(n: number): Promise<TestAgent> {
  clock.t = START;
  return makeAgent(clock, new MemoryKeyStore(seed(80 + n)), ownerA, `agent-${n}`);
}

async function signedResume(
  agent: TestAgent,
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
    op: 'agent.resume',
    params: { agent: over.paramsAgent ?? over.agentId ?? agent.id },
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

const pauseRows = (agent: TestAgent) => agent.store.transaction((tx) => tx.select('agent_pause'));
const nonceRows = (agent: TestAgent) =>
  agent.store.transaction((tx) => tx.select('owner_action_nonces'));

/** A store whose every transaction fails (an unreadable pause row). */
function brokenStore(): MemoryStore {
  const store = new MemoryStore();
  (store as unknown as { transaction: () => Promise<never> }).transaction = () =>
    Promise.reject(new Error('database is locked'));
  return store;
}

async function rejectsPaused(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CoreError);
  expect((thrown as CoreError).code).toBe('agent_paused');
}

describe('agent_pause (07 §3.2; 06 §6 "Paused agents")', () => {
  it('is a one-row table of schema version 11, in clear (a slot and a time)', () => {
    expect(STORE_SCHEMA_VERSION).toBe(11);
    expect(TABLES.agent_pause).toMatchObject({ primaryKey: ['slot'], maxRows: 1 });
    expect(Object.keys(TABLES.agent_pause.columns).sort()).toEqual(['paused_at', 'slot']);
    expect(TABLES.agent_pause.columns.paused_at.kind).toBe('int');
  });

  it('pause writes one row with the time and signs nothing; a second pause changes nothing', async () => {
    const a = await agentOf(1);
    expect(await a.client.pause.read()).toEqual({ status: 'running' });
    expect(await a.client.paused()).toBe(false);
    expect(await a.client.pause.pause()).toBe('paused');
    expect(await pauseRows(a)).toEqual([{ slot: 'current', paused_at: START }]);
    expect(await a.client.pause.read()).toEqual({ status: 'paused', pausedAt: START });
    expect(await a.client.paused()).toBe(true);
    clock.t += 30;
    expect(await a.client.pause.pause()).toBe('already');
    expect(await pauseRows(a)).toEqual([{ slot: 'current', paused_at: START }]);
    // Nothing signed: no nonce row.
    expect(await nonceRows(a)).toEqual([]);
  });

  it('fails closed: a pause row that cannot be read counts as paused', async () => {
    const pause = new AgentPause({ store: brokenStore(), now: () => START });
    expect(await pause.read()).toEqual({ status: 'unreadable' });
    expect(await pause.paused()).toBe(true);
  });

  it('the client fails closed too when its store cannot be read', async () => {
    const a = await agentOf(2);
    (a.store as unknown as { transaction: () => Promise<never> }).transaction = () =>
      Promise.reject(new Error('SQLITE_CORRUPT'));
    expect(await a.client.paused()).toBe(true);
    await rejectsPaused(() => a.client.syncInbox({ budgetMs: 10 }));
  });
});

describe('while paused the core refuses relay and sending paths before any effect', () => {
  it('sync, catch-up, subscription, send, fetch file, terms, proofs and card updates refuse', async () => {
    const a = await agentOf(3);
    await a.client.pause.pause();
    await rejectsPaused(() => a.client.syncInbox({ budgetMs: 10 }));
    await rejectsPaused(() => a.client.catchUp({ budgetMs: 10 }));
    await rejectsPaused(() => a.client.subscribeInbox());
    await rejectsPaused(() =>
      a.client.sendMessage({ to: `0x${'b'.repeat(40)}`, text: 'hi', clientRequestId: 'req-1' }),
    );
    await rejectsPaused(() =>
      a.client.fetchFile({ envelopeId: 'A'.repeat(22), clientRequestId: 'req-2' } as never),
    );
    await rejectsPaused(() => a.client.requestFileLink({ envelopeId: 'A'.repeat(22) } as never));
    await rejectsPaused(() => a.client.proposeTerms({} as never));
    await rejectsPaused(() => a.client.respondToTerms({} as never));
    await rejectsPaused(() => a.client.notarize({} as never));
    await rejectsPaused(() => a.client.acknowledge({} as never));
    await rejectsPaused(() => a.client.sendCardUpdates());
    // W4-FILES-SAVE: the app's Save is a file fetch too; refused before any nonce is recorded.
    await rejectsPaused(() => a.client.saveReceivedFile({}));
    expect(await nonceRows(a)).toEqual([]);
    // No idempotency result is kept (07 §3.3): the same clientRequestId works after resume.
    expect(await a.store.transaction((tx) => tx.select('idempotency'))).toEqual([]);
  });
});

describe('agent.resume (04 §2.5.1)', () => {
  it('applies only while paused: deletes the row and records the nonce in one transaction', async () => {
    const a = await agentOf(4);
    await a.client.pause.pause();
    const outcome = await a.client.ownerActions.apply(await signedResume(a));
    expect(outcome).toEqual({ status: 'applied', op: 'agent.resume' });
    expect(await pauseRows(a)).toEqual([]);
    expect(await a.client.paused()).toBe(false);
    expect((await nonceRows(a)).map((r) => r.op)).toEqual(['agent.resume']);
  });

  it('is refused with not_paused when the agent is not paused, and the nonce stays unused', async () => {
    const a = await agentOf(5);
    const signed = await signedResume(a);
    expect(await a.client.ownerActions.apply(signed)).toMatchObject({
      status: 'refused',
      op: 'agent.resume',
      reason: 'not_paused',
    });
    expect(await nonceRows(a)).toEqual([]);
    // The same object still applies once the agent is paused.
    await a.client.pause.pause();
    expect(await a.client.ownerActions.apply(signed)).toEqual({
      status: 'applied',
      op: 'agent.resume',
    });
  });

  it('a replayed agent.resume is refused by its nonce', async () => {
    const a = await agentOf(6);
    await a.client.pause.pause();
    const signed = await signedResume(a);
    expect((await a.client.ownerActions.apply(signed)).status).toBe('applied');
    await a.client.pause.pause();
    expect(await a.client.ownerActions.apply(signed)).toMatchObject({
      status: 'refused',
      reason: 'nonce_used',
    });
    expect(await a.client.paused()).toBe(true);
  });

  it('another owner, another agent or a params.agent that differs is refused; the pause stays', async () => {
    const a = await agentOf(7);
    const b = await agentOf(8);
    await a.client.pause.pause();
    const cases: [string, string][] = [
      [await signedResume(a, { owner: stranger }), 'owner_mismatch'],
      [await signedResume(b), 'agent_mismatch'],
    ];
    for (const [signed, reason] of cases) {
      expect(await a.client.ownerActions.apply(signed)).toMatchObject({
        status: 'refused',
        reason,
      });
    }
    const otherParams = await signedResume(a, { paramsAgent: b.id });
    expect((await a.client.ownerActions.apply(otherParams)).status).toBe('refused');
    expect(await a.client.paused()).toBe(true);
    expect(await nonceRows(a)).toEqual([]);
  });

  it('lives at most 600 s: an expired object and one outliving L(op) are refused', async () => {
    const a = await agentOf(9);
    await a.client.pause.pause();
    const old = await signedResume(a, { issuedAt: START - 700, life: 600 });
    expect(await a.client.ownerActions.apply(old)).toMatchObject({
      status: 'refused',
      reason: 'expired',
    });
    const long = await signedResume(a, { life: 601 });
    const outcome = await a.client.ownerActions.apply(long);
    expect(outcome.status).toBe('refused');
    expect(await a.client.paused()).toBe(true);
  });

  it('prepareResume builds {agent} for this agent only while paused, else not_paused', async () => {
    const a = await agentOf(10);
    expect(await a.client.ownerActions.prepareResume()).toMatchObject({
      status: 'refused',
      op: 'agent.resume',
      reason: 'not_paused',
    });
    await a.client.pause.pause();
    const prepared = await a.client.ownerActions.prepareResume();
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') return;
    expect(prepared.body.op).toBe('agent.resume');
    expect(prepared.body.agent).toBe(a.id);
    expect(prepared.body.params).toEqual({ agent: a.id });
    expect(prepared.body.expiresAt - prepared.body.issuedAt).toBeLessThanOrEqual(600);
  });
});
