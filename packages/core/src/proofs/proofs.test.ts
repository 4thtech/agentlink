// M1-7g: notarize, receipts and the proof-pack export, end to end between two real cores (03 §4.3;
// 04 §3.4 `proof`, §5; 05 §3.1, §3.3; 06 §2.4, §3; 07 §2.1 step 4, §6.2, §6.3, §8; D-31, D-32, D-55,
// D-61, D-86, D-102). Envelopes are real signed envelopes handed to the other core's receive path;
// the chain is the in-memory Notary of testing/chain.ts behind the chain package's own submitter,
// selector and verifier, so every chain decision runs the code that runs against a testnet.
import { parseJson, type JsonObject, type KeyStore } from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { RECORD_KIND, buildRecord, signRecord, verifyProofPack, type Hex } from '@4thtech-io/chain';
import { createLogger } from '@4thtech-io/log';
import { defaultPolicy, type Policy, type RecordJson } from '@4thtech-io/types';
import { wrapEnvelope, type PublishOutcome } from '@4thtech-io/transport-nostr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  agentEnc,
  agentSigner,
  craft,
  ownerEnc,
  pairWith,
  type TestOwner,
} from '../testing/envelopes.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from '../testing/owner.js';
import type { TransportFactory } from '../transport.js';

// Each test here runs two or three real cores end to end (signed envelopes, pairing, owner-signed
// rules, notarize, receipts). On a loaded CI runner this file runs ~10-40x slower than locally: on
// main the first acceptance test took 15.3 s against the 20 s default (0.5 s locally), and the
// three-agent contact-rule test took 20.5 s (0.73 s locally). This file allows 60 s, as the
// Argon2id files do (repo-reference, M0-10e). Assertions are unchanged.
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
  return {
    client,
    store,
    cipher,
    keyStore,
    owner,
    id: client.agentId,
    mark,
    lines,
    policyVersion: 0,
  };
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

/**
 * A and B, paired, A funded. Delivery receipts are off by default (D-109), so unless a test asks
 * for the defaults, B's owner turns them on (`receipts.autoDelivered: true`): every "no receipt"
 * check below then proves the refusal, not the default.
 */
async function twoAgents({ defaults = false }: { readonly defaults?: boolean } = {}) {
  const a = await openAgent(31, ownerA, 'alice');
  const b = await openAgent(32, ownerB, 'bob');
  await pair(a, b);
  chain.fund(a.id, 10n * FEE_UNITS);
  if (!defaults) {
    await setPolicy(b, (p) => {
      p.receipts.autoDelivered = true;
    });
  }
  return { a, b };
}

beforeEach(() => {
  clock = new FakeClock();
  chain = new FakeNotary(clock.now);
});

