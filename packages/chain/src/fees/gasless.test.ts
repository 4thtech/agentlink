// M3-4b-t-2: the gasless top-up builder (05 §2.5; 03 §4.4; 12 §4.1; 07 §7; D-123). The agent signs
// an EIP-3009 `ReceiveWithAuthorization` with its own EVM key, payee = the shipped fee vault, under
// the token's domain as read from chain, and never anything else. No network: the token answers
// through a fake `eth_call`.
//
// Keys here are test values built at run time (a repeated byte), never a real secret.
import {
  decodeEcdsaSignature,
  encodeHex0x,
  hashTypedData,
  recoverEvmAddress,
  tokenDomainSeparator,
  type TypedData,
} from '@4thtech-io/crypto';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex as ViemHex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainState } from '../clients/state.js';
import type { ChainConfig } from '../config/index.js';
import type { Hex } from '../ids/index.js';

// The shipped registry composes `eip3009` from the token flag AND the vault capability, which is
// false until the M3-4b-t-0 ABI import. Tests switch the capability on here; the real registry
// answers whenever `capability.on` is false.
const capability = vi.hoisted(() => ({ on: true }));
vi.mock('../clients/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../clients/registry.js')>();
  return {
    ...real,
    getChainConfig: (chainId: number): ChainConfig | undefined => {
      const c = real.getChainConfig(chainId);
      if (c === undefined || !capability.on) return c;
      // Base Sepolia USDC carries the shipped token flag (config/testnets.ts).
      const feeTokens = c.feeTokens.map((t) =>
        Object.freeze({ ...t, eip3009: t.symbol === 'USDC' }),
      );
      return Object.freeze({ ...c, feeTokens });
    },
  };
});

// CHORE-GASLESS-NONCE-TIMEOUT: secp256k1 public-key recovery is the slow part of a build (about
// 1.0 ms of 1.6 ms locally; the 1 000-build nonce test took 56 s on a loaded CI runner). This
// pass-through counts every real recovery. With `recovery.memo` on (one test only, reset before
// each test), a signature the fake signer below made itself answers with its signer's address,
// which is what real recovery returns for it; anything else still runs the real recovery.
const recovery = vi.hoisted(() => ({
  memo: false,
  real: 0,
  known: new Map<string, Uint8Array>(),
}));
vi.mock('@4thtech-io/crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('@4thtech-io/crypto')>();
  return {
    ...real,
    recoverEvmAddress: (digest: Uint8Array, signature: Uint8Array): Uint8Array => {
      if (recovery.memo) {
        const hit = recovery.known.get(
          `${real.encodeHex0x(digest)}:${real.encodeHex0x(signature)}`,
        );
        if (hit !== undefined) return hit.slice();
      }
      recovery.real += 1;
      return real.recoverEvmAddress(digest, signature);
    },
  };
});

const { getChainConfig } = await import('../clients/registry.js');
const { DEPOSIT_AUTH_CLOCK_SKEW_SECONDS } = await import('../submitter/deposit-relay.js');
const {
  GASLESS_CHAIN_IDS,
  GASLESS_MAX_USD_CENTS,
  GASLESS_MAX_WINDOW_SECONDS,
  GASLESS_MIN_USD_CENTS,
  GASLESS_WINDOW_SECONDS,
  buildReceiveWithAuthorization,
  gaslessToken,
  gaslessValueBounds,
  readAuthorizationUsed,
  readTokenDomain,
  recoverAuthorizationSigner,
} = await import('./gasless.js');

const testKey = (byte: string): ViemHex => `0x${byte.repeat(32)}` as ViemHex;
const AGENT_KEY = testKey('a1');
const OWNER_KEY = testKey('b2');
const AGENT = privateKeyToAccount(AGENT_KEY).address.toLowerCase() as Hex;

