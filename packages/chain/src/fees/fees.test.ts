// M1-4b: fee quotes in USD, credits across chains, the direct-mode deposit helper and the credit
// event filter (07 §6.2; 12 §4, §5; 06 §2.1 `credits` and `prices`; D-46; IR-M1-3b-1 I-2). No
// network: every read goes through an injected, branded fetch that plays the fee vault.
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  type AbiEvent,
  type Hex,
} from 'viem';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { BASE_SEPOLIA, GNOSIS_CHIADO } from '../config/index.js';
import type { ChainConfig, ChainNetwork, FeeToken } from '../config/index.js';
import { loadOccV2Contracts, type OccV2Contracts } from '../occ-v2.js';
import { composeChainConfig } from '../clients/registry.js';
import {
  ChainError,
  FEE_VAULT_CLIENT_ABI,
  createReadClient,
  getChainConfig,
} from '../clients/index.js';
import { ChainInputError } from '../ids/index.js';
import {
  FEE_TYPE_IDS,
  MAX_LOG_BLOCK_SPAN,
  buildDeposit,
  filterCreditEvents,
  quoteFee,
  readCreditHistory,
  readCredits,
  readCreditsAcrossChains,
  tokenUnitsToUsd,
  type RawLog,
} from './index.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO_APP = `0x${'0'.repeat(64)}` as Hex;
const APP = `0x${'ab'.repeat(32)}` as Hex;
const PAYER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TREASURY = '0x3333333333333333333333333333333333333333';
const USDC = BASE_SEPOLIA.feeTokens[0]?.address as Hex;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function base(): ChainConfig {
  return getChainConfig(84532) as ChainConfig;
}

/** Chiado is not deployed yet (M1-3j): the same CREATE3 addresses, native xDAI as the fee token. */
function chiado(): ChainConfig {
  const b = loadOccV2Contracts(84532) as OccV2Contracts;
  const contracts: OccV2Contracts = {
    ...b,
    chainId: 10200,
    feeTokens: [{ address: ZERO, decimals: 18, eip3009: false, native: true, symbol: 'NATIVE' }],
    depositWithAuthorization: false,
  };
  return composeChainConfig(clone(GNOSIS_CHIADO) as ChainNetwork, contracts);
}

// --- a fake fee vault behind a branded fetch ------------------------------------------------------

const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');

type FetchInput = string | URL | Request;
type RpcCall = { method: string; params: unknown[]; to?: string; fn?: string; args?: unknown[] };

interface FakeVault {
  /** Protocol fee per [feeType][token] in base units. */
  protocolFee?: (feeType: number, token: string) => bigint;
  /** Integrator fee per app; the vault caps it at multiple × protocol fee (12 §5). */
  integratorFee?: (appId: string, feeType: number, token: string) => bigint;
  multiple?: bigint;
  /** Overrides the computed quote (a lying RPC). */
  quote?: (feeType: number, token: string, appId: string) => readonly [bigint, bigint, bigint];
  credits?: (payer: string, token: string) => bigint;
  logs?: () => unknown[];
  fail?: boolean;
}

function vaultFetch(config: ChainConfig, vault: FakeVault) {
  const calls: RpcCall[] = [];
  const impl = async (_url: FetchInput, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const answer = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (vault.fail === true) return new Response('down', { status: 500 });
    if (body.method === 'eth_chainId') return answer(`0x${config.chainId.toString(16)}`);
    if (body.method === 'eth_getLogs') {
      calls.push({ method: body.method, params: body.params });
      return answer(vault.logs?.() ?? []);
    }
    if (body.method !== 'eth_call') throw new Error(`unexpected ${body.method}`);
    const tx = body.params[0] as { to: string; data: Hex };
    const { functionName, args } = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: tx.data });
    calls.push({
      method: body.method,
      params: body.params,
      to: tx.to,
      fn: functionName,
      args: [...(args ?? [])],
    });
    const a = (args ?? []) as unknown[];
    let result: unknown;
    if (functionName === 'quote') {
      const [t, token, appId] = a as [number, string, string];
      if (vault.quote) result = vault.quote(t, token, appId);
      else {
        const p = vault.protocolFee?.(t, token) ?? 0n;
        const fee = BigInt(appId) === 0n ? 0n : (vault.integratorFee?.(appId, t, token) ?? 0n);
        const cap = (vault.multiple ?? 4n) * p;
        const i = fee < cap ? fee : cap;
        result = [p, i, p + i];
      }
    } else if (functionName === 'creditsOf') {
      const [payer, token] = a as [string, string];
      result = vault.credits?.(payer, token) ?? 0n;
    } else {
      throw new Error(`unexpected ${functionName}`);
    }
    return answer(
      encodeFunctionResult({
        abi: FEE_VAULT_CLIENT_ABI,
        functionName,
        result,
      } as Parameters<typeof encodeFunctionResult>[0]),
    );
  };
  const fetchFn = vi.fn(impl) as Mock<typeof impl>;
  Object.defineProperty(fetchFn, ADDRESS_CHECKED, { value: true });
  return { fetchFn, calls };
}

