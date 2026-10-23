// M3-4b-t-T4-a: the core gasless top-up step (12 §4.1 "gasless USDC"; 07 §7; 04 §2.5; D-123).
// The agent turns test USDC already at its own address into its own credits: an owner-approved
// `credits.deposit` reaches `runGaslessTopUp`, which signs the EIP-3009 authorization with the
// AGENT KeyStore (never the owner key), posts it through the deposit-auth port and confirms the
// credit on chain. Real @4thtech-io/crypto KeyStores with separate owner and agent seeds.
import {
  decodeEcdsaSignature,
  encodeBase64url,
  encodeHex0x,
  randomBytes,
  receiveWithAuthorizationTypedData,
  type KeyStore,
  type TokenDomain,
} from '@4thtech-io/crypto';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import * as chainKit from '@4thtech-io/chain';
import {
  getChainConfig,
  recoverAuthorizationSigner,
  type ChainConfig,
  type ChainState,
  type DepositAuthorizationRequest,
  type GaslessToken,
  type Hex,
  type ReadClient,
} from '@4thtech-io/chain';
import type { Fields, Logger } from '@4thtech-io/log';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreContext } from '../context.js';
import { ownerActionHash } from '../owner-action.js';
import { MemoryStore } from '../store/memory-store.js';
import { FakeClock, TestStoreCipher, passphrase, seed } from '../testing/fixtures.js';
import {
  GASLESS_TOPUP_LIMIT_PER_HOUR,
  GASLESS_TOPUP_WINDOW_SECONDS,
  runGaslessTopUp,
  type DepositAuthAnswer,
  type DepositAuthPort,
  type GaslessApprovalPort,
  type GaslessTopUpDeps,
} from './gasless-topup.js';
import type { ProofChain, ProofKit, ProofsPlatform } from './platform.js';

const BASE_SEPOLIA = getChainConfig(84532) as ChainConfig;
const CHIADO = getChainConfig(10200) as ChainConfig;
const USDC = (
  BASE_SEPOLIA.feeTokens.find((t) => t.symbol === 'USDC')?.address as string
).toLowerCase() as Hex;
const VAULT = BASE_SEPOLIA.contracts.vault.toLowerCase() as Hex;
const DOMAIN: TokenDomain = {
  name: 'USDC',
  version: '2',
  chainId: 84532,
  verifyingContract: USDC,
};
/** $1 in 6-decimal USDC. */
const DOLLAR = 1_000_000n;
const cents = (n: number): bigint => (BigInt(n) * DOLLAR) / 100n;

const AGENT_SEED = seed(0x21);
const OWNER_SEED = seed(0x42);

/** A logger that records exactly what the core passes it (before any redaction). */
function spyLogger(): Logger & { readonly calls: unknown[] } {
  const calls: unknown[] = [];
  const record = (msg: string, fields?: Fields | Error) => {
    calls.push([msg, fields]);
  };
  const logger = {
    calls,
    level: 'debug' as const,
    isEnabled: () => true,
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
    withCodes: () => logger,
  };
  return logger;
}

/**
 * The chain package's builder, stood in for while the shipped registry keeps GASLESS_TOPUP_ENABLED
 * false (it refuses every token then, see the kill-switch test). It builds the same typed data
 * through @4thtech-io/crypto and signs with the KeyStore it is GIVEN, so the test sees which key
 * the core hands it.
 */
function fakeBuilder(calls: { n: number; windowSeconds?: number | undefined }) {
  return async (
    state: ChainState,
    signer: Pick<KeyStore, 'getPublicBundle' | 'sign712'>,
    request: { token: string; value: bigint },
    options: { nowSeconds?: () => number; windowSeconds?: number },
  ): Promise<DepositAuthorizationRequest> => {
    calls.n += 1;
    calls.windowSeconds = options.windowSeconds;
    const { agentId } = await signer.getPublicBundle();
    const now = options.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    const message = {
      from: agentId.toLowerCase(),
      to: VAULT,
      value: request.value.toString(),
      validAfter: '0',
      validBefore: String(now + (options.windowSeconds ?? 900)),
      nonce: encodeHex0x(randomBytes(32)),
    };
    const signature = await signer.sign712(receiveWithAuthorizationTypedData(DOMAIN, message));
    const bytes = decodeEcdsaSignature(signature);
    return {
      chainId: state.config.chainId,
      token: USDC,
      auth: {
        ...message,
        from: message.from as Hex,
        to: VAULT,
        nonce: message.nonce as Hex,
        v: bytes[64] as 27 | 28,
        r: encodeHex0x(bytes.subarray(0, 32)) as Hex,
        s: encodeHex0x(bytes.subarray(32, 64)) as Hex,
      },
    };
  };
}

