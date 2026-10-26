// M3-4b-t-2: the submitter's relay side of a gasless top-up (07 §7 `/v1/deposit-authorization`;
// 05 §2.5; 04 §7 gas griefing). Before the gas key signs anything, the relay checks the chain, the
// token flag, the payee (the shipped vault), the amount, the window, the signature (under the token
// domain read from chain), that `from` is an EOA, that the nonce is unused, and simulates the call.
// No network: every request goes to an in-memory chain behind a mock fetch.
//
// Keys here are test values built at run time (a repeated byte), never a real secret.
import {
  encodeHex0x,
  hashTypedData,
  receiveWithAuthorizationTypedData,
  tokenDomainSeparator,
} from '@4thtech-io/crypto';
import {
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  parseTransaction,
  type Abi,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainConfig } from '../config/index.js';
import type { Hex } from '../ids/index.js';

const capability = vi.hoisted(() => ({ on: true }));
vi.mock('../clients/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../clients/registry.js')>();
  return {
    ...real,
    getChainConfig: (chainId: number): ChainConfig | undefined => {
      const c = real.getChainConfig(chainId);
      if (c === undefined || !capability.on) return c;
      const feeTokens = c.feeTokens.map((t) =>
        Object.freeze({ ...t, eip3009: t.symbol === 'USDC' }),
      );
      return Object.freeze({ ...c, feeTokens });
    },
  };
});

const { getChainConfig } = await import('../clients/registry.js');
const {
  DEPOSIT_AUTH_MAX_GAS,
  checkRelayAbi,
  createDepositRelayChain,
  depositAuthorizationCalldata,
} = await import('./index.js');
type DepositAuthorizationRequest = import('./index.js').DepositAuthorizationRequest;

const testKey = (byte: string): ViemHex => `0x${byte.repeat(32)}` as ViemHex;
const AGENT_KEY = testKey('a1');
const OTHER_KEY = testKey('b2');
const GAS_KEY = testKey('c3');
const AGENT = privateKeyToAccount(AGENT_KEY).address.toLowerCase() as Hex;
const OTHER = privateKeyToAccount(OTHER_KEY).address.toLowerCase() as Hex;
const GAS_ADDRESS = privateKeyToAccount(GAS_KEY).address.toLowerCase() as Hex;

const CONFIG = getChainConfig(84532) as ChainConfig;
const VAULT = CONFIG.contracts.vault.toLowerCase() as Hex;
const USDC = (CONFIG.feeTokens.find((t) => t.symbol === 'USDC')?.address ?? '') as Hex;
const DOLLAR = 1_000_000n;
const NOW = 1_800_000_000;
const DOMAIN = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC };

// The relay ABI as 05 §2.5 specifies it; step 0 (M3-4b-t-0) passes occFeeVaultRelayAbi.
const RELAY_ABI = parseAbi([
  'function depositWithAuthorization(address token, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'error BelowMinDeposit()',
  'error DepositMismatch()',
  'event Deposited(address indexed payer, address indexed token, uint256 amount)',
]);
const VAULT_READ_ABI = parseAbi(['function minDeposit(address token) view returns (uint256)']);
const TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]);

interface MockChain {
  minDeposit: bigint;
  code: Map<string, string>;
  used: Set<string>;
  estimate: bigint;
  revert: string | null;
  methods: string[];
  calls: string[];
  sent: { raw: Hex; hash: Hex }[];
  receipts: Map<string, unknown>;
  separatorChainId: number;
}

const newChain = (): MockChain => ({
  minDeposit: 5n * DOLLAR,
  code: new Map(),
  used: new Set(),
  estimate: 120_000n,
  revert: null,
  methods: [],
  calls: [],
  sent: [],
  receipts: new Map(),
  separatorChainId: 84532,
});

