// M1-10b, M1-10b-b: the testnet faucet's chain side (05 §9; 03 §4.4; 12 §4.1; audit-rules SUB-7). The
// hard-coded testnet allowlist, the `depositFor` calls and the faucet key's wallet. No network:
// every request goes to an in-memory chain behind a mock fetch.
//
// Keys here are test values built at run time (a repeated byte), never a real secret.
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  keccak256,
  parseTransaction,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { getChainConfig } from '../clients/index.js';
import { FEE_VAULT_CLIENT_ABI } from '../clients/calls.js';
import type { ChainConfig } from '../config/index.js';
import type { Hex } from '../ids/index.js';
import {
  FAUCET_CHAIN_IDS,
  FAUCET_MAX_GAS,
  FAUCET_MAX_USD_CENTS,
  buildDepositFor,
  createFaucetChain,
  isFaucetChain,
} from './index.js';

const config = getChainConfig(84532) as ChainConfig;
if (!config) throw new Error('test setup: no Base Sepolia deployment');
const VAULT = config.contracts.vault.toLowerCase() as Hex;
const USDC = (config.feeTokens[0]?.address ?? '').toLowerCase() as Hex;

const testKey = (byte: string): ViemHex => `0x${byte.repeat(32)}` as ViemHex;
const FAUCET_KEY = testKey('d4');
const FAUCET = privateKeyToAccount(FAUCET_KEY).address.toLowerCase() as Hex;
const AGENT = `0x${'ab'.repeat(20)}` as Hex;
const RPC_URL = 'https://rpc.provider-one.io/v1/secret-path-key';
const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');
const ONE_USDC = 1_000_000n;

interface MockChain {
  chainId: number;
  tokenBalance: bigint;
  allowance: bigint;
  gasBalance: bigint;
  nonce: number;
  /** The `pending` nonce when it differs from the `latest` one (a transaction still in the mempool). */
  pendingNonce?: number;
  estimate: bigint;
  /** What `eth_estimateGas` answers for a `depositFor` (it reverts while the allowance is short). */
  depositEstimate: bigint;
  revertEstimate: boolean;
  failSend: 'none' | 'answer' | 'network';
  /** Which sends fail as `failSend` says: every one, or only the approve or the depositFor. */
  failOn: 'all' | 'approve' | 'deposit';
  /** How a sent transaction's receipt answers: mined (status 1), never mined, or reverted. */
  receipt: 'mined' | 'pending' | 'reverted';
  methods: string[];
  sent: { raw: Hex; hash: Hex }[];
  /** Every raw transaction handed to `eth_sendRawTransaction`, whatever the answer. */
  attempted: Hex[];
  /** The gas of every `depositFor` simulation, in order. */
  depositEstimates: number;
}

function newChain(overrides: Partial<MockChain> = {}): MockChain {
  return {
    chainId: 84532,
    tokenBalance: 100n * ONE_USDC,
    allowance: 0n,
    gasBalance: 10n ** 18n,
    nonce: 7,
    estimate: 60_000n,
    depositEstimate: 71_000n,
    revertEstimate: false,
    failSend: 'none',
    failOn: 'all',
    receipt: 'mined',
    methods: [],
    sent: [],
    attempted: [],
    depositEstimates: 0,
    ...overrides,
  };
}