describe('notarize → DELIVERED → OPENED → export → verify (acceptance, testnet-style)', () => {
  it('records, delivers the salt, gets automatic DELIVERED and explicit OPENED, and the pack verifies', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    // B's owner turned delivery receipts on for A (06 §3 contact rule, D-109).
    await setPolicy(b, (p) => {
      p.contactRules = [{ contact: a.id, receipts: { autoDelivered: true } }];
    });
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

    // The proof envelope reaches B; B checks on-chain, then DELIVERED goes out under B's rule.
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
    });
    expect(pack).not.toHaveProperty('envelope');
    // 07 §8 "optional disclosure", 04 §5: the recipient and the salt only on an explicit request.
    expect(pack).not.toHaveProperty('recipient');
    const named = await a.client.exportProofPack({ envelopeId, includeRecipient: true });
    const withRecipient = (named as { pack: Record<string, unknown> }).pack;
    expect(withRecipient.recipient).toMatchObject({ evm: b.id });
    expect(
      await verifyProofPack(JSON.stringify(withRecipient), {
        chains: [{ config: chain.config, client: chain.client }],
      }),
    ).toMatchObject({ valid: true, recipient: { evm: b.id } });
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
    expect(
      (result as unknown as { receipts: { type: string }[] }).receipts.map((r) => r.type),
    ).toEqual(['DELIVERED', 'OPENED']);
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

  it('the default rules (D-109): the proof is checked and stored, and no DELIVERED is signed', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    const proof = await a.client.notarize({ envelopeId });
    await deliver(a, b);
    expect(await receipts(b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
    expect(await b.client.getProof({ envelopeId })).toMatchObject({
      recordId: (proof as { recordId: string }).recordId,
    });
  });

  it('a contact rule turns DELIVERED on for that contact only (06 §3, D-109)', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const c = await openAgent(33, ownerC, 'carol');
    await pair(c, b);
    chain.fund(c.id, 10n * FEE_UNITS);
    await setPolicy(b, (p) => {
      p.contactRules = [{ contact: a.id, receipts: { autoDelivered: true } }];
    });

    const fromA = await sendText(a, b);
    const recordA = (await a.client.notarize({ envelopeId: fromA })) as { recordId: string };
    await deliver(a, b);
    expect(await receipts(b)).toEqual([
      expect.objectContaining({ record_id: recordA.recordId, type: 1, signer: b.id }),
    ]);

    const fromC = await sendText(c, b);
    const recordC = (await c.client.notarize({ envelopeId: fromC })) as { recordId: string };
    await deliver(c, b);
    expect((await receipts(b)).map((r) => r.record_id)).toEqual([recordA.recordId]);
    expect(onChain(recordC.recordId)?.receiptAt[0]).toBe(0n);
    expect(chain.calls.acknowledge).toBe(1);
  });

  it('under failing rules no DELIVERED is signed, even with a contact rule on (G-6)', async () => {
    const { a, b } = await twoAgents();
    await setPolicy(b, (p) => {
      p.receipts.autoDelivered = true;
      p.contactRules = [{ contact: a.id, receipts: { autoDelivered: true } }];
    });
    // The stored rules go missing after a version was applied: fail closed (06 §3).
    await b.store.transaction((tx) => tx.delete('policies', {}));
    expect((await b.client.ownerActions.loadPolicy()).mode).toBe('fail_closed');
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    expect(await receipts(b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
  });

  it('a second notarize of the same envelope returns the stored record and charges nothing', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const first = await a.client.notarize({ envelopeId });
    const second = await a.client.notarize({ envelopeId });
    expect(second).toMatchObject({
      status: 'ok',
      recordId: (first as { recordId: string }).recordId,
    });
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
    await sendProofEnvelope(a, b, {
      envelopeId,
      recordId: real.recordId,
      salt: `0x${'77'.repeat(32)}`,
    });
    // The record of another envelope, named for this one.
    await sendProofEnvelope(a, b, {
      envelopeId,
      recordId: otherRecord.recordId,
      salt: otherRecord.salt,
    });
    // A record ID with no record.
    await sendProofEnvelope(a, b, {
      envelopeId,
      recordId: `0x${'ab'.repeat(32)}`,
      salt: real.salt,
    });
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
    // The defaults in full (D-109: no automatic DELIVERED either); ACCEPTED is unchanged.
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    const pending = await b.client.acknowledge({ envelopeId, type: 'accepted' });
    expect(pending.status).toBe('pending_approval');
    expect((await receipts(b)).map((r) => r.type)).toEqual([]);
    const approvalId = (pending as { approvalId: string }).approvalId;
    // An approval ID the owner has not signed does nothing.
    expect(await b.client.acknowledge({ envelopeId, type: 'accepted', approvalId })).toMatchObject({
      status: 'rejected',
    });
    await approve(b, approvalId);
    expect(await b.client.acknowledge({ envelopeId, type: 'accepted', approvalId })).toMatchObject({
      status: 'ok',
      receipt: 'ACCEPTED',
    });
    expect((await receipts(b)).map((r) => r.type)).toEqual([3]);
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

  it('allowKeyDisclosure deny: POLICY_DENIED on the sender side and on the recipient side', async () => {
    const { a, b } = await twoAgents();
    for (const agent of [a, b]) {
      await setPolicy(agent, (p) => {
        p.proofs.allowKeyDisclosure = 'deny';
      });
    }
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    expect(await a.client.exportProofPack({ envelopeId, includeContentKey: true })).toEqual({
      status: 'rejected',
      code: 'POLICY_DENIED',
    });
    // D-107: the recipient holds the signed Record and can export, under the same key rule.
    expect(await b.client.exportProofPack({ envelopeId, includeContentKey: true })).toEqual({
      status: 'rejected',
      code: 'POLICY_DENIED',
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

describe('signed receipts are stored and resent unchanged (04 §5; IR-M1-7g-1 M1, M2, L5)', () => {
  it('an OPENED that did not land is resent byte for byte until it lands', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId })) as { recordId: string };
    await deliver(a, b);
    chain.censor = true;
    expect(await b.client.acknowledge({ envelopeId, type: 'opened' })).toMatchObject({
      status: 'ok',
      onChain: false,
    });
    const first = chain.receiptSignatures.at(-1);
    // A second call does not report it forever as not on-chain: it resends the stored item.
    chain.censor = false;
    expect(await b.client.acknowledge({ envelopeId, type: 'opened' })).toMatchObject({
      status: 'ok',
      onChain: true,
    });
    expect(chain.receiptSignatures.at(-1)).toBe(first);
    expect(onChain(proof.recordId)!.receiptAt[1]).not.toBe(0n);
  });

  it('an approved ACCEPTED that did not land is resent by resubmitPending, not lost with its approval', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId })) as { recordId: string };
    await deliver(a, b);
    const pending = await b.client.acknowledge({ envelopeId, type: 'accepted' });
    const approvalId = (pending as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    chain.censor = true;
    await b.client.acknowledge({ envelopeId, type: 'accepted', approvalId });
    const first = chain.receiptSignatures.at(-1);
    expect(onChain(proof.recordId)!.receiptAt[2]).toBe(0n);
    chain.censor = false;
    expect(await b.client.proofs.resubmitPending()).toMatchObject({ recorded: 1 });
    expect(onChain(proof.recordId)!.receiptAt[2]).not.toBe(0n);
    expect(chain.receiptSignatures.at(-1)).toBe(first);
  });

  it('a receipt is replaced only after its deadline, with nothing on-chain at the finalized block', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId })) as { recordId: string };
    chain.censor = true;
    await deliver(a, b);
    const first = chain.receiptSignatures.at(-1);
    await b.client.proofs.resubmitPending();
    expect(chain.receiptSignatures.at(-1)).toBe(first);
    clock.t += 3_600 + 60;
    chain.censor = false;
    await b.client.proofs.resubmitPending();
    expect(chain.receiptSignatures.at(-1)).not.toBe(first);
    expect(onChain(proof.recordId)!.receiptAt[0]).not.toBe(0n);
  });

  it('a deferred ACCEPTED whose submit failed is republished and its part marked done when it lands', async () => {
    const { a, b } = await twoAgents();
    const offer = await sendOffer(a, b);
    const accepted = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    const approvalId = (accepted as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    await b.client.respondToTerms({ envelopeId: offer, decision: 'accept', approvalId });
    const rec = await recordDirectly(a, b, offer, RECORD_KIND.OFFER);
    chain.censor = true;
    await sendProofEnvelope(a, b, { envelopeId: offer, recordId: rec.recordId, salt: rec.salt });
    const part = () =>
      b.store.transaction((tx) =>
        tx.get('commitment_parts', { approval_id: approvalId, part: 'receipt' }),
      );
    expect((await part())?.state).toBe('claimed');
    chain.censor = false;
    await b.client.proofs.resubmitPending();
    expect(onChain(rec.recordId)!.receiptAt[2]).not.toBe(0n);
    expect((await part())?.state).toBe('done');
  });

  it('a proof envelope that arrives before its message is kept and checked when the message arrives', async () => {
    const { a, b } = await twoAgents();
    const sent = await a.client.sendMessage({ to: b.id, text: 'late message' });
    const envelopeId = (sent as { envelopeId: string }).envelopeId;
    const rec = await recordDirectly(a, b, envelopeId, RECORD_KIND.MESSAGE);
    await sendProofEnvelope(a, b, { envelopeId, recordId: rec.recordId, salt: rec.salt });
    expect(await receipts(b)).toEqual([]);
    // Now the message itself arrives: the kept proof is checked and DELIVERED signed.
    await deliver(a, b);
    expect(onChain(rec.recordId)!.receiptAt[0]).not.toBe(0n);
    expect(await b.client.getProof({ envelopeId })).toMatchObject({ recordId: rec.recordId });
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

  it('an offer recorded before the accept: the approved accept signs its ACCEPTED at once', async () => {
    const { a, b } = await twoAgents();
    const { envelopeId: offer, recordId } = await offerRecorded(a, b);
    const accepted = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    expect(onChain(recordId)!.receiptAt[2]).toBe(0n);
    const approvalId = (accepted as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    expect(
      await b.client.respondToTerms({ envelopeId: offer, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'ok' });
    expect(onChain(recordId)!.receiptAt[2]).not.toBe(0n);
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

// --- M1-7g-b: the signed Record in the `proof` body and the recipient-side export (D-107) --------

/** The proofs row status of a body whose chain read failed (04 §3.4, M1-7g-b; white-box). */
const PENDING = 'proof_pending';
const logged = (agent: Agent, code: string) => agent.lines.some((l) => l.includes(code));
const pendingRows = async (agent: Agent) =>
  (await proofRows(agent)).filter((r) => r.status === PENDING);
const verify = (pack: unknown) =>
  verifyProofPack(JSON.stringify(pack), {
    chains: [{ config: chain.config, client: chain.client }],
  });

describe('the sender puts the signed Record in the proof body (04 §3.4, D-107)', () => {
  it('every proof body the core sends carries the Record and signature exactly as submitted', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId })) as { recordId: Hex };
    const bodies = await proofBodiesSent(a);
    expect(bodies).toHaveLength(1);
    const stored = (await proofRows(a)).find((r) => r.record_id === proof.recordId)!;
    const item = parseJson(stored.record_json) as { record: unknown; signature: string };
    expect(bodies[0]).toEqual({
      envelopeId,
      chainId: chain.config.chainId,
      recordId: proof.recordId,
      salt: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown,
      record: item.record,
      signature: item.signature,
    });
    expect(bodies[0]!.record).toEqual(onChain(proof.recordId)!.record);
  });
});

describe('recipient-side export verifies end to end (07 §8, D-107)', () => {
  it('B exports A’s record: record_only without content, verified with A’s card and both card signatures', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId })) as { recordId: Hex };
    await deliver(a, b);
    expect(await receipts(b)).toEqual([expect.objectContaining({ type: 1, signer: b.id })]);

    const exported = await b.client.exportProofPack({ envelopeId });
    expect(exported.status).toBe('ok');
    const pack = (exported as { pack: Record<string, unknown> }).pack;
    const sent = (await proofBodiesSent(a))[0]!;
    expect(pack).toMatchObject({
      type: 'agentlink.proof',
      chainId: chain.config.chainId,
      notary: chain.config.contracts.notary.toLowerCase(),
      recordId: proof.recordId,
      record: sent.record,
      signature: sent.signature,
      envelopeHash: (sent.record as RecordJson).envelopeHash,
      disclosure: null,
    });
    // The recipient is left out by default (05 §3.3 privacy note).
    expect(pack).not.toHaveProperty('recipient');
    // The signer block: A's card of the envelope's key epoch with both of its signatures (D-102).
    const own = await a.client.identity.signedCard();
    expect(pack.signer).toEqual({
      evm: a.id,
      agentCard: own.card,
      cardSig: own.cardSig,
      cardAgentSig: own.cardAgentSig,
      cardPop: own.cardPop,
    });
    expect(await verify(pack)).toMatchObject({
      valid: true,
      verdict: 'record_only',
      recordId: proof.recordId,
      signer: a.id,
    });

    // With the content key (owner-approved): verified, attributed to A through A's card.
    const pending = await b.client.exportProofPack({ envelopeId, includeContentKey: true });
    expect(pending.status).toBe('pending_approval');
    const approvalId = (pending as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    const disclosed = await b.client.exportProofPack({
      envelopeId,
      includeContentKey: true,
      approvalId,
    });
    expect(disclosed.status).toBe('ok');
    const withKey = (disclosed as { pack: Record<string, unknown> }).pack;
    expect(withKey.envelope).toBeDefined();
    expect(await verify(withKey)).toMatchObject({
      valid: true,
      verdict: 'verified',
      contentVerified: true,
    });
    // The card alone (no proof of possession): record_only.
    const cardOnly = {
      ...withKey,
      signer: { evm: a.id, agentCard: own.card, cardSig: own.cardSig },
    };
    expect(await verify(cardOnly)).toMatchObject({ valid: true, verdict: 'record_only' });
  });

  it('includeRecipient: B’s own address and the salt; the verifier opens the commitment', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    const named = await b.client.exportProofPack({ envelopeId, includeRecipient: true });
    const pack = (named as { pack: Record<string, unknown> }).pack;
    const salt = (await proofBodiesSent(a))[0]!.salt;
    expect(pack.recipient).toEqual({ evm: b.id, salt });
    expect(await verify(pack)).toMatchObject({ valid: true, recipient: { evm: b.id } });
  });

  it('a proof of agreement: B’s pack of A’s OFFER record carries B’s approval, valid on the recipient side', async () => {
    const { a, b } = await twoAgents();
    const offer = await sendOffer(a, b);
    const accepted = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    const approvalId = (accepted as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    expect(
      await b.client.respondToTerms({ envelopeId: offer, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'ok' });
    const rec = await signedRecordOf(a, b, offer, RECORD_KIND.OFFER);
    await sendProofEnvelope(a, b, bodyOf(rec, offer));
    expect(onChain(rec.recordId)!.receiptAt[2]).not.toBe(0n);

    const exported = await b.client.exportProofPack({ envelopeId: offer });
    expect(exported.status).toBe('ok');
    const pack = (exported as { pack: Record<string, unknown> }).pack;
    expect(pack.ownerApproval).not.toBeNull();
    expect(await verify(pack)).toMatchObject({
      valid: true,
      ownerApproval: { status: 'signed', approver: 'recipient', decision: 'accept' },
    });
    // The owner may leave it out.
    const without = await b.client.exportProofPack({
      envelopeId: offer,
      includeOwnerApproval: false,
    });
    expect((without as { pack: Record<string, unknown> }).pack.ownerApproval).toBeNull();
  });
});

describe('the recipient checks the signed Record before storing it (04 §3.4 checks 1–5)', () => {
  interface Tamper {
    readonly a: Agent;
    readonly b: Agent;
    readonly envelopeId: string;
    readonly rec: SignedRecord;
  }

  /** A real Record for a real message, then its `proof` body with `edit` applied, sent to B. */
  async function tampered(
    edit: (body: ProofBodyIn, ctx: Tamper) => Promise<void> | void,
  ): Promise<Tamper> {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const body = bodyOf(rec, envelopeId);
    const ctx = { a, b, envelopeId, rec };
    await edit(body, ctx);
    await sendProofEnvelope(a, b, body);
    return ctx;
  }

  async function expectDropped(out: { readonly b: Agent; readonly envelopeId: string }) {
    expect(await receipts(out.b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
    expect(await out.b.client.getProof({ envelopeId: out.envelopeId })).toBeUndefined();
    expect(await pendingRows(out.b)).toEqual([]);
    expect(logged(out.b, 'proof_mismatch')).toBe(true);
  }

  it('an untampered body passes, is stored as received and gets DELIVERED', async () => {
    const out = await tampered(() => undefined);
    expect(await receipts(out.b)).toEqual([expect.objectContaining({ type: 1 })]);
    const row = (await proofRows(out.b)).find((r) => r.record_id === out.rec.recordId)!;
    const stored = parseJson(row.record_json) as { record: unknown; signature: string };
    expect(stored.record).toEqual(out.rec.record);
    expect(stored.signature).toBe(out.rec.signature);
    expect(logged(out.b, 'proof_mismatch')).toBe(false);
  });

  it.each([
    ['envelopeHash', (r: RecordJson) => void (r.envelopeHash = `0x${'e1'.repeat(32)}`)],
    [
      'recipientCommitment',
      (r: RecordJson) => void (r.recipientCommitment = `0x${'c2'.repeat(32)}`),
    ],
    ['kind', (r: RecordJson) => void (r.kind = RECORD_KIND.FILE)],
    ['nonce', (r: RecordJson) => void (r.nonce = (BigInt(r.nonce) + 1n).toString())],
    ['maxFee', (r: RecordJson) => void (r.maxFee = (BigInt(r.maxFee) + 1n).toString())],
    ['parentRecordId', (r: RecordJson) => void (r.parentRecordId = `0x${'9d'.repeat(32)}`)],
  ])('a changed record.%s is dropped: no proof, no receipt, proof_mismatch', async (_f, change) => {
    await expectDropped(
      await tampered((body) => {
        change(body.record as RecordJson);
      }),
    );
  });

  it('a struct hash that differs from the on-chain recordStructHash is dropped', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE, { put: false });
    // The chain holds a Record with the same signer, nonce, hash, commitment and kind, another deadline.
    chain.put({ ...rec.built.record, deadline: rec.built.record.deadline + 1 });
    await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    await expectDropped({ b, envelopeId });
  });

  it('a recordId that does not derive from signer and nonce is dropped', async () => {
    await expectDropped(
      await tampered(async (body, { a, b }) => {
        const other = await sendText(a, b, 'another message');
        body.recordId = (await signedRecordOf(a, b, other, RECORD_KIND.MESSAGE)).recordId;
      }),
    );
  });

  it('a record signed by someone other than the contact’s card agentEvm is dropped', async () => {
    const { a, b } = await twoAgents();
    const c = await openAgent(33, ownerC, 'carol');
    await pair(c, b);
    const envelopeId = await sendText(a, b);
    // C's own Record of A's envelope hash, committed to B, forwarded by A as its own.
    const rec = await signedRecordOf(c, b, envelopeId, RECORD_KIND.MESSAGE, {
      envelopeHash: await envelopeHashOf(a, envelopeId),
    });
    await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    await expectDropped({ b, envelopeId });
  });

  it('a signature by another key is dropped', async () => {
    const c = await openAgent(33, ownerC, 'carol');
    await expectDropped(
      await tampered(async (body, { rec }) => {
        body.signature = await signRecord(c.keyStore, rec.built);
      }),
    );
  });

  it('a non-canonical (high-s) ECDSA signature is dropped', async () => {
    await expectDropped(
      await tampered((body) => {
        body.signature = highS(body.signature as string);
      }),
    );
  });

  it('an ERC-1271 signer that does not accept is dropped; one that accepts is stored', async () => {
    const c = await openAgent(33, ownerC, 'carol');
    // A's address has code; the signature is not A's ECDSA signature: only the account can accept.
    const refused = await tampered(async (body, { a, rec }) => {
      chain.contractAccounts.set(a.id.toLowerCase(), false);
      body.signature = await signRecord(c.keyStore, rec.built);
    });
    await expectDropped(refused);

    const accepted = await tampered(async (body, { a, rec }) => {
      chain.contractAccounts.set(a.id.toLowerCase(), true);
      body.signature = await signRecord(c.keyStore, rec.built);
    });
    expect(await accepted.b.client.getProof({ envelopeId: accepted.envelopeId })).toMatchObject({
      recordId: accepted.rec.recordId,
    });
  });

  it.each([
    ['record without signature', (body: ProofBodyIn) => void delete body.signature],
    ['signature without record', (body: ProofBodyIn) => void delete body.record],
    [
      'an unknown key in the body',
      (body: ProofBodyIn) => void (body.notary = `0x${'9a'.repeat(20)}`),
    ],
    [
      'an unknown key in record',
      (body: ProofBodyIn) =>
        void ((body.record as Record<string, unknown>).txHash = `0x${'7e'.repeat(32)}`),
    ],
    [
      'an over-long signature',
      (body: ProofBodyIn) => void (body.signature = `0x${'e7'.repeat(4097)}`),
    ],
  ])(
    'a malformed body (%s) is refused as a malformed payload: nothing stored',
    async (_l, change) => {
      const { a, b } = await twoAgents();
      const envelopeId = await sendText(a, b);
      const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
      const body = bodyOf(rec, envelopeId);
      change(body);
      const reports = await sendRawProof(a, b, body);
      expect(reports).toMatchObject([{ outcome: 'dropped' }]);
      expect(await receipts(b)).toEqual([]);
      expect(await b.client.getProof({ envelopeId })).toBeUndefined();
      expect(await pendingRows(b)).toEqual([]);
    },
  );

  it('no log line or refusal carries the Record, signature or salt (I-7)', async () => {
    const out = await tampered((body) => {
      (body.record as RecordJson).maxFee = '1';
    });
    const text = [...out.a.lines, ...out.b.lines].join('\n');
    expect(logged(out.b, 'proof_mismatch')).toBe(true);
    expect(text).not.toContain(out.rec.signature.slice(2, 40));
    expect(text).not.toContain(out.rec.salt.slice(2, 40));
    expect(text).not.toContain(out.rec.record.nonce);
    expect(await out.b.client.exportProofPack({ envelopeId: out.envelopeId })).toEqual({
      status: 'rejected',
      code: 'NOT_RECORDED',
    });
  });
});

describe('an older sender without the signed Record (04 §3.4, D-107)', () => {
  it('is accepted as before, receipts work, and recipient export returns RECORD_UNAVAILABLE', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await recordDirectly(a, b, envelopeId, RECORD_KIND.MESSAGE);
    await sendProofEnvelope(a, b, { envelopeId, recordId: rec.recordId, salt: rec.salt });
    expect(await receipts(b)).toEqual([expect.objectContaining({ type: 1 })]);
    expect(await b.client.acknowledge({ envelopeId, type: 'opened' })).toMatchObject({
      status: 'ok',
    });
    expect(await b.client.exportProofPack({ envelopeId })).toEqual({
      status: 'rejected',
      code: 'RECORD_UNAVAILABLE',
    });
  });
});

