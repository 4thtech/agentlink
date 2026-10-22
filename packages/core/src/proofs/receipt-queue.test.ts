// M1-34-b (D-114; 07 §7; 12 §2): a receipt the submitter could not take is queued locally and posted
// on a later sync pass; the proof stays valid with fewer receipts meanwhile, and the recipient is
// never charged. Two real cores end to end over the in-memory Notary of testing/chain.ts behind the
// chain package's own submitter (as proofs.test.ts). The recipient holds nothing on the chain.
import { parseJson, type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { createLogger } from '@4thtech-io/log';
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLinkClient } from '../client.js';
import { MemoryStore } from '../store/memory-store.js';
import { FakeNotary, FEE_UNITS } from '../testing/chain.js';
import { QUEUED_RECEIPT_WAIT_MS } from './service.js';
import {
  FakeClock,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from '../testing/fixtures.js';
import { pairWith, type TestOwner } from '../testing/envelopes.js';
import { MemoryPolicyMark } from '../testing/owner.js';
import type { TransportFactory } from '../transport.js';
import type { ProofsPlatform } from './platform.js';

// Two real cores per test; slow on a loaded CI runner, as proofs.test.ts.
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

interface Agent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestStoreCipher;
  readonly keyStore: KeyStore;
  readonly owner: TestOwner;
  readonly id: string;
}

const RELAYS = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const ownerA = new MemoryOwnerKeyStore(seed(241), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(242), passphrase());

async function openAgent(
  n: number,
  owner: TestOwner,
  name: string,
  platform: ProofsPlatform = chain.platform(),
): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore = new MemoryKeyStore(seed(n));
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
  return { client, store, cipher, keyStore, owner, id: client.agentId };
}

const delivered = new WeakMap<Agent, Set<string>>();

/** Hands `from`'s stored envelopes for `to` to `to`'s receive path, then a sync pass's proof step. */
async function deliver(from: Agent, to: Agent) {
  const seen = delivered.get(to) ?? new Set<string>();
  delivered.set(to, seen);
  const rows = await from.store.transaction((tx) =>
    tx.select('envelopes', { direction: 'out', contact_id: to.id }),
  );
  for (const row of rows) {
    if (seen.has(row.envelope_id) || row.envelope_json === null) continue;
    seen.add(row.envelope_id);
    await to.client.envelopes.receive({ envelope: parseJson(row.envelope_json) });
  }
  const reports = await to.client.envelopes.processReceived();
  // The step syncInbox (and the live subscription) runs after processing (07 §2.1 step 4).
  await to.client.proofs.processInbound(reports);
  return reports;
}

/** A, B paired; only A funded. B (the recipient) holds nothing on the chain. */
async function twoAgents(platformB?: ProofsPlatform) {
  const a = await openAgent(51, ownerA, 'alice');
  const b = await openAgent(52, ownerB, 'bob', platformB);
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
  chain.fund(a.id, 10n * FEE_UNITS);
  return { a, b };
}

async function notarizedText(a: Agent, b: Agent) {
  const sent = await a.client.sendMessage({ to: b.id, text: 'the signed handover note' });
  if (sent.status !== 'ok') throw new Error('test: send failed');
  await deliver(a, b);
  const proof = await a.client.notarize({ envelopeId: sent.envelopeId });
  if (proof.status !== 'ok') throw new Error(`test: notarize failed: ${JSON.stringify(proof)}`);
  await deliver(a, b); // the `proof` envelope: B checks the record on-chain and stores it
  return { envelopeId: sent.envelopeId, recordId: proof.recordId };
}

const queued = (agent: Agent) =>
  agent.store.transaction((tx) => tx.select('proofs', { status: 'receipt_signed' }));

beforeEach(() => {
  clock = new FakeClock();
  chain = new FakeNotary(clock.now);
});