function mockFetch(chain: MockChain) {
  const fn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
        return reply(`0x${chain.chainId.toString(16)}`);
      case 'eth_getBalance':
        return reply(`0x${chain.gasBalance.toString(16)}`);
      case 'eth_getTransactionCount': {
        const n = p[1] === 'pending' ? (chain.pendingNonce ?? chain.nonce) : chain.nonce;
        return reply(`0x${n.toString(16)}`);
      }
      case 'eth_maxPriorityFeePerGas':
        return reply('0x3b9aca00');
      case 'eth_getBlockByNumber':
        return reply({ number: '0x10', baseFeePerGas: '0x77359400', timestamp: '0x1' });
      case 'eth_estimateGas': {
        const reverted = () =>
          replyError({ code: 3, message: 'execution reverted', data: '0x08c379a0' });
        if (chain.revertEstimate) return reverted();
        const call = p[0] as { to: string; data: ViemHex };
        if (call.to.toLowerCase() === VAULT) {
          // depositFor pulls the amount with transferFrom: it reverts while the allowance is short.
          const d = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: call.data });
          const amount = (d.args as readonly unknown[])[2] as bigint;
          if (chain.allowance < amount) return reverted();
          chain.depositEstimates += 1;
          return reply(`0x${chain.depositEstimate.toString(16)}`);
        }
        return reply(`0x${chain.estimate.toString(16)}`);
      }
      case 'eth_getTransactionReceipt': {
        const hash = String(p[0]).toLowerCase();
        const known = chain.sent.find((s) => s.hash === hash);
        if (!known || chain.receipt === 'pending') return reply(null);
        if (chain.receipt === 'reverted') return reply({ transactionHash: hash, status: '0x0' });
        // Mining an approve sets the allowance it grants.
        const tx = parseTransaction(known.raw as ViemHex);
        if (String(tx.to).toLowerCase() === USDC) {
          const a = decodeFunctionData({ abi: erc20Abi, data: tx.data as ViemHex });
          if (a.functionName === 'approve')
            chain.allowance = (a.args as readonly bigint[])[1] ?? 0n;
        }
        return reply({ transactionHash: hash, status: '0x1' });
      }
      case 'eth_call': {
        const call = p[0] as { to: string; data: ViemHex };
        const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
        if (decoded.functionName === 'balanceOf') {
          return reply(
            encodeFunctionResult({
              abi: erc20Abi,
              functionName: 'balanceOf',
              result: chain.tokenBalance,
            }),
          );
        }
        if (decoded.functionName === 'allowance') {
          return reply(
            encodeFunctionResult({
              abi: erc20Abi,
              functionName: 'allowance',
              result: chain.allowance,
            }),
          );
        }
        return replyError({ code: -32000, message: 'unexpected call' });
      }
      case 'eth_sendRawTransaction': {
        const raw = p[0] as ViemHex;
        chain.attempted.push(raw as Hex);
        const isDeposit = String(parseTransaction(raw).to).toLowerCase() === VAULT;
        const failing = chain.failOn === 'all' || (chain.failOn === 'deposit') === isDeposit;
        if (failing && chain.failSend === 'network') throw new TypeError('network down');
        if (failing && chain.failSend === 'answer') {
          return replyError({ code: -32000, message: 'nonce too low' });
        }
        const hash = keccak256(raw) as Hex;
        chain.sent.push({ raw: raw as Hex, hash });
        return reply(hash);
      }
      default:
        return replyError({ code: -32601, message: 'method not found' });
    }
  });
  Object.defineProperty(fn, ADDRESS_CHECKED, { value: true });
  return fn;
}

function faucet(chain: MockChain, cfg: ChainConfig = config) {
  return createFaucetChain(cfg, {
    fetchFn: mockFetch(chain) as unknown as typeof fetch,
    faucetKey: FAUCET_KEY,
    rpcUrls: [RPC_URL],
    timeoutMs: 1000,
    receiptPollMs: 1,
    receiptTimeoutMs: 40,
  });
}

function decodeSent(raw: Hex) {
  const tx = parseTransaction(raw as ViemHex);
  const to = String(tx.to).toLowerCase();
  if (to === VAULT) {
    const call = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: tx.data as ViemHex });
    return { tx, to, functionName: call.functionName, args: call.args as readonly unknown[] };
  }
  const call = decodeFunctionData({ abi: erc20Abi, data: tx.data as ViemHex });
  return { tx, to, functionName: call.functionName, args: call.args as readonly unknown[] };
}

