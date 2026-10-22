// M1-10a: the submitter's chain side (07 §7; 05 §3.2, §3.3; 04 §4, §7). The wire format, the local
// signature check, the Worker's chain port (simulation, the gas-key wallet, inclusion) and the
// client with failover. No network: every request goes to an in-memory Notary behind a mock fetch.
//
// Keys here are test values built at run time (a repeated byte), never a real secret.
import { getDeployment } from '@4thtech-io/occ-v2-abi';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { getChainConfig } from '../clients/index.js';
import { NOTARY_CLIENT_ABI } from '../clients/calls.js';
import type { ChainConfig } from '../config/index.js';
import { buildReceipt, buildRecord, RECORD_KIND } from '../typed-data/index.js';
import type { Hex } from '../ids/index.js';
import {
  MAX_RECEIPTS_PER_RECORD,
  SUBMITTER_MAX_ITEMS,
  SUBMITTER_RPC_METHODS,
  SubmitterError,
  createSubmitterChain,
  createSubmitterClient,
  itemSignatureMatches,
  parseHealthResponse,
  parseStatusResponse,
  parseSubmitRequest,
  parseSubmitResponse,
  type SubmitItem,
} from './index.js';

const config = getChainConfig(84532) as ChainConfig;
if (!getDeployment(84532) || !config) throw new Error('test setup: no Base Sepolia deployment');
const NOTARY = config.contracts.notary;
const CHAIN_ID = config.chainId;

// Test keys: repeated bytes, assembled at run time.
const testKey = (byte: string): ViemHex => `0x${byte.repeat(32)}` as ViemHex;
const AGENT_KEY = testKey('a1');
const OTHER_KEY = testKey('b2');
const GAS_KEY = testKey('c3');
const AGENT = privateKeyToAccount(AGENT_KEY).address.toLowerCase() as Hex;
const RECIPIENT = privateKeyToAccount(OTHER_KEY).address.toLowerCase() as Hex;
const GAS_ADDRESS = privateKeyToAccount(GAS_KEY).address.toLowerCase() as Hex;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as Hex;
const hash32 = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

async function signDigest(digest: Hex, key: ViemHex): Promise<Hex> {
  return (await sign({ hash: digest, privateKey: key, to: 'hex' })) as Hex;
}

async function signedRecord(key: ViemHex = AGENT_KEY, signer: Hex = AGENT) {
  const built = buildRecord({
    chainId: CHAIN_ID,
    notary: NOTARY,
    signer,
    envelopeHash: hash32('11'),
    recipient: RECIPIENT,
    kind: RECORD_KIND.MESSAGE,
    feeToken: ZERO_ADDRESS,
    maxFee: 1000n,
    deadline: FUTURE,
  });
  return { built, signature: await signDigest(built.digest, key) };
}

async function signedReceipt(recordId: Hex) {
  const built = buildReceipt({
    chainId: CHAIN_ID,
    notary: NOTARY,
    signer: RECIPIENT,
    recordId,
    receiptType: 1,
    salt: hash32('22'),
    deadline: FUTURE,
  });
  return { built, signature: await signDigest(built.digest, OTHER_KEY) };
}

const notaryFor = (chainId: number): string | undefined =>
  chainId === CHAIN_ID ? NOTARY : undefined;

async function recordItem(key: ViemHex = AGENT_KEY): Promise<SubmitItem> {
  const { built, signature } = await signedRecord(key);
  const req = parseSubmitRequest(
    'notarize',
    { chainId: CHAIN_ID, records: [{ record: built.record, signature }] },
    notaryFor,
  );
  return req.items[0] as SubmitItem;
}

// --- wire format (07 §7, 05 §3.1 JSON form) ------------------------------------------------------

