// M1-26: zero-config chain selection (07 §6.3, D-40, 02 F-51; 06 §2.1, §2.4; 12 §4). Table-driven
// over detected funding, plus detection through a mocked RPC (an injected, branded fetch that plays
// the fee vault and the stablecoin). No network.
import { decodeFunctionData, encodeFunctionResult, erc20Abi, type Hex } from 'viem';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { GNOSIS_CHIADO } from '../config/index.js';
import type { ChainConfig, ChainNetwork, FeeTokenSymbol } from '../config/index.js';
import { loadOccV2Contracts, type OccV2Contracts } from '../occ-v2.js';
import { composeChainConfig } from '../clients/registry.js';
import { FEE_VAULT_CLIENT_ABI, createReadClient, getChainConfig } from '../clients/index.js';
import { ChainConfigError } from '../config/index.js';
import { ChainInputError } from '../ids/index.js';
import type { FeeQuote } from '../fees/index.js';
import {
  DEFAULT_DETECT_BUDGET_MS,
  DEFAULT_DETECT_CACHE_MS,
  createChainSelector,
  detectFunding,
  pickChain,
  selectPayingChain,
  type ChainFunding,
  type ChainSelection,
  type FundingDetection,
} from './index.js';

/** A 20-byte value of one repeated byte (scanner-safe test addresses). */
const filled = (byte: string): Hex => `0x${byte.repeat(20)}`;
const ZERO = filled('00');
const PAYER = filled('11');
const PAYER_MIXED = `0x${'aB'.repeat(20)}` as Hex;

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

/** A third hypothetical testnet, to exercise "two others funded". */
function third(): ChainConfig {
  return { ...base(), key: 'third-testnet', chainId: 11155420 };
}

/** Base Sepolia once the vault accepts the gasless top-up (M1-3c): USDC eip3009. */
function baseTopUp(): ChainConfig {
  const b = base();
  return { ...b, feeTokens: b.feeTokens.map((t) => ({ ...t, eip3009: true })) };
}

/** A mainnet entry: never queried, never picked, never a top-up target. */
function mainnet(): ChainConfig {
  return { ...base(), key: 'base', chainId: 8453, testnet: false };
}

/** A config that claims to be a testnet but carries a known mainnet chain ID. */
function lyingMainnet(): ChainConfig {
  return { ...base(), key: 'not-a-testnet', chainId: 8453, testnet: true };
}

// --- table-driven selection over detected funding ----------------------------------------------

function quoteOf(config: ChainConfig, token: FeeTokenSymbol, micros: bigint): FeeQuote {
  const t = config.feeTokens.find((x) => x.symbol === token);
  if (!t) throw new Error('no such token');
  const total = micros * 10n ** BigInt(t.decimals - 6);
  const usd = (Number(micros) / 1e6).toString();
  return Object.freeze({
    chainId: config.chainId,
    feeType: 'NOTARIZE',
    token,
    tokenAddress: t.address,
    appId: `0x${'0'.repeat(64)}` as Hex,
    protocolPart: total,
    integratorPart: 0n,
    total,
    protocolUsd: usd,
    integratorUsd: '0',
    usd,
  });
}

interface Row {
  config: ChainConfig;
  token?: FeeTokenSymbol;
  /** The fee in micro-dollars. */
  fee: bigint;
  /** Credits in micro-dollars. */
  credits?: bigint;
  /** Stablecoin balance in micro-dollars; counted only where the gasless top-up exists. */
  balance?: bigint;
}

function scale(config: ChainConfig, token: FeeTokenSymbol, micros: bigint): bigint {
  const t = config.feeTokens.find((x) => x.symbol === token);
  return micros * 10n ** BigInt((t?.decimals ?? 6) - 6);
}

function funding(rows: Row[], unavailable: number[] = []): FundingDetection {
  const chains: ChainFunding[] = rows.map((r) => {
    const token = r.token ?? (r.config.feeTokens[0]?.symbol as FeeTokenSymbol);
    return {
      config: r.config,
      options: [
        {
          quote: quoteOf(r.config, token, r.fee),
          credits: scale(r.config, token, r.credits ?? 0n),
          topUpBalance: r.balance === undefined ? null : scale(r.config, token, r.balance),
        },
      ],
    };
  });
  return { payer: PAYER, chains, unavailable };
}

