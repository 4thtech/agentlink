// M1-11c-a4c: add credits by QR on Chiado, and withdraw credits (D-122, D-123; 12 §4.1, §4.4;
// 05 §2.5; 04 §2.5, §2.5.1; 07 §6.2). Written from the card:
// - `topUp()` names where the agent can be paid: on Chiado (the one top-up chain for now) the agent's
//   own address, what that account holds, how much of it can become credits after the gas reserve,
//   and the credits it can withdraw; on another testnet "coming soon"; a mainnet never appears.
// - `addReceivedFunds(signed)` turns received xDAI into the agent's own credits with the agent's own
//   `deposit`, signed by the KeyStore, only after a fresh owner-signed `credits.deposit` (owner
//   presence, 04 §2.5) that names the exact chain, token and amount. The gas reserve always stays in
//   the account; a mainnet or another chain is refused before any key or network is used.
// - `withdrawCredits(signed)` sends credits back with `withdraw(token, amount, to)` only after a
//   fresh owner-signed `credits.withdraw`; `to` must be the agent's own account (IR-M1-4c-b-1 M-1:
//   the recipient grant is a later card).
// - Each signed object applies once (its nonce is recorded before anything is sent). The generic
//   `ownerActions.apply` refuses the credits ops: only these two paths send.
// - Results are fixed words: no transaction hash, key, URL or error text.
import * as chainKit from '@4thtech-io/chain';
import {
  getChainConfig,
  keyStoreDirectSigner,
  type ChainConfig,
  type ChainState,
  type ContractTx,
  type DirectKeys,
  type DirectMode,
  type Hex,
} from '@4thtech-io/chain';
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import type { JsonObject } from '@4thtech-io/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentLinkClient } from '../client.js';
import { MemoryStore } from '../store/memory-store.js';
import { type TestAgent, type TestOwner } from '../testing/envelopes.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  seed,
} from '../testing/fixtures.js';
import { MemoryPolicyMark, newNonce, ownerHex, signWith } from '../testing/owner.js';
import type { ProofChain, ProofsPlatform } from './platform.js';
import { TOP_UP_CHAIN_IDS, TOP_UP_GAS_RESERVE_WEI, TOP_UP_MIN_WEI } from './credits-move.js';

const CHIADO = getChainConfig(10200) as ChainConfig;
const BASE_SEPOLIA = getChainConfig(84532) as ChainConfig;
const GNOSIS_MAINNET: ChainConfig = { ...CHIADO, chainId: 100, key: 'gnosis', testnet: false };
const XDAI = 10n ** 18n;
const ZERO = `0x${'0'.repeat(40)}`;
const OTHER = `0x${'22'.repeat(20)}`;

/** Anything that must never appear in a result (I-7). */
const FORBIDDEN =
  /salt|secret|seed|private|signed|signature|sig\b|url|key\b|tx_?hash|txHash|wallet|gas|0x[0-9a-f]{64}/i;

interface FakeChain {
  readonly chain: ProofChain;
  native: bigint;
  credits: bigint;
  status: 'success' | 'reverted' | 'pending';
  readonly simulated: ContractTx[];
  readonly sent: Hex[];
  directAsked: number;
}

