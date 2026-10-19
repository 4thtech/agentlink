// M1-7g: notarize, receipts and the proof-pack export, end to end between two real cores (03 §4.3;
// 04 §3.4 `proof`, §5; 05 §3.1, §3.3; 06 §2.4, §3; 07 §2.1 step 4, §6.2, §6.3, §8; D-31, D-32, D-55,
// D-61, D-86, D-102). Envelopes are real signed envelopes handed to the other core's receive path;
// the chain is the in-memory Notary of testing/chain.ts behind the chain package's own submitter,
// selector and verifier, so every chain decision runs the code that runs against a testnet.
import { parseJson, type JsonObject, type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import {
  RECORD_KIND,
  buildRecord,
  signRecord,
  verifyProofPack,
  type Hex,
} from '@4thtech-io/chain';
import { createLogger } from '@4thtech-io/log';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from '../client.js';
import * as core from '../index.js';
import { computeActionDigest } from '../owner-action.js';
import { MemoryStore } from '../store/memory-store.js';
import { FakeNotary, FEE_UNITS, USDC } from '../testing/chain.js';
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
  readonly mark: MemoryPolicyMark;
  readonly lines: string[];
  policyVersion: number;
}

const RELAYS = Object.freeze(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']);
const ownerA = new MemoryOwnerKeyStore(seed(221), passphrase());
const ownerB = new MemoryOwnerKeyStore(seed(222), passphrase());
const ownerC = new MemoryOwnerKeyStore(seed(223), passphrase());

async function openAgent(n: number, owner: TestOwner, name: string): Promise<Agent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const keyStore = new MemoryKeyStore(seed(n));
  const mark = new MemoryPolicyMark();
  const lines: string[] = [];
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    transport: relayFactory,
    policyMark: mark,
    logger: createLogger({ name: 'core', level: 'debug', sink: (_l, line) => lines.push(line) }),
    proofs: chain.platform(),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  return { client, store, cipher, keyStore, owner, id: client.agentId, mark, lines, policyVersion: 0 };
}

const delivered = new WeakMap<Agent, Set<string>>();

/** Hands every envelope `from` stored for `to` and not yet handed over to `to`'s receive path. */
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
  // The step syncInbox runs after processing (07 §2.1 step 4; M1-7g).
  await to.client.proofs.processInbound(reports);
  return reports;
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

async function approve(agent: Agent, approvalId: string) {
  const row = await agent.store.transaction((tx) =>
    tx.get('approvals', { approval_id: approvalId }),
  );
  const text = await agent.cipher.open(
    { table: 'approvals', column: 'action_json', rowKey: JSON.stringify([approvalId]) },
    row!.action_json,
  );
  const r = await agent.client.ownerActions.apply(
    await signedOwner(agent, 'approval.decide', {
      approvalId,
      actionDigest: computeActionDigest(parseJson(text)),
      decision: 'approve',
    }),
  );
  expect(r).toMatchObject({ status: 'applied' });
}

async function pair(a: Agent, b: Agent): Promise<void> {
  await pairWith(clock, a, b);
  await pairWith(clock, b, a);
}

async function sendText(from: Agent, to: Agent, text = 'the signed handover note') {
  const sent = await from.client.sendMessage({ to: to.id, text });
  if (sent.status !== 'ok') throw new Error('test: send failed');
  await deliver(from, to);
  return sent.envelopeId;
}

const receipts = (agent: Agent) => agent.store.transaction((tx) => tx.select('receipts'));
const proofRows = (agent: Agent) => agent.store.transaction((tx) => tx.select('proofs'));
const ledger = (agent: Agent) => agent.store.transaction((tx) => tx.select('budget_ledger'));
const onChain = (recordId: string) => chain.records.get(recordId);

async function twoAgents() {
  const a = await openAgent(31, ownerA, 'alice');
  const b = await openAgent(32, ownerB, 'bob');
  await pair(a, b);
  chain.fund(a.id, 10n * FEE_UNITS);
  return { a, b };
}

beforeEach(() => {
  clock = new FakeClock();
  chain = new FakeNotary(clock.now);
});