describe('a failed chain read keeps the body pending (04 §3.4, M1-7g-b)', () => {
  it('pending with no receipt; after the read recovers the next sync checks and stores it', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    chain.readsFail = true;
    const proof = (await a.client.notarize({ envelopeId })) as { recordId: Hex };
    await deliver(a, b);
    expect(await receipts(b)).toEqual([]);
    expect(await b.client.getProof({ envelopeId })).toBeUndefined();
    expect(await pendingRows(b)).toHaveLength(1);
    expect(logged(b, 'proof_mismatch')).toBe(false);

    // Still failing at the next sync: still pending, nothing signed.
    await b.client.proofs.processInbound([]);
    expect(await pendingRows(b)).toHaveLength(1);
    expect(await receipts(b)).toEqual([]);

    chain.readsFail = false;
    await b.client.proofs.processInbound([]);
    expect(await pendingRows(b)).toEqual([]);
    expect(await b.client.getProof({ envelopeId })).toMatchObject({ recordId: proof.recordId });
    expect(await receipts(b)).toEqual([expect.objectContaining({ type: 1 })]);
    expect((await b.client.exportProofPack({ envelopeId })).status).toBe('ok');
  });

  it('a definite mismatch found after the read recovers drops it as proof_mismatch', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE, { put: false });
    chain.put({ ...rec.built.record, deadline: rec.built.record.deadline + 1 });
    chain.readsFail = true;
    await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    expect(await pendingRows(b)).toHaveLength(1);
    expect(logged(b, 'proof_mismatch')).toBe(false);
    chain.readsFail = false;
    await b.client.proofs.processInbound([]);
    expect(await proofRows(b)).toEqual([]);
    expect(logged(b, 'proof_mismatch')).toBe(true);
    expect(await receipts(b)).toEqual([]);
  });

  it('past 7 days a pending body is dropped as proof_unchecked', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    chain.readsFail = true;
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    expect(await pendingRows(b)).toHaveLength(1);
    clock.t += 7 * 86_400 + 1;
    await b.client.proofs.processInbound([]);
    expect(await proofRows(b)).toEqual([]);
    expect(logged(b, 'proof_unchecked')).toBe(true);
    chain.readsFail = false;
    await b.client.proofs.processInbound([]);
    expect(await b.client.getProof({ envelopeId })).toBeUndefined();
    expect(await receipts(b)).toEqual([]);
  });

  it('beyond 256 pending bodies a new one is dropped as proof_unchecked', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    // 256 bodies already pending (white-box rows standing in for 256 real ones).
    const empty = await b.cipher.seal(
      { table: 'proofs', column: 'salt', rowKey: JSON.stringify(['filler']) },
      '',
    );
    await b.store.transaction((tx) => {
      for (let i = 0; i < 256; i += 1) {
        tx.insert('proofs', {
          record_id: `pending:filler${String(i)}`,
          envelope_id: `filler${String(i)}`,
          chain_id: chain.config.chainId,
          record_json: '{}',
          tx_hash: null,
          status: PENDING,
          fee_token: null,
          fee_amount: null,
          salt: empty,
          created_at: clock.t,
        });
      }
    });
    chain.readsFail = true;
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    expect(logged(b, 'proof_unchecked')).toBe(true);
    expect((await pendingRows(b)).some((r) => r.envelope_id === envelopeId)).toBe(false);
    chain.readsFail = false;
    await b.client.proofs.processInbound([]);
    expect(await b.client.getProof({ envelopeId })).toBeUndefined();
    expect(await receipts(b)).toEqual([]);
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
async function sendProofEnvelope(from: Agent, to: Agent, body: ProofBodyIn) {
  const { built, row } = await from.client.envelopes.prepare({
    to: { contact: to.id },
    payload: {
      type: 'proof',
      body: { chainId: chain.config.chainId, ...body } as never,
      replyTo: body.envelopeId,
      files: [],
    },
  });
  await from.store.transaction((tx) => tx.insert('envelopes', row));
  await to.client.envelopes.receive({ envelope: built.envelope });
  const reports = await to.client.envelopes.processReceived();
  const result = await to.client.proofs.processInbound(reports);
  return { proofEnvelopeId: built.envelope.id, reports, result };
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

/** A `proof` body as a test sends it: the 04 §3.4 fields, possibly tampered. */
type ProofBodyIn = { envelopeId: string; recordId: string; salt: string } & Record<string, unknown>;

interface SignedRecord {
  readonly recordId: string;
  readonly salt: string;
  readonly record: RecordJson;
  readonly signature: string;
  readonly built: ReturnType<typeof buildRecord>;
}

/**
 * A Record for `envelopeId` by `from` with a commitment to `to`, signed by `from`, and (unless
 * `put: false`) put on-chain. `envelopeHash` overrides the hash (a Record of someone else's envelope).
 */
async function signedRecordOf(
  from: Agent,
  to: Agent,
  envelopeId: string,
  kind: number,
  options: {
    readonly put?: boolean;
    readonly envelopeHash?: string;
    readonly parentRecordId?: string;
  } = {},
): Promise<SignedRecord> {
  const built = buildRecord({
    chainId: chain.config.chainId,
    notary: chain.config.contracts.notary,
    signer: from.id,
    envelopeHash: options.envelopeHash ?? (await envelopeHashOf(from, envelopeId)),
    recipient: to.id,
    ...(options.parentRecordId === undefined ? {} : { parentRecordId: options.parentRecordId }),
    kind: kind as never,
    feeToken: USDC,
    maxFee: FEE_UNITS,
    deadline: clock.t + 3600,
  });
  const signature = await signRecord(from.keyStore, built);
  if (options.put !== false) chain.put(built.record);
  return {
    recordId: built.recordId,
    salt: built.salt!,
    record: { ...built.record } as RecordJson,
    signature,
    built,
  };
}

/** The full (M1-7g-b) `proof` body for a signed Record. */
const bodyOf = (rec: SignedRecord, envelopeId: string): ProofBodyIn => ({
  envelopeId,
  recordId: rec.recordId,
  salt: rec.salt,
  record: { ...rec.record },
  signature: rec.signature,
});

/** The bodies of the `proof` envelopes `agent` sent, from its own store. */
async function proofBodiesSent(agent: Agent): Promise<ProofBodyIn[]> {
  const rows = await agent.store.transaction((tx) =>
    tx.select('envelopes', { direction: 'out', type: 'proof' }),
  );
  const out: ProofBodyIn[] = [];
  for (const row of rows) {
    const text = await agent.cipher.open(
      { table: 'envelopes', column: 'payload_json', rowKey: JSON.stringify([row.envelope_id]) },
      row.payload_json!,
    );
    out.push((parseJson(text) as unknown as { body: ProofBodyIn }).body);
  }
  return out;
}

/** The secp256k1 group order. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The same ECDSA signature in its non-canonical high-s form (s → n − s, v flipped). */
function highS(signature: string): string {
  const r = signature.slice(2, 66);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  const flipped = (v === 27 ? 28 : 27).toString(16);
  return `0x${r}${(SECP256K1_N - s).toString(16).padStart(64, '0')}${flipped}`;
}

/** A `proof` envelope with this body exactly, built outside the core's payload checks. */
async function sendRawProof(from: Agent, to: Agent, body: ProofBodyIn) {
  const envelope = await craft({
    signer: await agentSigner(from.keyStore),
    entries: [
      { pk: await agentEnc(to) },
      { pk: await ownerEnc(to.owner) },
      { pk: await ownerEnc(from.owner) },
      { pk: await agentEnc(from) },
    ],
    payload: {
      type: 'proof',
      body: { chainId: chain.config.chainId, ...body },
      replyTo: body.envelopeId,
      files: [],
    } as never,
    createdAt: clock.t,
  });
  await to.client.envelopes.receive({ envelope });
  const reports = await to.client.envelopes.processReceived();
  await to.client.proofs.processInbound(reports);
  return reports;
}

// --- M1-33c: the parentRecordId rule (D-109; 05 §3.1, 04 §5.1, 04 §3.4 parent check) -----------

const ZERO32 = `0x${'0'.repeat(64)}`;
const ownRecord = async (agent: Agent, recordId: string) =>
  parseJson((await proofRows(agent)).find((r) => r.record_id === recordId)!.record_json) as {
    record: RecordJson;
  };

describe('the sender sets parentRecordId only to zero or its own record (D-109, 05 §3.1)', () => {
  /** A and B paired, both funded; `own` is A's earlier record, `foreign` is B's record. */
  async function withRecords() {
    const { a, b } = await twoAgents();
    chain.fund(b.id, 10n * FEE_UNITS);
    const first = await sendText(a, b, 'version one');
    const own = (await a.client.notarize({ envelopeId: first })) as { recordId: Hex };
    const fromB = await sendText(b, a, 'a reply');
    const foreign = (await b.client.notarize({ envelopeId: fromB })) as { recordId: Hex };
    const envelopeId = await sendText(a, b, 'version two');
    return { a, b, own: own.recordId, foreign: foreign.recordId, envelopeId };
  }

  /** Nothing new is signed, stored, reserved or charged for `envelopeId` (04 §5). */
  async function nothingSigned(
    a: Agent,
    envelopeId: string,
    before: { calls: number; credit: bigint },
  ) {
    expect((await proofRows(a)).filter((r) => r.envelope_id === envelopeId)).toEqual([]);
    expect((await ledger(a)).filter((e) => e.state === 'reserved')).toEqual([]);
    expect(await ledger(a)).toHaveLength(1);
    expect(chain.calls.notarize).toBe(before.calls);
    expect(chain.creditOf(a.id)).toBe(before.credit);
  }

  it('by default the Record carries parentRecordId zero', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId })) as { recordId: Hex };
    expect(onChain(proof.recordId)?.record.parentRecordId).toBe(ZERO32);
    expect((await ownRecord(a, proof.recordId)).record.parentRecordId).toBe(ZERO32);
  });

  it('an explicit zero parent is the default: recorded with zero', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const proof = await a.client.notarize({ envelopeId, parentRecordId: ZERO32 } as never);
    expect(proof).toMatchObject({ status: 'ok' });
    const recordId = (proof as { recordId: Hex }).recordId;
    expect(onChain(recordId)?.record.parentRecordId).toBe(ZERO32);
  });

  it('a parent the chain shows signed by this agent is accepted and recorded', async () => {
    const { a, own, envelopeId } = await withRecords();
    const proof = await a.client.notarize({ envelopeId, parentRecordId: own } as never);
    expect(proof).toMatchObject({ status: 'ok' });
    const recordId = (proof as { recordId: Hex }).recordId;
    expect(onChain(recordId)?.record.parentRecordId).toBe(own);
    expect((await ownRecord(a, recordId)).record.parentRecordId).toBe(own);
  });

  it('a parent signed by another agent is refused: nothing signed or charged', async () => {
    const { a, foreign, envelopeId } = await withRecords();
    const before = { calls: chain.calls.notarize, credit: chain.creditOf(a.id) };
    expect(await a.client.notarize({ envelopeId, parentRecordId: foreign } as never)).toEqual({
      status: 'rejected',
      code: 'PARENT_NOT_OWN',
    });
    await nothingSigned(a, envelopeId, before);
  });

  it('a parent the chain does not hold is refused: nothing signed or charged', async () => {
    const { a, envelopeId } = await withRecords();
    const before = { calls: chain.calls.notarize, credit: chain.creditOf(a.id) };
    expect(
      await a.client.notarize({ envelopeId, parentRecordId: `0x${'ab'.repeat(32)}` } as never),
    ).toEqual({ status: 'rejected', code: 'PARENT_NOT_OWN' });
    await nothingSigned(a, envelopeId, before);
  });

  it.each([
    ['upper-case hex', (id: string) => `0x${id.slice(2).toUpperCase()}`],
    ['too short', (id: string) => id.slice(0, 40)],
    ['not hex', () => `0x${'zz'.repeat(32)}`],
    ['not a string', () => 7 as unknown as string],
  ])('a malformed parent (%s) is refused: nothing signed or charged', async (_c, spell) => {
    const { a, own, envelopeId } = await withRecords();
    const before = { calls: chain.calls.notarize, credit: chain.creditOf(a.id) };
    expect(await a.client.notarize({ envelopeId, parentRecordId: spell(own) } as never)).toEqual({
      status: 'rejected',
      code: 'PARENT_NOT_OWN',
    });
    await nothingSigned(a, envelopeId, before);
  });

  it('a failed chain read refuses (fail closed): nothing signed or charged', async () => {
    const { a, own, envelopeId } = await withRecords();
    const before = { calls: chain.calls.notarize, credit: chain.creditOf(a.id) };
    chain.stateReadsFail = true;
    expect(await a.client.notarize({ envelopeId, parentRecordId: own } as never)).toEqual({
      status: 'rejected',
      code: 'CHAIN_UNAVAILABLE',
    });
    chain.stateReadsFail = false;
    await nothingSigned(a, envelopeId, before);
  });

  it('under an approval policy a foreign parent is refused before any approval is asked', async () => {
    const { a, foreign, envelopeId } = await withRecords();
    await setPolicy(a, (p) => {
      p.proofs.notarize = 'approval';
    });
    expect(await a.client.notarize({ envelopeId, parentRecordId: foreign } as never)).toEqual({
      status: 'rejected',
      code: 'PARENT_NOT_OWN',
    });
    expect(await a.store.transaction((tx) => tx.select('approvals'))).toEqual([]);
  });

  it('an approval for a Record without a parent does not cover one with a parent', async () => {
    const { a, own, envelopeId } = await withRecords();
    await setPolicy(a, (p) => {
      p.proofs.notarize = 'approval';
    });
    const pending = await a.client.notarize({ envelopeId });
    expect(pending.status).toBe('pending_approval');
    const approvalId = (pending as { approvalId: string }).approvalId;
    await approve(a, approvalId);
    expect(
      await a.client.notarize({ envelopeId, parentRecordId: own, approvalId } as never),
    ).toEqual({ status: 'rejected', code: 'APPROVAL_INVALID' });
  });

  it('a replacement keeps the original parentRecordId', async () => {
    const { a, own, envelopeId } = await withRecords();
    chain.censor = true;
    const first = await a.client.notarize({ envelopeId, parentRecordId: own } as never);
    expect(first.status).toBe('submitted');
    const firstId = (first as { recordId: string }).recordId;
    clock.t += 3601 + 60;
    chain.censor = false;
    expect(await a.client.proofs.resubmitPending()).toMatchObject({ replaced: 1 });
    const replacement = (await proofRows(a)).find(
      (r) => r.envelope_id === envelopeId && r.record_id !== firstId,
    )!;
    expect(onChain(replacement.record_id)?.record.parentRecordId).toBe(own);
  });
});