const shipped = (): ChainConfig => {
  const c = getChainConfig(84532);
  if (!c) throw new Error('test setup: no Base Sepolia config');
  return c;
};
const CONFIG = shipped();
const VAULT = CONFIG.contracts.vault.toLowerCase() as Hex;
const USDC = (CONFIG.feeTokens.find((t) => t.symbol === 'USDC')?.address ?? '') as Hex;
const DOLLAR = 1_000_000n; // USDC has 6 decimals
const NOW = 1_800_000_000;

const TOKEN_ABI = parseAbi([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);

interface FakeToken {
  name: string;
  version: string;
  /** The chain ID and address the token's separator is computed for. */
  separatorChainId: number;
  separatorAddress: Hex;
  /** EIP-5267 answer, or undefined when the token lacks `eip712Domain()` (Circle's FiatToken). */
  eip5267?: { chainId: bigint; verifyingContract: Hex; fields?: ViemHex };
  used: Set<string>;
  calls: string[];
}

function fakeToken(overrides: Partial<FakeToken> = {}): FakeToken {
  return {
    name: 'USDC',
    version: '2',
    separatorChainId: 84532,
    separatorAddress: USDC,
    used: new Set(),
    calls: [],
    ...overrides,
  };
}

function ethCallOf(token: FakeToken) {
  return vi.fn((to: Hex, data: Hex): Promise<Hex> => {
    if (to.toLowerCase() !== USDC) return Promise.reject(new Error('unexpected contract'));
    const { functionName, args } = decodeFunctionData({ abi: TOKEN_ABI, data });
    token.calls.push(functionName);
    const result = (value: unknown) =>
      Promise.resolve(
        encodeFunctionResult({ abi: TOKEN_ABI, functionName, result: value } as never) as Hex,
      );
    switch (functionName) {
      case 'name':
        return result(token.name);
      case 'version':
        return result(token.version);
      case 'DOMAIN_SEPARATOR':
        return result(
          encodeHex0x(
            tokenDomainSeparator({
              name: token.name,
              version: token.version,
              chainId: token.separatorChainId,
              verifyingContract: token.separatorAddress,
            }),
          ),
        );
      case 'eip712Domain':
        if (!token.eip5267) return Promise.reject(new Error('execution reverted'));
        return result([
          token.eip5267.fields ?? '0x0f',
          token.name,
          token.version,
          token.eip5267.chainId,
          token.eip5267.verifyingContract,
          `0x${'00'.repeat(32)}`,
          [],
        ]);
      case 'authorizationState': {
        const [authorizer, nonce] = args as readonly [string, string];
        return result(token.used.has(`${authorizer.toLowerCase()}:${nonce}`));
      }
      default:
        return Promise.reject(new Error('unexpected function'));
    }
  });
}

function fakeState(
  config: ChainConfig = CONFIG,
  reads: { minDeposit?: bigint; balance?: bigint } = {},
): ChainState & { reads: string[] } {
  const seen: string[] = [];
  return {
    config,
    reads: seen,
    minDeposit: vi.fn((token: Hex) => {
      seen.push(`minDeposit:${token}`);
      return Promise.resolve(reads.minDeposit ?? 5n * DOLLAR);
    }),
    tokenBalance: vi.fn((token: Hex, owner: Hex) => {
      seen.push(`balanceOf:${token}:${owner}`);
      return Promise.resolve(reads.balance ?? 100n * DOLLAR);
    }),
  } as unknown as ChainState & { reads: string[] };
}

/** A KeyStore double: sign712 signs the digest with `key` (the agent's EVM key by default). */
function fakeSigner(key: ViemHex = AGENT_KEY, agentId: string = AGENT) {
  const signed: TypedData[] = [];
  return {
    signed,
    getPublicBundle: vi.fn(() => Promise.resolve({ agentId })),
    sign712: vi.fn(async (td: TypedData) => {
      signed.push(td);
      const { digest } = hashTypedData(td);
      return (await sign({
        hash: encodeHex0x(digest) as ViemHex,
        privateKey: key,
        to: 'hex',
      })) as string;
    }),
  };
}

type Signer = ReturnType<typeof fakeSigner>;
const asSigner = (s: Signer) => s as unknown as Parameters<typeof buildReceiveWithAuthorization>[1];

async function build(
  opts: {
    state?: ChainState;
    signer?: Signer;
    token?: FakeToken;
    value?: bigint;
    symbol?: 'USDC' | 'USDT' | 'NATIVE';
    windowSeconds?: number;
  } = {},
) {
  const token = opts.token ?? fakeToken();
  return buildReceiveWithAuthorization(
    opts.state ?? fakeState(),
    asSigner(opts.signer ?? fakeSigner()),
    { token: opts.symbol ?? 'USDC', value: opts.value ?? 10n * DOLLAR },
    {
      ethCall: ethCallOf(token),
      nowSeconds: () => NOW,
      ...(opts.windowSeconds === undefined ? {} : { windowSeconds: opts.windowSeconds }),
    },
  );
}

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  const err = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as { code?: string; message: string };
}