describe('notarize → DELIVERED → OPENED → export → verify (acceptance, testnet-style)', () => {
  it('records, delivers the salt, gets automatic DELIVERED and explicit OPENED, and the pack verifies', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);

    const proof = await a.client.notarize({ envelopeId });
    expect(proof).toMatchObject({
      status: 'ok',
      chainId: 84532,
      chain: 'base-sepolia',
      fee: { token: USDC.toLowerCase(), amount: FEE_UNITS.toString(), usd: '0.1' },
    });
    const recordId = (proof as { recordId: Hex }).recordId;
    const stored = onChain(recordId);
    expect(stored?.record.signer).toBe(a.id);
    expect(stored?.record.kind).toBe(RECORD_KIND.MESSAGE);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);

    // The proof envelope reaches B; B checks on-chain, then DELIVERED goes out on its own.
    await deliver(a, b);
    expect(stored?.receiptAt[0]).not.toBe(0n);
    expect(stored?.receiptAt[1]).toBe(0n);
    expect(await receipts(b)).toEqual([
      expect.objectContaining({ record_id: recordId, type: 1, signer: b.id }),
    ]);

    // OPENED only on an explicit request.
    expect(await b.client.acknowledge({ envelopeId, type: 'opened' })).toMatchObject({
      status: 'ok',
      recordId,
      receipt: 'OPENED',
    });
    expect(stored?.receiptAt[1]).not.toBe(0n);

    const view = await a.client.getProof({ envelopeId });
    expect(view?.receipts.map((r) => r.type)).toEqual(['DELIVERED', 'OPENED']);

    const exported = await a.client.exportProofPack({ envelopeId });
    expect(exported.status).toBe('ok');
    const pack = (exported as { pack: Record<string, unknown> }).pack;
    expect(pack).toMatchObject({
      type: 'agentlink.proof',
      chainId: 84532,
      recordId,
      disclosure: null,
      recipient: { evm: b.id },
    });
    expect(pack).not.toHaveProperty('envelope');
    // The signer block is the card of the envelope's key epoch with its proof of possession.
    const own = await a.client.identity.signedCard();
    expect(pack.signer).toEqual({
      evm: a.id,
      agentCard: own.card,
      cardSig: own.cardSig,
      cardAgentSig: own.cardAgentSig,
      cardPop: own.cardPop,
    });
    const result = await verifyProofPack(JSON.stringify(pack), {
      chains: [{ config: chain.config, client: chain.client }],
    });
    expect(result).toMatchObject({ valid: true, verdict: 'record_only', recordId });
    expect((result as { receipts: { type: string }[] }).receipts.map((r) => r.type)).toEqual([
      'DELIVERED',
      'OPENED',
    ]);
  });

  it('autoDelivered off: the proof is checked and stored, and no receipt is signed', async () => {
    const { a, b } = await twoAgents();
    await setPolicy(b, (p) => {
      p.receipts.autoDelivered = false;
    });
    const envelopeId = await sendText(a, b);
    const proof = await a.client.notarize({ envelopeId });
    await deliver(a, b);
    expect(await receipts(b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
    expect(await b.client.getProof({ envelopeId })).toMatchObject({
      recordId: (proof as { recordId: string }).recordId,
    });
  });

  it('a second notarize of the same envelope returns the stored record and charges nothing', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const first = await a.client.notarize({ envelopeId });
    const second = await a.client.notarize({ envelopeId });
    expect(second).toMatchObject({ status: 'ok', recordId: (first as { recordId: string }).recordId });
    expect(chain.calls.notarize).toBe(1);
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
    expect(await ledger(a)).toHaveLength(1);
  });
});

describe('kind mapping and what is never notarized (05 §3.1, D-86; 06 §2.4)', () => {
  it('an offer is USE_TERMS_TOOLS; an unknown envelope is ENVELOPE_NOT_FOUND; nothing is signed', async () => {
    const { a, b } = await twoAgents();
    const offer = await a.client.proposeTerms({
      to: b.id,
      terms: {
        subject: 'Website redesign',
        deliverables: [{ description: 'Design files', by: 'them' }],
        price: { amount: '500.00', currency: 'USD', payer: 'me' },
      },
    });
    const offerId = (offer as { envelopeId: string }).envelopeId;
    expect(await a.client.notarize({ envelopeId: offerId })).toEqual({
      status: 'rejected',
      code: 'USE_TERMS_TOOLS',
    });
    expect(await a.client.notarize({ envelopeId: 'AAAAAAAAAAAAAAAAAAAAAA' })).toEqual({
      status: 'rejected',
      code: 'ENVELOPE_NOT_FOUND',
    });
    expect(chain.calls.notarize).toBe(0);
    expect(await proofRows(a)).toEqual([]);
  });

  it('a control envelope (a proof envelope) is NOT_NOTARIZABLE', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    const proofEnvelope = await a.store.transaction(
      (tx) => tx.select('envelopes', { direction: 'out', type: 'proof' })[0],
    );
    expect(await a.client.notarize({ envelopeId: proofEnvelope!.envelope_id })).toEqual({
      status: 'rejected',
      code: 'NOT_NOTARIZABLE',
    });
  });

  it('the recipient signs nothing when the on-chain kind does not match the envelope it holds', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    // A record for the right envelope hash and commitment, but kind FILE for a text without files.
    const { recordId, salt } = await recordDirectly(a, b, envelopeId, RECORD_KIND.FILE);
    await sendProofEnvelope(a, b, { envelopeId, recordId, salt });
    expect(await receipts(b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
  });
});

