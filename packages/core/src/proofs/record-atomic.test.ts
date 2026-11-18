// SEC-RECORD-ATOMIC (D-156; 06 §3; 07 §3.5): a Record is signed only under a fee reservation that
// is already stored, and a signed Record is stored only while that reservation still holds. A
// failure between the two leaves the fee reserved (fail closed) until the Record can never land.
// Parallel calls never sign or reserve beyond the budget, and never sign one envelope twice.
import { parseJson, type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { BuiltRecord, ProofSubmitter } from '@4thtech-io/chain';
import { createLogger } from '@4thtech-io/log';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLinkClient } from '../client.js';
import { MemoryStore } from '../store/memory-store.js';
import { FakeNotary, FEE_UNITS } from '../testing/chain.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from '../testing/fixtures.js';
import { pairWith, type TestOwner } from '../testing/envelopes.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from '../testing/owner.js';
import type { TransportFactory } from '../transport.js';
import type { ProofsPlatform } from './platform.js';

vi.setConfig({ testTimeout: 60_000 });

let clock: FakeClock;
let chain: FakeNotary;

const relayFactory: TransportFactory = (deps) => ({
  wrap: (envelope, recipients, keys) => wrapEnvelope(envelope, recipients, keys, { now: deps.now }),
  publish: (_event, relays) =>
    Promise.resolve({
      results: relays.map((relay) => ({ relay, ok: true, reason: 'ok' as const })),
      acked: [...relays],
      sent: true,
    } as PublishOutcome),
});

type SignHook = (built: BuiltRecord, store: MemoryStore) => Promise<void> | void;

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestStoreCipher;
  readonly keyStore: KeyStore;
  readonly owner: TestOwner;
  readonly id: string;
  /** Every Record the KeyStore was asked to sign, in order. */
  readonly signed: BuiltRecord[];
  /** Runs before each Record signature (the test's view at the moment of signing). */
  hook: SignHook | undefined;
  /** Runs before each Record submission, with the signature already stored. */
  submitHook: (() => Promise<void>) | undefined;
  /** Record submissions this core started (before the submitter's own on-chain check). */
  submits: number;
  policyVersion: number;
}

const RELAYS = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const ownerA = new MemoryOwnerKeyStore(seed(241), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(242), passphrase());

async function openAgent(n: number, owner: TestOwner, name: string): Promise<Agent> {
  const store = new MemoryStore();
  const keyStore = new MemoryKeyStore(seed(n), { nowSeconds: () => clock.now() });
  const base = chain.platform();
  const cipher = new TestStoreCipher();
  type Mutable = { -readonly [K in keyof Agent]: Agent[K] };
  // `client`, `id` and `policyVersion` are filled in below, once the client exists.
  const agent: Pick<
    Mutable,
    'store' | 'cipher' | 'keyStore' | 'owner' | 'signed' | 'hook' | 'submitHook' | 'submits'
  > &
    Partial<Mutable> = {
    store,
    cipher,
    keyStore,
    owner,
    signed: [],
    hook: undefined,
    submitHook: undefined,
    submits: 0,
  };
  const [baseChain] = base.chains;
  const platform: ProofsPlatform = {
    ...base,
    chains: [
      {
        ...baseChain!,
        submitter: {
          ...baseChain!.submitter,
          notarize: async (item: Parameters<ProofSubmitter['notarize']>[0]) => {
            agent.submits += 1;
            await agent.submitHook?.();
            return baseChain!.submitter.notarize(item);
          },
        },
      },
    ],
    kit: {
      ...base.kit,
      signRecord: async (signer, built) => {
        agent.signed.push(built);
        await agent.hook?.(built, store);
        return base.kit.signRecord(signer, built);
      },
    },
  };
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: relayFactory,
    policyMark: new MemoryPolicyMark(),
    logger: createLogger({ name: 'core', level: 'debug', sink: () => undefined }),
    proofs: platform,
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  agent.client = client;
  agent.id = client.agentId;
  agent.policyVersion = 0;
  return agent as Agent;
}

async function setPolicy(agent: Agent, edit: (p: Policy) => void): Promise<void> {
  const policy = defaultPolicy();
  edit(policy);
  agent.policyVersion += 1;
  const signed = await signWith(agent.owner, {
    v: 1,
    agent: agent.id,
    owner: await ownerHex(agent.owner),
    op: 'policy.set',
    params: { version: agent.policyVersion, policy: policy as never },
    nonce: newNonce(),
    issuedAt: clock.t,
    expiresAt: clock.t + 600,
  });
  const r = await agent.client.ownerActions.apply(JSON.stringify(signed));
  expect(r).toMatchObject({ status: 'applied' });
}

async function twoAgents() {
  const a = await openAgent(51, ownerA, 'alice');
  const b = await openAgent(52, ownerB, 'bob');
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
  chain.fund(a.id, 10n * FEE_UNITS);
  return { a, b };
}