beforeEach(() => {
  capability.on = true;
  recovery.memo = false;
  recovery.real = 0;
  recovery.known.clear();
});

describe('gasless top-up limits (owner decisions 2026-10-23)', () => {
  it('Base Sepolia only, $5 to $50 per top-up, a 15-minute window', () => {
    expect(GASLESS_CHAIN_IDS).toEqual([84532]);
    expect(GASLESS_MIN_USD_CENTS).toBe(500);
    expect(GASLESS_MAX_USD_CENTS).toBe(5_000);
    expect(GASLESS_WINDOW_SECONDS).toBe(900);
    expect(gaslessValueBounds(6)).toEqual({ min: 5n * DOLLAR, max: 50n * DOLLAR });
    expect(gaslessValueBounds(18)).toEqual({ min: 5n * 10n ** 18n, max: 50n * 10n ** 18n });
  });
});

describe('gaslessToken: the shipped vault and the eip3009 capability', () => {
  it('returns the shipped vault and token for Base Sepolia USDC', () => {
    expect(gaslessToken(CONFIG, 'USDC')).toEqual({
      chainId: 84532,
      symbol: 'USDC',
      token: USDC,
      decimals: 6,
      vault: VAULT,
    });
    expect(gaslessToken(CONFIG, USDC).token).toBe(USDC);
  });

  it('is unavailable while the shipped registry has no capability (today, before step 0)', () => {
    capability.on = false;
    const real = getChainConfig(84532) as ChainConfig;
    expect(() => gaslessToken(real, 'USDC')).toThrow(
      expect.objectContaining({ code: 'gasless_unavailable' }),
    );
    // A hand-made config cannot switch it on: the shipped registry must agree.
    const forged: ChainConfig = {
      ...real,
      feeTokens: real.feeTokens.map((t) => ({ ...t, eip3009: true })),
    };
    expect(() => gaslessToken(forged, 'USDC')).toThrow(
      expect.objectContaining({ code: 'gasless_unavailable' }),
    );
  });

  it('refuses a config whose eip3009 flag is off even when the registry has it on', () => {
    const off: ChainConfig = {
      ...CONFIG,
      feeTokens: CONFIG.feeTokens.map((t) => ({ ...t, eip3009: false })),
    };
    expect(() => gaslessToken(off, 'USDC')).toThrow(
      expect.objectContaining({ code: 'gasless_unavailable' }),
    );
  });

  it('refuses a config that names another vault (the payee is never a parameter)', () => {
    const other: ChainConfig = {
      ...CONFIG,
      contracts: { ...CONFIG.contracts, vault: `0x${'99'.repeat(20)}` },
    };
    expect(() => gaslessToken(other, 'USDC')).toThrow(
      expect.objectContaining({ code: 'not_vault' }),
    );
  });

  it('refuses a token that is not offered, or another token address', () => {
    expect(() => gaslessToken(CONFIG, 'USDT')).toThrow(
      expect.objectContaining({ code: 'gasless_unavailable' }),
    );
    expect(() => gaslessToken(CONFIG, `0x${'12'.repeat(20)}`)).toThrow(
      expect.objectContaining({ code: 'gasless_unavailable' }),
    );
  });

  it('refuses Gnosis Chiado and any mainnet ID outright', () => {
    const chiado = getChainConfig(10200);
    if (chiado) {
      expect(() => gaslessToken(chiado, 'NATIVE')).toThrow(
        expect.objectContaining({ code: 'unsupported_chain' }),
      );
    }
    for (const chainId of [8453, 1, 100, 10200]) {
      const mainnet: ChainConfig = { ...CONFIG, chainId, testnet: chainId === 10200 };
      expect(() => gaslessToken(mainnet, 'USDC')).toThrow(
        expect.objectContaining({ code: 'unsupported_chain' }),
      );
    }
    const notTestnet: ChainConfig = { ...CONFIG, testnet: false };
    expect(() => gaslessToken(notTestnet, 'USDC')).toThrow(
      expect.objectContaining({ code: 'unsupported_chain' }),
    );
  });
});