/** One chain whose state is in memory; direct mode signs with the agent KeyStore it is handed. */
function fakeChain(config: ChainConfig, withDirect = true): FakeChain {
  const fake: FakeChain = {
    native: 0n,
    credits: 0n,
    status: 'success',
    simulated: [],
    sent: [],
    directAsked: 0,
    chain: undefined as unknown as ProofChain,
  };
  const state = {
    config,
    simulate: (tx: ContractTx) => {
      fake.simulated.push(tx);
      return Promise.resolve({ ok: true as const, gas: 80_000n });
    },
    fees: () => Promise.resolve({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    pendingNonce: () => Promise.resolve(0),
    nativeBalance: () => Promise.resolve(fake.native),
    creditsOf: () => Promise.resolve(fake.credits),
    txStatus: () => Promise.resolve(fake.status),
  } as unknown as ChainState;
  const directMode = async (keys: DirectKeys): Promise<DirectMode> => {
    fake.directAsked += 1;
    return {
      signer: await keyStoreDirectSigner(keys),
      broadcast: (raw: Hex) => {
        fake.sent.push(raw);
        return Promise.resolve();
      },
    };
  };
  (fake as { chain: ProofChain }).chain = {
    config,
    client: {} as ProofChain['client'],
    state,
    submitter: {} as ProofChain['submitter'],
    ...(withDirect ? { directMode } : {}),
  };
  return fake;
}

function platformOf(...chains: FakeChain[]): ProofsPlatform {
  return {
    kit: chainKit,
    chains: chains.map((c) => c.chain),
    directPoll: { pollMs: 1, waitMs: 1, sleep: () => Promise.resolve() },
  };
}

const asOwner = (o: MemoryOwnerKeyStore): TestOwner => o as unknown as TestOwner;

async function openAgent(clock: FakeClock, n: number, proofs?: ProofsPlatform): Promise<TestAgent> {
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
    ...(proofs === undefined ? {} : { proofs }),
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

async function signedOp(
  a: TestAgent,
  op: 'credits.deposit' | 'credits.withdraw',
  params: JsonObject,
  over: Partial<JsonObject> = {},
) {
  const body: JsonObject = {
    v: 1,
    agent: a.id,
    owner: await ownerHex(a.owner),
    op,
    params,
    nonce: newNonce(),
    issuedAt: clock.t,
    expiresAt: clock.t + 600,
    ...over,
  };
  return signWith(a.owner, body);
}

const deposit = (amount: bigint, chainId = 10200, token = 'NATIVE'): JsonObject => ({
  chainId,
  token,
  amount: amount.toString(),
});
const withdraw = (amount: bigint, to: string, chainId = 10200): JsonObject => ({
  chainId,
  token: 'NATIVE',
  amount: amount.toString(),
  to,
});

function expectClean(value: unknown): void {
  expect(JSON.stringify(value)).not.toMatch(FORBIDDEN);
}

describe('topUp: where to send funds (M1-11c-a4c, D-123)', () => {
  it('the top-up chain is Chiado only, with a gas reserve and a minimum', () => {
    expect(TOP_UP_CHAIN_IDS).toEqual([10200]);
    expect(Object.isFrozen(TOP_UP_CHAIN_IDS)).toBe(true);
    expect(TOP_UP_GAS_RESERVE_WEI).toBe(10n ** 16n);
    expect(TOP_UP_MIN_WEI).toBe(10n ** 17n);
  });

  it('without a proofs platform: unavailable', async () => {
    const a = await openAgent(clock, 60);
    expect(await a.client.proofs.topUp()).toEqual({ status: 'unavailable' });
  });

  it('Chiado: the agent address, what arrived, what can become credits after the reserve', async () => {
    const chiado = fakeChain(CHIADO);
    const base = fakeChain(BASE_SEPOLIA);
    const a = await openAgent(clock, 61, platformOf(base, chiado));
    chiado.native = 5n * XDAI;
    chiado.credits = 2n * XDAI;
    const got = await a.client.proofs.topUp();
    expect(got).toEqual({
      status: 'ok',
      agentId: a.id,
      chains: [
        { chainId: 84532, chain: BASE_SEPOLIA.key, method: 'coming_soon' },
        {
          chainId: 10200,
          chain: CHIADO.key,
          method: 'address',
          available: true,
          token: 'NATIVE',
          received: { amount: (5n * XDAI).toString(), usd: '5' },
          addable: { amount: (5n * XDAI - TOP_UP_GAS_RESERVE_WEI).toString(), usd: '4.99' },
          credits: { amount: (2n * XDAI).toString(), usd: '2' },
        },
      ],
    });
    expect(a.id).toMatch(/^0x[0-9a-f]{40}$/);
    // A read never asks for direct mode (no key use).
    expect(chiado.directAsked + base.directAsked).toBe(0);
  });

  it('below the minimum after the reserve, nothing can be added yet', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 62, platformOf(chiado));
    chiado.native = TOP_UP_MIN_WEI + TOP_UP_GAS_RESERVE_WEI - 1n;
    const got = await a.client.proofs.topUp();
    expect(got.status === 'ok' && got.chains[0]).toMatchObject({
      method: 'address',
      addable: { amount: '0', usd: '0' },
    });
  });

  it('a mainnet is never offered, and a chain without direct mode is coming soon', async () => {
    const main = fakeChain(GNOSIS_MAINNET);
    const noDirect = fakeChain(CHIADO, false);
    const a = await openAgent(clock, 63, platformOf(main, noDirect));
    const got = await a.client.proofs.topUp();
    expect(got).toEqual({
      status: 'ok',
      agentId: a.id,
      chains: [{ chainId: 10200, chain: CHIADO.key, method: 'coming_soon' }],
    });
  });

  it('a Chiado read that fails is listed as not available, with no error text', async () => {
    const chiado = fakeChain(CHIADO);
    (chiado.chain.state as { nativeBalance: unknown }).nativeBalance = () =>
      Promise.reject(new Error('https://rpc.example/KEY-IN-PATH'));
    const a = await openAgent(clock, 64, platformOf(chiado));
    const got = await a.client.proofs.topUp();
    expect(got).toEqual({
      status: 'ok',
      agentId: a.id,
      chains: [{ chainId: 10200, chain: CHIADO.key, method: 'address', available: false }],
    });
    expect(JSON.stringify(got)).not.toContain('KEY-IN-PATH');
  });
});

describe('addReceivedFunds: received xDAI becomes credits (owner presence)', () => {
  it('deposits exactly the signed amount from the agent account, signed by its KeyStore', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 65, platformOf(chiado));
    chiado.native = 5n * XDAI;
    const amount = 5n * XDAI - TOP_UP_GAS_RESERVE_WEI;
    const result = await a.client.proofs.addReceivedFunds(
      await signedOp(a, 'credits.deposit', deposit(amount)),
    );
    expect(result).toEqual({ status: 'done' });
    expect(chiado.simulated.map((t) => [t.functionName, t.value, t.from])).toEqual([
      ['deposit', amount, a.id],
    ]);
    // sendDirect broadcasts only bytes that parse to exactly the simulated call (M1-4c-b).
    expect(chiado.sent).toHaveLength(1);
    expect(chiado.simulated[0]?.to.toLowerCase()).toBe(CHIADO.contracts.vault.toLowerCase());
    expectClean(result);
  });

  it('keeps the gas reserve: an amount that would spend it is refused, nothing is signed', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 66, platformOf(chiado));
    chiado.native = 5n * XDAI;
    for (const amount of [5n * XDAI, 5n * XDAI - TOP_UP_GAS_RESERVE_WEI + 1n]) {
      const result = await a.client.proofs.addReceivedFunds(
        await signedOp(a, 'credits.deposit', deposit(amount)),
      );
      expect(result).toEqual({ status: 'refused', reason: 'amount_unavailable' });
    }
    expect(chiado.directAsked).toBe(0);
    expect(chiado.sent).toHaveLength(0);
  });

  it('refuses an amount below the minimum', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 67, platformOf(chiado));
    chiado.native = 5n * XDAI;
    const result = await a.client.proofs.addReceivedFunds(
      await signedOp(a, 'credits.deposit', deposit(TOP_UP_MIN_WEI - 1n)),
    );
    expect(result).toEqual({ status: 'refused', reason: 'below_minimum' });
    expect(chiado.sent).toHaveLength(0);
  });

  it('refuses without a valid owner signature, for another agent, expired or replayed', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 68, platformOf(chiado));
    chiado.native = 5n * XDAI;
    const good = await signedOp(a, 'credits.deposit', deposit(XDAI));
    const forged = { body: good.body, sig: 'ab'.repeat(64) };
    expect(await a.client.proofs.addReceivedFunds(forged)).toEqual({
      status: 'refused',
      reason: 'signature_invalid',
    });
    expect(await a.client.proofs.addReceivedFunds({ body: good.body })).toEqual({
      status: 'refused',
      reason: 'malformed',
    });
    const other = await signedOp(a, 'credits.deposit', deposit(XDAI), { agent: OTHER });
    expect(await a.client.proofs.addReceivedFunds(other)).toEqual({
      status: 'refused',
      reason: 'agent_mismatch',
    });
    const old = await signedOp(a, 'credits.deposit', deposit(XDAI), {
      issuedAt: clock.t - 1000,
      expiresAt: clock.t - 400,
    });
    expect(await a.client.proofs.addReceivedFunds(old)).toEqual({
      status: 'refused',
      reason: 'expired',
    });
    expect(chiado.sent).toHaveLength(0);
    expect(await a.client.proofs.addReceivedFunds(good)).toEqual({ status: 'done' });
    expect(await a.client.proofs.addReceivedFunds(good)).toEqual({
      status: 'refused',
      reason: 'nonce_used',
    });
    expect(chiado.sent).toHaveLength(1);
  });

  it('refuses a withdraw object, and the generic apply refuses both credits ops', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 69, platformOf(chiado));
    chiado.native = 5n * XDAI;
    chiado.credits = 5n * XDAI;
    const w = await signedOp(a, 'credits.withdraw', withdraw(XDAI, a.id));
    expect(await a.client.proofs.addReceivedFunds(w)).toEqual({
      status: 'refused',
      reason: 'malformed',
    });
    const d = await signedOp(a, 'credits.deposit', deposit(XDAI));
    expect(await a.client.ownerActions.apply(d)).toMatchObject({
      status: 'refused',
      reason: 'unsupported_op',
      nonceBurnt: false,
    });
    expect(await a.client.ownerActions.apply(w)).toMatchObject({
      status: 'refused',
      reason: 'unsupported_op',
    });
    expect(chiado.sent).toHaveLength(0);
    // Still unused: the credits path applies it once.
    expect(await a.client.proofs.addReceivedFunds(d)).toEqual({ status: 'done' });
  });

  it('refuses a mainnet, another chain or token before direct mode is asked', async () => {
    const main = fakeChain(GNOSIS_MAINNET);
    const base = fakeChain(BASE_SEPOLIA);
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 70, platformOf(main, base, chiado));
    main.native = base.native = chiado.native = 5n * XDAI;
    for (const params of [deposit(XDAI, 100), deposit(XDAI, 84532), deposit(XDAI, 10200, 'USDC')]) {
      const result = await a.client.proofs.addReceivedFunds(
        await signedOp(a, 'credits.deposit', params),
      );
      expect(result).toEqual({ status: 'refused', reason: 'not_available' });
    }
    expect(main.directAsked + base.directAsked + chiado.directAsked).toBe(0);
  });

  it('a deposit not yet included is pending; a revert or missing gas is a fixed failure', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 71, platformOf(chiado));
    chiado.native = 5n * XDAI;
    chiado.status = 'pending';
    expect(
      await a.client.proofs.addReceivedFunds(await signedOp(a, 'credits.deposit', deposit(XDAI))),
    ).toEqual({ status: 'pending' });
    chiado.status = 'reverted';
    const reverted = await a.client.proofs.addReceivedFunds(
      await signedOp(a, 'credits.deposit', deposit(XDAI)),
    );
    expect(reverted).toEqual({ status: 'failed', reason: 'reverted' });
    expectClean(reverted);
  });

  it('a revert after the nonce was recorded burns the object: a replay is refused', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 76, platformOf(chiado));
    chiado.native = 5n * XDAI;
    chiado.status = 'reverted';
    const once = await signedOp(a, 'credits.deposit', deposit(XDAI));
    expect(await a.client.proofs.addReceivedFunds(once)).toEqual({
      status: 'failed',
      reason: 'reverted',
    });
    expect(chiado.sent).toHaveLength(1);
    chiado.status = 'success';
    expect(await a.client.proofs.addReceivedFunds(once)).toEqual({
      status: 'refused',
      reason: 'nonce_used',
    });
    expect(chiado.sent).toHaveLength(1);
    expect(chiado.directAsked).toBe(1);
  });
});