describe('the recipient drops a Record whose parent is another signer’s (04 §3.4 parent check)', () => {
  async function received(parent: (ctx: { a: Agent; b: Agent }) => Promise<string>) {
    const { a, b } = await twoAgents();
    chain.fund(b.id, 10n * FEE_UNITS);
    const parentRecordId = await parent({ a, b });
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE, { parentRecordId });
    return { a, b, envelopeId, rec };
  }

  const aOwn = async ({ a, b }: { a: Agent; b: Agent }) => {
    const earlier = await sendText(a, b, 'version one');
    return ((await a.client.notarize({ envelopeId: earlier })) as { recordId: Hex }).recordId;
  };
  const bOwn = async ({ a, b }: { a: Agent; b: Agent }) => {
    const reply = await sendText(b, a, 'a reply');
    return ((await b.client.notarize({ envelopeId: reply })) as { recordId: Hex }).recordId;
  };

  async function expectDroppedParent(out: { b: Agent; envelopeId: string }, acksBefore: number) {
    expect(await receipts(out.b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(acksBefore);
    expect(await out.b.client.getProof({ envelopeId: out.envelopeId })).toBeUndefined();
    expect(await pendingRows(out.b)).toEqual([]);
    expect(logged(out.b, 'proof_parent_mismatch')).toBe(true);
    const ack = await out.b.client.acknowledge({ envelopeId: out.envelopeId, type: 'opened' });
    expect(ack.status).toBe('rejected');
    expect(chain.calls.acknowledge).toBe(acksBefore);
  }

  it('a parent signed by the same signer passes and the record is stored', async () => {
    const out = await received(aOwn);
    await sendProofEnvelope(out.a, out.b, bodyOf(out.rec, out.envelopeId));
    expect(await out.b.client.getProof({ envelopeId: out.envelopeId })).toMatchObject({
      recordId: out.rec.recordId,
    });
    expect(logged(out.b, 'proof_parent_mismatch')).toBe(false);
  });

  it('a parent signed by another agent (the recipient’s own record) is dropped and logged: no receipt', async () => {
    const out = await received(bOwn);
    const acks = chain.calls.acknowledge;
    await sendProofEnvelope(out.a, out.b, bodyOf(out.rec, out.envelopeId));
    await expectDroppedParent(out, acks);
  });

  it('a parent the chain does not show (yet) is kept pending, never flagged, then dropped unchecked', async () => {
    const out = await received(() => Promise.resolve(`0x${'ab'.repeat(32)}`));
    const acks = chain.calls.acknowledge;
    const sent = await sendProofEnvelope(out.a, out.b, bodyOf(out.rec, out.envelopeId));
    expect(sent.result.reports).toEqual([]);
    expect(await receipts(out.b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(acks);
    expect(await pendingRows(out.b)).toHaveLength(1);
    expect(logged(out.b, 'proof_parent_mismatch')).toBe(false);
    clock.t += 7 * 86_400 + 1;
    expect((await out.b.client.proofs.processInbound([])).reports).toEqual([]);
    expect(await pendingRows(out.b)).toEqual([]);
    expect(logged(out.b, 'proof_unchecked')).toBe(true);
    expect(await out.b.client.getProof({ envelopeId: out.envelopeId })).toBeUndefined();
  });

  it('a failed parent read signs no receipt and is tried again at the next sync (then dropped)', async () => {
    const out = await received(bOwn);
    const acks = chain.calls.acknowledge;
    chain.stateReadsFail = true;
    await sendProofEnvelope(out.a, out.b, bodyOf(out.rec, out.envelopeId));
    expect(await receipts(out.b)).toEqual([]);
    expect(await out.b.client.getProof({ envelopeId: out.envelopeId })).toBeUndefined();
    expect(await pendingRows(out.b)).toHaveLength(1);
    expect(logged(out.b, 'proof_parent_mismatch')).toBe(false);
    chain.stateReadsFail = false;
    await out.b.client.proofs.processInbound([]);
    await expectDroppedParent(out, acks);
  });

  it('a failed read of an own parent passes once the read recovers', async () => {
    const out = await received(aOwn);
    chain.stateReadsFail = true;
    await sendProofEnvelope(out.a, out.b, bodyOf(out.rec, out.envelopeId));
    expect(await pendingRows(out.b)).toHaveLength(1);
    chain.stateReadsFail = false;
    await out.b.client.proofs.processInbound([]);
    expect(await pendingRows(out.b)).toEqual([]);
    expect(await out.b.client.getProof({ envelopeId: out.envelopeId })).toMatchObject({
      recordId: out.rec.recordId,
    });
  });

  it('a zero parent needs no read: stored while chain-state reads fail', async () => {
    const out = await received(() => Promise.resolve(ZERO32));
    chain.stateReadsFail = true;
    await sendProofEnvelope(out.a, out.b, bodyOf(out.rec, out.envelopeId));
    chain.stateReadsFail = false;
    expect(await out.b.client.getProof({ envelopeId: out.envelopeId })).toMatchObject({
      recordId: out.rec.recordId,
    });
  });
});

describe('a proof body that does not match the chain flags its contact (04 §3.4, M1-7g-c)', () => {
  const envelopeRow = (agent: Agent, envelopeId: string) =>
    agent.store.transaction((tx) => tx.get('envelopes', { envelope_id: envelopeId }));

  /** The flag report for one proof envelope: fixed codes and validated IDs only (I-5). */
  const flagOf = (proofEnvelopeId: string, contactId: string, reason: string) => ({
    envelopeId: proofEnvelopeId,
    outcome: 'refused',
    reason,
    contactId,
    flagged: true,
  });

  it('a mismatching body flags the contact and stores the proof envelope as refused', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const body = bodyOf(rec, envelopeId);
    (body.record as RecordJson).envelopeHash = `0x${'e1'.repeat(32)}`;
    const sent = await sendProofEnvelope(a, b, body);
    expect(sent.result.reports).toEqual([flagOf(sent.proofEnvelopeId, a.id, 'proof_mismatch')]);
    // Exactly the fixed keys: nothing from the body or the chain answer (I-5, I-7).
    for (const r of sent.result.reports) {
      expect(Object.keys(r).sort()).toEqual(
        ['contactId', 'envelopeId', 'flagged', 'outcome', 'reason'].sort(),
      );
    }
    const row = await envelopeRow(b, sent.proofEnvelopeId);
    expect(row).toMatchObject({
      state: 'refused',
      refused_reason: 'proof_mismatch',
      contact_id: a.id,
      payload_json: null,
      envelope_json: null,
    });
    expect(row?.refused_at).toBe(clock.t);
    expect(await receipts(b)).toEqual([]);
    expect(await b.client.getProof({ envelopeId })).toBeUndefined();
  });

  it('a legacy body naming the wrong record flags the contact too', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const real = await recordDirectly(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const sent = await sendProofEnvelope(a, b, {
      envelopeId,
      recordId: real.recordId,
      salt: `0x${'77'.repeat(32)}`,
    });
    expect(sent.result.reports).toEqual([flagOf(sent.proofEnvelopeId, a.id, 'proof_mismatch')]);
  });

  it('a parent signed by another agent flags the contact with proof_parent_mismatch', async () => {
    const { a, b } = await twoAgents();
    chain.fund(b.id, 10n * FEE_UNITS);
    const reply = await sendText(b, a, 'a reply');
    const parent = ((await b.client.notarize({ envelopeId: reply })) as { recordId: Hex }).recordId;
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE, {
      parentRecordId: parent,
    });
    const sent = await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    expect(sent.result.reports).toEqual([
      flagOf(sent.proofEnvelopeId, a.id, 'proof_parent_mismatch'),
    ]);
    expect(await envelopeRow(b, sent.proofEnvelopeId)).toMatchObject({
      state: 'refused',
      refused_reason: 'proof_parent_mismatch',
    });
  });

  it('a matching body and a failed chain read flag nothing', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const ok = await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    expect(ok.result.reports).toEqual([]);
    expect((await envelopeRow(b, ok.proofEnvelopeId))?.state).toBe('ok');

    const other = await sendText(a, b, 'a second message');
    const rec2 = await signedRecordOf(a, b, other, RECORD_KIND.MESSAGE);
    chain.readsFail = true;
    const pend = await sendProofEnvelope(a, b, bodyOf(rec2, other));
    expect(pend.result.reports).toEqual([]);
    expect((await envelopeRow(b, pend.proofEnvelopeId))?.state).toBe('ok');
    expect(await pendingRows(b)).toHaveLength(1);
  });

  it('a pending body found to mismatch at a later sync flags the contact in that pass', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE, { put: false });
    chain.put({ ...rec.built.record, deadline: rec.built.record.deadline + 1 });
    chain.readsFail = true;
    const sent = await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    expect(sent.result.reports).toEqual([]);
    chain.readsFail = false;
    const later = await b.client.proofs.processInbound([]);
    expect(later.reports).toEqual([flagOf(sent.proofEnvelopeId, a.id, 'proof_mismatch')]);
    expect(await pendingRows(b)).toEqual([]);
    // Checked once: the refused envelope is not checked or flagged again.
    expect((await b.client.proofs.processInbound(sent.reports)).reports).toEqual([]);
  });

  it('the flag is not something a tool can clear: the refused proof envelope stays refused', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const real = await recordDirectly(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const sent = await sendProofEnvelope(a, b, {
      envelopeId,
      recordId: real.recordId,
      salt: `0x${'77'.repeat(32)}`,
    });
    // Re-processing the same reports (a restart) neither stores the proof nor clears the refusal.
    const again = await b.client.proofs.processInbound(sent.reports);
    expect(again).toEqual({ signed: 0, reports: [] });
    expect((await envelopeRow(b, sent.proofEnvelopeId))?.state).toBe('refused');
    expect(await b.client.getProof({ envelopeId })).toBeUndefined();
  });
});