describe('the faucet chain allowlist (SUB-7)', () => {
  it('is hard-coded to Base Sepolia until Chiado is deployed (M1-3j)', () => {
    expect(FAUCET_CHAIN_IDS).toEqual([84532]);
    expect(Object.isFrozen(FAUCET_CHAIN_IDS)).toBe(true);
    expect(isFaucetChain(84532)).toBe(true);
  });

  it('refuses every mainnet chain ID and Chiado (not deployed yet)', () => {
    for (const id of [1, 8453, 100, 42161, 10, 137, 10200, 11155111, 0, -1, 84532.5]) {
      expect(isFaucetChain(id)).toBe(false);
    }
    expect(isFaucetChain('84532')).toBe(false);
  });

  it('createFaucetChain refuses a config off the allowlist, even one that claims to be a testnet', () => {
    const chain = newChain();
    expect(() => faucet(chain, { ...config, chainId: 8453 })).toThrow(/faucet/);
    expect(() => faucet(chain, { ...config, chainId: 100, testnet: true })).toThrow(/faucet/);
    expect(() => faucet(chain, { ...config, testnet: false })).toThrow(/faucet/);
    expect(chain.methods).toEqual([]);
  });

  it('refuses a malformed key without echoing it', () => {
    const bad = `0x${'zz'.repeat(32)}`;
    let message = '';
    try {
      createFaucetChain(config, {
        fetchFn: mockFetch(newChain()) as unknown as typeof fetch,
        faucetKey: bad,
      });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('zz'.repeat(4));
  });
});

describe('buildDepositFor', () => {
  it('approves exactly the amount to the vault, then calls depositFor(agent, token, amount)', () => {
    const steps = buildDepositFor(config, { agent: AGENT, token: 'USDC', amount: ONE_USDC });
    expect(steps.map((s) => s.purpose)).toEqual(['approve', 'deposit']);
    const [approve, deposit] = steps;
    expect(String(approve?.to).toLowerCase()).toBe(USDC);
    const a = decodeFunctionData({ abi: erc20Abi, data: approve?.data as ViemHex });
    expect(a.functionName).toBe('approve');
    expect((a.args as readonly unknown[]).map(String)).toEqual([
      expect.stringMatching(new RegExp(VAULT, 'i')),
      String(ONE_USDC),
    ]);
    expect(String(deposit?.to).toLowerCase()).toBe(VAULT);
    const d = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: deposit?.data as ViemHex });
    expect(d.functionName).toBe('depositFor');
    const args = d.args as readonly unknown[];
    expect(String(args[0]).toLowerCase()).toBe(AGENT);
    expect(String(args[1]).toLowerCase()).toBe(USDC);
    expect(args[2]).toBe(ONE_USDC);
    expect(deposit?.value).toBe(0n);
  });

  it('refuses the zero address, a bad address and a bad amount', () => {
    const zero = `0x${'0'.repeat(40)}`;
    expect(() => buildDepositFor(config, { agent: zero, token: 'USDC', amount: 1n })).toThrow();
    expect(() => buildDepositFor(config, { agent: '0x1234', token: 'USDC', amount: 1n })).toThrow();
    expect(() => buildDepositFor(config, { agent: AGENT, token: 'USDC', amount: 0n })).toThrow();
  });
});