describe('parseSubmitRequest', () => {
  it('parses a notarize body and computes each record ID as the Notary does', async () => {
    const { built, signature } = await signedRecord();
    const req = parseSubmitRequest(
      'notarize',
      { chainId: CHAIN_ID, records: [{ record: built.record, signature }] },
      notaryFor,
    );
    expect(req.chainId).toBe(CHAIN_ID);
    expect(req.items).toHaveLength(1);
    const item = req.items[0] as SubmitItem;
    expect(item.type).toBe('record');
    expect(item.id).toBe(built.recordId);
    expect(item.recordId).toBe(built.recordId);
    expect(item.signer).toBe(AGENT);
    expect(item.signature).toBe(signature);
  });

  it('parses a receipt body; the item ID is `<recordId>:<type>`', async () => {
    const { built, signature } = await signedReceipt(hash32('33'));
    const req = parseSubmitRequest(
      'receipt',
      { chainId: CHAIN_ID, receipts: [{ receipt: built.receipt, signature }] },
      notaryFor,
    );
    const item = req.items[0] as SubmitItem;
    expect(item.type).toBe('receipt');
    expect(item.id).toBe(`${hash32('33')}:1`);
    expect(item.signer).toBe(RECIPIENT);
  });

  it('refuses anything outside the strict form, without echoing input', async () => {
    const { built, signature } = await signedRecord();
    const good = { record: built.record, signature };
    const bodies: unknown[] = [
      null,
      [],
      { chainId: CHAIN_ID },
      { chainId: CHAIN_ID, records: [] },
      { chainId: CHAIN_ID, records: [good], extra: 1 },
      { chainId: '84532', records: [good] },
      { chainId: CHAIN_ID, records: [{ ...good, extra: true }] },
      {
        chainId: CHAIN_ID,
        records: [{ record: built.record, signature: signature.toUpperCase() }],
      },
      { chainId: CHAIN_ID, records: [{ record: built.record, signature: signature.slice(2) }] },
      { chainId: CHAIN_ID, records: [{ record: built.record, signature: `${signature}0` }] },
      { chainId: CHAIN_ID, records: [{ record: { ...built.record, maxFee: 1000 }, signature }] },
      {
        chainId: CHAIN_ID,
        records: [{ record: { ...built.record, signer: AGENT.toUpperCase() }, signature }],
      },
      { chainId: CHAIN_ID, records: [good, good] },
      { chainId: CHAIN_ID, records: new Array(SUBMITTER_MAX_ITEMS + 1).fill(good) },
      { chainId: CHAIN_ID, receipts: [good] },
    ];
    for (const body of bodies) {
      let thrown: unknown;
      try {
        parseSubmitRequest('notarize', body, notaryFor);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, JSON.stringify(body)?.slice(0, 80)).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).not.toContain(signature.slice(2, 40));
      expect(message).not.toContain(AGENT.slice(2));
    }
  });

  it('refuses a chain the caller does not serve', async () => {
    const { built, signature } = await signedRecord();
    expect(() =>
      parseSubmitRequest(
        'notarize',
        { chainId: 1, records: [{ record: built.record, signature }] },
        notaryFor,
      ),
    ).toThrow(expect.objectContaining({ code: 'unsupported_chain' }) as Error);
  });

  it('accepts a long ERC-1271 signature up to 2048 bytes and no longer', async () => {
    const { built } = await signedRecord();
    const ok = `0x${'ab'.repeat(2048)}`;
    const tooLong = `0x${'ab'.repeat(2049)}`;
    expect(
      parseSubmitRequest(
        'notarize',
        { chainId: CHAIN_ID, records: [{ record: built.record, signature: ok }] },
        notaryFor,
      ).items,
    ).toHaveLength(1);
    expect(() =>
      parseSubmitRequest(
        'notarize',
        { chainId: CHAIN_ID, records: [{ record: built.record, signature: tooLong }] },
        notaryFor,
      ),
    ).toThrow();
  });
});

describe('submitter answers are parsed strictly', () => {
  const id = hash32('44');
  it('accepts a well-formed submit, status and health answer', () => {
    expect(
      parseSubmitResponse({
        chainId: CHAIN_ID,
        items: [{ id, recordId: id, status: 'submitted', txHash: hash32('55') }],
      }).items[0]?.status,
    ).toBe('submitted');
    expect(
      parseStatusResponse({
        chainId: CHAIN_ID,
        txHash: hash32('55'),
        state: 'reverted',
        items: [{ id: `${id}:2`, recordId: id, status: 'failed', error: 'InsufficientCredits' }],
      }).state,
    ).toBe('reverted');
    expect(
      parseHealthResponse({
        ok: true,
        chains: [{ chainId: CHAIN_ID, available: true, gasBalance: '12', queueDepth: 0 }],
      }).chains,
    ).toHaveLength(1);
  });

  it('health: reads the optional per-chain pool states (M1-10b-e) and refuses unknown ones', () => {
    const chain = { chainId: CHAIN_ID, available: true, gasBalance: '12', queueDepth: 0 };
    expect(
      parseHealthResponse({ ok: true, chains: [{ ...chain, gas: 'low', faucet: 'paused' }] })
        .chains[0],
    ).toEqual({ ...chain, gas: 'low', faucet: 'paused' });
    expect(
      parseHealthResponse({ ok: true, chains: [{ ...chain, gas: 'ok', faucet: 'low' }] }).chains[0],
    ).toMatchObject({ gas: 'ok', faucet: 'low' });
    expect(
      parseHealthResponse({ ok: true, chains: [{ ...chain, gas: null, faucet: null }] }).chains[0],
    ).toMatchObject({ gas: null, faucet: null });
    // An older submitter sends neither field.
    expect(parseHealthResponse({ ok: true, chains: [chain] }).chains[0]).toEqual(chain);
    for (const extra of [
      { gas: 'paused' },
      { gas: 'empty' },
      { faucet: 'empty' },
      { faucet: 1 },
      { gas: true },
      { faucetAddress: `0x${'ab'.repeat(20)}` },
    ]) {
      expect(() => parseHealthResponse({ ok: true, chains: [{ ...chain, ...extra }] })).toThrow();
    }
  });

  it('refuses unknown statuses, fields, mismatched IDs and odd error text', () => {
    const bad: unknown[] = [
      { chainId: CHAIN_ID, items: [{ id, recordId: id, status: 'done' }] },
      { chainId: CHAIN_ID, items: [{ id, recordId: id, status: 'recorded', extra: 1 }] },
      { chainId: CHAIN_ID, items: [{ id, recordId: hash32('66'), status: 'recorded' }] },
      { chainId: CHAIN_ID, items: [{ id, recordId: id, status: 'failed', error: 'has space' }] },
      { chainId: CHAIN_ID, items: [{ id, recordId: id, status: 'recorded', txHash: '0x12' }] },
      { chainId: CHAIN_ID, items: {} },
    ];
    for (const value of bad) expect(() => parseSubmitResponse(value)).toThrow();
  });
});