const DEPLOYMENT: GaslessToken = Object.freeze({
  chainId: 84532,
  symbol: 'USDC',
  token: USDC,
  decimals: 6,
  vault: VAULT,
});

interface FakeChain {
  readonly chain: ProofChain;
  balance: bigint;
  credits: bigint;
  /** Credits rise by the posted value when the port says `submitted` (when true). */
  creditOnSubmit: boolean;
}

function fakeChain(config: ChainConfig = BASE_SEPOLIA): FakeChain {
  const fake: FakeChain = {
    balance: 100n * DOLLAR,
    credits: 0n,
    creditOnSubmit: true,
    chain: undefined as unknown as ProofChain,
  };
  const state = {
    config,
    minDeposit: () => Promise.resolve(0n),
    tokenBalance: () => Promise.resolve(fake.balance),
    creditsOf: () => Promise.resolve(fake.credits),
  } as unknown as ChainState;
  const client = { call: () => Promise.reject(new Error('no eth_call in this test')) };
  (fake as { chain: ProofChain }).chain = {
    config,
    client: client as unknown as ReadClient,
    state,
    submitter: {} as ProofChain['submitter'],
  };
  return fake;
}

interface Harness {
  readonly deps: GaslessTopUpDeps;
  readonly clock: FakeClock;
  readonly store: MemoryStore;
  readonly log: ReturnType<typeof spyLogger>;
  readonly agent: MemoryKeyStore;
  readonly agentId: string;
  readonly fake: FakeChain;
  readonly posted: DepositAuthorizationRequest[];
  readonly builder: { n: number; windowSeconds?: number | undefined };
  readonly sign712: ReturnType<typeof vi.fn>;
  readonly verify: ReturnType<typeof vi.fn>;
  answer: DepositAuthAnswer;
  approve(amount: bigint, extra?: Partial<Record<string, unknown>>): Promise<unknown>;
}

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const k of opened.splice(0)) await k.close();
});

async function harness(
  options: {
    readonly kit?: ProofKit;
    readonly store?: MemoryStore;
    readonly clock?: FakeClock;
    readonly config?: ChainConfig;
    readonly keyStore?: KeyStore;
    readonly real?: boolean;
  } = {},
): Promise<Harness> {
  const clock = options.clock ?? new FakeClock();
  const store = options.store ?? new MemoryStore();
  const log = spyLogger();
  const agent = new MemoryKeyStore(AGENT_SEED);
  opened.push(agent);
  const agentId = (await agent.getPublicBundle()).agentId;
  const keyStore = options.keyStore ?? agent;
  const sign712 = vi.spyOn(keyStore, 'sign712');
  const fake = fakeChain(options.config);
  const posted: DepositAuthorizationRequest[] = [];
  const builder = { n: 0 } as { n: number; windowSeconds?: number | undefined };
  const kit: ProofKit =
    options.kit ??
    (options.real === true
      ? chainKit
      : ({
          ...chainKit,
          gaslessToken: (config: ChainConfig, token: string) => {
            if (config.chainId !== 84532 || token !== 'USDC') {
              throw new chainKit.ChainInputError('gasless_unavailable', 'no gasless top-up');
            }
            return DEPLOYMENT;
          },
          buildReceiveWithAuthorization: fakeBuilder(builder),
        } as ProofKit));
  const h = {
    answer: { status: 'submitted' } as DepositAuthAnswer,
  } as Harness;
  const port: DepositAuthPort = {
    submit: (request) => {
      posted.push(request);
      if (h.answer.status === 'submitted' && fake.creditOnSubmit) {
        fake.credits += BigInt(request.auth.value);
      }
      return Promise.resolve(h.answer);
    },
  };
  const platform: ProofsPlatform = {
    kit,
    chains: [fake.chain],
    depositAuth: port,
  };
  // The owner-action verifier (T4-c wires OwnerActions.verifyCredits): ok for any object the test
  // owner signed below, with its action hash.
  const verify = vi.fn((input: unknown) =>
    Promise.resolve(
      (input as { sig?: unknown }).sig === 'owner-signed'
        ? { ok: true as const, actionHash: ownerActionHash(input) }
        : { ok: false as const },
    ),
  );
  const approvals: GaslessApprovalPort = { verify };
  const ctx: CoreContext = {
    keyStore,
    store,
    cipher: new TestStoreCipher(),
    now: clock.now,
    log,
  };
  const deps: GaslessTopUpDeps = {
    ctx,
    platform,
    approvals,
    agentId: () => Promise.resolve(agentId),
    poll: { attempts: 3, intervalMs: 0 },
  };
  Object.assign(h, {
    deps,
    clock,
    store,
    log,
    agent,
    agentId,
    fake,
    posted,
    builder,
    sign712,
    verify,
    approve: (amount: bigint, extra: Partial<Record<string, unknown>> = {}) =>
      Promise.resolve({
        body: {
          v: 1,
          op: 'credits.deposit',
          agent: agentId,
          owner: `0x${'0f'.repeat(32)}`,
          nonce: encodeBase64url(randomBytes(16)),
          issuedAt: clock.t,
          expiresAt: clock.t + 600,
          params: { chainId: 84532, token: 'USDC', amount: amount.toString() },
          ...extra,
        },
        sig: 'owner-signed',
      }),
  });
  return h;
}