describe('withdrawCredits: credits back to the agent account (owner presence)', () => {
  it('withdraws the signed amount to the agent own account', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 72, platformOf(chiado));
    chiado.native = TOP_UP_GAS_RESERVE_WEI;
    chiado.credits = 3n * XDAI;
    const result = await a.client.proofs.withdrawCredits(
      await signedOp(a, 'credits.withdraw', withdraw(3n * XDAI, a.id)),
    );
    expect(result).toEqual({ status: 'done' });
    expect(chiado.simulated.map((t) => [t.functionName, t.args])).toEqual([
      ['withdraw', [ZERO, 3n * XDAI, a.id]],
    ]);
    expect(chiado.sent).toHaveLength(1);
    expectClean(result);
  });

  it('refuses another recipient before direct mode is asked (grant not built yet)', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 73, platformOf(chiado));
    chiado.native = XDAI;
    chiado.credits = 3n * XDAI;
    const result = await a.client.proofs.withdrawCredits(
      await signedOp(a, 'credits.withdraw', withdraw(XDAI, OTHER)),
    );
    expect(result).toEqual({ status: 'refused', reason: 'recipient_not_allowed' });
    expect(chiado.directAsked).toBe(0);
    expect(chiado.sent).toHaveLength(0);
  });

  it('refuses more than the credits, a deposit object, a mainnet and a replay', async () => {
    const main = fakeChain(GNOSIS_MAINNET);
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 74, platformOf(main, chiado));
    chiado.native = main.native = XDAI;
    chiado.credits = main.credits = 3n * XDAI;
    expect(
      await a.client.proofs.withdrawCredits(
        await signedOp(a, 'credits.withdraw', withdraw(3n * XDAI + 1n, a.id)),
      ),
    ).toEqual({ status: 'refused', reason: 'amount_unavailable' });
    expect(
      await a.client.proofs.withdrawCredits(await signedOp(a, 'credits.deposit', deposit(XDAI))),
    ).toEqual({ status: 'refused', reason: 'malformed' });
    expect(
      await a.client.proofs.withdrawCredits(
        await signedOp(a, 'credits.withdraw', withdraw(XDAI, a.id, 100)),
      ),
    ).toEqual({ status: 'refused', reason: 'not_available' });
    expect(main.directAsked).toBe(0);
    const once = await signedOp(a, 'credits.withdraw', withdraw(XDAI, a.id));
    expect(await a.client.proofs.withdrawCredits(once)).toEqual({ status: 'done' });
    expect(await a.client.proofs.withdrawCredits(once)).toEqual({
      status: 'refused',
      reason: 'nonce_used',
    });
  });

  it('no gas left for the withdrawal is a fixed failure', async () => {
    const chiado = fakeChain(CHIADO);
    const a = await openAgent(clock, 75, platformOf(chiado));
    chiado.native = 0n;
    chiado.credits = 3n * XDAI;
    const result = await a.client.proofs.withdrawCredits(
      await signedOp(a, 'credits.withdraw', withdraw(XDAI, a.id)),
    );
    expect(result).toEqual({ status: 'failed', reason: 'no_funds_for_fee' });
    expect(chiado.sent).toHaveLength(0);
  });
});