describe('createFaucetChain().credit', () => {
  it('with no allowance: approve at the pending nonce, then depositFor at the next one', async () => {
    const chain = newChain();
    const port = faucet(chain);
    expect(port.chainId).toBe(84532);
    expect(port.faucetAddress).toBe(FAUCET);
    const result = await port.credit(AGENT, 100);
    expect(result.state).toBe('sent');
    expect(chain.sent).toHaveLength(2);
    const [first, second] = chain.sent.map((s) => decodeSent(s.raw));
    expect(first?.functionName).toBe('approve');
    expect(first?.tx.nonce).toBe(7);
    expect(first?.args[1]).toBe(ONE_USDC);
    expect(second?.functionName).toBe('depositFor');
    expect(second?.tx.nonce).toBe(8);
    expect(String(second?.args[0]).toLowerCase()).toBe(AGENT);
    expect(second?.args[2]).toBe(ONE_USDC);
    expect(second?.tx.chainId).toBe(84532);
    if (result.state === 'sent') expect(result.txHash).toBe(chain.sent[1]?.hash);
  });

  it('with no allowance: the depositFor gas comes from its simulation once the approve is mined (M1-10b-b)', async () => {
    const chain = newChain({ estimate: 46_000n, depositEstimate: 71_000n });
    const result = await faucet(chain).credit(AGENT, 100);
    expect(result.state).toBe('sent');
    const [approve, deposit] = chain.sent.map((s) => decodeSent(s.raw));
    expect(approve?.tx.gas).toBe(46_000n + 25_000n);
    expect(deposit?.functionName).toBe('depositFor');
    // Simulated, not a fixed limit: the estimate plus the margin.
    expect(deposit?.tx.gas).toBe(71_000n + 25_000n);
    expect(deposit?.tx.gas).not.toBe(200_000n);
    expect(chain.depositEstimates).toBe(1);
    // The depositFor is simulated only after the approve's receipt, and signed after that.
    const sends = chain.methods.flatMap((m, i) => (m === 'eth_sendRawTransaction' ? [i] : []));
    const receipt = chain.methods.indexOf('eth_getTransactionReceipt');
    const lastEstimate = chain.methods.lastIndexOf('eth_estimateGas');
    expect(sends).toHaveLength(2);
    expect(receipt).toBeGreaterThan(sends[0] ?? Infinity);
    expect(lastEstimate).toBeGreaterThan(receipt);
    expect(sends[1]).toBeGreaterThan(lastEstimate);
  });

  it('with no allowance: an approve that is not mined in time sends no depositFor', async () => {
    const chain = newChain({ receipt: 'pending' });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'unavailable',
    });
    expect(chain.sent.map((s) => decodeSent(s.raw).functionName)).toEqual(['approve']);
  });

  it('with no allowance: a reverted approve sends no depositFor', async () => {
    const chain = newChain({ receipt: 'reverted' });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'unavailable',
    });
    expect(chain.sent.map((s) => decodeSent(s.raw).functionName)).toEqual(['approve']);
  });

  it('with no allowance: an approve whose answer was lost sends no depositFor', async () => {
    const chain = newChain({ failSend: 'network', failOn: 'approve' });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'unavailable',
    });
    expect(chain.attempted).toHaveLength(1);
  });

  it('with no allowance: a depositFor whose answer was lost is unknown, with its hash', async () => {
    const chain = newChain({ failSend: 'network', failOn: 'deposit' });
    const result = await faucet(chain).credit(AGENT, 100);
    expect(chain.attempted).toHaveLength(2);
    expect(result).toEqual({ state: 'unknown', txHash: keccak256(chain.attempted[1] as ViemHex) });
  });

  it('refuses receipt polling options out of bounds', () => {
    const base = {
      fetchFn: mockFetch(newChain()) as unknown as typeof fetch,
      faucetKey: FAUCET_KEY,
    };
    for (const bad of [0, -1, 1.5, 10_001]) {
      expect(() => createFaucetChain(config, { ...base, receiptPollMs: bad })).toThrow();
    }
    for (const bad of [0, 120_001, 2.5]) {
      expect(() => createFaucetChain(config, { ...base, receiptTimeoutMs: bad })).toThrow();
    }
  });

  it('with an allowance that covers the amount: one depositFor, gas = estimate + margin', async () => {
    const chain = newChain({ allowance: 5n * ONE_USDC });
    const result = await faucet(chain).credit(AGENT, 100);
    expect(result.state).toBe('sent');
    expect(chain.sent).toHaveLength(1);
    const only = decodeSent(chain.sent[0]?.raw as Hex);
    expect(only.functionName).toBe('depositFor');
    expect(only.tx.gas).toBe(71_000n + 25_000n);
  });

  it('converts US cents to token units by the token decimals', async () => {
    const chain = newChain({ allowance: 10n * ONE_USDC });
    await faucet(chain).credit(AGENT, 250);
    expect(decodeSent(chain.sent[0]?.raw as Hex).args[2]).toBe(2_500_000n);
  });

  it('sends nothing when the faucet holds too little of the token', async () => {
    const chain = newChain({ tokenBalance: ONE_USDC - 1n });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'faucet_empty',
    });
    expect(chain.sent).toEqual([]);
    expect(chain.methods).not.toContain('eth_sendRawTransaction');
  });

  it('sends nothing when the faucet key cannot pay the gas', async () => {
    const chain = newChain({ gasBalance: 1n });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({ state: 'not_sent', reason: 'no_gas' });
    expect(chain.sent).toEqual([]);
  });

  it('sends nothing when the simulation reverts', async () => {
    const chain = newChain({ revertEstimate: true });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'reverted',
    });
    expect(chain.sent).toEqual([]);
  });

  it('refuses an RPC that reports another chain ID, before signing', async () => {
    const chain = newChain({ chainId: 8453 });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'unavailable',
    });
    expect(chain.methods).not.toContain('eth_sendRawTransaction');
  });

  it('a node that refuses the transaction is not_sent; a lost answer is unknown', async () => {
    const refused = newChain({ allowance: ONE_USDC, failSend: 'answer' });
    expect(await faucet(refused).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'unavailable',
    });
    const lost = newChain({ allowance: ONE_USDC, failSend: 'network' });
    // The hash is computed locally from the signed bytes, so a retry can return it (M1-10b-b).
    expect(await faucet(lost).credit(AGENT, 100)).toEqual({
      state: 'unknown',
      txHash: keccak256(lost.attempted[0] as ViemHex),
    });
  });

  it('bounds the amount per claim and refuses a bad agent before any request', async () => {
    const chain = newChain();
    const port = faucet(chain);
    await expect(port.credit(AGENT, 0)).rejects.toThrow();
    await expect(port.credit(AGENT, FAUCET_MAX_USD_CENTS + 1)).rejects.toThrow();
    await expect(port.credit(AGENT, 1.5)).rejects.toThrow();
    await expect(port.credit(`0x${'0'.repeat(40)}` as Hex, 100)).rejects.toThrow();
    expect(chain.methods).toEqual([]);
    expect(FAUCET_MAX_USD_CENTS).toBeLessThanOrEqual(1_000);
  });
});