const CENT = 10_000n;

describe('pickChain: the 07 §6.3 order, no user choice (D-40)', () => {
  const cases: {
    name: string;
    rows: () => Row[];
    defaultChain?: string;
    unavailable?: number[];
    want: { status: ChainSelection['status']; chainId?: number; reason?: string; payFrom?: string };
  }[] = [
    {
      name: 'default chain funded: picked even when another funded chain is cheaper',
      rows: () => [
        { config: base(), fee: 10n * CENT, credits: 100n * CENT },
        { config: chiado(), fee: 1n * CENT, credits: 100n * CENT },
      ],
      defaultChain: 'base-sepolia',
      want: { status: 'ok', chainId: 84532, reason: 'default', payFrom: 'credits' },
    },
    {
      name: 'default chain empty, two others funded: the cheaper wins',
      rows: () => [
        { config: base(), fee: 1n * CENT },
        { config: chiado(), fee: 5n * CENT, credits: 100n * CENT },
        { config: third(), fee: 3n * CENT, credits: 100n * CENT },
      ],
      defaultChain: 'base-sepolia',
      want: { status: 'ok', chainId: 11155420, reason: 'cheapest', payFrom: 'credits' },
    },
    {
      name: 'credits below the quote do not count as funded',
      rows: () => [
        { config: base(), fee: 10n * CENT, credits: 10n * CENT - 1n },
        { config: chiado(), fee: 20n * CENT, credits: 20n * CENT },
      ],
      defaultChain: 'base-sepolia',
      want: { status: 'ok', chainId: 10200, reason: 'cheapest', payFrom: 'credits' },
    },
    {
      name: 'stablecoin balance only, gasless top-up available: funded through a top-up',
      rows: () => [{ config: baseTopUp(), fee: 10n * CENT, balance: 50n * CENT }],
      want: { status: 'ok', chainId: 84532, reason: 'cheapest', payFrom: 'top_up' },
    },
    {
      name: 'credits beat a top-up at the same fee',
      rows: () => [
        { config: baseTopUp(), fee: 10n * CENT, balance: 50n * CENT },
        { config: third(), fee: 10n * CENT, credits: 50n * CENT },
      ],
      want: { status: 'ok', chainId: 11155420, reason: 'cheapest', payFrom: 'credits' },
    },
    {
      name: 'stablecoin balance only, no gasless top-up yet: not funded',
      rows: () => [{ config: base(), fee: 10n * CENT, balance: 50n * CENT }],
      want: { status: 'needs_credits', chainId: 84532 },
    },
    {
      name: 'nothing funded: needs_credits routed to the cheapest supported chain',
      rows: () => [
        { config: base(), fee: 10n * CENT },
        { config: chiado(), fee: 2n * CENT },
        { config: third(), fee: 5n * CENT },
      ],
      defaultChain: 'base-sepolia',
      want: { status: 'needs_credits', chainId: 10200 },
    },
    {
      name: 'single supported chain (Base Sepolia today), funded',
      rows: () => [{ config: base(), fee: 10n * CENT, credits: 10n * CENT }],
      want: { status: 'ok', chainId: 84532, reason: 'cheapest', payFrom: 'credits' },
    },
    {
      name: 'single supported chain (Base Sepolia today), empty',
      rows: () => [{ config: base(), fee: 10n * CENT }],
      want: { status: 'needs_credits', chainId: 84532 },
    },
    {
      name: 'an unknown default chain key is ignored, not an error',
      rows: () => [{ config: base(), fee: 10n * CENT, credits: 10n * CENT }],
      defaultChain: 'nowhere',
      want: { status: 'ok', chainId: 84532, reason: 'cheapest' },
    },
    {
      name: 'no chain answered: unavailable, never needs_credits',
      rows: () => [],
      unavailable: [84532, 10200],
      want: { status: 'unavailable' },
    },
  ];

  it.each(cases)('$name', ({ rows, defaultChain, unavailable, want }) => {
    const got = pickChain(funding(rows(), unavailable), defaultChain ? { defaultChain } : {});
    expect(got.status).toBe(want.status);
    if (got.status === 'ok') {
      expect(got.chainId).toBe(want.chainId);
      expect(got.reason).toBe(want.reason);
      if (want.payFrom) expect(got.payFrom).toBe(want.payFrom);
      expect(got.quote.chainId).toBe(got.chainId);
    }
    if (got.status === 'needs_credits') {
      expect(got.topUp.chainId).toBe(want.chainId);
      expect(got.topUp.agentAddress).toBe(PAYER);
    }
    expect(got.unavailable).toEqual([...(unavailable ?? [])].sort((a, b) => a - b));
  });

  it('needs_credits carries the top-up routing: chain, token, $ amount, agent address', () => {
    const got = pickChain(
      funding([
        { config: base(), fee: 10n * CENT, credits: 3n * CENT },
        { config: chiado(), fee: 25n * CENT },
      ]),
    );
    expect(got).toEqual({
      status: 'needs_credits',
      topUp: {
        chainId: 84532,
        chain: 'base-sepolia',
        token: 'USDC',
        usd: '0.1',
        agentAddress: PAYER,
      },
      unavailable: [],
    });
  });

  it('the override (Advanced or tool chain?) forces a supported chain', () => {
    const rows = [
      { config: base(), fee: 10n * CENT, credits: 100n * CENT },
      { config: chiado(), fee: 1n * CENT, credits: 100n * CENT },
    ];
    const got = pickChain(funding(rows), { chainId: 84532 });
    expect(got).toMatchObject({ status: 'ok', chainId: 84532, reason: 'override' });
  });

  it('an unfunded override routes the top-up to that chain, not elsewhere', () => {
    const rows = [
      { config: base(), fee: 10n * CENT },
      { config: chiado(), fee: 1n * CENT, credits: 100n * CENT },
    ];
    const got = pickChain(funding(rows), { chainId: 84532 });
    expect(got).toMatchObject({ status: 'needs_credits', topUp: { chainId: 84532 } });
  });

  it('an override for an unavailable chain is unavailable, never a silent switch', () => {
    const got = pickChain(funding([{ config: chiado(), fee: CENT, credits: CENT }], [84532]), {
      chainId: 84532,
    });
    expect(got).toEqual({ status: 'unavailable', unavailable: [84532] });
  });

  it('an override for an unsupported chain is refused with a fixed code', () => {
    const run = () =>
      pickChain(funding([{ config: base(), fee: CENT, credits: CENT }]), {
        chainId: 1,
      });
    expect(run).toThrow(ChainConfigError);
    try {
      run();
    } catch (e) {
      expect((e as ChainConfigError).code).toBe('unsupported_chain');
    }
  });
});