function mockFetch(chain: MockChain) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    chain.methods.push(req.method);
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    const replyError = (error: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error }));
    const p = req.params;
    switch (req.method) {
      case 'eth_chainId':
        return reply('0x14a34');
      case 'eth_getCode':
        return reply(chain.code.get(String(p[0]).toLowerCase()) ?? '0x');
      case 'eth_getTransactionCount':
        return reply('0x7');
      case 'eth_maxPriorityFeePerGas':
        return reply('0x3b9aca00');
      case 'eth_getBlockByNumber':
        return reply({ number: '0x10', baseFeePerGas: '0x77359400', timestamp: '0x1' });
      case 'eth_estimateGas': {
        const call = p[0] as { to: string; from: string; data: ViemHex };
        chain.calls.push(`estimate:${call.to}:${call.from}`);
        if (chain.revert) {
          const data = encodeErrorResult({ abi: RELAY_ABI, errorName: chain.revert as never });
          return replyError({ code: 3, message: 'execution reverted', data });
        }
        return reply(`0x${chain.estimate.toString(16)}`);
      }
      case 'eth_call': {
        const call = p[0] as { to: string; data: ViemHex };
        const to = call.to.toLowerCase();
        if (to === VAULT) {
          chain.calls.push('minDeposit');
          return reply(
            encodeFunctionResult({
              abi: VAULT_READ_ABI,
              functionName: 'minDeposit',
              result: chain.minDeposit,
            }),
          );
        }
        if (to !== USDC) return replyError({ code: -32000, message: 'execution reverted' });
        const { functionName, args } = decodeFunctionData({ abi: TOKEN_ABI, data: call.data });
        chain.calls.push(functionName);
        const result = (value: unknown) =>
          reply(encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: value } as never));
        switch (functionName) {
          case 'name':
            return result('USDC');
          case 'version':
            return result('2');
          case 'DOMAIN_SEPARATOR':
            return result(
              encodeHex0x(tokenDomainSeparator({ ...DOMAIN, chainId: chain.separatorChainId })),
            );
          case 'authorizationState': {
            const [a, n] = args as readonly [string, string];
            return result(chain.used.has(`${a.toLowerCase()}:${n}`));
          }
          default:
            // Circle's FiatToken has no eip712Domain(): the call reverts without data.
            return replyError({ code: 3, message: 'execution reverted', data: '0x' });
        }
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
}

function relay(chain: MockChain, overrides: { relayAbi?: unknown; gasKey?: string } = {}) {
  return createDepositRelayChain(CONFIG, {
    fetchFn: mockFetch(chain) as never,
    gasKey: overrides.gasKey ?? GAS_KEY,
    rpcUrls: ['https://rpc.example-host.io/secret-path-key'],
    relayAbi: overrides.relayAbi ?? RELAY_ABI,
  });
}

interface AuthFields {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

async function signed(
  overrides: Partial<AuthFields> = {},
  opts: { key?: ViemHex; primaryType?: 'Transfer' } = {},
): Promise<DepositAuthorizationRequest> {
  const auth: AuthFields = {
    from: AGENT,
    to: VAULT,
    value: (10n * DOLLAR).toString(),
    validAfter: '0',
    validBefore: String(NOW + 900),
    nonce: `0x${'3c'.repeat(32)}` as Hex,
    ...overrides,
  };
  const td = receiveWithAuthorizationTypedData(DOMAIN, auth);
  const signedTd =
    opts.primaryType === 'Transfer'
      ? {
          ...td,
          primaryType: 'TransferWithAuthorization',
          types: {
            EIP712Domain: td.types.EIP712Domain,
            TransferWithAuthorization: td.types.ReceiveWithAuthorization,
          },
        }
      : td;
  const sig = (await sign({
    hash: encodeHex0x(hashTypedData(signedTd as typeof td).digest) as ViemHex,
    privateKey: opts.key ?? AGENT_KEY,
    to: 'hex',
  })) as string;
  return {
    chainId: 84532,
    token: USDC,
    auth: {
      ...auth,
      r: `0x${sig.slice(2, 66)}` as Hex,
      s: `0x${sig.slice(66, 130)}` as Hex,
      v: Number.parseInt(sig.slice(130, 132), 16) as 27 | 28,
    },
  };
}

beforeEach(() => {
  capability.on = true;
});

describe('checkRelayAbi', () => {
  it('accepts exactly depositWithAuthorization as 05 §2.5 specifies it, plus events and errors', () => {
    expect(checkRelayAbi(RELAY_ABI)).toBeDefined();
  });

  it('refuses any other function, a different signature, or none', () => {
    const extra = [...RELAY_ABI, ...parseAbi(['function withdraw(address, uint256, address)'])];
    const wrong = parseAbi([
      'function depositWithAuthorization(address token, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
    ]);
    const payable = parseAbi([
      'function depositWithAuthorization(address token, address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) payable',
    ]);
    for (const abi of [
      extra,
      wrong,
      payable,
      [],
      RELAY_ABI.filter((e) => e.type !== 'function'),
      'x',
    ]) {
      expect(() => checkRelayAbi(abi)).toThrow(expect.objectContaining({ code: 'bad_relay_abi' }));
    }
  });
});

describe('depositAuthorizationCalldata', () => {
  it('encodes exactly the authorization, for the vault to redeem', async () => {
    const req = await signed();
    const data = depositAuthorizationCalldata(RELAY_ABI as Abi, req);
    const { functionName, args } = decodeFunctionData({ abi: RELAY_ABI, data });
    expect(functionName).toBe('depositWithAuthorization');
    expect(args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a))).toEqual([
      USDC,
      AGENT,
      10n * DOLLAR,
      0n,
      BigInt(NOW + 900),
      req.auth.nonce,
      req.auth.v,
      req.auth.r,
      req.auth.s,
    ]);
  });
});