async function sendText(from: Agent, to: Agent, text: string): Promise<string> {
  const sent = await from.client.sendMessage({ to: to.id, text });
  if (sent.status !== 'ok') throw new Error('test: send failed');
  return sent.envelopeId;
}

const proofRows = (agent: Agent) => agent.store.transaction((tx) => tx.select('proofs'));
const ledger = (agent: Agent) => agent.store.transaction((tx) => tx.select('budget_ledger'));
const onChain = (recordId: string) => chain.records.get(recordId);
const signedRows = async (agent: Agent) =>
  (await proofRows(agent)).filter((r) => {
    const item = parseJson(r.record_json) as { signature?: unknown };
    return typeof item.signature === 'string';
  });

beforeEach(() => {
  clock = new FakeClock();
  chain = new FakeNotary(clock.now);
});

describe('a Record is signed only under a stored reservation (SEC-RECORD-ATOMIC)', () => {
  it('the fee is reserved for this exact Record before the KeyStore signs it', async () => {
    const { a, b } = await twoAgents();
    const seen: string[] = [];
    a.hook = async (built, store) => {
      const row = await store.transaction(
        (tx) => tx.select('budget_ledger', { record_id: built.recordId, state: 'reserved' })[0],
      );
      seen.push(row === undefined ? 'unreserved' : 'reserved');
    };
    const envelopeId = await sendText(a, b, 'one');
    expect(await a.client.notarize({ envelopeId })).toMatchObject({ status: 'ok' });
    expect(seen).toEqual(['reserved']);
  });

  it('a replacement is also signed only under its own stored reservation', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    chain.censor = true;
    expect(await a.client.notarize({ envelopeId })).toMatchObject({ status: 'submitted' });
    const seen: string[] = [];
    a.hook = async (built, store) => {
      const row = await store.transaction(
        (tx) => tx.select('budget_ledger', { record_id: built.recordId, state: 'reserved' })[0],
      );
      seen.push(row === undefined ? 'unreserved' : 'reserved');
    };
    clock.t += 3601 + 60;
    chain.censor = false;
    expect(await a.client.proofs.resubmitPending()).toMatchObject({ replaced: 1 });
    expect(seen).toEqual(['reserved']);
  });
});

describe('parallel proof requests never overspend (SEC-RECORD-ATOMIC)', () => {
  it('five parallel calls under a one-proof budget: one signature, one reservation, one charge', async () => {
    const { a, b } = await twoAgents();
    await setPolicy(a, (p) => {
      p.proofs.dailyBudgetUSD = '0.15';
      p.proofs.hardDailyUSD = '0.15';
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await sendText(a, b, `note ${String(i)}`));
    const results = await Promise.all(ids.map((envelopeId) => a.client.notarize({ envelopeId })));
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
    expect(a.signed).toHaveLength(1);
    expect(await ledger(a)).toHaveLength(1);
    expect(chain.calls.notarize).toBe(1);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
  });

  it('three parallel calls for one envelope sign, reserve and charge once', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    const results = await Promise.all([1, 2, 3].map(() => a.client.notarize({ envelopeId })));
    for (const r of results) expect(['ok', 'submitted']).toContain(r.status);
    expect(a.signed).toHaveLength(1);
    expect(await ledger(a)).toHaveLength(1);
    expect(await proofRows(a)).toHaveLength(1);
    expect(chain.calls.notarize).toBe(1);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
  });
});

describe('a parallel call never submits a Record another call owns (SEC-RECORD-ATOMIC)', () => {
  it('a call arriving after the signature is stored, while the first call submits, waits for it', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    let late: Promise<unknown> | undefined;
    a.submitHook = async () => {
      if (late !== undefined) return;
      a.submitHook = undefined;
      // The stored row is `signed` now; the second call runs as far as it can before we go on.
      late = a.client.notarize({ envelopeId });
      await new Promise((r) => setTimeout(r, 300));
    };
    const first = await a.client.notarize({ envelopeId });
    expect(first).toMatchObject({ status: 'ok' });
    expect(await late).toMatchObject({
      status: 'ok',
      recordId: (first as { recordId: string }).recordId,
    });
    expect(a.signed).toHaveLength(1);
    expect(a.submits).toBe(1);
    expect(chain.calls.notarize).toBe(1);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
  });

  it('a sync pass during the submission never submits the same Record again', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    let pass: Promise<unknown> | undefined;
    a.submitHook = async () => {
      a.submitHook = undefined;
      pass = a.client.proofs.resubmitPending();
      await new Promise((r) => setTimeout(r, 300));
    };
    expect(await a.client.notarize({ envelopeId })).toMatchObject({ status: 'ok' });
    await pass;
    expect(a.submits).toBe(1);
    expect(chain.calls.notarize).toBe(1);
  });
});