describe('createFaucetChain().credit robustness (M1-10b-c)', () => {
  it('with a stuck approve (pending nonce above latest), a claim that needs an approve is refused at once and sends nothing', async () => {
    const chain = newChain({ nonce: 7, pendingNonce: 8, allowance: 0n });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({ state: 'not_sent', reason: 'busy' });
    expect(chain.attempted).toEqual([]);
    expect(chain.methods).not.toContain('eth_sendRawTransaction');
    expect(chain.methods).not.toContain('eth_estimateGas');
  });

  it('reads both the latest and the pending nonce before an approve', async () => {
    const chain = newChain();
    const tags: unknown[] = [];
    const fetchFn = mockFetch(chain);
    const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (req.method === 'eth_getTransactionCount') tags.push(req.params[1]);
      return fetchFn(url, init);
    });
    Object.defineProperty(spy, ADDRESS_CHECKED, { value: true });
    const port = createFaucetChain(config, {
      fetchFn: spy as unknown as typeof fetch,
      faucetKey: FAUCET_KEY,
      rpcUrls: [RPC_URL],
      timeoutMs: 1000,
      receiptPollMs: 1,
      receiptTimeoutMs: 40,
    });
    expect((await port.credit(AGENT, 100)).state).toBe('sent');
    expect(tags).toContain('latest');
    expect(tags).toContain('pending');
  });

  it('once the stuck approve is mined (nonces equal again), the next claim goes through', async () => {
    const chain = newChain({ nonce: 7, pendingNonce: 8 });
    const port = faucet(chain);
    expect(await port.credit(AGENT, 100)).toEqual({ state: 'not_sent', reason: 'busy' });
    chain.nonce = 8;
    delete chain.pendingNonce;
    expect((await port.credit(AGENT, 100)).state).toBe('sent');
    expect(decodeSent(chain.sent[0]?.raw as Hex).tx.nonce).toBe(8);
  });

  it('caps the depositFor gas: at most FAUCET_MAX_GAS (300k)', () => {
    expect(FAUCET_MAX_GAS).toBe(300_000n);
  });

  it('a depositFor simulation above the cap is rejected and sends nothing (no clamping)', async () => {
    const chain = newChain({ allowance: ONE_USDC, depositEstimate: 300_000n - 25_000n + 1n });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'unavailable',
    });
    expect(chain.attempted).toEqual([]);
  });

  it('a depositFor simulation exactly at the cap is sent with the cap as its limit', async () => {
    const chain = newChain({ allowance: ONE_USDC, depositEstimate: 300_000n - 25_000n });
    expect((await faucet(chain).credit(AGENT, 100)).state).toBe('sent');
    expect(decodeSent(chain.sent[0]?.raw as Hex).tx.gas).toBe(300_000n);
  });

  it('a runaway depositFor simulation after the approve sends no depositFor', async () => {
    const chain = newChain({ depositEstimate: 10_000_000n });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'unavailable',
    });
    expect(chain.sent.map((s) => decodeSent(s.raw).functionName)).toEqual(['approve']);
  });

  it('an approve simulation above the cap is rejected and sends nothing', async () => {
    const chain = newChain({ estimate: 10_000_000n });
    expect(await faucet(chain).credit(AGENT, 100)).toEqual({
      state: 'not_sent',
      reason: 'unavailable',
    });
    expect(chain.attempted).toEqual([]);
  });
});