describe('each contact has a share of the pending pool (04 §3.4, M1-7g-c)', () => {
  /** `count` pending bodies attributed to `contactId` (white-box rows standing in for real ones). */
  async function fill(agent: Agent, contactId: string, count: number, tag: string) {
    const template = await agent.store.transaction(
      (tx) => tx.select('envelopes', { direction: 'in', contact_id: contactId })[0],
    );
    if (template === undefined) throw new Error('test: no envelope from that contact');
    const empty = await agent.cipher.seal(
      { table: 'proofs', column: 'salt', rowKey: JSON.stringify(['filler']) },
      '',
    );
    await agent.store.transaction((tx) => {
      for (let i = 0; i < count; i += 1) {
        const id = `${tag}${String(i)}`;
        tx.insert('envelopes', {
          ...template,
          envelope_id: id,
          envelope_hash: `${tag}hash${String(i)}`,
          type: 'proof',
        });
        tx.insert('proofs', {
          record_id: `pending:${id}`,
          envelope_id: template.envelope_id,
          chain_id: chain.config.chainId,
          record_json: '{}',
          tx_hash: null,
          status: PENDING,
          fee_token: null,
          fee_amount: null,
          salt: empty,
          created_at: clock.t,
        });
      }
    });
  }

  it('a contact at its share of 32 cannot add a pending body; another contact still can', async () => {
    const { a, b } = await twoAgents();
    const c = await openAgent(33, ownerC, 'carol');
    await pair(c, b);
    chain.fund(c.id, 10n * FEE_UNITS);
    const fromA = await sendText(a, b);
    const fromC = await sendText(c, b, 'from carol');
    await fill(b, a.id, 32, 'fillerA');

    chain.readsFail = true;
    await a.client.notarize({ envelopeId: fromA });
    await deliver(a, b);
    expect(logged(b, 'proof_unchecked')).toBe(true);
    expect((await pendingRows(b)).some((r) => r.envelope_id === fromA)).toBe(false);

    await c.client.notarize({ envelopeId: fromC });
    await deliver(c, b);
    expect((await pendingRows(b)).some((r) => r.envelope_id === fromC)).toBe(true);

    chain.readsFail = false;
    await b.client.proofs.processInbound([]);
    expect(await b.client.getProof({ envelopeId: fromA })).toBeUndefined();
    expect(await b.client.getProof({ envelopeId: fromC })).toBeDefined();
    expect(core.PROOF_PENDING_PER_CONTACT).toBe(32);
  });

  it('below its share a contact keeps adding pending bodies', async () => {
    const { a, b } = await twoAgents();
    const fromA = await sendText(a, b);
    await fill(b, a.id, 31, 'fillerA');
    chain.readsFail = true;
    await a.client.notarize({ envelopeId: fromA });
    await deliver(a, b);
    expect((await pendingRows(b)).some((r) => r.envelope_id === fromA)).toBe(true);
    expect(logged(b, 'proof_unchecked')).toBe(false);
  });
});