function clientFor(config: ChainConfig, vault: FakeVault) {
  const { fetchFn, calls } = vaultFetch(config, vault);
  return { client: createReadClient(config, { fetchFn, retryCount: 0 }), fetchFn, calls };
}

const NOTARIZE_FEES = (decimals: number) => (t: number) =>
  t === FEE_TYPE_IDS.NOTARIZE
    ? 100_000n * 10n ** BigInt(decimals - 6)
    : t === FEE_TYPE_IDS.REGISTER
      ? 5_000_000n * 10n ** BigInt(decimals - 6)
      : 0n;

// --- quotes --------------------------------------------------------------------------------------

describe('quoteFee: the contract quote, shown in USD, parts separate (07 §6.2, 12 §5)', () => {
  it('maps fee types to the 05 §2.2 enum', () => {
    expect(FEE_TYPE_IDS).toEqual({ NOTARIZE: 0, REGISTER: 1 });
  });

  it('quotes a proof in USDC on Base Sepolia for the official app (no integrator part)', async () => {
    const { client, calls } = clientFor(base(), { protocolFee: NOTARIZE_FEES(6) });
    const q = await quoteFee(client, base(), { feeType: 'NOTARIZE', token: 'USDC' });
    expect(q).toEqual({
      chainId: 84532,
      feeType: 'NOTARIZE',
      token: 'USDC',
      tokenAddress: USDC,
      appId: ZERO_APP,
      protocolPart: 100_000n,
      integratorPart: 0n,
      total: 100_000n,
      protocolUsd: '0.1',
      integratorUsd: '0',
      usd: '0.1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('quote');
    expect(calls[0]?.to?.toLowerCase()).toBe(base().contracts.vault);
    expect(calls[0]?.args).toEqual([
      0,
      expect.stringMatching(/^0x036cbd53842c5426634e7929541ec2318f3dcf7e$/i),
      ZERO_APP,
    ]);
  });

  it("equals the contract's quote including the integrator cap, parts in USD", async () => {
    const vault: FakeVault = {
      protocolFee: NOTARIZE_FEES(6),
      integratorFee: () => 50_000_000n, // asks $50, the vault caps it at 4 × $5
    };
    const { client } = clientFor(base(), vault);
    const q = await quoteFee(client, base(), { feeType: 'REGISTER', token: 'USDC', appId: APP });
    expect([q.protocolPart, q.integratorPart, q.total]).toEqual([
      5_000_000n,
      20_000_000n,
      25_000_000n,
    ]);
    expect([q.protocolUsd, q.integratorUsd, q.usd]).toEqual(['5', '20', '25']);
    expect(q.appId).toBe(APP);
    const small = await quoteFee(
      clientFor(base(), { ...vault, integratorFee: () => 30_000n }).client,
      base(),
      {
        feeType: 'NOTARIZE',
        token: 'USDC',
        appId: APP,
      },
    );
    expect([small.protocolUsd, small.integratorUsd, small.usd]).toEqual(['0.1', '0.03', '0.13']);
  });

  it('quotes native xDAI on Chiado at 1:1 with 18 decimals (address(0) in the vault)', async () => {
    const { client, calls } = clientFor(chiado(), { protocolFee: NOTARIZE_FEES(18) });
    const q = await quoteFee(client, chiado(), { feeType: 'NOTARIZE', token: 'NATIVE' });
    expect(q.tokenAddress).toBeNull();
    expect(q.total).toBe(10n ** 17n);
    expect(q.usd).toBe('0.1');
    expect(calls[0]?.args?.[1]).toBe(ZERO);
  });

  it('never prices a token outside the configured stablecoin allowlist (D-46)', async () => {
    const { client, fetchFn } = clientFor(base(), { protocolFee: NOTARIZE_FEES(6) });
    const offered = expect.objectContaining({ code: 'fee_token_not_offered' });
    // USDT and NATIVE are not offered on Base Sepolia.
    await expect(quoteFee(client, base(), { feeType: 'NOTARIZE', token: 'USDT' })).rejects.toThrow(
      offered,
    );
    await expect(
      quoteFee(client, base(), { feeType: 'NOTARIZE', token: 'NATIVE' }),
    ).rejects.toThrow(offered);
    // A hand-made config that slips in a volatile token or a native coin off Gnosis is refused too.
    const weth: FeeToken = {
      symbol: 'WETH' as FeeToken['symbol'],
      address: '0x4200000000000000000000000000000000000006',
      decimals: 18,
      source: { url: 'https://example.org/weth', verifiedOn: '2026-10-19' },
    };
    const native: FeeToken = { ...weth, symbol: 'NATIVE', address: null };
    for (const extra of [weth, native]) {
      const bad = { ...base(), feeTokens: [...base().feeTokens, extra] } as ChainConfig;
      await expect(
        quoteFee(client, bad, { feeType: 'NOTARIZE', token: extra.symbol }),
      ).rejects.toThrow(offered);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses unconfigured fee types and malformed app IDs before any request', async () => {
    const { client, fetchFn } = clientFor(base(), {});
    await expect(
      quoteFee(client, base(), { feeType: 'ANCHOR' as 'NOTARIZE', token: 'USDC' }),
    ).rejects.toBeInstanceOf(ChainInputError);
    for (const appId of ['0x00', `0x${'g'.repeat(64)}`, 'ab'.repeat(32)]) {
      await expect(
        quoteFee(client, base(), { feeType: 'NOTARIZE', token: 'USDC', appId: appId as Hex }),
      ).rejects.toThrow(expect.objectContaining({ code: 'invalid_app_id' }));
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails closed on an answer that does not add up', async () => {
    const lying: [string, readonly [bigint, bigint, bigint], Hex][] = [
      ['total is not the sum', [100_000n, 0n, 90_000n], ZERO_APP],
      ['an integrator part for the official app', [100_000n, 1n, 100_001n], ZERO_APP],
      ['an integrator part above the 10× contract bound', [100_000n, 1_000_001n, 1_100_001n], APP],
    ];
    for (const [, answer, appId] of lying) {
      const { client } = clientFor(base(), { quote: () => answer });
      const error = await quoteFee(client, base(), {
        feeType: 'NOTARIZE',
        token: 'USDC',
        appId,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChainError);
      expect((error as ChainError).code).toBe('bad_answer');
    }
  });

  it('a failing RPC gives a URL-free ChainError', async () => {
    const { client } = clientFor(base(), { fail: true });
    const error = await quoteFee(client, base(), { feeType: 'NOTARIZE', token: 'USDC' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChainError);
  });
});

describe('tokenUnitsToUsd: 1:1 for USD stablecoins (D-46)', () => {
  it('converts exactly, rounding as asked, and refuses what cannot be shown', () => {
    expect(tokenUnitsToUsd(1_234_567n, 6, 'down')).toBe('1.234567');
    expect(tokenUnitsToUsd(10n ** 17n, 18, 'down')).toBe('0.1');
    expect(tokenUnitsToUsd(10n ** 17n + 1n, 18, 'down')).toBe('0.1');
    expect(tokenUnitsToUsd(10n ** 17n + 1n, 18, 'up')).toBe('0.100001');
    expect(tokenUnitsToUsd(0n, 18, 'up')).toBe('0');
    expect(tokenUnitsToUsd(10n ** 15n * 10n ** 6n, 6, 'down')).toBeNull(); // above 999 999 999.999999
    expect(() => tokenUnitsToUsd(-1n, 6, 'down')).toThrow(RangeError);
    expect(() => tokenUnitsToUsd(1n, 5, 'down')).toThrow(RangeError);
  });
});

// --- credits ---------------------------------------------------------------------------------------

describe('readCredits: creditsOf on every supported chain (06 §2.1 credits)', () => {
  it('reads the payer credits per fee token, with USD rounded down', async () => {
    const { client, calls } = clientFor(base(), { credits: () => 12_345_678n });
    expect(await readCredits(client, base(), PAYER)).toEqual([
      {
        chainId: 84532,
        chain: 'base-sepolia',
        token: 'USDC',
        amount: 12_345_678n,
        usd: '12.345678',
      },
    ]);
    expect(calls[0]?.fn).toBe('creditsOf');
    expect(calls[0]?.to?.toLowerCase()).toBe(base().contracts.vault);
    expect(String(calls[0]?.args?.[0]).toLowerCase()).toBe(PAYER);
  });

  it('reads every chain in parallel; a chain that fails is listed, not fatal', async () => {
    const b = clientFor(base(), { credits: () => 5_000_000n });
    const c = clientFor(chiado(), { credits: () => 25n * 10n ** 17n + 1n });
    const both = await readCreditsAcrossChains(
      [
        { config: base(), client: b.client },
        { config: chiado(), client: c.client },
      ],
      PAYER,
    );
    expect(both).toEqual({
      credits: [
        { chainId: 84532, chain: 'base-sepolia', token: 'USDC', amount: 5_000_000n, usd: '5' },
        {
          chainId: 10200,
          chain: 'gnosis-chiado',
          token: 'NATIVE',
          amount: 25n * 10n ** 17n + 1n,
          usd: '2.5',
        },
      ],
      unavailable: [],
    });
    expect(c.calls[0]?.args?.[1]).toBe(ZERO);
    const down = clientFor(chiado(), { fail: true });
    expect(
      await readCreditsAcrossChains(
        [
          { config: base(), client: b.client },
          { config: chiado(), client: down.client },
        ],
        PAYER,
      ),
    ).toEqual({
      credits: [
        { chainId: 84532, chain: 'base-sepolia', token: 'USDC', amount: 5_000_000n, usd: '5' },
      ],
      unavailable: [10200],
    });
  });

  it('shows no USD for a balance above the USD range, and refuses a bad payer', async () => {
    const { client, fetchFn } = clientFor(base(), { credits: () => 10n ** 30n });
    expect((await readCredits(client, base(), PAYER))[0]?.usd).toBeNull();
    fetchFn.mockClear();
    await expect(readCredits(client, base(), '0x1234' as Hex)).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_address' }),
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// --- deposit (direct mode) -------------------------------------------------------------------------

describe('buildDeposit: direct-mode deposit steps, never sent here (12 §4.1)', () => {
  it('USDC: an exact-amount approve, then deposit, both from the payer', () => {
    const steps = buildDeposit(base(), { token: 'USDC', amount: 5_000_000n });
    expect(steps.map((s) => s.purpose)).toEqual(['approve', 'deposit']);
    const [approve, deposit] = steps;
    expect(approve?.to).toBe(USDC);
    expect(approve?.value).toBe(0n);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve?.data as Hex })).toEqual({
      functionName: 'approve',
      args: [expect.stringMatching(new RegExp(`^${base().contracts.vault}$`, 'i')), 5_000_000n],
    });
    expect(deposit?.to).toBe(base().contracts.vault);
    expect(deposit?.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: deposit?.data as Hex });
    expect(decoded.functionName).toBe('deposit');
    expect(decoded.args?.[1]).toBe(5_000_000n);
    expect(String(decoded.args?.[0]).toLowerCase()).toBe(USDC);
  });

  it('native xDAI on Chiado: one deposit of address(0) carrying the value', () => {
    const steps = buildDeposit(chiado(), { token: 'NATIVE', amount: 10n ** 18n });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.purpose).toBe('deposit');
    expect(steps[0]?.value).toBe(10n ** 18n);
    const decoded = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: steps[0]?.data as Hex });
    expect(decoded.functionName).toBe('deposit');
    expect(decoded.args).toEqual([ZERO, 10n ** 18n]);
  });

  it('refuses a zero, negative or oversize amount and a token that is not offered', () => {
    for (const amount of [0n, -1n, 2n ** 256n]) {
      expect(() => buildDeposit(base(), { token: 'USDC', amount })).toThrow(
        expect.objectContaining({ code: 'invalid_amount' }),
      );
    }
    expect(() => buildDeposit(base(), { token: 'USDC', amount: 5 as unknown as bigint })).toThrow(
      expect.objectContaining({ code: 'invalid_amount' }),
    );
    expect(() => buildDeposit(base(), { token: 'NATIVE', amount: 1n })).toThrow(
      expect.objectContaining({ code: 'fee_token_not_offered' }),
    );
  });
});

// --- credit events (IR-M1-3b-1 I-2) ----------------------------------------------------------------

function eventOf(name: string): AbiEvent {
  const e = FEE_VAULT_CLIENT_ABI.find((x) => x.type === 'event' && x.name === name);
  if (!e) throw new Error(`no event ${name}`);
  return e as AbiEvent;
}

let logIndex = 0;
function logOf(
  name: string,
  args: Record<string, unknown>,
  over: Partial<RawLog> & { blockNumber?: bigint } = {},
): RawLog {
  const event = eventOf(name);
  const indexed = Object.fromEntries(
    event.inputs.filter((i) => i.indexed === true).map((i) => [i.name, args[i.name as string]]),
  );
  const plain = event.inputs.filter((i) => i.indexed !== true);
  const topics = encodeEventTopics({
    abi: [event],
    eventName: name,
    args: indexed,
  } as Parameters<typeof encodeEventTopics>[0]) as [Hex, ...Hex[]];
  const data = encodeAbiParameters(
    plain,
    plain.map((i) => args[i.name as string]),
  );
  return {
    address: base().contracts.vault,
    topics,
    data,
    blockNumber: 100n,
    logIndex: logIndex++,
    transactionHash: `0x${'cd'.repeat(32)}`,
    removed: false,
    ...over,
  };
}

const deposited = (amount: bigint, over: Partial<RawLog> = {}) =>
  logOf('Deposited', { payer: PAYER, token: USDC, amount, from: PAYER }, over);

describe('filterCreditEvents: zero amounts and foreign addresses are ignored', () => {
  it('keeps real events from the canonical vault and drops the rest', () => {
    const keep = [
      deposited(5_000_000n, { blockNumber: 101n }),
      logOf(
        'Withdrawn',
        { payer: PAYER, token: USDC, amount: 1_000_000n, to: PAYER },
        { blockNumber: 102n },
      ),
      logOf(
        'Charged',
        {
          payer: PAYER,
          feeType: 0,
          appId: ZERO_APP,
          token: USDC,
          protocolPart: 100_000n,
          integratorPart: 0n,
        },
        { blockNumber: 103n },
      ),
      logOf('Swept', { token: USDC, amount: 7n, treasury: TREASURY }, { blockNumber: 104n }),
    ];
    const drop = [
      deposited(0n), // zero-amount deposit (anyone can emit one)
      logOf('Swept', { token: USDC, amount: 0n, treasury: TREASURY }),
      logOf('IntegratorWithdrawn', { appId: APP, token: USDC, to: OTHER, amount: 0n }),
      deposited(5_000_000n, { address: OTHER }), // not the canonical vault
      deposited(5_000_000n, { removed: true }), // reorged out
      deposited(5_000_000n, { blockNumber: null }), // pending
      logOf('Deposited', { payer: PAYER, token: OTHER, amount: 9n, from: PAYER }), // not a fee token
      { ...deposited(5_000_000n), data: '0x1234' as Hex }, // malformed
      logOf('Paused', { account: OTHER }), // not a credit event
    ];
    const out = filterCreditEvents(base(), [...drop, ...keep].reverse());
    expect(out.map((e) => e.eventName)).toEqual(['Deposited', 'Withdrawn', 'Charged', 'Swept']);
    expect(out[0]).toMatchObject({
      token: 'USDC',
      blockNumber: 101n,
      args: { amount: 5_000_000n },
    });
  });
});

describe('readCreditHistory: payer events from the canonical vault, bounded range', () => {
  it('asks the vault address only, then filters what the RPC returns', async () => {
    const rpcLog = (log: RawLog) => ({
      ...log,
      blockNumber: log.blockNumber === null ? null : `0x${log.blockNumber.toString(16)}`,
      logIndex: log.logIndex === null ? null : `0x${log.logIndex.toString(16)}`,
      blockHash: `0x${'ef'.repeat(32)}`,
      transactionIndex: '0x0',
    });
    const logs = [
      deposited(0n),
      deposited(3_000_000n, { blockNumber: 150n }),
      deposited(1n, { address: OTHER }),
    ];
    const { client, calls } = clientFor(base(), { logs: () => logs.map(rpcLog) });
    const history = await readCreditHistory(client, base(), {
      payer: PAYER,
      fromBlock: 100n,
      toBlock: 200n,
    });
    expect(history.map((e) => [e.eventName, e.args.amount])).toEqual([['Deposited', 3_000_000n]]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.method).toBe('eth_getLogs');
      const filter = call.params[0] as { address: string; fromBlock: string; toBlock: string };
      expect(filter.address.toLowerCase()).toBe(base().contracts.vault);
      expect([filter.fromBlock, filter.toBlock]).toEqual(['0x64', '0xc8']);
    }
  });

  it('refuses a reversed or oversize range and a bad payer before any request', async () => {
    const { client, fetchFn } = clientFor(base(), {});
    const bad = [
      { payer: PAYER, fromBlock: 200n, toBlock: 100n },
      { payer: PAYER, fromBlock: 0n, toBlock: MAX_LOG_BLOCK_SPAN + 1n },
      { payer: PAYER, fromBlock: -1n, toBlock: 10n },
    ];
    for (const range of bad) {
      await expect(readCreditHistory(client, base(), range)).rejects.toThrow(
        expect.objectContaining({ code: 'invalid_block_range' }),
      );
    }
    await expect(
      readCreditHistory(client, base(), { payer: '0x12' as Hex, fromBlock: 0n, toBlock: 1n }),
    ).rejects.toThrow(expect.objectContaining({ code: 'invalid_address' }));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