describe('no receipt on a record that does not match (tampered proof envelope, 04 §3.4, 05 §3.3)', () => {
  it('a wrong salt, another record, or another envelope gets no receipt', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const other = await sendText(a, b, 'a second message');
    const real = await recordDirectly(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const otherRecord = await recordDirectly(a, b, other, RECORD_KIND.MESSAGE);

    // Wrong salt: the commitment does not open to B.
    await sendProofEnvelope(a, b, { envelopeId, recordId: real.recordId, salt: `0x${'77'.repeat(32)}` });
    // The record of another envelope, named for this one.
    await sendProofEnvelope(a, b, { envelopeId, recordId: otherRecord.recordId, salt: otherRecord.salt });
    // A record ID with no record.
    await sendProofEnvelope(a, b, { envelopeId, recordId: `0x${'ab'.repeat(32)}`, salt: real.salt });
    expect(await receipts(b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
    expect(await b.client.getProof({ envelopeId })).toBeUndefined();
    // B cannot acknowledge what it never verified.
    expect(await b.client.acknowledge({ envelopeId, type: 'opened' })).toEqual({
      status: 'rejected',
      code: 'NOT_RECORDED',
    });
  });

  it('a record signed by someone other than the sending contact gets no receipt', async () => {
    const { a, b } = await twoAgents();
    const c = await openAgent(33, ownerC, 'carol');
    await pair(c, b);
    chain.fund(c.id, 10n * FEE_UNITS);
    const envelopeId = await sendText(a, b);
    const hash = await envelopeHashOf(a, envelopeId);
    // C records A's envelope hash with a commitment to B, then A forwards C's record as its own.
    const built = buildRecord({
      chainId: chain.config.chainId,
      notary: chain.config.contracts.notary,
      signer: c.id,
      envelopeHash: hash,
      recipient: b.id,
      kind: RECORD_KIND.MESSAGE,
      feeToken: USDC,
      maxFee: FEE_UNITS,
      deadline: clock.t + 3600,
    });
    chain.put(built.record);
    await sendProofEnvelope(a, b, { envelopeId, recordId: built.recordId, salt: built.salt! });
    expect(await receipts(b)).toEqual([]);
  });
});

describe('credits and policy (06 §3, 07 §6.3)', () => {
  it('zero credits: needs_credits with the agent address and the top-up route; nothing is signed', async () => {
    const a = await openAgent(31, ownerA, 'alice');
    const b = await openAgent(32, ownerB, 'bob');
    await pair(a, b);
    const envelopeId = await sendText(a, b);
    const r = await a.client.notarize({ envelopeId });
    expect(r).toMatchObject({
      status: 'needs_credits',
      topUp: { agentAddress: a.id, chainId: 84532, feeUsd: '0.1' },
    });
    expect(await proofRows(a)).toEqual([]);
    expect(await ledger(a)).toEqual([]);
    expect(chain.calls.notarize).toBe(0);
  });

  it('proofs.notarize approval: pending_approval, then the approved call records once', async () => {
    const { a, b } = await twoAgents();
    await setPolicy(a, (p) => {
      p.proofs.notarize = 'approval';
    });
    const envelopeId = await sendText(a, b);
    const pending = await a.client.notarize({ envelopeId });
    expect(pending.status).toBe('pending_approval');
    expect(chain.calls.notarize).toBe(0);
    const approvalId = (pending as { approvalId: string }).approvalId;
    await approve(a, approvalId);
    expect(await a.client.notarize({ envelopeId, approvalId })).toMatchObject({ status: 'ok' });
    expect(chain.calls.notarize).toBe(1);
    const [entry] = await ledger(a);
    expect(entry).toMatchObject({ approval_id: approvalId });
  });

  it('proofs.notarize deny: POLICY_DENIED, nothing signed', async () => {
    const { a, b } = await twoAgents();
    await setPolicy(a, (p) => {
      p.proofs.notarize = 'deny';
    });
    const envelopeId = await sendText(a, b);
    expect(await a.client.notarize({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'POLICY_DENIED',
    });
    expect(await proofRows(a)).toEqual([]);
  });
});

describe('ACCEPTED / REJECTED without terms are commitments (D-31, 06 §2.4)', () => {
  it('no ACCEPTED under the default policy without an owner-signed approval; then exclusive', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    const pending = await b.client.acknowledge({ envelopeId, type: 'accepted' });
    expect(pending.status).toBe('pending_approval');
    expect((await receipts(b)).map((r) => r.type)).toEqual([1]);
    const approvalId = (pending as { approvalId: string }).approvalId;
    // An approval ID the owner has not signed does nothing.
    expect(await b.client.acknowledge({ envelopeId, type: 'accepted', approvalId })).toMatchObject({
      status: 'rejected',
    });
    await approve(b, approvalId);
    expect(
      await b.client.acknowledge({ envelopeId, type: 'accepted', approvalId }),
    ).toMatchObject({ status: 'ok', receipt: 'ACCEPTED' });
    expect((await receipts(b)).map((r) => r.type).sort()).toEqual([1, 3]);
    // REJECTED is exclusive with ACCEPTED.
    expect(await b.client.acknowledge({ envelopeId, type: 'rejected' })).toEqual({
      status: 'rejected',
      code: 'RECEIPT_CONFLICT',
    });
  });

  it('accepted on a record whose envelope carries terms is USE_RESPOND_TO_TERMS', async () => {
    const { a, b } = await twoAgents();
    const { envelopeId } = await offerRecorded(a, b);
    expect(await b.client.acknowledge({ envelopeId, type: 'accepted' })).toEqual({
      status: 'rejected',
      code: 'USE_RESPOND_TO_TERMS',
    });
  });
});

describe('key disclosure in the export (07 §8, G-46; 06 §3 allowKeyDisclosure)', () => {
  it('without an approval: pending_approval and no key; approved: envelope + CEK, verified; one use', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    await deliver(a, b);

    const pending = await a.client.exportProofPack({ envelopeId, includeContentKey: true });
    expect(pending.status).toBe('pending_approval');
    expect(JSON.stringify(pending)).not.toContain('contentKey');
    const approvalId = (pending as { approvalId: string }).approvalId;
    await approve(a, approvalId);

    const exported = await a.client.exportProofPack({
      envelopeId,
      includeContentKey: true,
      approvalId,
    });
    expect(exported.status).toBe('ok');
    const pack = (exported as { pack: Record<string, unknown> }).pack;
    expect(pack.envelope).toBeDefined();
    expect((pack.disclosure as { contentKey: string }).contentKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const result = await verifyProofPack(JSON.stringify(pack), {
      chains: [{ config: chain.config, client: chain.client }],
    });
    expect(result).toMatchObject({ valid: true, verdict: 'verified', contentVerified: true });

    // The approval was for one export.
    const again = await a.client.exportProofPack({
      envelopeId,
      includeContentKey: true,
      approvalId,
    });
    expect(again.status).toBe('rejected');
    // No log line carries the content key.
    const key = (pack.disclosure as { contentKey: string }).contentKey;
    expect(a.lines.join('\n')).not.toContain(key);
  });

  it('allowKeyDisclosure deny: POLICY_DENIED; a recipient without the record cannot export', async () => {
    const { a, b } = await twoAgents();
    await setPolicy(a, (p) => {
      p.proofs.allowKeyDisclosure = 'deny';
    });
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    expect(await a.client.exportProofPack({ envelopeId, includeContentKey: true })).toEqual({
      status: 'rejected',
      code: 'POLICY_DENIED',
    });
    // The `proof` body carries no Record or signature (04 §3.4): the recipient cannot build a pack.
    expect(await b.client.exportProofPack({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'RECORD_UNAVAILABLE',
    });
  });
});

describe('fresh salts (04 §5, D-61)', () => {
  it('two Records for the same recipient have different CSPRNG salts, nonces and commitments', async () => {
    const { a, b } = await twoAgents();
    const one = await sendText(a, b, 'one');
    const two = await sendText(a, b, 'two');
    const r1 = (await a.client.notarize({ envelopeId: one })) as { recordId: string };
    const r2 = (await a.client.notarize({ envelopeId: two })) as { recordId: string };
    const s1 = onChain(r1.recordId)!.record;
    const s2 = onChain(r2.recordId)!.record;
    expect(r1.recordId).not.toBe(r2.recordId);
    expect(s1.recipientCommitment).not.toBe(s2.recipientCommitment);
    expect(s1.nonce).not.toBe(s2.nonce);
    const salts = await saltsSent(a);
    expect(salts).toHaveLength(2);
    expect(salts[0]).not.toBe(salts[1]);
    // The salt never reaches a log line.
    for (const s of salts) expect(a.lines.join('\n')).not.toContain(s.slice(2, 26));
  });

  it('no salt-derivation API is exported', () => {
    const names = Object.keys(core).map((n) => n.toLowerCase());
    expect(names.filter((n) => n.includes('salt'))).toEqual([]);
  });
});

describe('replacing a signed Record (04 §5)', () => {
  it('a censored Record is resent unchanged, and replaced only after the deadline with nothing on-chain', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    chain.censor = true;
    const first = await a.client.notarize({ envelopeId });
    expect(first.status).toBe('submitted');
    const firstId = (first as { recordId: string }).recordId;

    // Before the deadline: the same signed item again, never a new one.
    expect(await a.client.proofs.resubmitPending()).toMatchObject({ replaced: 0 });
    expect(await proofRows(a)).toHaveLength(1);

    // After the deadline, the finalized block shows no record: one replacement, fresh salt.
    clock.t += 3601 + 60;
    chain.censor = false;
    expect(await a.client.proofs.resubmitPending()).toMatchObject({ replaced: 1 });
    const rows = await proofRows(a);
    expect(rows).toHaveLength(2);
    const replacement = rows.find((r) => r.record_id !== firstId)!;
    expect(onChain(replacement.record_id)).toBeDefined();
    expect(onChain(firstId)).toBeUndefined();
    const entries = await ledger(a);
    expect(entries.map((e) => e.state).sort()).toEqual(['charged', 'released']);
    expect(entries.find((e) => e.state === 'charged')?.replaces).toBe(
      entries.find((e) => e.state === 'released')?.entry_id,
    );
    // Still exactly one charge on-chain.
    expect(chain.creditOf(a.id)).toBe(9n * FEE_UNITS);
  });

  it('an earlier Record that landed is never replaced: it becomes the record, charged once', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    chain.censor = true;
    const first = (await a.client.notarize({ envelopeId })) as { recordId: string };
    // It lands through another route just before its deadline.
    const row = (await proofRows(a))[0]!;
    const signed = parseJson(row.record_json) as { record: never };
    chain.put(signed.record);
    clock.t += 3601 + 60;
    expect(await a.client.proofs.resubmitPending()).toMatchObject({ replaced: 0 });
    expect(await proofRows(a)).toHaveLength(1);
    expect((await ledger(a)).map((e) => e.state)).toEqual(['charged']);
    expect(await a.client.getProof({ envelopeId })).toMatchObject({ recordId: first.recordId });
  });
});

describe('the deferred ACCEPTED receipt (07 §2.1 step 4, D-55)', () => {
  it('an offer recorded after the approved accept gets exactly one ACCEPTED, with no second approval', async () => {
    const { a, b } = await twoAgents();
    const offer = await sendOffer(a, b);
    const accepted = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    expect(accepted.status).toBe('pending_approval');
    const approvalId = (accepted as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    expect(
      await b.client.respondToTerms({ envelopeId: offer, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'ok' });

    const rec = await recordDirectly(a, b, offer, RECORD_KIND.OFFER);
    await sendProofEnvelope(a, b, { envelopeId: offer, recordId: rec.recordId, salt: rec.salt });
    const stored = onChain(rec.recordId)!;
    expect(stored.receiptAt[2]).not.toBe(0n);
    const parts = await b.store.transaction((tx) =>
      tx.get('commitment_parts', { approval_id: approvalId, part: 'receipt' }),
    );
    expect(parts?.state).toBe('done');

    // The same proof again: nothing more is signed.
    const before = chain.calls.acknowledge;
    await sendProofEnvelope(a, b, { envelopeId: offer, recordId: rec.recordId, salt: rec.salt });
    expect(chain.calls.acknowledge).toBe(before);
    expect((await receipts(b)).filter((r) => r.type === 3)).toHaveLength(1);
  });

  it('a record arriving after the scope expired gets no ACCEPTED', async () => {
    const { a, b } = await twoAgents();
    const offer = await sendOffer(a, b);
    const accepted = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    const approvalId = (accepted as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    await b.client.respondToTerms({ envelopeId: offer, decision: 'accept', approvalId });
    clock.t += 8 * 86_400;
    chain.fund(a.id, 10n * FEE_UNITS);
    const rec = await recordDirectly(a, b, offer, RECORD_KIND.OFFER);
    await sendProofEnvelope(a, b, { envelopeId: offer, recordId: rec.recordId, salt: rec.salt });
    expect(onChain(rec.recordId)!.receiptAt[2]).toBe(0n);
  });

  it('an OFFER record of another envelope gets no ACCEPTED', async () => {
    const { a, b } = await twoAgents();
    const offer = await sendOffer(a, b);
    const accepted = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    const approvalId = (accepted as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    await b.client.respondToTerms({ envelopeId: offer, decision: 'accept', approvalId });
    const note = await sendText(a, b, 'not the offer');
    const rec = await recordDirectly(a, b, note, RECORD_KIND.MESSAGE);
    await sendProofEnvelope(a, b, { envelopeId: note, recordId: rec.recordId, salt: rec.salt });
    expect(onChain(rec.recordId)!.receiptAt[2]).toBe(0n);
    expect((await receipts(b)).filter((r) => r.type === 3)).toEqual([]);
  });
});

// --- helpers -------------------------------------------------------------------------------------

async function envelopeHashOf(agent: Agent, envelopeId: string): Promise<string> {
  const row = await agent.store.transaction((tx) =>
    tx.get('envelopes', { envelope_id: envelopeId }),
  );
  return `0x${row!.envelope_hash.replace(/^0x/, '')}`;
}

/** A Record for `envelopeId` signed by `from` with a commitment to `to`, put on-chain directly. */
async function recordDirectly(from: Agent, to: Agent, envelopeId: string, kind: number) {
  const built = buildRecord({
    chainId: chain.config.chainId,
    notary: chain.config.contracts.notary,
    signer: from.id,
    envelopeHash: await envelopeHashOf(from, envelopeId),
    recipient: to.id,
    kind: kind as never,
    feeToken: USDC,
    maxFee: FEE_UNITS,
    deadline: clock.t + 3600,
  });
  await signRecord(from.keyStore, built);
  chain.put(built.record);
  return { recordId: built.recordId as string, salt: built.salt as string };
}

/** `from` sends a `proof` envelope with this body to `to`, which processes it. */
async function sendProofEnvelope(
  from: Agent,
  to: Agent,
  body: { envelopeId: string; recordId: string; salt: string },
) {
  const { built, row } = await from.client.envelopes.prepare({
    to: { contact: to.id },
    payload: {
      type: 'proof',
      body: { ...body, chainId: chain.config.chainId },
      replyTo: body.envelopeId,
      files: [],
    },
  });
  await from.store.transaction((tx) => tx.insert('envelopes', row));
  await to.client.envelopes.receive({ envelope: built.envelope });
  const reports = await to.client.envelopes.processReceived();
  await to.client.proofs.processInbound(reports);
}

async function sendOffer(a: Agent, b: Agent): Promise<string> {
  const offer = await a.client.proposeTerms({
    to: b.id,
    terms: {
      subject: 'Website redesign',
      deliverables: [{ description: 'Design files', by: 'them' }],
      price: { amount: '500.00', currency: 'USD', payer: 'me' },
    },
  });
  await deliver(a, b);
  return (offer as { envelopeId: string }).envelopeId;
}

async function offerRecorded(a: Agent, b: Agent) {
  const envelopeId = await sendOffer(a, b);
  const rec = await recordDirectly(a, b, envelopeId, RECORD_KIND.OFFER);
  await sendProofEnvelope(a, b, { envelopeId, recordId: rec.recordId, salt: rec.salt });
  return { envelopeId, ...rec };
}

/** The salts `agent` delivered in its `proof` envelopes, from its own store. */
async function saltsSent(agent: Agent): Promise<string[]> {
  const rows = await agent.store.transaction((tx) =>
    tx.select('envelopes', { direction: 'out', type: 'proof' }),
  );
  const out: string[] = [];
  for (const row of rows) {
    const text = await agent.cipher.open(
      { table: 'envelopes', column: 'payload_json', rowKey: JSON.stringify([row.envelope_id]) },
      row.payload_json!,
    );
    out.push((parseJson(text) as { body: { salt: string } }).body.salt);
  }
  return out;
}