describe('only a definite contradiction flags; not-yet and unknown cases are retried (IR-M1-7g-c-1)', () => {
  const envelopeRow = (agent: Agent, envelopeId: string) =>
    agent.store.transaction((tx) => tx.get('envelopes', { envelope_id: envelopeId }));

  it('(a) a record the chain does not show yet: pending, no flag; stored once it is visible', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE, { put: false });
    const sent = await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    expect(sent.result.reports).toEqual([]);
    expect((await envelopeRow(b, sent.proofEnvelopeId))?.state).toBe('ok');
    expect(await pendingRows(b)).toHaveLength(1);
    expect(logged(b, 'proof_mismatch')).toBe(false);
    chain.put(rec.built.record);
    expect((await b.client.proofs.processInbound([])).reports).toEqual([]);
    expect(await pendingRows(b)).toEqual([]);
    expect(await b.client.getProof({ envelopeId })).toMatchObject({ recordId: rec.recordId });
  });

  it('(b) a chain this agent does not know: pending, no flag, dropped unchecked after 7 days', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const sent = await sendProofEnvelope(a, b, { ...bodyOf(rec, envelopeId), chainId: 999_999 });
    expect(sent.result.reports).toEqual([]);
    expect((await envelopeRow(b, sent.proofEnvelopeId))?.state).toBe('ok');
    expect(await pendingRows(b)).toHaveLength(1);
    clock.t += 7 * 86_400 + 1;
    expect((await b.client.proofs.processInbound([])).reports).toEqual([]);
    expect(await pendingRows(b)).toEqual([]);
    expect(logged(b, 'proof_mismatch')).toBe(false);
    expect((await envelopeRow(b, sent.proofEnvelopeId))?.state).toBe('ok');
  });

  it('(c) the message is not ok yet (still received): pending, no flag; stored once it is ok', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const { built, row } = await a.client.envelopes.prepare({
      to: { contact: b.id },
      payload: {
        type: 'proof',
        body: { chainId: chain.config.chainId, ...bodyOf(rec, envelopeId) } as never,
        replyTo: envelopeId,
        files: [],
      },
    });
    await a.store.transaction((tx) => tx.insert('envelopes', row));
    await b.client.envelopes.receive({ envelope: built.envelope });
    const reports = await b.client.envelopes.processReceived();
    // The message is back to `received` when the proof is checked (e.g. a terms offer waiting).
    await b.store.transaction((tx) =>
      tx.update('envelopes', { envelope_id: envelopeId }, { state: 'received' }),
    );
    expect((await b.client.proofs.processInbound(reports)).reports).toEqual([]);
    expect((await envelopeRow(b, built.envelope.id))?.state).toBe('ok');
    expect(await pendingRows(b)).toHaveLength(1);
    expect(logged(b, 'proof_mismatch')).toBe(false);
    await b.store.transaction((tx) =>
      tx.update('envelopes', { envelope_id: envelopeId }, { state: 'ok' }),
    );
    expect((await b.client.proofs.processInbound([])).reports).toEqual([]);
    expect(await b.client.getProof({ envelopeId })).toMatchObject({ recordId: rec.recordId });
  });

  it('an answered read that contradicts the body (another struct hash on-chain) still flags', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE, { put: false });
    chain.put({ ...rec.built.record, deadline: rec.built.record.deadline + 1 });
    const sent = await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    expect(sent.result.reports).toEqual([
      {
        envelopeId: sent.proofEnvelopeId,
        outcome: 'refused',
        reason: 'proof_mismatch',
        contactId: a.id,
        flagged: true,
      },
    ]);
    expect((await envelopeRow(b, sent.proofEnvelopeId))?.state).toBe('refused');
  });

  it('a pending row whose proof envelope was refused meanwhile is removed, not checked', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE, { put: false });
    const sent = await sendProofEnvelope(a, b, bodyOf(rec, envelopeId));
    expect(await pendingRows(b)).toHaveLength(1);
    // A concurrent pass refused the proof envelope after this row was written.
    await b.store.transaction((tx) =>
      tx.update(
        'envelopes',
        { envelope_id: sent.proofEnvelopeId },
        { state: 'refused', refused_reason: 'proof_mismatch', refused_at: clock.t },
      ),
    );
    chain.put(rec.built.record);
    expect((await b.client.proofs.processInbound([])).reports).toEqual([]);
    expect(await pendingRows(b)).toEqual([]);
    expect(await b.client.getProof({ envelopeId })).toBeUndefined();
    expect(await receipts(b)).toEqual([]);
  });
});

// --- M1-33d: receipt requests and the user's own DELIVERED (D-109; 04 §3.4, 06 §2.2, §2.4, §3) ---

/** The agent's inbound items, read and unread, as `agentlink_inbox` reads them (06 §2.2). */
async function inboxItems(agent: Agent) {
  const page = await agent.client.inbox.page({
    limit: 100,
    includeRead: true,
    includeSent: false,
    sizeOf: () => 1,
    maxBytes: 1_000_000,
  });
  if (page.status !== 'ok') throw new Error('test: inbox page');
  return page.items;
}

const itemOf = async (agent: Agent, envelopeId: string) =>
  (await inboxItems(agent)).find((i) => i.envelopeId === envelopeId) as
    (Record<string, unknown> & { receiptRequested?: boolean }) | undefined;

describe('the sender asks for a delivery receipt (06 §2.4 requestReceipt, 04 §3.4)', () => {
  it('requestReceipt puts receiptRequest "delivered" in the proof body, and says so in the result', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    const proof = await a.client.notarize({ envelopeId, requestReceipt: true });
    expect(proof).toMatchObject({ status: 'ok', receiptRequested: true });
    const bodies = await proofBodiesSent(a);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ envelopeId, receiptRequest: 'delivered' });
  });

  it('without requestReceipt the body asks for nothing and the result claims no request', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    const proof = await a.client.notarize({ envelopeId });
    expect(proof).toMatchObject({ status: 'ok' });
    expect(proof).not.toHaveProperty('receiptRequested');
    const [body] = await proofBodiesSent(a);
    expect(body).not.toHaveProperty('receiptRequest');
  });

  it('the request never reaches the proof service: the stored, submitted item is the Record only', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId, requestReceipt: true })) as {
      recordId: string;
    };
    const own = (await proofRows(a)).find((r) => r.record_id === proof.recordId)!;
    expect(Object.keys(parseJson(own.record_json) as object).sort()).toEqual([
      'record',
      'signature',
    ]);
  });

  it('a request on an envelope already notarized without one asks for nothing more', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    const again = await a.client.notarize({ envelopeId, requestReceipt: true });
    expect(again).toMatchObject({ status: 'ok' });
    expect(again).not.toHaveProperty('receiptRequested');
    const bodies = await proofBodiesSent(a);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('receiptRequest');
  });

  it('under an approval policy the approval covers the request; one call without it is refused', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    await setPolicy(a, (p) => {
      p.proofs.notarize = 'approval';
    });
    const envelopeId = await sendText(a, b);
    const pending = await a.client.notarize({ envelopeId, requestReceipt: true });
    expect(pending.status).toBe('pending_approval');
    const approvalId = (pending as { approvalId: string }).approvalId;
    await approve(a, approvalId);
    // The approved action carries the request: a call without it is another action.
    expect(await a.client.notarize({ envelopeId, approvalId })).toMatchObject({
      status: 'rejected',
      code: 'APPROVAL_INVALID',
    });
    expect(await a.client.notarize({ envelopeId, approvalId, requestReceipt: true })).toMatchObject(
      { status: 'ok', receiptRequested: true },
    );
    const [body] = await proofBodiesSent(a);
    expect(body).toMatchObject({ receiptRequest: 'delivered' });
  });

  it('a replacement Record keeps the request (04 §5)', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    chain.censor = true;
    const first = await a.client.notarize({ envelopeId, requestReceipt: true });
    expect(first.status).toBe('submitted');
    clock.t += 3601 + 60;
    chain.censor = false;
    expect(await a.client.proofs.resubmitPending()).toMatchObject({ replaced: 1 });
    const bodies = await proofBodiesSent(a);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ receiptRequest: 'delivered' });
  });
});

describe('M1-33d-b: a request on an envelope already notarized is reported as not added', () => {
  it('the result says the request was not added, and the proof is the stored one', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    const first = (await a.client.notarize({ envelopeId })) as { recordId: string };
    const again = await a.client.notarize({ envelopeId, requestReceipt: true });
    expect(again).toMatchObject({
      status: 'ok',
      recordId: first.recordId,
      receiptRequestNotAdded: true,
    });
    expect(again).not.toHaveProperty('receiptRequested');
    const bodies = await proofBodiesSent(a);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('receiptRequest');
  });

  it('a submitted (not yet landed) proof without a request reports it too', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    chain.censor = true;
    expect((await a.client.notarize({ envelopeId })).status).toBe('submitted');
    const again = await a.client.notarize({ envelopeId, requestReceipt: true });
    expect(again).toMatchObject({ status: 'submitted', receiptRequestNotAdded: true });
    expect(again).not.toHaveProperty('receiptRequested');
  });

  it('never on a request that was kept, nor on a call that did not ask', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const asked = await sendText(a, b);
    const kept = await a.client.notarize({ envelopeId: asked, requestReceipt: true });
    expect(kept).toMatchObject({ status: 'ok', receiptRequested: true });
    expect(kept).not.toHaveProperty('receiptRequestNotAdded');
    const repeat = await a.client.notarize({ envelopeId: asked, requestReceipt: true });
    expect(repeat).toMatchObject({ status: 'ok', receiptRequested: true });
    expect(repeat).not.toHaveProperty('receiptRequestNotAdded');
    const plain = await sendText(a, b);
    await a.client.notarize({ envelopeId: plain });
    const plainAgain = await a.client.notarize({ envelopeId: plain });
    expect(plainAgain).not.toHaveProperty('receiptRequestNotAdded');
  });
});

describe('M1-33d-b: concurrent acknowledge delivered signs at most one DELIVERED (I-6)', () => {
  it('two concurrent calls for the same record sign, store and submit exactly one receipt', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId, requestReceipt: true })) as {
      recordId: string;
    };
    await deliver(a, b);
    const signs = vi.spyOn(b.keyStore, 'sign712');
    const [one, two] = await Promise.all([
      b.client.acknowledge({ envelopeId, type: 'delivered' }),
      b.client.acknowledge({ envelopeId, type: 'delivered' }),
    ]);
    for (const r of [one, two]) {
      expect(r).toMatchObject({ status: 'ok', recordId: proof.recordId, receipt: 'DELIVERED' });
    }
    expect(signs).toHaveBeenCalledTimes(1);
    signs.mockRestore();
    expect(await receipts(b)).toEqual([
      expect.objectContaining({ record_id: proof.recordId, type: 1, signer: b.id }),
    ]);
    expect((await proofRows(b)).filter((r) => r.record_id === `${proof.recordId}:1`)).toHaveLength(
      1,
    );
    expect(chain.calls.acknowledge).toBe(1);
  });
});