describe('pickChain: never a mainnet (launch is testnet only)', () => {
  it('a funded, cheapest mainnet entry is never picked', () => {
    const got = pickChain(
      funding([
        { config: mainnet(), fee: 1n, credits: 100n * CENT },
        { config: base(), fee: 10n * CENT, credits: 100n * CENT },
      ]),
      { defaultChain: 'base' },
    );
    expect(got).toMatchObject({ status: 'ok', chainId: 84532 });
  });

  it('a known mainnet chain ID is never picked even when flagged as a testnet', () => {
    const got = pickChain(funding([{ config: lyingMainnet(), fee: 1n, credits: 100n * CENT }]));
    expect(got.status).toBe('unavailable');
  });

  it('needs_credits never routes a top-up to a mainnet', () => {
    const got = pickChain(
      funding([
        { config: mainnet(), fee: 1n },
        { config: base(), fee: 10n * CENT },
      ]),
    );
    expect(got).toMatchObject({ status: 'needs_credits', topUp: { chainId: 84532 } });
  });

  it('an override naming a mainnet is refused', () => {
    expect(() =>
      pickChain(funding([{ config: mainnet(), fee: 1n, credits: CENT }]), { chainId: 8453 }),
    ).toThrow(ChainConfigError);
  });
});

describe('pickChain: stable tie-breaks', () => {
  function permutations<T>(xs: T[]): T[][] {
    if (xs.length <= 1) return [xs];
    return xs.flatMap((x, i) =>
      permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]),
    );
  }

  it('equal fees: the lower chain ID wins, whatever the input order', () => {
    const rows = [
      { config: third(), fee: 5n * CENT, credits: CENT * 100n },
      { config: chiado(), fee: 5n * CENT, credits: CENT * 100n },
      { config: base(), fee: 5n * CENT, credits: CENT * 100n },
    ];
    for (const order of permutations(rows)) {
      expect(pickChain(funding(order))).toMatchObject({ status: 'ok', chainId: 10200 });
    }
  });

  it('equal fees with nothing funded: the top-up target is stable too', () => {
    const rows = [
      { config: third(), fee: 5n * CENT },
      { config: base(), fee: 5n * CENT },
    ];
    for (const order of permutations(rows)) {
      expect(pickChain(funding(order))).toMatchObject({ topUp: { chainId: 84532 } });
    }
  });

  it('the same input always gives the same result', () => {
    const d = funding([
      { config: base(), fee: 7n * CENT, credits: CENT * 100n },
      { config: chiado(), fee: 7n * CENT, credits: CENT * 100n },
    ]);
    const first = pickChain(d);
    for (let i = 0; i < 5; i++) expect(pickChain(d)).toEqual(first);
  });
});