// --- local signature check ------------------------------------------------------------------------

describe('itemSignatureMatches (EOA signatures, checked before any chain request)', () => {
  it('is true for the signer’s own signature on a record and on a receipt', async () => {
    const item = await recordItem();
    expect(itemSignatureMatches(CHAIN_ID, NOTARY, item)).toBe(true);
    const { built, signature } = await signedReceipt(hash32('33'));
    const receipt = parseSubmitRequest(
      'receipt',
      { chainId: CHAIN_ID, receipts: [{ receipt: built.receipt, signature }] },
      notaryFor,
    ).items[0] as SubmitItem;
    expect(itemSignatureMatches(CHAIN_ID, NOTARY, receipt)).toBe(true);
  });

  it('is false for another key, another domain, a long or a malformed signature', async () => {
    const { built } = await signedRecord();
    const other = await signDigest(built.digest, OTHER_KEY);
    const item = parseSubmitRequest(
      'notarize',
      { chainId: CHAIN_ID, records: [{ record: built.record, signature: other }] },
      notaryFor,
    ).items[0] as SubmitItem;
    expect(itemSignatureMatches(CHAIN_ID, NOTARY, item)).toBe(false);
    const good = await recordItem();
    expect(itemSignatureMatches(CHAIN_ID, RECIPIENT, good)).toBe(false);
    expect(itemSignatureMatches(CHAIN_ID + 1, NOTARY, good)).toBe(false);
    expect(
      itemSignatureMatches(CHAIN_ID, NOTARY, { ...good, signature: `0x${'ab'.repeat(300)}` }),
    ).toBe(false);
    expect(
      itemSignatureMatches(CHAIN_ID, NOTARY, { ...good, signature: `0x${'00'.repeat(65)}` }),
    ).toBe(false);
  });
});

// --- the Worker's chain port -----------------------------------------------------------------------

const RPC_URL = 'https://rpc.provider-one.io/v1/secret-path-key';

type StoredRecord = {
  signer: Hex;
  structHash: Hex;
  receiptAt: [bigint, bigint, bigint, bigint];
};

interface MockChain {
  code: Map<string, Hex>;
  records: Map<string, StoredRecord>;
  revertWith: { name: string; args?: readonly unknown[] } | null;
  estimate: bigint;
  balance: bigint;
  /** The gas wallet's next nonce counting the mempool (`pending`). */
  nonce: number;
  /** The gas wallet's next nonce counting mined transactions only (`latest`). */
  minedNonce: number;
  sent: { raw: Hex; hash: Hex }[];
  receipts: Map<string, unknown>;
  methods: string[];
  failNetwork: boolean;
  /** Answer eth_estimateGas and eth_call with a JSON-RPC error that carries no revert data. */
  noDataError: boolean;
  /** Answer getRecord with this revert (any record ID). */
  getRecordRevert: string | null;
}

function newChain(): MockChain {
  return {
    code: new Map(),
    records: new Map(),
    revertWith: null,
    estimate: 150_000n,
    balance: 5n * 10n ** 17n,
    nonce: 7,
    minedNonce: 7,
    sent: [],
    receipts: new Map(),
    methods: [],
    failNetwork: false,
    noDataError: false,
    getRecordRevert: null,
  };
}

const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');

function revertError(chain: MockChain) {
  const data = encodeErrorResult({
    abi: NOTARY_CLIENT_ABI,
    errorName: chain.revertWith?.name as never,
    args: (chain.revertWith?.args ?? []) as never,
  });
  return { code: 3, message: 'execution reverted', data };
}

