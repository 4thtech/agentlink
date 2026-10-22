// M1-11r-a: the read-only accessors the local UI server serves its pages from (identity
// fingerprints and agent ID, resolved folders, the proof list, credits, free test credits, relays and
// the activity feed). Zero access: every result is checked against its exact key set, so no key,
// salt, signed object, sealed value or URL can ride along (I-7). Paging is newest first.
import { type ChainConfig } from '@4thtech-io/chain';
import {
  agentFingerprint,
  decodeHex0x,
  encodeHex,
  formatFingerprint,
  ownerFingerprint,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { defaultPolicy, type Policy } from '@4thtech-io/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from './client.js';
import { seal, type CoreContext } from './context.js';
import type { FilesPlatform } from './files/platform.js';
import type { ProofsPlatform } from './proofs/platform.js';
import { MemoryStore } from './store/memory-store.js';
import type { Sealed } from './store/schema.js';
import { BASE_SEPOLIA, FakeNotary } from './testing/chain.js';
import { makeAgent, pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from './testing/fixtures.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from './testing/owner.js';
import type { JsonObject } from '@4thtech-io/crypto';

const asOwner = (o: MemoryOwnerKeyStore): TestOwner => o as unknown as TestOwner;
const keysOf = (o: object): string[] => Object.keys(o).sort();
const hex64 = (n: number): string => n.toString(16).padStart(64, '0');
const recordId = (n: number): string => `0x${hex64(n)}`;

/** Anything that must never appear in a UI read (zero access, I-7). */
const FORBIDDEN = /salt|secret|seed|private|record_?json|signed|signature|sig\b|url|presign|key\b|fileKey|tx_?hash|txHash|wallet|gas/i;

function assertNoSecretFields(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretFields(v, `${path}[${String(i)}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      expect(FORBIDDEN.test(k), `${path}.${k}`).toBe(false);
      assertNoSecretFields(v, `${path}.${k}`);
    }
  }
}

/** The client's context, for sealing rows the tests write directly (display reads only). */
function ctxOf(agent: TestAgent): CoreContext {
  return {
    keyStore: agent.keyStore,
    store: agent.store,
    cipher: agent.cipher,
    now: () => 0,
    log: undefined as never,
  };
}

async function insertProof(
  agent: TestAgent,
  row: { n: number; status: string; createdAt: number; key?: string; direction?: 'received' },
): Promise<string> {
  const id = row.key ?? recordId(row.n);
  const salt = await seal(ctxOf(agent), 'proofs', 'salt', [id], 'SALT-MUST-NOT-LEAK');
  await agent.store.transaction((tx) =>
    tx.insert('proofs', {
      record_id: id,
      envelope_id: `env${String(row.n)}`,
      chain_id: 84532,
      record_json: '{"secret":"RECORD-JSON-MUST-NOT-LEAK"}',
      tx_hash: `0x${hex64(row.n + 1000)}`,
      status: row.status,
      fee_token: null,
      fee_amount: null,
      salt,
      created_at: row.createdAt,
    }),
  );
  return id;
}

async function insertApproval(
  agent: TestAgent,
  row: {
    id: string;
    status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'void';
    decidedAt: number | null;
    decision?: boolean;
  },
): Promise<void> {
  const c = ctxOf(agent);
  const action = await seal(c, 'approvals', 'action_json', [row.id], '{"tool":"x"}');
  const summary: Sealed = await seal(c, 'approvals', 'summary', [row.id], 'SUMMARY');
  await agent.store.transaction((tx) =>
    tx.insert('approvals', {
      approval_id: row.id,
      action_json: action,
      scope_json: null,
      answers_envelope_id: null,
      scope_key: null,
      source: 'owner',
      policy_hash: null,
      signed_decision: row.decision === false ? null : '{"sig":"SIGNED-MUST-NOT-LEAK"}',
      signed_cancel: null,
      summary,
      status: row.status,
      expires_at: 2_000_000_000,
      created_at: 1_700_000_000,
      decided_at: row.decidedAt,
    }),
  );
}

async function applyPolicy(agent: TestAgent, clock: FakeClock, edit: (p: Policy) => void) {
  const policy = defaultPolicy();
  edit(policy);
  const signed = await signWith(agent.owner, {
    v: 1,
    agent: agent.id,
    owner: await ownerHex(agent.owner),
    op: 'policy.set',
    params: { version: 1, policy: policy as unknown as JsonObject },
    nonce: newNonce(),
    issuedAt: clock.t,
    expiresAt: clock.t + 600,
  });
  const applied = await agent.client.ownerActions.apply(JSON.stringify(signed));
  if (applied.status !== 'applied') throw new Error('policy not applied');
}

/** An agent with a policy mark, an optional files platform and an optional proofs platform. */
async function openAgent(
  clock: FakeClock,
  n: number,
  options: { files?: FilesPlatform; proofs?: ProofsPlatform } = {},
): Promise<TestAgent> {
  const keyStore = new MemoryKeyStore(seed(n));
  const owner = asOwner(new MemoryOwnerKeyStore(seed(n + 100), passphrase()));
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
    policyMark: new MemoryPolicyMark(),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.proofs === undefined ? {} : { proofs: options.proofs }),
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name: 'Alpha',
    relays: RELAYS,
  });
  return { client, store, cipher, keyStore, owner, id: client.agentId };
}

let clock: FakeClock;

beforeEach(() => {
  clock = new FakeClock();
});

describe('identity reads (M1-11r-a)', () => {
  it('before init: no fingerprints, no agent ID, no relays', async () => {
    const client = await AgentLinkClient.create({
      keyStore: new MemoryKeyStore(seed(41)),
      store: new MemoryStore(),
      cipher: new TestStoreCipher(),
      approvals: new RecordingApprovalChannel(),
    });
    expect(await client.identity.fingerprints()).toBeUndefined();
    expect(await client.identity.agentAddress()).toBeUndefined();
    expect(await client.identity.relays()).toEqual([]);
  });

  it('fingerprints are the public agent and owner fingerprints, nothing else', async () => {
    const owner = new MemoryOwnerKeyStore(seed(142), passphrase());
    const a = await makeAgent(clock, new MemoryKeyStore(seed(42)), asOwner(owner), 'Alpha');
    const fp = await a.client.identity.fingerprints();
    expect(fp).toBeDefined();
    if (fp === undefined) return;
    expect(keysOf(fp)).toEqual(['agent', 'owner']);
    expect(keysOf(fp.agent)).toEqual(['long', 'short']);
    expect(keysOf(fp.owner)).toEqual(['long', 'short']);

    const card = (await a.client.identity.get())?.card;
    if (card === undefined) throw new Error('no card');
    const ownerDigest = ownerFingerprint(
      decodeHex0x(card.ownerEvm, { length: 20 }),
      decodeHex0x(card.ownerNostr, { length: 32 }),
      decodeHex0x(card.ownerEnc, { length: 32 }),
    );
    expect(fp.owner).toEqual({
      short: formatFingerprint(ownerDigest, 'short'),
      long: encodeHex(ownerDigest),
    });
    const agentDigest = agentFingerprint(decodeHex0x(a.id, { length: 20 }));
    expect(fp.agent).toEqual({
      short: formatFingerprint(agentDigest, 'short'),
      long: encodeHex(agentDigest),
    });
    assertNoSecretFields(fp);
  });

  it('agentAddress is the agent ID (the credits payer), and relays are the stored list', async () => {
    const a = await openAgent(clock, 43);
    expect(await a.client.identity.agentAddress()).toBe(a.id);
    expect(await a.client.identity.relays()).toEqual([...RELAYS]);
  });
});

describe('files.resolvedFolders (M1-11r-a)', () => {
  it('without a files platform: the configured folders and nothing resolved', async () => {
    const a = await openAgent(clock, 44);
    const got = await a.client.files.resolvedFolders();
    expect(keysOf(got)).toEqual(['configured', 'resolved']);
    expect(got.resolved).toEqual([]);
  });

  it('resolves the policy folders through the platform, returning paths only', async () => {
    const asked: (readonly string[])[] = [];
    const platform: FilesPlatform = {
      allowedFolderRealpaths: (folders) => {
        asked.push(folders);
        return Promise.resolve(['/home/u/Work']);
      },
      download: () => {
        throw new Error('unused');
      },
      inbox: () => Promise.reject(new Error('unused')),
    };
    const a = await openAgent(clock, 45, { files: platform });
    await applyPolicy(a, clock, (p) => {
      p.files.allowedFolders = ['~/Work'];
    });
    const got = await a.client.files.resolvedFolders();
    expect(got).toEqual({ configured: ['~/Work'], resolved: ['/home/u/Work'] });
    expect(asked).toEqual([['~/Work']]);
  });

  it('a platform failure resolves nothing and never throws its text', async () => {
    const platform: FilesPlatform = {
      allowedFolderRealpaths: () => Promise.reject(new Error('/secret/path/in/error')),
      download: () => {
        throw new Error('unused');
      },
      inbox: () => Promise.reject(new Error('unused')),
    };
    const a = await openAgent(clock, 46, { files: platform });
    await applyPolicy(a, clock, (p) => {
      p.files.allowedFolders = ['~/Work'];
    });
    expect(await a.client.files.resolvedFolders()).toEqual({
      configured: ['~/Work'],
      resolved: [],
    });
  });
});

describe('ProofService.list (M1-11r-a)', () => {
  it('an empty store gives an empty page and no cursor', async () => {
    const a = await openAgent(clock, 47);
    expect(await a.client.proofs.list({ limit: 10 })).toEqual({ items: [] });
  });

  it('lists records newest first, paged with an opaque cursor, without stored receipts or waiting rows', async () => {
    const a = await openAgent(clock, 48);
    // Five records; two share a time (tie broken by record ID, descending).
    await insertProof(a, { n: 1, status: 'recorded', createdAt: 100 });
    await insertProof(a, { n: 2, status: 'pending', createdAt: 200 });
    await insertProof(a, { n: 3, status: 'received', createdAt: 300 });
    await insertProof(a, { n: 4, status: 'needs_credits', createdAt: 300 });
    await insertProof(a, { n: 5, status: 'announced', createdAt: 400 });
    // Not records: a replaced one, a stored receipt, a waiting proof, a receipt request.
    await insertProof(a, { n: 6, status: 'replaced', createdAt: 500 });
    await insertProof(a, { n: 7, status: 'receipt_signed', createdAt: 500, key: `${recordId(1)}:1` });
    await insertProof(a, { n: 8, status: 'awaiting', createdAt: 500, key: 'await:x' });
    await insertProof(a, { n: 9, status: 'receipt_request', createdAt: 500, key: 'request:y' });

    const first = await a.client.proofs.list({ limit: 2 });
    expect(first.items.map((i) => i.recordId)).toEqual([recordId(5), recordId(4)]);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await a.client.proofs.list({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((i) => i.recordId)).toEqual([recordId(3), recordId(2)]);
    const third = await a.client.proofs.list({ limit: 2, cursor: second.nextCursor });
    expect(third.items.map((i) => i.recordId)).toEqual([recordId(1)]);
    expect(third.nextCursor).toBeUndefined();

    const all = await a.client.proofs.list({ limit: 100 });
    expect(all.items).toHaveLength(5);
    const received = all.items.find((i) => i.recordId === recordId(3));
    expect(received?.direction).toBe('received');
    expect(all.items.find((i) => i.recordId === recordId(5))?.direction).toBe('sent');
    for (const item of all.items) {
      expect(keysOf(item)).toEqual([
        'chain',
        'chainId',
        'createdAt',
        'direction',
        'envelopeId',
        'recordId',
        'status',
      ]);
    }
    const text = JSON.stringify(all);
    expect(text).not.toContain('SALT-MUST-NOT-LEAK');
    expect(text).not.toContain('RECORD-JSON-MUST-NOT-LEAK');
    expect(text).not.toContain(hex64(1001));
    assertNoSecretFields(all);
  });

  it('refuses a bad limit or a malformed cursor', async () => {
    const a = await openAgent(clock, 49);
    await expect(a.client.proofs.list({ limit: 0 })).rejects.toMatchObject({
      code: 'page_query_invalid',
    });
    await expect(a.client.proofs.list({ limit: 101 })).rejects.toMatchObject({
      code: 'page_query_invalid',
    });
    await expect(a.client.proofs.list({ limit: 5, cursor: 'nope' })).rejects.toMatchObject({
      code: 'page_query_invalid',
    });
  });
});

describe('ProofService.creditsBalance and requestFaucet (M1-11r-a)', () => {
  it('without a proofs platform: unavailable', async () => {
    const a = await openAgent(clock, 50);
    expect(await a.client.proofs.creditsBalance()).toEqual({ status: 'unavailable' });
    expect(await a.client.proofs.requestFaucet(84532)).toEqual({ status: 'unavailable' });
  });

  it('reads credits per chain for the agent ID, with public values only', async () => {
    const notary = new FakeNotary(clock.now);
    const a = await openAgent(clock, 51, { proofs: notary.platform() });
    notary.fund(a.id, 2_500_000n);
    const got = await a.client.proofs.creditsBalance();
    expect(got.status).toBe('ok');
    if (got.status !== 'ok') return;
    expect(keysOf(got)).toEqual(['agentId', 'chains', 'status']);
    expect(got.agentId).toBe(a.id);
    expect(got.chains).toHaveLength(1);
    const [chain] = got.chains;
    expect(keysOf(chain ?? {})).toEqual([
      'available',
      'chain',
      'chainId',
      'credits',
      'freeCredits',
      'testnet',
    ]);
    expect(chain).toMatchObject({
      chainId: 84532,
      chain: BASE_SEPOLIA.key,
      testnet: true,
      freeCredits: true,
      available: true,
    });
    for (const c of chain?.credits ?? []) expect(keysOf(c)).toEqual(['amount', 'token', 'usd']);
    expect(chain?.credits.some((c) => c.amount === '2500000' && c.usd === '2.5')).toBe(true);
    assertNoSecretFields(got);
  });

  it('a chain that cannot be read is listed as not available', async () => {
    const notary = new FakeNotary(clock.now);
    const base = notary.platform();
    const first = base.chains[0];
    if (first === undefined) throw new Error('no chain');
    const down = {
      readContract: () => Promise.reject(new Error('https://rpc.example/KEY-IN-PATH')),
    } as unknown as typeof first.client;
    const a = await openAgent(clock, 52, {
      proofs: { ...base, chains: [{ ...first, client: down }] },
    });
    const got = await a.client.proofs.creditsBalance();
    expect(got.status).toBe('ok');
    if (got.status !== 'ok') return;
    expect(got.chains).toEqual([
      {
        chainId: 84532,
        chain: BASE_SEPOLIA.key,
        testnet: true,
        freeCredits: true,
        available: false,
        credits: [],
      },
    ]);
    expect(JSON.stringify(got)).not.toContain('KEY-IN-PATH');
  });

  it('requests free test credits for the agent ID on an allowlisted testnet', async () => {
    const notary = new FakeNotary(clock.now);
    const asked: { chainId: number; agent: string }[] = [];
    const platform: ProofsPlatform = {
      ...notary.platform(),
      faucet: {
        request: (input) => {
          asked.push({ ...input });
          return Promise.resolve({ status: 'sent' });
        },
      },
    };
    const a = await openAgent(clock, 53, { proofs: platform });
    expect(await a.client.proofs.requestFaucet(84532)).toEqual({ status: 'sent' });
    expect(asked).toEqual([{ chainId: 84532, agent: a.id }]);
  });

  it('passes on a limit answer with its wait', async () => {
    const notary = new FakeNotary(clock.now);
    const platform: ProofsPlatform = {
      ...notary.platform(),
      faucet: {
        request: () => Promise.resolve({ status: 'already_claimed', retryAfter: 3600 }),
      },
    };
    const a = await openAgent(clock, 54, { proofs: platform });
    expect(await a.client.proofs.requestFaucet(84532)).toEqual({
      status: 'already_claimed',
      retryAfter: 3600,
    });
  });

  it('refuses a mainnet chain, and a chain whose config is not a testnet, before any request', async () => {
    const notary = new FakeNotary(clock.now);
    let calls = 0;
    const mainnet: ChainConfig = { ...BASE_SEPOLIA, key: 'base', chainId: 8453, testnet: false };
    const base = notary.platform();
    const first = base.chains[0];
    if (first === undefined) throw new Error('no chain');
    const platform: ProofsPlatform = {
      ...base,
      chains: [...base.chains, { ...first, config: mainnet }],
      faucet: {
        request: () => {
          calls += 1;
          return Promise.resolve({ status: 'sent' });
        },
      },
    };
    const a = await openAgent(clock, 55, { proofs: platform });
    expect(await a.client.proofs.requestFaucet(8453)).toEqual({
      status: 'refused',
      reason: 'not_testnet',
    });
    expect(await a.client.proofs.requestFaucet(1)).toEqual({
      status: 'refused',
      reason: 'not_testnet',
    });
    // An allowlisted ID whose shipped config does not say testnet is refused too.
    const misconfigured: ProofsPlatform = {
      ...platform,
      chains: [{ ...first, config: { ...BASE_SEPOLIA, testnet: false } }],
    };
    const b = await openAgent(clock, 56, { proofs: misconfigured });
    expect(await b.client.proofs.requestFaucet(84532)).toEqual({
      status: 'refused',
      reason: 'not_testnet',
    });
    expect(calls).toBe(0);
  });

  it('a port failure is unavailable, with no error text', async () => {
    const notary = new FakeNotary(clock.now);
    const platform: ProofsPlatform = {
      ...notary.platform(),
      faucet: { request: () => Promise.reject(new Error('https://submit.example/secret')) },
    };
    const a = await openAgent(clock, 57, { proofs: platform });
    expect(await a.client.proofs.requestFaucet(84532)).toEqual({ status: 'unavailable' });
  });
});

describe('ActivityService.list (M1-11r-a)', () => {
  it('an empty store gives an empty feed', async () => {
    const a = await openAgent(clock, 58);
    expect(await a.client.activity.list({ limit: 20 })).toEqual({ items: [] });
  });

  it('merges decided approvals, proofs, blocks and the rules change, newest first, paged', async () => {
    const a = await openAgent(clock, 59);
    const owner = new MemoryOwnerKeyStore(seed(160), passphrase());
    const b = await makeAgent(clock, new MemoryKeyStore(seed(60)), asOwner(owner), 'Bravo');
    await pairWith(clock, a, b);

    await insertApproval(a, { id: 'apr_pending', status: 'pending', decidedAt: null });
    await insertApproval(a, { id: 'apr_yes', status: 'approved', decidedAt: 1_800_000_010 });
    await insertApproval(a, { id: 'apr_used', status: 'void', decidedAt: 1_800_000_020 });
    await insertApproval(a, { id: 'apr_no', status: 'denied', decidedAt: 1_800_000_030 });
    await insertProof(a, { n: 11, status: 'recorded', createdAt: 1_800_000_040 });
    await insertProof(a, { n: 12, status: 'receipt_signed', createdAt: 1_800_000_041, key: 'r:1' });
    const fromKey = hex64(77);
    await a.store.transaction((tx) =>
      tx.insert('blocked_keys', {
        from_key: fromKey,
        blocked_at: 1_800_000_050,
        via_envelope_id: 'env-blocked',
      }),
    );
    clock.t = 1_800_000_060;
    await a.client.contacts.block(b.id);
    clock.t = 1_800_000_070;
    await applyPolicy(a, clock, () => {});

    const all = await a.client.activity.list({ limit: 100 });
    expect(all.items.map((i) => i.kind)).toEqual([
      'rules_changed',
      'contact_blocked',
      'sender_blocked',
      'proof',
      'approval_decided',
      'approval_decided',
      'approval_decided',
    ]);
    expect(all.nextCursor).toBeUndefined();
    const at = all.items.map((i) => i.at);
    expect([...at].sort((x, y) => y - x)).toEqual(at);

    const byKind = (k: string) => all.items.filter((i) => i.kind === k);
    expect(byKind('approval_decided').map((i) => ('decision' in i ? i.decision : ''))).toEqual([
      'denied',
      'approved',
      'approved',
    ]);
    for (const item of all.items) {
      switch (item.kind) {
        case 'approval_decided':
          expect(keysOf(item)).toEqual(['approvalId', 'at', 'decision', 'id', 'kind']);
          break;
        case 'proof':
          expect(keysOf(item)).toEqual(['at', 'chainId', 'direction', 'id', 'kind', 'recordId', 'status']);
          break;
        case 'sender_blocked':
          expect(keysOf(item)).toEqual(['at', 'id', 'kind', 'senderCode']);
          expect(item.senderCode).toMatch(/^[0-9A-F]{4}·[0-9A-F]{4}$/);
          break;
        case 'contact_blocked':
          expect(keysOf(item)).toEqual(['at', 'contactId', 'id', 'kind']);
          expect(item.contactId).toBe(b.id);
          break;
        case 'rules_changed':
          expect(keysOf(item)).toEqual(['at', 'id', 'kind', 'version']);
          expect(item.version).toBe(1);
          break;
      }
    }
    const text = JSON.stringify(all);
    expect(text).not.toContain('SIGNED-MUST-NOT-LEAK');
    expect(text).not.toContain('SALT-MUST-NOT-LEAK');
    expect(text).not.toContain('SUMMARY');
    expect(text).not.toContain(fromKey);
    assertNoSecretFields(all);

    // Paging gives the same feed, in pages of 3, with no item twice or missing.
    const paged: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i += 1) {
      const page = await a.client.activity.list({ limit: 3, ...(cursor ? { cursor } : {}) });
      paged.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(paged).toEqual(all.items.map((i) => i.id));
  });

  it('breaks ties in time by a stable order, across pages', async () => {
    const a = await openAgent(clock, 61);
    for (let n = 1; n <= 5; n += 1) {
      await insertProof(a, { n, status: 'recorded', createdAt: 1_000 });
    }
    await insertApproval(a, { id: 'apr_tie', status: 'approved', decidedAt: 1_000 });
    const all = await a.client.activity.list({ limit: 100 });
    expect(all.items).toHaveLength(6);
    const paged: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i += 1) {
      const page = await a.client.activity.list({ limit: 2, ...(cursor ? { cursor } : {}) });
      paged.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(paged).toEqual(all.items.map((i) => i.id));
    expect(new Set(paged).size).toBe(6);
  });

  it('refuses a bad limit or cursor', async () => {
    const a = await openAgent(clock, 62);
    await expect(a.client.activity.list({ limit: 0 })).rejects.toMatchObject({
      code: 'page_query_invalid',
    });
    await expect(a.client.activity.list({ limit: 3, cursor: '12' })).rejects.toMatchObject({
      code: 'page_query_invalid',
    });
  });
});