describe('results carry no jargon and no free text (11 §5)', () => {
  const JARGON = /wallet|\bgas\b|seed|transaction|private key/i;
  const json = (v: unknown) =>
    JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

  it.each([
    ['ok', funding([{ config: base(), fee: CENT, credits: CENT }])],
    ['needs_credits', funding([{ config: base(), fee: CENT }])],
    ['unavailable', funding([], [84532])],
  ])('%s', (_name, d) => {
    const got = pickChain(d);
    expect(json(got)).not.toMatch(JARGON);
    expect(got).not.toHaveProperty('message');
    expect(got).not.toHaveProperty('error');
  });
});

// --- detection through a mocked RPC -------------------------------------------------------------

const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');
type FetchInput = string | URL | Request;

interface FakeChain {
  /** Fee per token address (base units). */
  fee?: (token: string) => bigint;
  credits?: (payer: string, token: string) => bigint;
  balance?: (token: string, owner: string) => bigint;
  fail?: boolean;
  hang?: boolean;
}

function fakeFetch(config: ChainConfig, fake: FakeChain) {
  const calls: { fn: string; to: string; args: unknown[] }[] = [];
  const impl = async (_url: FetchInput, init?: RequestInit): Promise<Response> => {
    if (fake.hang === true) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    }
    if (fake.fail === true) return new Response('down', { status: 500 });
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
    if (body.method === 'eth_chainId') return answer(`0x${config.chainId.toString(16)}`);
    if (body.method !== 'eth_call') throw new Error(`unexpected ${body.method}`);
    const tx = body.params[0] as { to: string; data: Hex };
    const to = tx.to.toLowerCase();
    if (to === config.contracts.vault) {
      const { functionName, args } = decodeFunctionData({
        abi: FEE_VAULT_CLIENT_ABI,
        data: tx.data,
      });
      const a = [...(args ?? [])] as unknown[];
      calls.push({ fn: functionName, to, args: a });
      let result: unknown;
      if (functionName === 'quote') {
        const p = fake.fee?.((a[1] as string).toLowerCase()) ?? 0n;
        result = [p, 0n, p];
      } else if (functionName === 'creditsOf') {
        result =
          fake.credits?.((a[0] as string).toLowerCase(), (a[1] as string).toLowerCase()) ?? 0n;
      } else throw new Error(`unexpected ${functionName}`);
      return answer(
        encodeFunctionResult({
          abi: FEE_VAULT_CLIENT_ABI,
          functionName,
          result,
        } as Parameters<typeof encodeFunctionResult>[0]),
      );
    }
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    const a = [...(args ?? [])] as unknown[];
    calls.push({ fn: functionName, to, args: a });
    if (functionName !== 'balanceOf') throw new Error(`unexpected ${functionName}`);
    return answer(
      encodeFunctionResult({
        abi: erc20Abi,
        functionName: 'balanceOf',
        result: fake.balance?.(to, (a[0] as string).toLowerCase()) ?? 0n,
      }),
    );
  };
  const fetchFn = vi.fn(impl) as Mock<typeof impl>;
  Object.defineProperty(fetchFn, ADDRESS_CHECKED, { value: true });
  return { fetchFn, calls };
}