const ADDRESS = /0x[0-9a-fA-F]{40}/;
const HEX32 = /0x[0-9a-fA-F]{64}/;
const URL_LIKE = /https?:\/\//;

function expectClean(value: unknown): void {
  const text = JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  expect(text).not.toMatch(ADDRESS);
  expect(text).not.toMatch(HEX32);
  expect(text).not.toMatch(URL_LIKE);
}

describe('runGaslessTopUp (M3-4b-t-T4-a)', () => {
  it('1. signs with the agent key only; the owner key is never reachable', async () => {
    const owner = new MemoryOwnerKeyStore(OWNER_SEED, passphrase());
    opened.push(owner);
    const ownerSpies = [
      vi.spyOn(owner, 'getPublicKeys'),
      vi.spyOn(owner, 'unlock'),
      vi.spyOn(owner, 'lock'),
    ];
    // The owner seed in EVM form: what a confused wiring would sign with.
    const ownerAsEvm = new MemoryKeyStore(OWNER_SEED);
    opened.push(ownerAsEvm);
    const ownerEvmId = (await ownerAsEvm.getPublicBundle()).agentId;

    const h = await harness();
    // An extra owner field on the deps is never read: the step takes no owner signer at all.
    Object.assign(h.deps, { ownerKeyStore: owner });
    const result = await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
    expect(result).toEqual({ status: 'done' });
    expect(h.posted).toHaveLength(1);
    const recovered = recoverAuthorizationSigner(DOMAIN, (h.posted[0] as DepositAuthorizationRequest).auth);
    expect(recovered).toBe(h.agentId.toLowerCase());
    expect(recovered).not.toBe(ownerEvmId.toLowerCase());
    expect(h.sign712).toHaveBeenCalledTimes(1);
    for (const spy of ownerSpies) expect(spy).toHaveBeenCalledTimes(0);
  });

  it('1b. a KeyStore that is not the agent (the owner seed) is refused: its signature is never posted', async () => {
    const ownerAsEvm = new MemoryKeyStore(OWNER_SEED);
    opened.push(ownerAsEvm);
    const h = await harness({ keyStore: ownerAsEvm });
    const result = await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
    expect(result).toMatchObject({ status: 'failed', reason: 'signer_mismatch' });
    expect(h.posted).toHaveLength(0);
  });

  it('2. honours the kill switch: the real registry (GASLESS_TOPUP_ENABLED false) refuses with no signing and no network call', async () => {
    const h = await harness({ real: true });
    const balance = vi.spyOn(h.fake.chain.state, 'tokenBalance');
    const credits = vi.spyOn(h.fake.chain.state, 'creditsOf');
    const result = await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
    expect(result).toEqual({ status: 'refused', reason: 'gasless_unavailable' });
    expect(h.sign712).toHaveBeenCalledTimes(0);
    expect(h.posted).toHaveLength(0);
    expect(balance).toHaveBeenCalledTimes(0);
    expect(credits).toHaveBeenCalledTimes(0);
  });

  it('3. chain and token gate: Chiado, a mainnet ID, chain 1 and a non-USDC token are refused before signing', async () => {
    for (const params of [
      { chainId: 10200, token: 'USDC' },
      { chainId: 8453, token: 'USDC' },
      { chainId: 1, token: 'USDC' },
      { chainId: 84532, token: 'USDT' },
      { chainId: 84532, token: 'NATIVE' },
    ]) {
      const h = await harness({ config: params.chainId === 10200 ? CHIADO : BASE_SEPOLIA });
      const result = await runGaslessTopUp(h.deps, {
        approval: await h.approve(20n * DOLLAR, {
          params: { ...params, amount: (20n * DOLLAR).toString() },
        }),
      });
      expect(result.status).toBe('refused');
      expect(h.sign712).toHaveBeenCalledTimes(0);
      expect(h.posted).toHaveLength(0);
    }
  });

  it('4. $5 minimum and $50 cap, checked before signing; the signed value is exactly the approved amount', async () => {
    for (const amount of [cents(499), cents(5001)]) {
      const h = await harness();
      const result = await runGaslessTopUp(h.deps, { approval: await h.approve(amount) });
      expect(result).toMatchObject({ status: 'refused' });
      expect(h.sign712).toHaveBeenCalledTimes(0);
    }
    for (const amount of [cents(500), cents(5000), 12_345_678n]) {
      const h = await harness();
      const result = await runGaslessTopUp(h.deps, { approval: await h.approve(amount) });
      expect(result).toEqual({ status: 'done' });
      expect((h.posted[0] as DepositAuthorizationRequest).auth.value).toBe(amount.toString());
    }
  });

  it('5. the authorization window: validAfter 0, validBefore at most now + 900 s', async () => {
    expect(GASLESS_TOPUP_WINDOW_SECONDS).toBe(900);
    const h = await harness();
    await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
    const auth = (h.posted[0] as DepositAuthorizationRequest).auth;
    expect(auth.validAfter).toBe('0');
    const window = Number(auth.validBefore) - h.clock.t;
    expect(window).toBeGreaterThan(0);
    expect(window).toBeLessThanOrEqual(900);
    expect(h.builder.windowSeconds).toBe(900);
  });

  it('5b. an answer from the builder outside the rules (a longer window) is never posted', async () => {
    const calls = { n: 0 } as { n: number; windowSeconds?: number | undefined };
    const inner = fakeBuilder(calls);
    const h = await harness({
      kit: {
        ...chainKit,
        gaslessToken: () => DEPLOYMENT,
        buildReceiveWithAuthorization: ((state, signer, request, options) =>
          inner(state, signer, request, { ...options, windowSeconds: 3_600 })) as ProofKit['buildReceiveWithAuthorization'],
      } as ProofKit,
    });
    const result = await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
    expect(result.status).toBe('failed');
    expect(h.posted).toHaveLength(0);
  });

  it('6. at most 5 approved top-ups per agent per hour, counted in the store (survives a restart)', async () => {
    expect(GASLESS_TOPUP_LIMIT_PER_HOUR).toBe(5);
    const store = new MemoryStore();
    const clock = new FakeClock();
    let h = await harness({ store, clock });
    for (let i = 0; i < 5; i += 1) {
      // The 3rd one fails at the submitter: it still counts (an approved attempt).
      h.answer = i === 2 ? { status: 'unavailable' } : { status: 'submitted' };
      const r = await runGaslessTopUp(h.deps, { approval: await h.approve(5n * DOLLAR) });
      expect(r.status).not.toBe('refused');
      clock.t += 60;
    }
    // A restart: new deps, the same store.
    h = await harness({ store, clock });
    const sixth = await runGaslessTopUp(h.deps, { approval: await h.approve(5n * DOLLAR) });
    expect(sixth).toMatchObject({ status: 'refused', reason: 'rate_limited' });
    expect((sixth as { retryAfter?: number }).retryAfter).toBeGreaterThan(0);
    expect(h.sign712).toHaveBeenCalledTimes(0);
    expect(h.posted).toHaveLength(0);
    // An hour after the first, one slot is free again.
    clock.t += 3_600 - 5 * 60 + 1;
    const later = await runGaslessTopUp(h.deps, { approval: await h.approve(5n * DOLLAR) });
    expect(later).toEqual({ status: 'done' });
  });

  it('7. the submitter answer is untrusted: `submitted` without a credits rise is pending, a rise is done and clears the selector', async () => {
    const h = await harness();
    h.fake.creditOnSubmit = false;
    const pending = await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
    expect(pending).toEqual({ status: 'pending' });

    const h2 = await harness();
    const clear = vi.fn();
    Object.assign(h2.deps, { selector: { clear } });
    const done = await runGaslessTopUp(h2.deps, { approval: await h2.approve(20n * DOLLAR) });
    expect(done).toEqual({ status: 'done' });
    expect(clear).toHaveBeenCalled();
  });

  it('8. every port answer maps to a fixed word; no txHash, signature, nonce, address or URL in results or logs', async () => {
    const answers: DepositAuthAnswer[] = [
      { status: 'submitted' },
      { status: 'rate_limited' },
      { status: 'already_used' },
      { status: 'unavailable' },
      { status: 'refused', code: 'expired' },
      { status: 'refused', code: 'simulation_failed' },
      { status: 'refused', code: 'something_new' as never },
    ];
    for (const answer of answers) {
      const h = await harness();
      h.answer = answer;
      const result = await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
      expect(['done', 'pending', 'failed']).toContain(result.status);
      if (result.status === 'failed') {
        expect(['rate_limited', 'already_used', 'unavailable', 'refused']).toContain(result.reason);
      }
      expectClean(result);
      expectClean(h.log.calls);
    }
    // A port that throws (with a URL and an address in its text) is unavailable, and that text goes nowhere.
    const h = await harness();
    (h.deps.platform as { depositAuth: DepositAuthPort }).depositAuth = {
      submit: () => Promise.reject(new Error(`https://submitter.example/x 0x${'ab'.repeat(20)}`)),
    };
    const thrown = await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
    expect(thrown).toEqual({ status: 'failed', reason: 'unavailable' });
    expectClean(thrown);
    expectClean(h.log.calls);
  });

  it('6b. owner decision (4): every approved attempt counts, also when none went through', async () => {
    const h = await harness();
    h.answer = { status: 'unavailable' };
    for (let i = 0; i < 5; i += 1) {
      const r = await runGaslessTopUp(h.deps, { approval: await h.approve(5n * DOLLAR) });
      expect(r).toEqual({ status: 'failed', reason: 'unavailable' });
    }
    h.answer = { status: 'submitted' };
    const sixth = await runGaslessTopUp(h.deps, { approval: await h.approve(5n * DOLLAR) });
    expect(sixth).toMatchObject({ status: 'refused', reason: 'rate_limited' });
    expect(h.sign712).toHaveBeenCalledTimes(5);
  });

  it('9b. owner decision (2): owner-started only, no MCP tool or agent request path reaches it', async () => {
    const { MCP_TOOL_NAMES } = await import('@4thtech-io/types');
    expect(MCP_TOOL_NAMES.some((n) => /top.?up|deposit|credit|gasless/i.test(n))).toBe(false);
    const { ProofService } = await import('./service.js');
    expect(
      Object.getOwnPropertyNames(ProofService.prototype).some((n) =>
        /gasless|top.?up|deposit/i.test(n),
      ),
    ).toBe(false);
    // Only the owner-signed credits.deposit path (T4-c, credits-move.ts) may import the step.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = decodeURIComponent(new URL('..', import.meta.url).pathname);
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          entry.name !== 'gasless-topup.ts' &&
          readFileSync(path, 'utf8').includes('gasless-topup')
        ) {
          importers.push(path.slice(root.length));
        }
      }
    };
    walk(root);
    for (const file of importers) expect(file).toBe('proofs/credits-move.ts');
  });

  it('9. not reachable from the core public API', async () => {
    const core = await import('../index.js');
    expect(Object.keys(core)).not.toContain('runGaslessTopUp');
    expect(Object.keys(core).some((k) => /gasless/i.test(k))).toBe(false);
  });

  it('10. concurrent calls are serialised: one balance never yields two signatures above it', async () => {
    const h = await harness();
    h.fake.balance = 30n * DOLLAR;
    h.fake.creditOnSubmit = false; // both stay pending: the first is not yet visible on chain
    const [a, b] = await Promise.all([
      runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) }),
      runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) }),
    ]);
    expect(h.sign712).toHaveBeenCalledTimes(1);
    expect([a.status, b.status].sort()).toEqual(['pending', 'refused']);
  });

  describe('owner approval is required', () => {
    it('refuses without an approval: nothing is verified, signed or sent', async () => {
      const h = await harness();
      for (const approval of [undefined, null, {}, 'x']) {
        const result = await runGaslessTopUp(h.deps, { approval });
        expect(result.status).toBe('refused');
      }
      expect(h.sign712).toHaveBeenCalledTimes(0);
      expect(h.posted).toHaveLength(0);
    });

    it('refuses an object the verifier does not accept', async () => {
      const h = await harness();
      const approval = { ...((await h.approve(20n * DOLLAR)) as object), sig: 'forged' };
      const result = await runGaslessTopUp(h.deps, { approval });
      expect(result).toEqual({ status: 'refused', reason: 'approval_invalid' });
      expect(h.sign712).toHaveBeenCalledTimes(0);
    });

    it('refuses when the verifier vouches for another object (action hash mismatch)', async () => {
      const h = await harness();
      const other = await h.approve(20n * DOLLAR);
      h.verify.mockResolvedValueOnce({ ok: true, actionHash: ownerActionHash(other) });
      const result = await runGaslessTopUp(h.deps, { approval: await h.approve(50n * DOLLAR) });
      expect(result).toEqual({ status: 'refused', reason: 'approval_invalid' });
      expect(h.sign712).toHaveBeenCalledTimes(0);
    });

    it('refuses an approval for another agent, an expired one and one living over 600 s', async () => {
      const h = await harness();
      for (const extra of [
        { agent: `0x${'11'.repeat(20)}` },
        { issuedAt: h.clock.t - 700, expiresAt: h.clock.t - 100 },
        { expiresAt: h.clock.t + 601 },
      ]) {
        const result = await runGaslessTopUp(h.deps, {
          approval: await h.approve(20n * DOLLAR, extra),
        });
        expect(result).toEqual({ status: 'refused', reason: 'approval_invalid' });
      }
      expect(h.sign712).toHaveBeenCalledTimes(0);
    });

    it('one approval gives at most one authorization, also after a restart', async () => {
      const store = new MemoryStore();
      const clock = new FakeClock();
      const h = await harness({ store, clock });
      const approval = await h.approve(20n * DOLLAR);
      expect(await runGaslessTopUp(h.deps, { approval })).toEqual({ status: 'done' });
      expect(await runGaslessTopUp(h.deps, { approval })).toEqual({
        status: 'refused',
        reason: 'approval_used',
      });
      const restarted = await harness({ store, clock });
      expect(await runGaslessTopUp(restarted.deps, { approval })).toEqual({
        status: 'refused',
        reason: 'approval_used',
      });
      expect(h.sign712).toHaveBeenCalledTimes(1);
      expect(restarted.sign712).toHaveBeenCalledTimes(0);
    });

    it('the approval is recorded before signing (owner_action_nonces row)', async () => {
      const h = await harness();
      const approval = (await h.approve(20n * DOLLAR)) as { body: { nonce: string } };
      let rowAtSign: unknown;
      h.sign712.mockImplementationOnce(async function (this: unknown, ...args: unknown[]) {
        rowAtSign = await h.store.transaction((tx) =>
          tx.get('owner_action_nonces', { nonce: approval.body.nonce }),
        );
        return MemoryKeyStore.prototype.sign712.apply(h.agent, args as never);
      });
      await runGaslessTopUp(h.deps, { approval });
      expect(rowAtSign).toMatchObject({
        op: 'credits.deposit',
        action_hash: ownerActionHash(approval),
      });
    });
  });

  it('refuses when the platform or the deposit-auth port is missing (no network call)', async () => {
    const h = await harness();
    const approval = await h.approve(20n * DOLLAR);
    expect(
      await runGaslessTopUp({ ...h.deps, platform: undefined }, { approval }),
    ).toEqual({ status: 'refused', reason: 'not_available' });
    const { depositAuth: _drop, ...noPort } = h.deps.platform as ProofsPlatform;
    expect(await runGaslessTopUp({ ...h.deps, platform: noPort }, { approval })).toEqual({
      status: 'refused',
      reason: 'not_available',
    });
    expect(h.sign712).toHaveBeenCalledTimes(0);
  });

  it('refuses more than the agent holds before signing', async () => {
    const h = await harness();
    h.fake.balance = 10n * DOLLAR;
    const result = await runGaslessTopUp(h.deps, { approval: await h.approve(20n * DOLLAR) });
    expect(result).toEqual({ status: 'refused', reason: 'amount_unavailable' });
    expect(h.sign712).toHaveBeenCalledTimes(0);
  });
});