describe('createDepositRelayChain', () => {
  it('refuses a bad gas key or relay ABI without echoing the key', () => {
    for (const gasKey of ['0x1234', GAS_KEY.toUpperCase(), '']) {
      try {
        relay(newChain(), { gasKey });
        expect.unreachable();
      } catch (e) {
        expect((e as { code?: string }).code).toBe('bad_gas_key');
        expect((e as Error).message).not.toContain(GAS_KEY.slice(2, 20));
      }
    }
    expect(() => relay(newChain(), { relayAbi: [] })).toThrow(
      expect.objectContaining({ code: 'bad_relay_abi' }),
    );
  });

  it('refuses a chain outside the gasless allowlist', () => {
    const chiado = getChainConfig(10200);
    if (chiado) {
      expect(() =>
        createDepositRelayChain(chiado, {
          fetchFn: mockFetch(newChain()) as never,
          gasKey: GAS_KEY,
          relayAbi: RELAY_ABI,
        }),
      ).toThrow(expect.objectContaining({ code: 'unsupported_chain' }));
    }
  });

  it('exposes the vault and the gas address, never the key', () => {
    const r = relay(newChain());
    expect(r.chainId).toBe(84532);
    expect(r.vault).toBe(VAULT);
    expect(r.gasAddress).toBe(GAS_ADDRESS);
    expect(JSON.stringify(r)).not.toContain(GAS_KEY.slice(2, 20));
  });
});

describe('check: relay validation before the gas key signs', () => {
  it('passes a valid authorization; gas = simulation + 20 %, simulated from the gas wallet to the vault', async () => {
    const chain = newChain();
    const result = await relay(chain).check(await signed(), NOW);
    expect(result).toEqual({ ok: true, gasLimit: 144_000n });
    expect(chain.calls).toContain(`estimate:${VAULT}:${GAS_ADDRESS}`);
    expect(chain.methods).not.toContain('eth_sendRawTransaction');
  });

  const refusals: [
    string,
    () => Promise<{ req: DepositAuthorizationRequest; chain?: MockChain }>,
  ][] = [
    ['unsupported_chain', async () => ({ req: { ...(await signed()), chainId: 10200 } })],
    [
      'gasless_unavailable',
      async () => ({ req: { ...(await signed()), token: `0x${'12'.repeat(20)}` as Hex } }),
    ],
    ['not_vault', async () => ({ req: await signed({ to: OTHER }) })],
    ['below_min_deposit', async () => ({ req: await signed({ value: '4999999' }) })],
    [
      'below_min_deposit',
      async () => {
        const chain = newChain();
        chain.minDeposit = 20n * DOLLAR;
        return { req: await signed(), chain };
      },
    ],
    ['above_max_top_up', async () => ({ req: await signed({ value: '50000001' }) })],
    ['expired', async () => ({ req: await signed({ validBefore: String(NOW) }) })],
    ['expired', async () => ({ req: await signed({ validBefore: String(NOW + 30) }) })],
    ['invalid_window', async () => ({ req: await signed({ validBefore: String(NOW + 3_600) }) })],
    // One past the builder's longest window plus the clock skew (M3-4b-t-T2-b).
    [
      'invalid_window',
      async () => ({ req: await signed({ validBefore: String(NOW + 900 + 120 + 1) }) }),
    ],
    ['invalid_window', async () => ({ req: await signed({ validAfter: String(NOW + 10) }) })],
    ['invalid_signature', async () => ({ req: await signed({}, { key: OTHER_KEY }) })],
    ['invalid_signature', async () => ({ req: await signed({}, { primaryType: 'Transfer' }) })],
    [
      'invalid_signature',
      async () => {
        const chain = newChain();
        chain.code.set(AGENT, '0x6001');
        return { req: await signed(), chain };
      },
    ],
    [
      'gasless_unavailable',
      async () => {
        const chain = newChain();
        chain.separatorChainId = 8453;
        return { req: await signed(), chain };
      },
    ],
    [
      'already_used',
      async () => {
        const chain = newChain();
        const req = await signed();
        chain.used.add(`${AGENT}:${req.auth.nonce}`);
        return { req, chain };
      },
    ],
    [
      'simulation_failed',
      async () => {
        const chain = newChain();
        chain.revert = 'DepositMismatch';
        return { req: await signed(), chain };
      },
    ],
    [
      'gas_too_high',
      async () => {
        const chain = newChain();
        chain.estimate = DEPOSIT_AUTH_MAX_GAS;
        return { req: await signed(), chain };
      },
    ],
  ];

  for (const [code, make] of refusals) {
    it(`refuses: ${code}`, async () => {
      const { req, chain = newChain() } = await make();
      expect(await relay(chain).check(req, NOW)).toEqual({ ok: false, error: code });
      expect(chain.methods).not.toContain('eth_sendRawTransaction');
    });
  }

  it('refuses a token without the eip3009 capability before any chain request', async () => {
    capability.on = false;
    const chain = newChain();
    const r = createDepositRelayChain(getChainConfig(84532) as ChainConfig, {
      fetchFn: mockFetch(chain) as never,
      gasKey: GAS_KEY,
      rpcUrls: ['https://rpc.example-host.io/secret-path-key'],
      relayAbi: RELAY_ABI,
    });
    expect(await r.check(await signed(), NOW)).toEqual({
      ok: false,
      error: 'gasless_unavailable',
    });
    expect(chain.methods).toEqual([]);
  });

  it('refuses a replayed nonce before simulating or sending', async () => {
    const chain = newChain();
    const req = await signed();
    chain.used.add(`${AGENT}:${req.auth.nonce}`);
    expect(await relay(chain).check(req, NOW)).toEqual({ ok: false, error: 'already_used' });
    expect(chain.calls.some((c) => c.startsWith('estimate:'))).toBe(false);
  });

  it('a malformed request is refused as such (the wire parser runs first)', async () => {
    const req = await signed();
    const bad = { ...req, auth: { ...req.auth, v: 1 } } as unknown as DepositAuthorizationRequest;
    await expect(relay(newChain()).check(bad, NOW)).rejects.toMatchObject({
      code: 'invalid_deposit_auth_body',
    });
  });
});