describe('readTokenDomain: from chain, never hard-coded', () => {
  const t = () => gaslessToken(CONFIG, 'USDC');

  it('reads name(), version() and DOMAIN_SEPARATOR() when the token has no eip712Domain()', async () => {
    const token = fakeToken({ name: 'USD Coin', version: '2' });
    const domain = await readTokenDomain(ethCallOf(token), t());
    expect(domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 84532,
      verifyingContract: USDC,
    });
    expect(token.calls).toContain('DOMAIN_SEPARATOR');
  });

  it('uses EIP-5267 eip712Domain() where the token has it', async () => {
    const token = fakeToken({ eip5267: { chainId: 84532n, verifyingContract: USDC } });
    const domain = await readTokenDomain(ethCallOf(token), t());
    expect(domain.name).toBe('USDC');
    expect(token.calls[0]).toBe('eip712Domain');
  });

  it('refuses a separator made for another chain or another contract', async () => {
    for (const token of [
      fakeToken({ separatorChainId: 8453 }),
      fakeToken({ separatorAddress: `0x${'77'.repeat(20)}` }),
    ]) {
      const err = await refusal(readTokenDomain(ethCallOf(token), t()));
      expect(err.code).toBe('token_domain_mismatch');
    }
  });

  it('refuses an eip712Domain() for another chain or contract', async () => {
    for (const eip5267 of [
      { chainId: 8453n, verifyingContract: USDC },
      { chainId: 84532n, verifyingContract: `0x${'77'.repeat(20)}` as Hex },
    ]) {
      const err = await refusal(readTokenDomain(ethCallOf(fakeToken({ eip5267 })), t()));
      expect(err.code).toBe('token_domain_mismatch');
    }
  });

  it('readAuthorizationUsed reads authorizationState(from, nonce)', async () => {
    const token = fakeToken();
    const nonce = `0x${'ab'.repeat(32)}` as Hex;
    expect(await readAuthorizationUsed(ethCallOf(token), USDC, AGENT, nonce)).toBe(false);
    token.used.add(`${AGENT}:${nonce}`);
    expect(await readAuthorizationUsed(ethCallOf(token), USDC, AGENT, nonce)).toBe(true);
  });
});