describe('a receipt the submitter could not take is queued and posted later (D-114)', () => {
  it('an unreachable submitter queues the receipt; the next sync pass posts the same signed item', async () => {
    const { a, b } = await twoAgents();
    const { envelopeId, recordId } = await notarizedText(a, b);
    chain.censor = true; // the submitter cannot be reached
    expect(await b.client.acknowledge({ envelopeId, type: 'opened' })).toMatchObject({
      status: 'ok',
      receipt: 'OPENED',
      onChain: false,
    });
    expect(await queued(b)).toHaveLength(1);
    const first = chain.receiptSignatures.at(-1);
    // Meanwhile the proof stands with fewer receipts.
    expect(chain.records.get(recordId)?.receiptAt[1]).toBe(0n);
    expect(await a.client.getProof({ envelopeId })).toMatchObject({ recordId });

    // A pass while it is still unreachable keeps the receipt queued.
    await b.client.proofs.processInbound([]);
    expect(await queued(b)).toHaveLength(1);

    // The submitter is back: a sync pass with nothing new posts the queued receipt, unchanged.
    chain.censor = false;
    await b.client.proofs.processInbound([]);
    expect(chain.records.get(recordId)?.receiptAt[1]).not.toBe(0n);
    expect(chain.receiptSignatures.at(-1)).toBe(first);
    expect(await queued(b)).toEqual([]);
    // Posted once: a later pass sends nothing more.
    const calls = chain.calls.acknowledge;
    await b.client.proofs.processInbound([]);
    expect(chain.calls.acknowledge).toBe(calls);
  });

  it('no path charges the recipient: B never holds or spends credits, and is never asked to top up', async () => {
    const { a, b } = await twoAgents();
    const { envelopeId, recordId } = await notarizedText(a, b);
    const senderCredits = chain.creditOf(a.id);
    chain.censor = true;
    const opened = await b.client.acknowledge({ envelopeId, type: 'opened' });
    expect(opened.status).toBe('ok');
    expect(opened).not.toHaveProperty('topUp');
    chain.censor = false;
    await b.client.proofs.processInbound([]);
    expect(chain.records.get(recordId)?.receiptAt[1]).not.toBe(0n);
    expect(chain.creditOf(b.id)).toBe(0n);
    // The receipt is covered by the sender's proof fee, charged once at notarize (12 §2).
    expect(chain.creditOf(a.id)).toBe(senderCredits);
  });
});

describe('queued posts stay short and come after new envelopes (IR-M1-34-b-1 M-1, L-1)', () => {
  /** B's platform, recording record reads (new envelopes) and receipt posts with their wait. */
  function watched(events: string[]): ProofsPlatform {
    const base = chain.platform();
    const c = base.chains[0] as ProofsPlatform['chains'][number];
    const client = {
      ...c.client,
      readContract: (call: { functionName: string }) => {
        if (call.functionName === 'getRecord') events.push('inbound');
        return (c.client.readContract as (x: unknown) => Promise<unknown>)(call);
      },
    } as unknown as typeof c.client;
    const submitter = {
      ...c.submitter,
      acknowledge: (
        item: Parameters<typeof c.submitter.acknowledge>[0],
        call?: { waitMs?: number },
      ) => {
        events.push(`post:${String(call?.waitMs ?? 'default')}`);
        return c.submitter.acknowledge(item, call);
      },
    };
    return { ...base, chains: [{ ...c, client, submitter }] };
  }

  it('a pass checks its new proof envelopes first, then posts queued receipts with a short wait', async () => {
    const events: string[] = [];
    const { a, b } = await twoAgents(watched(events));
    const first = await notarizedText(a, b);
    chain.censor = true;
    await b.client.acknowledge({ envelopeId: first.envelopeId, type: 'opened' });
    // A second message and its proof arrive in the same pass as the queued post.
    const sent = await a.client.sendMessage({ to: b.id, text: 'a second note' });
    if (sent.status !== 'ok') throw new Error('test: send failed');
    chain.censor = false;
    const proof = await a.client.notarize({ envelopeId: sent.envelopeId });
    expect(proof.status).toBe('ok');
    events.length = 0;
    await deliver(a, b);
    const inbound = events.indexOf('inbound');
    const posted = events.indexOf(`post:${String(QUEUED_RECEIPT_WAIT_MS)}`);
    expect(inbound).toBeGreaterThanOrEqual(0);
    expect(posted).toBeGreaterThan(inbound);
    expect(QUEUED_RECEIPT_WAIT_MS).toBeLessThanOrEqual(5_000);
    expect(chain.records.get(first.recordId)?.receiptAt[1]).not.toBe(0n);
  });

  it('a receipt the chain refuses for good leaves the queue and is not retried', async () => {
    const { a, b } = await twoAgents();
    const { envelopeId, recordId } = await notarizedText(a, b);
    chain.censor = true;
    await b.client.acknowledge({ envelopeId, type: 'opened' });
    expect(await queued(b)).toHaveLength(1);
    // The record is gone from the chain (the client's own simulation: RecordNotFound).
    chain.records.delete(recordId);
    chain.censor = false;
    await b.client.proofs.processInbound([]);
    expect(await queued(b)).toEqual([]);
    const rows = await b.store.transaction((tx) =>
      tx.select('proofs', { status: 'receipt_failed' }),
    );
    expect(rows).toHaveLength(1);
    const calls = chain.calls.acknowledge;
    await b.client.proofs.processInbound([]);
    await b.client.proofs.processInbound([]);
    expect(chain.calls.acknowledge).toBe(calls);
    expect(await b.client.acknowledge({ envelopeId, type: 'opened' })).toMatchObject({
      status: 'rejected',
    });
  });
});