describe('send', () => {
  it('signs one EIP-1559 transaction to the vault carrying exactly the authorization', async () => {
    const chain = newChain();
    const r = relay(chain);
    const req = await signed();
    const hash = await r.send(req, { gasLimit: 144_000n, nonce: 7 });
    expect(chain.sent).toHaveLength(1);
    const sent = chain.sent[0] as { raw: Hex; hash: Hex };
    expect(hash).toBe(sent.hash);
    const tx = parseTransaction(sent.raw);
    expect(tx.to?.toLowerCase()).toBe(VAULT);
    expect(tx.chainId).toBe(84532);
    expect(tx.gas).toBe(144_000n);
    expect(tx.nonce).toBe(7);
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.data).toBe(depositAuthorizationCalldata(RELAY_ABI as Abi, req));
  });

  it('refuses a gas limit above the cap, another payee or another chain, sending nothing', async () => {
    const chain = newChain();
    const r = relay(chain);
    await expect(
      r.send(await signed(), { gasLimit: DEPOSIT_AUTH_MAX_GAS + 1n, nonce: 7 }),
    ).rejects.toMatchObject({ code: 'invalid_call' });
    await expect(
      r.send(await signed({ to: OTHER }), { gasLimit: 100_000n, nonce: 7 }),
    ).rejects.toMatchObject({ code: 'invalid_call' });
    await expect(
      r.send({ ...(await signed()), chainId: 10200 }, { gasLimit: 100_000n, nonce: 7 }),
    ).rejects.toMatchObject({ code: 'invalid_call' });
    expect(chain.sent).toEqual([]);
  });

  it('reads authorizationState, nonces and the receipt status', async () => {
    const chain = newChain();
    const r = relay(chain);
    const req = await signed();
    expect(await r.authorizationUsed(req)).toBe(false);
    chain.used.add(`${AGENT}:${req.auth.nonce}`);
    expect(await r.authorizationUsed(req)).toBe(true);
    expect(await r.pendingNonce()).toBe(7);
    expect(await r.latestNonce()).toBe(7);
    const h = `0x${'55'.repeat(32)}` as Hex;
    expect(await r.txStatus(h)).toBe('pending');
    chain.receipts.set(h, { status: '0x1' });
    expect(await r.txStatus(h)).toBe('success');
    chain.receipts.set(h, { status: '0x0' });
    expect(await r.txStatus(h)).toBe('reverted');
  });

  it('never puts the RPC URL or the gas key in an error', async () => {
    const r = createDepositRelayChain(CONFIG, {
      fetchFn: vi.fn(() => Promise.reject(new TypeError('down'))) as never,
      gasKey: GAS_KEY,
      rpcUrls: ['https://rpc.example-host.io/secret-path-key'],
      relayAbi: RELAY_ABI,
    });
    const err = await r.check(await signed(), NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const text = `${(err as Error).message} ${JSON.stringify(err)} ${String((err as Error).stack)}`;
    expect(text).not.toContain('secret-path-key');
    expect(text).not.toContain(GAS_KEY.slice(2, 20));
  });
});