describe('a failure between reserving and storing fails closed (SEC-RECORD-ATOMIC)', () => {
  it('a signing failure keeps the fee reserved; a retry signs the same Record, charged once', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    a.hook = () => {
      throw new Error('test: signer unavailable');
    };
    await expect(a.client.notarize({ envelopeId })).rejects.toThrow();
    // The fee stays reserved; nothing signed is stored and nothing reached the chain.
    expect((await ledger(a)).map((e) => e.state)).toEqual(['reserved']);
    expect(await signedRows(a)).toEqual([]);
    expect(chain.calls.notarize).toBe(0);
    const [unsigned] = await proofRows(a);
    // While unsigned, the proof reads as pending, never as an unknown state.
    expect(await a.client.getProof({ envelopeId })).toMatchObject({
      status: 'pending',
      recordId: unsigned!.record_id,
    });

    // A retry re-signs the SAME Record under the held reservation: no second reservation.
    a.hook = undefined;
    expect(await a.client.notarize({ envelopeId })).toMatchObject({
      status: 'ok',
      recordId: unsigned!.record_id,
    });
    expect(a.signed.map((r) => r.recordId)).toEqual([unsigned!.record_id, unsigned!.record_id]);
    expect((await ledger(a)).map((e) => e.state)).toEqual(['charged']);
    expect(chain.calls.notarize).toBe(1);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
  });

  it('a signing failure is re-signed by the next pass without a retry', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    a.hook = () => {
      throw new Error('test: signer unavailable');
    };
    await expect(a.client.notarize({ envelopeId })).rejects.toThrow();
    const [unsigned] = await proofRows(a);
    a.hook = undefined;
    await a.client.proofs.resubmitPending();
    expect(onChain(unsigned!.record_id)).toBeDefined();
    expect((await ledger(a)).map((e) => e.state)).toEqual(['charged']);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
  });

  it('an unsigned Record past its deadline is replaced, never lost; still one charge', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    a.hook = () => {
      throw new Error('test: signer unavailable');
    };
    await expect(a.client.notarize({ envelopeId })).rejects.toThrow();
    a.hook = undefined;
    clock.t += 3601 + 60;
    expect(await a.client.proofs.resubmitPending()).toMatchObject({ replaced: 1, recorded: 1 });
    expect((await ledger(a)).map((e) => e.state).sort()).toEqual(['charged', 'released']);
    expect(await a.client.getProof({ envelopeId })).toMatchObject({ status: 'announced' });
    expect(chain.calls.notarize).toBe(1);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
  });

  it('a transient signer failure during an automatic replacement is retried, not lost', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    chain.censor = true;
    expect(await a.client.notarize({ envelopeId })).toMatchObject({ status: 'submitted' });
    clock.t += 3601 + 60;
    // Still censored: the first Record does not land, and its replacement's signer fails.
    let failed = 0;
    a.hook = () => {
      failed += 1;
      throw new Error('test: signer unavailable');
    };
    await a.client.proofs.resubmitPending().catch(() => undefined);
    expect(failed).toBe(1);
    expect((await proofRows(a)).map((r) => r.status).sort()).toEqual(['replaced', 'signing']);
    a.hook = undefined;
    chain.censor = false;
    await a.client.proofs.resubmitPending();
    const live = (await proofRows(a)).filter((r) => r.status === 'announced');
    expect(live).toHaveLength(1);
    expect(onChain(live[0]!.record_id)).toBeDefined();
    expect((await ledger(a)).map((e) => e.state).sort()).toEqual(['charged', 'released']);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
  });

  it('an unsigned row whose Record the chain already shows is reconciled: recorded and charged', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    // The Record landed (an earlier copy of this store signed it) but this store kept no signature.
    a.hook = (built) => {
      chain.put(built.record);
      throw new Error('test: crash before the signature was stored');
    };
    await expect(a.client.notarize({ envelopeId })).rejects.toThrow();
    a.hook = undefined;
    // A failed chain read keeps it reserved and unsigned (fail closed).
    chain.stateReadsFail = true;
    chain.readsFail = true;
    await a.client.proofs.resubmitPending().catch(() => undefined);
    expect((await ledger(a)).map((e) => e.state)).toEqual(['reserved']);
    expect((await proofRows(a)).map((r) => r.status)).toEqual(['signing']);
    chain.stateReadsFail = false;
    chain.readsFail = false;
    await a.client.proofs.resubmitPending();
    expect((await ledger(a)).map((e) => e.state)).toEqual(['charged']);
    expect(['recorded', 'announced']).toContain((await proofRows(a))[0]!.status);
  });

  it('a reservation released while signing: the signature is never stored or submitted', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b, 'one');
    let released = 0;
    a.hook = async (built, store) => {
      released += await store.transaction((tx) =>
        tx.update(
          'budget_ledger',
          { record_id: built.recordId, state: 'reserved' },
          { state: 'released', settled_at: clock.now() },
        ),
      );
    };
    expect(await a.client.notarize({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'POLICY_CHANGED',
    });
    expect(released).toBe(1);
    expect(await signedRows(a)).toEqual([]);
    expect(chain.calls.notarize).toBe(0);
  });
});