function reader(config: ChainConfig, fake: FakeChain) {
  const { fetchFn, calls } = fakeFetch(config, fake);
  return {
    reader: { config, client: createReadClient(config, { fetchFn, retryCount: 0 }) },
    fetchFn,
    calls,
  };
}

const USDC_FEE = () => 100_000n; // $0.10 in 6-decimal USDC
const XDAI_FEE = () => 2n * 10n ** 16n; // $0.02 in 18-decimal xDAI

describe('detectFunding: credits, quotes and top-up balances on every chain, in parallel', () => {
  it('has short defaults: a few seconds budget, a one-minute cache', () => {
    expect(DEFAULT_DETECT_BUDGET_MS).toBeLessThanOrEqual(5_000);
    expect(DEFAULT_DETECT_CACHE_MS).toBe(60_000);
  });

  it('reads the quote and creditsOf for every offered token; no balanceOf without a gasless top-up', async () => {
    const b = reader(base(), { fee: USDC_FEE, credits: () => 300_000n });
    const d = await detectFunding([b.reader], PAYER_MIXED, { feeType: 'NOTARIZE' });
    expect(d.payer).toBe(PAYER_MIXED.toLowerCase());
    expect(d.unavailable).toEqual([]);
    expect(d.chains).toHaveLength(1);
    expect(d.chains[0]?.options[0]).toMatchObject({ credits: 300_000n, topUpBalance: null });
    expect(d.chains[0]?.options[0]?.quote.total).toBe(100_000n);
    expect(b.calls.map((c) => c.fn).sort()).toEqual(['creditsOf', 'quote']);
  });

  it('reads the stablecoin balance where the gasless top-up exists', async () => {
    const c = baseTopUp();
    const b = reader(c, { fee: USDC_FEE, balance: () => 7_000_000n });
    const d = await detectFunding([b.reader], PAYER, { feeType: 'NOTARIZE' });
    expect(d.chains[0]?.options[0]?.topUpBalance).toBe(7_000_000n);
    expect(b.calls.find((x) => x.fn === 'balanceOf')?.args).toEqual([
      expect.stringMatching(new RegExp(`^${PAYER}$`, 'i')),
    ]);
  });

  it('an RPC failure on one chain neither blocks nor picks it', async () => {
    const b = reader(base(), { fail: true });
    const c = reader(chiado(), { fee: XDAI_FEE, credits: () => 10n ** 18n });
    const got = await selectPayingChain([b.reader, c.reader], PAYER, {
      feeType: 'NOTARIZE',
      defaultChain: 'base-sepolia',
    });
    expect(got).toMatchObject({ status: 'ok', chainId: 10200, unavailable: [84532] });
  });

  it('a chain that does not answer within the budget is skipped for this attempt', async () => {
    const b = reader(base(), { hang: true });
    const c = reader(chiado(), { fee: XDAI_FEE, credits: () => 10n ** 18n });
    const started = Date.now();
    const got = await selectPayingChain([b.reader, c.reader], PAYER, {
      feeType: 'NOTARIZE',
      budgetMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(got).toMatchObject({ status: 'ok', chainId: 10200, unavailable: [84532] });
  });

  it('never queries a mainnet entry (its RPC never sees the address)', async () => {
    const m = reader(mainnet(), { fee: USDC_FEE, credits: () => 10n ** 12n });
    const l = reader(lyingMainnet(), { fee: USDC_FEE, credits: () => 10n ** 12n });
    const b = reader(base(), { fee: USDC_FEE });
    const got = await selectPayingChain([m.reader, l.reader, b.reader], PAYER, {
      feeType: 'NOTARIZE',
    });
    expect(m.fetchFn).not.toHaveBeenCalled();
    expect(l.fetchFn).not.toHaveBeenCalled();
    expect(got).toMatchObject({ status: 'needs_credits', topUp: { chainId: 84532 } });
  });

  it('nothing funded across chains: needs_credits to the cheapest chain, with the agent address', async () => {
    const b = reader(base(), { fee: USDC_FEE });
    const c = reader(chiado(), { fee: XDAI_FEE });
    const got = await selectPayingChain([b.reader, c.reader], PAYER, { feeType: 'NOTARIZE' });
    expect(got).toEqual({
      status: 'needs_credits',
      topUp: {
        chainId: 10200,
        chain: 'gnosis-chiado',
        token: 'NATIVE',
        usd: '0.02',
        agentAddress: PAYER,
      },
      unavailable: [],
    });
  });

  it('refuses a malformed payer before any request', async () => {
    const b = reader(base(), { fee: USDC_FEE });
    await expect(
      detectFunding([b.reader], '0x1234' as Hex, { feeType: 'NOTARIZE' }),
    ).rejects.toBeInstanceOf(ChainInputError);
    expect(b.fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a budget outside 1 ms to 30 s', async () => {
    const b = reader(base(), { fee: USDC_FEE });
    for (const budgetMs of [0, -1, 30_001, Number.NaN]) {
      await expect(
        detectFunding([b.reader], PAYER, { feeType: 'NOTARIZE', budgetMs }),
      ).rejects.toBeInstanceOf(ChainInputError);
    }
  });
});

describe('createChainSelector: a short detection cache', () => {
  it('reuses a detection within the cache time and reads again after it', async () => {
    let now = 1_000_000;
    const b = reader(base(), { fee: USDC_FEE, credits: () => 10n ** 9n });
    const selector = createChainSelector({ now: () => now });
    const opts = { feeType: 'NOTARIZE' as const };
    await selector.select([b.reader], PAYER, opts);
    const after1 = b.fetchFn.mock.calls.length;
    await selector.select([b.reader], PAYER, opts);
    expect(b.fetchFn.mock.calls.length).toBe(after1);
    now += DEFAULT_DETECT_CACHE_MS + 1;
    await selector.select([b.reader], PAYER, opts);
    expect(b.fetchFn.mock.calls.length).toBeGreaterThan(after1);
  });

  it('keys the cache by payer and fee type, and clear() drops it', async () => {
    const b = reader(base(), { fee: USDC_FEE, credits: () => 10n ** 9n });
    const selector = createChainSelector();
    await selector.select([b.reader], PAYER, { feeType: 'NOTARIZE' });
    const n = b.fetchFn.mock.calls.length;
    await selector.select([b.reader], PAYER, { feeType: 'REGISTER' });
    expect(b.fetchFn.mock.calls.length).toBeGreaterThan(n);
    const m = b.fetchFn.mock.calls.length;
    selector.clear();
    await selector.select([b.reader], PAYER, { feeType: 'NOTARIZE' });
    expect(b.fetchFn.mock.calls.length).toBeGreaterThan(m);
  });

  it('does not cache a chain that was unavailable', async () => {
    const b = reader(base(), { fail: true });
    const selector = createChainSelector();
    const first = await selector.select([b.reader], PAYER, { feeType: 'NOTARIZE' });
    expect(first.status).toBe('unavailable');
    const n = b.fetchFn.mock.calls.length;
    await selector.select([b.reader], PAYER, { feeType: 'NOTARIZE' });
    expect(b.fetchFn.mock.calls.length).toBeGreaterThan(n);
  });
});