describe('the recipient: a receipt request alone never signs anything (D-109, I-4, I-6)', () => {
  it('default rules: nothing is signed, and the inbox item says the sender asked', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId, requestReceipt: true });
    await deliver(a, b);
    expect(await receipts(b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
    expect(await itemOf(b, envelopeId)).toMatchObject({ receiptRequested: true });
  });

  it('the user’s acknowledge delivered signs exactly one DELIVERED; a repeat signs nothing more', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    const proof = (await a.client.notarize({ envelopeId, requestReceipt: true })) as {
      recordId: string;
    };
    await deliver(a, b);
    const policyBefore = await b.client.ownerActions.loadPolicy();

    const first = await b.client.acknowledge({ envelopeId, type: 'delivered' });
    expect(first).toMatchObject({
      status: 'ok',
      recordId: proof.recordId,
      receipt: 'DELIVERED',
      onChain: true,
    });
    expect(await receipts(b)).toEqual([
      expect.objectContaining({ record_id: proof.recordId, type: 1, signer: b.id }),
    ]);
    expect(onChain(proof.recordId)!.receiptAt[0]).not.toBe(0n);
    expect(chain.calls.acknowledge).toBe(1);

    const second = await b.client.acknowledge({ envelopeId, type: 'delivered' });
    expect(second).toMatchObject({ status: 'ok', receipt: 'DELIVERED' });
    expect(await receipts(b)).toHaveLength(1);
    expect(chain.calls.acknowledge).toBe(1);
    expect((await proofRows(b)).filter((r) => r.record_id === `${proof.recordId}:1`)).toHaveLength(
      1,
    );

    // Signed: the item no longer asks. The rules are unchanged (no tool changes a policy, I-4).
    const item = await itemOf(b, envelopeId);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('receiptRequested');
    expect(await b.client.ownerActions.loadPolicy()).toEqual(policyBefore);
  });

  it('later passes never sign the request on their own', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId, requestReceipt: true });
    await deliver(a, b);
    await b.client.proofs.processInbound([]);
    await b.client.proofs.runDeferredReceipts();
    await b.client.proofs.resubmitPending();
    expect(await receipts(b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
  });

  it('with delivery receipts on for the contact, DELIVERED is signed once by policy and nothing is asked', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    await setPolicy(b, (p) => {
      p.contactRules = [{ contact: a.id, receipts: { autoDelivered: true } }];
    });
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId, requestReceipt: true });
    await deliver(a, b);
    expect(await receipts(b)).toEqual([expect.objectContaining({ type: 1 })]);
    expect(await itemOf(b, envelopeId)).not.toHaveProperty('receiptRequested');
  });

  it('a proof without a request: the item does not ask, and the user can still confirm delivery', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    await deliver(a, b);
    expect(await itemOf(b, envelopeId)).not.toHaveProperty('receiptRequested');
    expect(await b.client.acknowledge({ envelopeId, type: 'delivered' })).toMatchObject({
      status: 'ok',
      receipt: 'DELIVERED',
    });
    expect(await receipts(b)).toHaveLength(1);
  });

  it('acknowledge delivered on a message without a proof signs nothing (NOT_RECORDED)', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    expect(await b.client.acknowledge({ envelopeId, type: 'delivered' })).toEqual({
      status: 'rejected',
      code: 'NOT_RECORDED',
    });
    expect(await receipts(b)).toEqual([]);
  });

  it('a request in a body kept pending on a failed read is shown once the body is checked', async () => {
    const { a, b } = await twoAgents({ defaults: true });
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    chain.readsFail = true;
    await sendProofEnvelope(a, b, { ...bodyOf(rec, envelopeId), receiptRequest: 'delivered' });
    expect(await itemOf(b, envelopeId)).not.toHaveProperty('receiptRequested');
    chain.readsFail = false;
    await b.client.proofs.processInbound([]);
    expect(await receipts(b)).toEqual([]);
    expect(await itemOf(b, envelopeId)).toMatchObject({ receiptRequested: true });
  });
});

describe('a malformed receiptRequest refuses the whole body (04 §3.4, I-5)', () => {
  it.each([
    ['opened', 'opened'],
    ['DELIVERED', 'DELIVERED'],
    ['true', true],
    ['an object', { type: 'delivered' }],
  ])('receiptRequest %s: no proof stored, no receipt, no request shown', async (_l, value) => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    await sendRawProof(a, b, { ...bodyOf(rec, envelopeId), receiptRequest: value });
    // B's rules turn DELIVERED on (twoAgents), so only the refusal explains the empty list.
    expect(await receipts(b)).toEqual([]);
    expect(chain.calls.acknowledge).toBe(0);
    expect(await b.client.getProof({ envelopeId })).toBeUndefined();
    expect(await itemOf(b, envelopeId)).not.toHaveProperty('receiptRequested');
  });

  it('the control: the same body with "delivered" is stored and gets DELIVERED by policy', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    await sendRawProof(a, b, { ...bodyOf(rec, envelopeId), receiptRequest: 'delivered' });
    expect(await receipts(b)).toEqual([expect.objectContaining({ type: 1 })]);
  });
});

// --- M1-7g-d: logged fixed codes, the ACCEPTED of `confirm`, the waiting pool's share ------------

/** The `code` fields of `agent`'s log lines. */
const codesLogged = (agent: Agent) =>
  agent.lines
    .map((l) => parseJson(l) as { code?: unknown })
    .filter((r) => r.code !== undefined)
    .map((r) => r.code);

describe('the proof flow logs only its listed fixed codes (M1-7g-d, I-7)', () => {
  it('a mismatching body logs the fixed code as a field, and nothing unlisted', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    const rec = await signedRecordOf(a, b, envelopeId, RECORD_KIND.MESSAGE);
    const body = bodyOf(rec, envelopeId);
    (body.record as RecordJson).envelopeHash = `0x${'e1'.repeat(32)}`;
    await sendProofEnvelope(a, b, body);
    const codes = codesLogged(b);
    expect(codes).toContain('proof_mismatch');
    for (const code of codes) expect(core.PROOF_LOG_CODES).toContain(code);
  });

  it('a body dropped unchecked logs `proof_unchecked` as a field', async () => {
    const { a, b } = await twoAgents();
    const envelopeId = await sendText(a, b);
    await a.client.notarize({ envelopeId });
    chain.readsFail = true;
    await deliver(a, b);
    expect(codesLogged(b)).toContain('proof_pending');
    clock.t += 8 * 86_400;
    await b.client.proofs.processInbound([]);
    expect(codesLogged(b)).toContain('proof_unchecked');
  });

  it('every listed code is a fixed identifier the logger accepts', () => {
    expect(core.PROOF_LOG_CODES.length).toBeGreaterThan(0);
    expect(() => createLogger({ codes: core.PROOF_LOG_CODES })).not.toThrow();
  });
});