function mockFetch(chain: MockChain) {
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (chain.failNetwork) throw new TypeError('network down');
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    chain.methods.push(req.method);
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    const replyError = (error: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error }), {
        headers: { 'content-type': 'application/json' },
      });
    const p = req.params;
    switch (req.method) {
      case 'eth_chainId':
        return reply(`0x${CHAIN_ID.toString(16)}`);
      case 'eth_getCode':
        return reply(chain.code.get(String(p[0]).toLowerCase()) ?? '0x');
      case 'eth_getBalance':
        return reply(`0x${chain.balance.toString(16)}`);
      case 'eth_getTransactionCount': {
        const n = p[1] === 'latest' ? chain.minedNonce : p[1] === 'pending' ? chain.nonce : -1;
        if (n < 0) return replyError({ code: -32602, message: 'unexpected block tag' });
        return reply(`0x${n.toString(16)}`);
      }
      case 'eth_maxPriorityFeePerGas':
        return reply('0x3b9aca00');
      case 'eth_getBlockByNumber':
        return reply({ number: '0x10', baseFeePerGas: '0x77359400', timestamp: '0x1' });
      case 'eth_estimateGas':
        if (chain.noDataError) return replyError({ code: -32005, message: 'limit exceeded' });
        if (chain.revertWith) return replyError(revertError(chain));
        return reply(`0x${chain.estimate.toString(16)}`);
      case 'eth_call': {
        const call = p[0] as { to: string; data: ViemHex; from?: string };
        const decoded = decodeFunctionData({ abi: NOTARY_CLIENT_ABI, data: call.data });
        if (decoded.functionName === 'getRecord') {
          const id = (decoded.args as readonly [Hex])[0];
          const stored = chain.records.get(id);
          if (chain.getRecordRevert !== null) {
            // An error name, or raw revert data when it starts with 0x.
            const data = chain.getRecordRevert.startsWith('0x')
              ? chain.getRecordRevert
              : encodeErrorResult({
                  abi: NOTARY_CLIENT_ABI,
                  errorName: chain.getRecordRevert as never,
                });
            return replyError({ code: 3, message: 'execution reverted', data });
          }
          // The deployed Notary reverts RecordNotFound() for an unknown record ID.
          if (!stored) {
            const data = encodeErrorResult({ abi: NOTARY_CLIENT_ABI, errorName: 'RecordNotFound' });
            return replyError({ code: 3, message: 'execution reverted', data });
          }
          return reply(
            encodeFunctionResult({
              abi: NOTARY_CLIENT_ABI,
              functionName: 'getRecord',
              result: {
                signer: stored?.signer ?? ZERO_ADDRESS,
                timestamp: stored ? 1n : 0n,
                kind: stored ? 1 : 0,
                receiptFlags: 0,
                envelopeHash: hash32('00'),
                recipientCommitment: hash32('00'),
                recordStructHash: stored?.structHash ?? hash32('00'),
                receiptAt: stored?.receiptAt ?? [0n, 0n, 0n, 0n],
              } as never,
            }),
          );
        }
        if (chain.revertWith) return replyError(revertError(chain));
        return reply('0x');
      }
      case 'eth_sendRawTransaction': {
        const raw = p[0] as ViemHex;
        const hash = keccak256(raw) as Hex;
        chain.sent.push({ raw: raw as Hex, hash });
        return reply(hash);
      }
      case 'eth_getTransactionReceipt':
        return reply(chain.receipts.get(String(p[0])) ?? null);
      default:
        return replyError({ code: -32601, message: 'method not found' });
    }
  });
  Object.defineProperty(fn, ADDRESS_CHECKED, { value: true });
  return fn;
}

function port(chain: MockChain, overrides: { gasKey?: string; rpcUrls?: string[] } = {}) {
  return createSubmitterChain(config, {
    fetchFn: mockFetch(chain) as unknown as typeof fetch,
    gasKey: overrides.gasKey ?? GAS_KEY,
    rpcUrls: overrides.rpcUrls ?? [RPC_URL],
    timeoutMs: 1000,
  });
}