describe('buildReceiveWithAuthorization', () => {
  it('signs from = the agent, to = the shipped vault, under the domain read from chain', async () => {
    const signer = fakeSigner();
    const token = fakeToken({ name: 'USD Coin' });
    const req = await build({ signer, token, value: 12n * DOLLAR });
    expect(req.chainId).toBe(84532);
    expect(req.token).toBe(USDC);
    expect(req.auth.from).toBe(AGENT);
    expect(req.auth.to).toBe(VAULT);
    expect(req.auth.value).toBe('12000000');
    expect(req.auth.validAfter).toBe('0');
    expect(req.auth.validBefore).toBe(String(NOW + 900));
    expect(req.auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect([27, 28]).toContain(req.auth.v);
    expect(req.auth.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(req.auth.s).toMatch(/^0x[0-9a-f]{64}$/);

    expect(signer.sign712).toHaveBeenCalledTimes(1);
    const td = signer.signed[0] as TypedData;
    expect(td.primaryType).toBe('ReceiveWithAuthorization');
    expect(Object.keys(td.types)).not.toContain('TransferWithAuthorization');
    expect(td.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 84532,
      verifyingContract: USDC,
    });
    expect((td.message as { to: string }).to).toBe(VAULT);

    // The split signature recovers the agent under that domain.
    const sig = decodeEcdsaSignature(
      `0x${req.auth.r.slice(2)}${req.auth.s.slice(2)}${req.auth.v.toString(16)}`,
    );
    expect(encodeHex0x(recoverEvmAddress(hashTypedData(td).digest, sig))).toBe(AGENT);
    expect(
      recoverAuthorizationSigner(
        { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: USDC },
        req.auth,
      ),
    ).toBe(AGENT);
  });

  it('reads minDeposit from the vault and balanceOf(agent) from the token', async () => {
    const state = fakeState();
    await build({ state });
    expect(state.reads).toEqual([`minDeposit:${USDC}`, `balanceOf:${USDC}:${AGENT}`]);
  });

  it('draws a fresh 32-byte nonce every time (1 000 builds, no repeat)', async () => {
    const nonces = new Set<string>();
    const state = fakeState();
    const signer = fakeSigner();
    const token = fakeToken();
    const ethCall = ethCallOf(token);
    const auths: Awaited<ReturnType<typeof buildReceiveWithAuthorization>>['auth'][] = [];
    for (let i = 0; i < 1_000; i += 1) {
      const req = await buildReceiveWithAuthorization(
        state,
        asSigner(signer),
        { token: 'USDC', value: 5n * DOLLAR },
        { ethCall, nowSeconds: () => NOW },
      );
      expect(req.auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);
      nonces.add(req.auth.nonce);
      auths.push(req.auth);
    }
    expect(nonces.size).toBe(1_000);
    expect(signer.sign712).toHaveBeenCalledTimes(1_000);
    // The time budget: no build in the loop repeats the real secp256k1 recovery.
    expect(recovery.real).toBe(0);
    // Real recovery on a sample: each signed authorization recovers the agent.
    recovery.memo = false;
    const domain = { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC };
    for (const i of [0, 1, 499, 998, 999]) {
      expect(recoverAuthorizationSigner(domain, auths[i] as (typeof auths)[number])).toBe(AGENT);
    }
    expect(recovery.real).toBe(5);
  }, 60_000);

  it('refuses a signature that is not the agent key (the owner key never signs this)', async () => {
    const owner = fakeSigner(OWNER_KEY);
    const err = await refusal(build({ signer: owner }));
    expect(err.code).toBe('signer_mismatch');
  });

  it('refuses below $5, below the vault minDeposit, above $50 and above the balance', async () => {
    const cases: [ChainState, bigint, string][] = [
      [fakeState(), 5n * DOLLAR - 1n, 'below_min_deposit'],
      [fakeState(CONFIG, { minDeposit: 20n * DOLLAR }), 10n * DOLLAR, 'below_min_deposit'],
      [fakeState(), 50n * DOLLAR + 1n, 'above_max_top_up'],
      [fakeState(CONFIG, { balance: 7n * DOLLAR }), 8n * DOLLAR, 'insufficient_balance'],
    ];
    for (const [state, value, code] of cases) {
      const signer = fakeSigner();
      const err = await refusal(build({ state, signer, value }));
      expect(err.code).toBe(code);
      expect(signer.sign712).not.toHaveBeenCalled();
    }
    // The bounds themselves pass.
    await expect(build({ value: 5n * DOLLAR })).resolves.toBeDefined();
    await expect(build({ value: 50n * DOLLAR })).resolves.toBeDefined();
  });

  it('refuses a non-bigint or non-positive value before any read', async () => {
    for (const value of [0n, -1n, 10 as unknown as bigint]) {
      const state = fakeState();
      const err = await refusal(build({ state, value }));
      expect(err.code).toBe('invalid_amount');
      expect(state.reads).toEqual([]);
    }
  });

  it('refuses a token without the flag, another vault, Chiado and mainnet before any read or signature', async () => {
    capability.on = false;
    const signer = fakeSigner();
    const state = fakeState(getChainConfig(84532) as ChainConfig);
    expect((await refusal(build({ state, signer }))).code).toBe('gasless_unavailable');
    capability.on = true;
    const other = fakeState({
      ...CONFIG,
      contracts: { ...CONFIG.contracts, vault: `0x${'99'.repeat(20)}` },
    });
    expect((await refusal(build({ state: other, signer }))).code).toBe('not_vault');
    const mainnet = fakeState({ ...CONFIG, chainId: 8453, testnet: false });
    expect((await refusal(build({ state: mainnet, signer }))).code).toBe('unsupported_chain');
    expect(signer.sign712).not.toHaveBeenCalled();
    expect(state.reads).toEqual([]);
    expect(other.reads).toEqual([]);
  });

  it('refuses a mismatched token domain and signs nothing', async () => {
    const signer = fakeSigner();
    const err = await refusal(build({ signer, token: fakeToken({ separatorChainId: 1 }) }));
    expect(err.code).toBe('token_domain_mismatch');
    expect(signer.sign712).not.toHaveBeenCalled();
  });

  it('refuses an agent identity that is not an EVM address', async () => {
    const signer = fakeSigner(AGENT_KEY, 'not-an-address');
    expect((await refusal(build({ signer }))).code).toBe('invalid_call');
    expect(signer.sign712).not.toHaveBeenCalled();
  });

  it('takes a window of 60 s to the relay bound, 15 minutes by default (M3-4b-t-T2-b)', async () => {
    expect(GASLESS_MAX_WINDOW_SECONDS).toBe(GASLESS_WINDOW_SECONDS);
    expect((await build({ windowSeconds: 60 })).auth.validBefore).toBe(String(NOW + 60));
    expect((await build({ windowSeconds: 900 })).auth.validBefore).toBe(String(NOW + 900));
    // A window the relay would refuse (validBefore beyond now + 900 + 120 s) is never signed.
    for (const windowSeconds of [59, 901, 1_021, 3_600, 3_601, 1.5]) {
      expect((await refusal(build({ windowSeconds }))).code).toBe('invalid_option');
    }
    const built = await build({ windowSeconds: GASLESS_MAX_WINDOW_SECONDS });
    expect(Number(built.auth.validBefore)).toBeLessThanOrEqual(
      NOW + GASLESS_MAX_WINDOW_SECONDS + DEPOSIT_AUTH_CLOCK_SKEW_SECONDS,
    );
  });

  it('never echoes the agent address, the vault or a signature in an error', async () => {
    const errors = await Promise.all([
      refusal(build({ signer: fakeSigner(OWNER_KEY) })),
      refusal(build({ value: 51n * DOLLAR })),
      refusal(build({ token: fakeToken({ separatorChainId: 1 }) })),
    ]);
    for (const err of errors) {
      const text = `${err.message} ${JSON.stringify(err)}`;
      expect(text).not.toContain(AGENT.slice(2, 12));
      expect(text).not.toContain(VAULT.slice(2, 12));
      expect(text).not.toContain(USDC.slice(2, 12));
    }
  });
});