describe('`confirm` signs the ACCEPTED receipt on their ACCEPT record (M1-7g-d; 04 §3.4.2, 07 §2.1)', () => {
  /** A offers, B accepts with its owner's approval and records the accept; A holds that record. */
  async function acceptRecorded() {
    const { a, b } = await twoAgents();
    const offer = await sendOffer(a, b);
    const asked = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    const bApproval = (asked as { approvalId: string }).approvalId;
    await approve(b, bApproval);
    const sent = await b.client.respondToTerms({
      envelopeId: offer,
      decision: 'accept',
      approvalId: bApproval,
    });
    const accept = (sent as { envelopeId: string }).envelopeId;
    expect(accept).toBeDefined();
    await deliver(b, a);
    const rec = await recordDirectly(b, a, accept, RECORD_KIND.ACCEPT);
    await sendProofEnvelope(b, a, { envelopeId: accept, recordId: rec.recordId, salt: rec.salt });
    expect(await a.client.getProof({ envelopeId: accept })).toMatchObject({
      recordId: rec.recordId,
    });
    return { a, b, offer, accept, ...rec };
  }

  it('the approved confirm signs exactly one ACCEPTED, on-chain, and marks its part done', async () => {
    const { a, accept, recordId } = await acceptRecorded();
    const asked = await a.client.respondToTerms({ envelopeId: accept, decision: 'accept' });
    expect(asked.status).toBe('pending_approval');
    const approvalId = (asked as { approvalId: string }).approvalId;
    // Nothing is signed before the owner approves (04 §3.4.2).
    expect(onChain(recordId)!.receiptAt[2]).toBe(0n);
    await approve(a, approvalId);
    expect(
      await a.client.respondToTerms({ envelopeId: accept, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'ok' });
    expect(onChain(recordId)!.receiptAt[2]).not.toBe(0n);
    expect((await receipts(a)).filter((r) => r.type === 3)).toHaveLength(1);
    const part = await a.store.transaction((tx) =>
      tx.get('commitment_parts', { approval_id: approvalId, part: 'receipt' }),
    );
    expect(part?.state).toBe('done');

    // A repeat call with the same approval signs nothing more.
    const before = chain.calls.acknowledge;
    expect(
      await a.client.respondToTerms({ envelopeId: accept, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'rejected', code: 'APPROVAL_USED' });
    await a.client.proofs.runDeferredReceipts();
    expect(chain.calls.acknowledge).toBe(before);
    expect((await receipts(a)).filter((r) => r.type === 3)).toHaveLength(1);
  });

  // M1-7g-f: the result reports what happened to the receipt part, read after the deferred run.
  it('an approved confirm whose ACCEPTED lands returns receipt status `recorded` (M1-7g-f)', async () => {
    const { a, accept } = await acceptRecorded();
    const asked = await a.client.respondToTerms({ envelopeId: accept, decision: 'accept' });
    const approvalId = (asked as { approvalId: string }).approvalId;
    await approve(a, approvalId);
    expect(
      await a.client.respondToTerms({ envelopeId: accept, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'ok', receipt: { type: 'ACCEPTED', status: 'recorded' } });
  });

  it('an approved confirm whose ACCEPTED is signed but not landed returns `submitted` (M1-7g-f)', async () => {
    const { a, accept, recordId } = await acceptRecorded();
    const asked = await a.client.respondToTerms({ envelopeId: accept, decision: 'accept' });
    const approvalId = (asked as { approvalId: string }).approvalId;
    await approve(a, approvalId);
    chain.censor = true;
    expect(
      await a.client.respondToTerms({ envelopeId: accept, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'ok', receipt: { type: 'ACCEPTED', status: 'submitted' } });
    expect(onChain(recordId)!.receiptAt[2]).toBe(0n);
    chain.censor = false;
  });

  it('when the receipt re-read fails, the call returns its own result and logs only `deferred_error` (M1-7g-f)', async () => {
    const { a, accept } = await acceptRecorded();
    const asked = await a.client.respondToTerms({ envelopeId: accept, decision: 'accept' });
    const approvalId = (asked as { approvalId: string }).approvalId;
    await approve(a, approvalId);
    const spy = vi.spyOn(a.client.terms, 'receiptStatus').mockRejectedValue(new Error('canary-x'));
    const before = a.lines.length;
    try {
      expect(
        await a.client.respondToTerms({ envelopeId: accept, decision: 'accept', approvalId }),
      ).toMatchObject({
        status: 'ok',
        receipt: { type: 'ACCEPTED', status: 'waiting_for_record' },
      });
    } finally {
      spy.mockRestore();
    }
    const fresh = a.lines.slice(before);
    expect(fresh.join('\n')).not.toContain('canary-x');
    const codes = fresh
      .map((l) => parseJson(l) as { code?: unknown })
      .filter((r) => r.code !== undefined)
      .map((r) => r.code);
    expect(codes).toEqual(['deferred_error']);
  });

  // A confirm needs their ACCEPT record first (NOT_RECORDED otherwise, 06 §2.2a), so the case of
  // a record that has not arrived is an accept of an offer that is not recorded yet.
  it('an approved accept of an offer not recorded yet returns `waiting_for_record` (M1-7g-f)', async () => {
    const { a, b } = await twoAgents();
    const offer = await sendOffer(a, b);
    const asked = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    const approvalId = (asked as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    expect(
      await b.client.respondToTerms({ envelopeId: offer, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'ok', receipt: { type: 'ACCEPTED', status: 'waiting_for_record' } });
    expect((await receipts(b)).filter((r) => r.type === 3)).toEqual([]);
  });

  it('an approved accept of an offer already recorded returns `recorded` (M1-7g-f)', async () => {
    const { a, b } = await twoAgents();
    const offer = await sendOffer(a, b);
    const rec = await recordDirectly(a, b, offer, RECORD_KIND.OFFER);
    await sendProofEnvelope(a, b, { envelopeId: offer, recordId: rec.recordId, salt: rec.salt });
    const asked = await b.client.respondToTerms({ envelopeId: offer, decision: 'accept' });
    const approvalId = (asked as { approvalId: string }).approvalId;
    await approve(b, approvalId);
    expect(
      await b.client.respondToTerms({ envelopeId: offer, decision: 'accept', approvalId }),
    ).toMatchObject({ status: 'ok', receipt: { type: 'ACCEPTED', status: 'recorded' } });
    expect(onChain(rec.recordId)!.receiptAt[2]).not.toBe(0n);
  });

  it('a confirm that is only pending signs nothing, whatever the sync passes', async () => {
    const { a, accept, recordId } = await acceptRecorded();
    const asked = await a.client.respondToTerms({ envelopeId: accept, decision: 'accept' });
    expect(asked.status).toBe('pending_approval');
    await a.client.proofs.runDeferredReceipts();
    await a.client.proofs.processInbound([]);
    expect(onChain(recordId)!.receiptAt[2]).toBe(0n);
    expect((await receipts(a)).filter((r) => r.type === 3)).toEqual([]);
  });

  it('a confirm approved after its scope expired signs nothing', async () => {
    const { a, accept, recordId } = await acceptRecorded();
    const asked = await a.client.respondToTerms({ envelopeId: accept, decision: 'accept' });
    const approvalId = (asked as { approvalId: string }).approvalId;
    await approve(a, approvalId);
    clock.t += 8 * 86_400;
    const r = await a.client.respondToTerms({
      envelopeId: accept,
      decision: 'accept',
      approvalId,
    });
    expect(r.status).toBe('rejected');
    await a.client.proofs.runDeferredReceipts();
    expect(onChain(recordId)!.receiptAt[2]).toBe(0n);
  });

  it('an approved accept scope never matches an ACCEPT record', async () => {
    const { a, b, accept, recordId } = await acceptRecorded();
    const acceptHash = (await a.store.transaction((tx) =>
      tx.get('envelopes', { envelope_id: accept }),
    ))!.envelope_hash;
    // B's own approved accept scope answers A's offer; an ACCEPT record (B's own) never matches it.
    expect(
      await b.client.terms.deferredReceipt({
        envelopeHash: acceptHash,
        kind: 'ACCEPT',
        signer: b.id,
      }),
    ).toEqual({ status: 'none' });
    expect(onChain(recordId)!.receiptAt[2]).toBe(0n);
  });
});

describe('each contact has a share of the waiting pool (M1-7g-d; 04 §3.4)', () => {
  const AWAITING = 'awaiting';
  const awaitingRows = async (agent: Agent) =>
    (await proofRows(agent)).filter((r) => r.status === AWAITING);

  /** `count` waiting proof envelopes attributed to `contactId` (white-box rows). */
  async function fillAwaiting(agent: Agent, contactId: string, count: number, tag: string) {
    const template = await agent.store.transaction(
      (tx) => tx.select('envelopes', { direction: 'in', contact_id: contactId })[0],
    );
    if (template === undefined) throw new Error('test: no envelope from that contact');
    const empty = await agent.cipher.seal(
      { table: 'proofs', column: 'salt', rowKey: JSON.stringify(['filler']) },
      '',
    );
    await agent.store.transaction((tx) => {
      for (let i = 0; i < count; i += 1) {
        const id = `${tag}${String(i)}`;
        tx.insert('envelopes', {
          ...template,
          envelope_id: id,
          envelope_hash: `${tag}hash${String(i)}`,
          type: 'proof',
        });
        tx.insert('proofs', {
          record_id: `await:${id}`,
          envelope_id: `${tag}message${String(i)}`,
          chain_id: chain.config.chainId,
          record_json: '{}',
          tx_hash: null,
          status: AWAITING,
          fee_token: null,
          fee_amount: null,
          salt: empty,
          created_at: clock.t,
        });
      }
    });
  }

  /** `from` sends a message that `to` has not received, then its proof envelope, which `to` gets. */
  async function proofBeforeMessage(from: Agent, to: Agent, text: string) {
    const sent = await from.client.sendMessage({ to: to.id, text });
    const envelopeId = (sent as { envelopeId: string }).envelopeId;
    const rec = await recordDirectly(from, to, envelopeId, RECORD_KIND.MESSAGE);
    await sendProofEnvelope(from, to, { envelopeId, recordId: rec.recordId, salt: rec.salt });
    return { envelopeId, ...rec };
  }

  it('a contact at its share of 32 cannot add a waiting proof; another contact still can', async () => {
    const { a, b } = await twoAgents();
    const c = await openAgent(33, ownerC, 'carol');
    await pair(c, b);
    await sendText(a, b);
    await sendText(c, b, 'from carol');
    await fillAwaiting(b, a.id, 32, 'waitA');

    const fromA = await proofBeforeMessage(a, b, 'late from alice');
    expect((await awaitingRows(b)).some((r) => r.envelope_id === fromA.envelopeId)).toBe(false);
    expect(codesLogged(b)).toContain('proof_unchecked');
    const fromC = await proofBeforeMessage(c, b, 'late from carol');
    expect((await awaitingRows(b)).some((r) => r.envelope_id === fromC.envelopeId)).toBe(true);

    // The messages arrive: only carol's waiting proof is checked and stored.
    await deliver(a, b);
    await deliver(c, b);
    expect(await b.client.getProof({ envelopeId: fromA.envelopeId })).toBeUndefined();
    expect(await b.client.getProof({ envelopeId: fromC.envelopeId })).toMatchObject({
      recordId: fromC.recordId,
    });
    expect(core.PROOF_AWAITING_PER_CONTACT).toBe(32);
  });

  it('below its share a contact keeps adding waiting proofs', async () => {
    const { a, b } = await twoAgents();
    await sendText(a, b);
    await fillAwaiting(b, a.id, 31, 'waitA');
    const fromA = await proofBeforeMessage(a, b, 'late from alice');
    expect((await awaitingRows(b)).some((r) => r.envelope_id === fromA.envelopeId)).toBe(true);
    expect(codesLogged(b)).not.toContain('proof_unchecked');
  });

  it('a waiting row whose proof envelope was refused does not count against the contact', async () => {
    const { a, b } = await twoAgents();
    await sendText(a, b);
    await fillAwaiting(b, a.id, 32, 'waitA');
    await b.store.transaction((tx) => {
      tx.update('envelopes', { envelope_id: 'waitA0' }, { state: 'refused' });
    });
    const fromA = await proofBeforeMessage(a, b, 'late from alice');
    expect((await awaitingRows(b)).some((r) => r.envelope_id === fromA.envelopeId)).toBe(true);
  });

  it('a refused waiting row releases its slot in the full pool of 256 (M1-7g-f)', async () => {
    const { a, b } = await twoAgents();
    const c = await openAgent(33, ownerC, 'carol');
    await pair(c, b);
    await sendText(a, b);
    await sendText(c, b, 'from carol');
    await fillAwaiting(b, c.id, 256, 'waitC');
    await b.store.transaction((tx) => {
      tx.update('envelopes', { envelope_id: 'waitC0' }, { state: 'refused' });
    });
    const fromA = await proofBeforeMessage(a, b, 'late from alice');
    const rows = await awaitingRows(b);
    expect(rows.some((r) => r.envelope_id === fromA.envelopeId)).toBe(true);
    // The refused row's slot is released, not held until it expires.
    expect(rows.some((r) => r.record_id === 'await:waitC0')).toBe(false);
    expect(rows).toHaveLength(256);
  });

  it('a waiting row whose proof envelope is no longer held releases its slot (M1-7g-f)', async () => {
    const { a, b } = await twoAgents();
    const c = await openAgent(33, ownerC, 'carol');
    await pair(c, b);
    await sendText(a, b);
    await sendText(c, b, 'from carol');
    await fillAwaiting(b, c.id, 256, 'waitC');
    await b.store.transaction((tx) => {
      tx.delete('envelopes', { envelope_id: 'waitC0' });
    });
    const fromA = await proofBeforeMessage(a, b, 'late from alice');
    const rows = await awaitingRows(b);
    expect(rows.some((r) => r.envelope_id === fromA.envelopeId)).toBe(true);
    expect(rows.some((r) => r.record_id === 'await:waitC0')).toBe(false);
    expect(rows).toHaveLength(256);
  });
});