describe('createSubmitterChain (the Worker’s chain port)', () => {
  it('derives the gas address and refuses a malformed gas key without echoing it', () => {
    expect(port(newChain()).gasAddress).toBe(GAS_ADDRESS);
    const bad = `${GAS_KEY.slice(0, -2)}zz`;
    let thrown: unknown;
    try {
      port(newChain(), { gasKey: bad });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(bad.slice(2, 30));
    expect(JSON.stringify(thrown)).not.toContain(bad.slice(2, 30));
  });

  it('refuses an RPC URL that breaks the 04 §4 rule, without echoing it', () => {
    for (const url of [
      'http://rpc.provider-one.io',
      'https://127.0.0.1/x',
      'https://localhost/x',
    ]) {
      let thrown: unknown;
      try {
        port(newChain(), { rpcUrls: [url] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).not.toContain(url);
    }
  });

  it('reads whether a signer has code (ERC-1271 account or EIP-7702 delegation)', async () => {
    const chain = newChain();
    chain.code.set(AGENT, `0xef0100${'12'.repeat(20)}` as Hex);
    const p = port(chain);
    expect(await p.hasCode(AGENT)).toBe(true);
    expect(await p.hasCode(RECIPIENT)).toBe(false);
  });

  it('simulates a new record as ok, an identical stored one as skipped, another as RecordExists', async () => {
    const chain = newChain();
    const p = port(chain);
    const item = await recordItem();
    expect(await p.simulateItem(item)).toEqual({ outcome: 'ok', gas: 150_000n });
    const { recordStructHash } = await import('@4thtech-io/crypto');
    const { encodeHex0x } = await import('@4thtech-io/crypto');
    if (item.type !== 'record') throw new Error('unreachable');
    chain.records.set(item.recordId, {
      signer: AGENT,
      structHash: encodeHex0x(recordStructHash(item.record)) as Hex,
      receiptAt: [0n, 0n, 0n, 0n],
    });
    expect(await p.simulateItem(item)).toEqual({ outcome: 'skipped' });
    chain.records.set(item.recordId, {
      signer: AGENT,
      structHash: hash32('99'),
      receiptAt: [0n, 0n, 0n, 0n],
    });
    expect(await p.simulateItem(item)).toEqual({ outcome: 'failed', error: 'RecordExists' });
  });

  it('names the contract error of a failing simulation; a pause is not a failure', async () => {
    const chain = newChain();
    const p = port(chain);
    const item = await recordItem();
    chain.revertWith = { name: 'InsufficientCredits', args: [AGENT, ZERO_ADDRESS, 10n, 1n] };
    expect(await p.simulateItem(item)).toEqual({ outcome: 'failed', error: 'InsufficientCredits' });
    chain.revertWith = { name: 'InvalidSignature' };
    expect(await p.simulateItem(item)).toEqual({ outcome: 'failed', error: 'InvalidSignature' });
    chain.revertWith = { name: 'EnforcedPause' };
    expect(await p.simulateItem(item)).toEqual({ outcome: 'paused' });
    expect(await p.simulateBatch([item])).toEqual({
      ok: false,
      error: 'EnforcedPause',
      paused: true,
    });
  });

  it('simulates a receipt whose type is already set as skipped', async () => {
    const chain = newChain();
    const p = port(chain);
    const recordId = hash32('33');
    const { built, signature } = await signedReceipt(recordId);
    const item = parseSubmitRequest(
      'receipt',
      { chainId: CHAIN_ID, receipts: [{ receipt: built.receipt, signature }] },
      notaryFor,
    ).items[0] as SubmitItem;
    chain.records.set(recordId, {
      signer: AGENT,
      structHash: hash32('77'),
      receiptAt: [0n, 0n, 0n, 0n],
    });
    expect(await p.simulateItem(item)).toEqual({ outcome: 'ok', gas: 150_000n });
    chain.records.set(recordId, {
      signer: AGENT,
      structHash: hash32('77'),
      receiptAt: [5n, 0n, 0n, 0n],
    });
    expect(await p.simulateItem(item)).toEqual({ outcome: 'skipped' });
  });

  it('reads a record’s receipt allowance: charged when the Notary stores it, with the types set (D-114)', async () => {
    const chain = newChain();
    const p = port(chain);
    const recordId = hash32('35');
    // Unknown to the Notary (RecordNotFound): never charged, so no receipt is covered.
    expect(await p.recordReceipts(recordId)).toEqual({ charged: false, set: [] });
    chain.records.set(recordId, {
      signer: AGENT,
      structHash: hash32('77'),
      receiptAt: [0n, 0n, 0n, 0n],
    });
    expect(await p.recordReceipts(recordId)).toEqual({ charged: true, set: [] });
    chain.records.set(recordId, {
      signer: AGENT,
      structHash: hash32('77'),
      receiptAt: [5n, 0n, 6n, 0n],
    });
    expect(await p.recordReceipts(recordId)).toEqual({ charged: true, set: [1, 3] });
    // One read: getRecord only; no estimate, no balance or credit read of anyone.
    expect(chain.methods.filter((m) => m !== 'eth_call')).toEqual([]);
    expect(MAX_RECEIPTS_PER_RECORD).toBe(3);
  });

  it('keeps a failed allowance read an infrastructure error, never "not charged"', async () => {
    const chain = newChain();
    chain.getRecordRevert = 'EnforcedPause';
    const p = port(chain);
    await expect(p.recordReceipts(hash32('35'))).rejects.toMatchObject({ code: 'rpc_error' });
    chain.getRecordRevert = null;
    chain.failNetwork = true;
    await expect(p.recordReceipts(hash32('35'))).rejects.toBeInstanceOf(Error);
  });

  it('reads the pending and the latest nonce of the gas wallet apart (M1-10a-b)', async () => {
    const chain = newChain();
    const p = port(chain);
    // A transaction at nonce 7 is still in the mempool, never mined.
    chain.nonce = 8;
    chain.minedNonce = 7;
    expect(await p.pendingNonce()).toBe(8);
    expect(await p.latestNonce()).toBe(7);
  });

  it('sends exactly the given items from the gas key, with the given gas limit and nonce', async () => {
    const chain = newChain();
    const p = port(chain);
    const a = await recordItem();
    const b = await recordItem();
    expect(await p.simulateBatch([a, b])).toEqual({ ok: true, gas: 150_000n });
    expect(await p.pendingNonce()).toBe(7);
    const hash = await p.send([a, b], { gasLimit: 175_000n, nonce: 7 });
    expect(chain.sent).toHaveLength(1);
    const sent = chain.sent[0] as { raw: Hex; hash: Hex };
    expect(hash).toBe(sent.hash);
    const tx = parseTransaction(sent.raw as ViemHex);
    expect(tx.gas).toBe(175_000n);
    expect(tx.nonce).toBe(7);
    expect(tx.chainId).toBe(CHAIN_ID);
    expect(tx.to?.toLowerCase()).toBe(NOTARY);
    expect(tx.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: NOTARY_CLIENT_ABI, data: tx.data as ViemHex });
    expect(call.functionName).toBe('notarizeBatch');
    const [records, sigs] = call.args as unknown as [{ nonce: bigint }[], Hex[]];
    expect(records.map((r) => r.nonce.toString())).toEqual(
      [a, b].map((i) => (i.type === 'record' ? i.record.nonce : '')),
    );
    expect(sigs).toEqual([a.signature, b.signature]);
  });

  it('reads inclusion from the receipt: Notary events only, reverted status', async () => {
    const chain = newChain();
    const p = port(chain);
    const a = await recordItem();
    const b = await recordItem();
    const txHash = hash32('aa');
    expect(await p.inclusion(txHash)).toEqual({ state: 'pending' });
    const log = (eventName: string, args: Record<string, unknown>, address: string) => {
      const topics = encodeEventTopics({ abi: NOTARY_CLIENT_ABI, eventName, args } as never);
      const event = NOTARY_CLIENT_ABI.find(
        (e) => e.type === 'event' && e.name === eventName,
      ) as unknown as { inputs: { name: string; type: string; indexed?: boolean }[] };
      const data = encodeAbiParameters(
        event.inputs.filter((i) => !i.indexed),
        event.inputs.filter((i) => !i.indexed).map((i) => args[i.name]) as never,
      );
      return { address, topics, data };
    };
    chain.receipts.set(txHash, {
      status: '0x1',
      logs: [
        log(
          'RecordNotarized',
          {
            recordId: a.recordId,
            signer: AGENT,
            envelopeHash: hash32('11'),
            recipientCommitment: hash32('00'),
            parentRecordId: hash32('00'),
            appId: hash32('00'),
            kind: 1,
            timestamp: 1n,
          },
          NOTARY,
        ),
        log('RecordSkipped', { recordId: b.recordId }, NOTARY),
        // A look-alike event from another contract is ignored.
        log('RecordSkipped', { recordId: a.recordId }, RECIPIENT),
      ],
    });
    const included = await p.inclusion(txHash);
    expect(included.state).toBe('included');
    if (included.state !== 'included') throw new Error('unreachable');
    expect(included.outcomes.get(a.id)).toBe('recorded');
    expect(included.outcomes.get(b.id)).toBe('skipped');
    chain.receipts.set(txHash, { status: '0x0', logs: [] });
    expect(await p.inclusion(txHash)).toEqual({ state: 'reverted' });
  });

  it('simulates a new record although the Notary reverts RecordNotFound for its ID', async () => {
    // The deployed Notary's getRecord reverts RecordNotFound() for an unknown ID rather than
    // returning an empty record; the port read that as an RPC error, so every new record made the
    // queue answer 503 (the staging smoke's simulated notarize).
    const chain = newChain();
    const p = port(chain);
    const item = await recordItem();
    expect(await p.simulateItem(item)).toEqual({ outcome: 'ok', gas: chain.estimate });
    chain.revertWith = { name: 'InsufficientCredits', args: [ZERO_ADDRESS, ZERO_ADDRESS, 1n, 0n] };
    expect(await p.simulateItem(item)).toEqual({
      outcome: 'failed',
      error: 'InsufficientCredits',
    });
  });

  it('keeps any other getRecord revert an infrastructure error', async () => {
    const chain = newChain();
    chain.getRecordRevert = 'EnforcedPause';
    const p = port(chain);
    const item = await recordItem();
    await expect(p.simulateItem(item)).rejects.toMatchObject({ code: 'rpc_error' });
  });

  it('reads absent only for the exact RecordNotFound selector, not one with trailing bytes', async () => {
    // IR #338 L1: decodeErrorResult accepts bytes after a no-argument error's selector.
    const chain = newChain();
    chain.getRecordRevert = '0x3e07f1a1deadbeef';
    const p = port(chain);
    const item = await recordItem();
    await expect(p.simulateItem(item)).rejects.toMatchObject({ code: 'rpc_error' });
    chain.getRecordRevert = '0x3e07f1a1';
    expect(await p.simulateItem(item)).toEqual({ outcome: 'ok', gas: chain.estimate });
  });

  it('treats an RPC error without revert data as the infrastructure’s, not a failed item', async () => {
    const chain = newChain();
    chain.noDataError = true;
    const p = port(chain);
    const item = await recordItem();
    await expect(p.simulateItem(item)).rejects.toMatchObject({ code: 'rpc_error' });
    await expect(p.simulateBatch([item])).rejects.toMatchObject({ code: 'rpc_error' });
  });

  it('raises fees for a replacement (feePercent) and keeps them under the configured ceiling', async () => {
    const item = await recordItem();
    const feesOf = async (feePercent: number, ceiling?: bigint) => {
      const chain = newChain();
      const p = createSubmitterChain(config, {
        fetchFn: mockFetch(chain) as unknown as typeof fetch,
        gasKey: GAS_KEY,
        rpcUrls: [RPC_URL],
        ...(ceiling === undefined ? {} : { maxFeePerGasWei: ceiling }),
      });
      await p.send([item], { gasLimit: 200_000n, nonce: 3, feePercent });
      const tx = parseTransaction((chain.sent[0] as { raw: Hex }).raw as ViemHex);
      expect(tx.nonce).toBe(3);
      return { max: tx.maxFeePerGas ?? 0n, tip: tx.maxPriorityFeePerGas ?? 0n };
    };
    const base = await feesOf(100);
    const bumped = await feesOf(125);
    expect(bumped.max).toBe((base.max * 125n) / 100n);
    expect(bumped.tip).toBe((base.tip * 125n) / 100n);
    const capped = await feesOf(125, 3_000_000_000n);
    expect(capped.max).toBe(3_000_000_000n);
    const chain = newChain();
    await expect(
      port(chain).send([item], { gasLimit: 1n, nonce: 1, feePercent: 50 }),
    ).rejects.toThrow();
  });

  it('reads the gas balance and sends only allowlisted RPC methods', async () => {
    const chain = newChain();
    const p = port(chain);
    expect(await p.gasBalance()).toBe(5n * 10n ** 17n);
    const item = await recordItem();
    await p.simulateItem(item);
    await p.simulateBatch([item]);
    await p.send([item], { gasLimit: 200_000n, nonce: 1 });
    await p.inclusion(hash32('aa'));
    for (const method of chain.methods) expect(SUBMITTER_RPC_METHODS).toContain(method);
  });

  it('runs over the Workers runtime fetch, which refuses redirect: "error"', async () => {
    // workerd throws a TypeError for `redirect: "error"` (it supports only "follow" and
    // "manual"), so every RPC URL failed and /v1/health reported the chain unavailable.
    const chain = newChain();
    const inner = mockFetch(chain);
    const inits: RequestInit[] = [];
    const workerdFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.redirect !== 'follow' && init?.redirect !== 'manual') {
        throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
      }
      inits.push(init);
      return inner(url, init);
    });
    const p = createSubmitterChain(config, {
      fetchFn: workerdFetch as unknown as typeof fetch,
      gasKey: GAS_KEY,
      rpcUrls: [RPC_URL],
      timeoutMs: 1000,
    });
    expect(await p.gasBalance()).toBe(5n * 10n ** 17n);
    for (const init of inits) expect(init.redirect).toBe('manual');
  });

  it('never follows a redirect: a 3xx answer moves to the next RPC URL', async () => {
    const chain = newChain();
    const inner = mockFetch(chain);
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push(String(url));
      if (String(url) === 'https://rpc.provider-one.io/first') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://rpc.provider-two.io/elsewhere' },
        });
      }
      return inner(url, init);
    });
    const p = createSubmitterChain(config, {
      fetchFn: fetchFn as unknown as typeof fetch,
      gasKey: GAS_KEY,
      rpcUrls: ['https://rpc.provider-one.io/first', RPC_URL],
      timeoutMs: 1000,
    });
    expect(await p.gasBalance()).toBe(5n * 10n ** 17n);
    expect(seen).toEqual(['https://rpc.provider-one.io/first', RPC_URL]);
  });

  it('never puts the RPC URL or the gas key in an error', async () => {
    const chain = newChain();
    chain.failNetwork = true;
    const p = port(chain);
    const item = await recordItem();
    for (const call of [
      () => p.hasCode(AGENT),
      () => p.simulateItem(item),
      () => p.send([item], { gasLimit: 1n, nonce: 1 }),
      () => p.gasBalance(),
    ]) {
      let thrown: unknown;
      try {
        await call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const text = `${(thrown as Error).message} ${JSON.stringify(thrown)} ${String((thrown as Error).stack)}`;
      expect(text).not.toContain('secret-path-key');
      expect(text).not.toContain(GAS_KEY.slice(2, 20));
    }
  });
});

// --- the submitter client (failover; 07 §6.2, §7) -------------------------------------------------

function clientFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  );
  Object.defineProperty(fn, ADDRESS_CHECKED, { value: true });
  return fn;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createSubmitterClient', () => {
  const A = 'https://submitter-a.example-host.io';
  const B = 'https://submitter-b.example-host.io/base';

  it('refuses a plain fetch and a URL that breaks the 04 §4 rule', () => {
    expect(() =>
      createSubmitterClient({ urls: [A], fetchFn: (async () => json(200, {})) as typeof fetch }),
    ).toThrow();
    const fetchFn = clientFetch(() => json(200, {})) as unknown as typeof fetch;
    expect(() =>
      createSubmitterClient({ urls: ['http://submitter-a.example-host.io'], fetchFn }),
    ).toThrow();
    expect(() => createSubmitterClient({ urls: [], fetchFn })).toThrow();
  });

  it('posts the signed items as JSON, without redirects or credentials', async () => {
    const { built, signature } = await signedRecord();
    const fetchFn = clientFetch((url, init) => {
      expect(url).toBe(`${A}/v1/notarize`);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.credentials).toBe('omit');
      const body = JSON.parse(String(init.body)) as { chainId: number; records: unknown[] };
      expect(body).toEqual({ chainId: CHAIN_ID, records: [{ record: built.record, signature }] });
      return json(200, {
        chainId: CHAIN_ID,
        items: [
          {
            id: built.recordId,
            recordId: built.recordId,
            status: 'submitted',
            txHash: hash32('55'),
          },
        ],
      });
    });
    const client = createSubmitterClient({
      urls: [A],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const res = await client.notarize(CHAIN_ID, [{ record: built.record, signature }]);
    expect(res.items[0]?.status).toBe('submitted');
  });

  it('fails over on a network error, a 5xx, a 429, an unserved chain or a malformed answer', async () => {
    const { built, signature } = await signedRecord();
    const answer = {
      chainId: CHAIN_ID,
      items: [{ id: built.recordId, recordId: built.recordId, status: 'skipped' }],
    };
    const firsts: (() => Response)[] = [
      () => {
        throw new TypeError('down');
      },
      () => json(503, { error: 'unavailable' }),
      () => json(429, { error: 'rate_limited' }),
      () => json(400, { error: 'unsupported_chain' }),
      () => json(200, { chainId: CHAIN_ID, items: [{ id: 'x' }] }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const first of firsts) {
      const seen: string[] = [];
      const fetchFn = clientFetch((url) => {
        seen.push(url);
        return new URL(url).origin === new URL(A).origin ? first() : json(200, answer);
      });
      const client = createSubmitterClient({
        urls: [A, B],
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      const res = await client.notarize(CHAIN_ID, [{ record: built.record, signature }]);
      expect(res.items[0]?.status).toBe('skipped');
      expect(seen).toEqual([`${A}/v1/notarize`, `${B}/v1/notarize`]);
    }
  });

  it('stops at a refusal of the request itself (400), with a fixed code and no URL', async () => {
    const { built, signature } = await signedRecord();
    const seen: string[] = [];
    const fetchFn = clientFetch((url) => {
      seen.push(url);
      return json(400, { error: 'bad_request' });
    });
    const client = createSubmitterClient({
      urls: [A, B],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const err = await client
      .notarize(CHAIN_ID, [{ record: built.record, signature }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitterError);
    expect((err as SubmitterError).code).toBe('refused');
    expect((err as Error).message).not.toContain('example-host');
    expect(seen).toHaveLength(1);
  });

  it('reports `unavailable` when every submitter fails, with no URL in the error', async () => {
    const fetchFn = clientFetch(() => json(502, {}));
    const client = createSubmitterClient({
      urls: [A, B],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const err = await client.status(hash32('55')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubmitterError);
    expect((err as SubmitterError).code).toBe('unavailable');
    expect(`${(err as Error).message} ${JSON.stringify(err)}`).not.toContain('example-host');
  });

  it('reads status and health with GET', async () => {
    const fetchFn = clientFetch((url, init) => {
      expect(init.method).toBe('GET');
      if (url.endsWith('/v1/health')) {
        return json(200, { ok: true, chains: [] });
      }
      expect(url).toBe(`${A}/v1/status/${hash32('55')}`);
      return json(200, { chainId: CHAIN_ID, txHash: hash32('55'), state: 'pending', items: [] });
    });
    const client = createSubmitterClient({
      urls: [A],
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect((await client.status(hash32('55'))).state).toBe('pending');
    expect((await client.health()).ok).toBe(true);
    await expect(client.status('0x12' as Hex)).rejects.toThrow();
  });
});
