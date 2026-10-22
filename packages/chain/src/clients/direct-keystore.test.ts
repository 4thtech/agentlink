// M1-4c-b: direct mode signs through the KeyStore (07 §6.2; 05 §2.5; 04 §2.1, §8.1). The chain
// package holds no key: keyStoreDirectSigner hands each transaction it built to
// KeyStore.signTransaction, createDirectMode wires it for a testnet only, and sendWithdraw is the
// typed withdraw API (the agent's own credits back to its own account).
//
// No network and no real KeyStore here (packages/core runs MemoryKeyStore end to end, and every
// backend runs the shared conformance suite): the KeyStore double applies crypto's own policy check
// (directTransactionSnapshot) and signs with a test key. Keys are test values built at run time.
import {
  CryptoInputError,
  DIRECT_TX_ALLOWLIST,
  DIRECT_TX_SELECTORS,
  TRANSACTION_REFUSED,
  directTransactionSnapshot,
  type DirectTransaction,
  type KeyStore,
} from '@4thtech-io/crypto';
import {
  decodeFunctionData,
  erc20Abi,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
  type Abi,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { ChainConfigError, type ChainConfig } from '../config/index.js';
import { buildWithdraw, sendDeposit, sendWithdraw, buildDeposit } from '../fees/index.js';
import type { Hex } from '../ids/index.js';
import {
  ChainError,
  FEE_VAULT_CLIENT_ABI,
  NOTARY_CLIENT_ABI,
  chainRegistry,
  createDirectMode,
  getChainConfig,
  keyStoreDirectSigner,
  sendDirect,
  type ChainState,
  type ContractTx,
  type DirectMode,
} from './index.js';

const CHIADO = getChainConfig(10200) as ChainConfig;
const BASE_SEPOLIA = getChainConfig(84532) as ChainConfig;
const ACCOUNT = privateKeyToAccount(`0x${'a7'.repeat(32)}` as ViemHex);
const AGENT = ACCOUNT.address.toLowerCase() as Hex;
const OTHER = `0x${'22'.repeat(20)}` as Hex;
const ZERO = `0x${'0'.repeat(40)}` as Hex;
const ADDRESS_CHECKED = Symbol.for('agentlink.address-checked-rpc-fetch');

/** A KeyStore double: crypto's policy check, then a test-key signature. */
function fakeKeys(address: Hex = AGENT) {
  const asked: DirectTransaction[] = [];
  const keys: Pick<KeyStore, 'getPublicBundle' | 'signTransaction'> = {
    getPublicBundle: vi.fn(() =>
      Promise.resolve({ agentId: address } as Awaited<ReturnType<KeyStore['getPublicBundle']>>),
    ),
    signTransaction: vi.fn(async (tx: DirectTransaction) => {
      asked.push(tx);
      const snap = directTransactionSnapshot(tx, address);
      const { type: _type, ...fields } = snap;
      return ACCOUNT.signTransaction({
        ...fields,
        type: 'eip1559',
        to: snap.to as ViemHex,
        data: snap.data as ViemHex,
      });
    }),
  };
  return { keys, asked };
}

/** A chain that simulates every allowed call as fine and mines at once. */
function fakeState(config: ChainConfig) {
  const simulated: ContractTx[] = [];
  const state = {
    config,
    simulate: (tx: ContractTx) => {
      simulated.push(tx);
      return Promise.resolve({ ok: true as const, gas: 60_000n });
    },
    fees: () => Promise.resolve({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n }),
    pendingNonce: () => Promise.resolve(9),
    nativeBalance: () => Promise.resolve(10n ** 18n),
    txStatus: () => Promise.resolve('success' as const),
  } as unknown as ChainState;
  return { state, simulated };
}

function directOver(config: ChainConfig, keys: Pick<KeyStore, 'getPublicBundle' | 'signTransaction'>) {
  const sent: Hex[] = [];
  return {
    sent,
    make: async (): Promise<DirectMode> => ({
      signer: await keyStoreDirectSigner(keys),
      broadcast: (raw: Hex) => {
        sent.push(raw);
        return Promise.resolve();
      },
    }),
    config,
  };
}

const checkedFetch = () => {
  const fn = vi.fn(() => Promise.reject(new Error('no network in this test')));
  Object.defineProperty(fn, ADDRESS_CHECKED, { value: true });
  return fn;
};

describe('keyStoreDirectSigner (M1-4c-b)', () => {
  it("uses the KeyStore's EVM address and passes the built transaction through unchanged", async () => {
    const { keys, asked } = fakeKeys();
    const signer = await keyStoreDirectSigner(keys);
    expect(signer.address).toBe(AGENT);
    const { state } = fakeState(CHIADO);
    const d = directOver(CHIADO, keys);
    const out = await sendDirect(state, await d.make(), {
      contract: 'vault',
      to: CHIADO.contracts.vault as Hex,
      value: 5n,
      functionName: 'deposit',
      args: [ZERO, 5n],
    });
    expect(out.ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ type: 'eip1559', chainId: 10200, nonce: 9, value: 5n });
    const raw = d.sent[0] as Hex;
    expect((await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase()).toBe(AGENT);
  });

  it('a KeyStore refusal is ChainError signing_refused: nothing is broadcast, no input in the text', async () => {
    const keys = {
      getPublicBundle: () =>
        Promise.resolve({ agentId: AGENT } as Awaited<ReturnType<KeyStore['getPublicBundle']>>),
      signTransaction: () =>
        Promise.reject(
          new CryptoInputError('transaction_refused', TRANSACTION_REFUSED.chain_not_allowed),
        ),
    };
    const { state } = fakeState(CHIADO);
    const d = directOver(CHIADO, keys);
    const err = await sendDirect(state, await d.make(), {
      contract: 'vault',
      to: CHIADO.contracts.vault as Hex,
      value: 5n,
      functionName: 'deposit',
      args: [ZERO, 5n],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainError);
    expect((err as ChainError).code).toBe('signing_refused');
    expect((err as Error).message).not.toMatch(/0x/);
    expect(d.sent).toHaveLength(0);
  });

  it('refuses a KeyStore whose address is not an EVM address', async () => {
    const { keys } = fakeKeys('nope' as Hex);
    await expect(keyStoreDirectSigner(keys)).rejects.toMatchObject({ code: 'invalid_call' });
  });
});

describe('createDirectMode (M1-4c-b): testnets of the KeyStore allowlist only', () => {
  it('builds a KeyStore signer and a broadcaster for Chiado and Base Sepolia', async () => {
    for (const config of [CHIADO, BASE_SEPOLIA]) {
      const { keys } = fakeKeys();
      const direct = await createDirectMode(config, keys, { fetchFn: checkedFetch() });
      expect(direct.signer.address).toBe(AGENT);
      expect(typeof direct.broadcast).toBe('function');
    }
  });

  it('refuses a mainnet, a chain outside the allowlist and a config whose contracts differ, before the KeyStore is asked', async () => {
    const cases: ChainConfig[] = [
      { ...CHIADO, chainId: 100, key: 'gnosis', testnet: false },
      { ...CHIADO, testnet: false },
      { ...CHIADO, chainId: 31337, key: 'local' },
      { ...CHIADO, contracts: { ...CHIADO.contracts, vault: OTHER } },
      { ...CHIADO, contracts: { ...CHIADO.contracts, notary: OTHER } },
    ];
    for (const config of cases) {
      const { keys } = fakeKeys();
      const err = await createDirectMode(config, keys, { fetchFn: checkedFetch() }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ChainConfigError);
      expect((err as ChainConfigError).code).toBe('direct_mode_unavailable');
      expect(keys.getPublicBundle).not.toHaveBeenCalled();
    }
  });
});

describe('sendDeposit on Chiado through the KeyStore (D-123 top-up)', () => {
  it('one native deposit(address(0), amount) carrying the amount, signed by the agent', async () => {
    const { keys, asked } = fakeKeys();
    const { state, simulated } = fakeState(CHIADO);
    const d = directOver(CHIADO, keys);
    const amount = 10n ** 16n;
    const steps = buildDeposit(CHIADO, { token: 'NATIVE', amount });
    const out = await sendDeposit(state, await d.make(), { token: 'NATIVE', amount }, steps, {
      pollMs: 1,
      waitMs: 1,
    });
    expect(out.txHashes).toHaveLength(1);
    expect(simulated).toHaveLength(1);
    expect(asked).toHaveLength(1);
    const got = parseTransaction(d.sent[0] as ViemHex);
    expect(got.chainId).toBe(10200);
    expect(got.to?.toLowerCase()).toBe(CHIADO.contracts.vault);
    expect(got.value).toBe(amount);
    const call = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: got.data as ViemHex });
    expect(call.functionName).toBe('deposit');
    expect(call.args).toEqual([ZERO, amount]);
  });
});

describe('buildWithdraw and sendWithdraw (M1-4c-b): the typed withdraw API', () => {
  it('buildWithdraw: withdraw(token, amount, to) on the vault, no value', () => {
    const step = buildWithdraw(CHIADO, { token: 'NATIVE', amount: 7n, to: AGENT });
    expect(step.to).toBe(CHIADO.contracts.vault);
    expect(step.value).toBe(0n);
    const call = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: step.data });
    expect(call.functionName).toBe('withdraw');
    expect(call.args).toEqual([ZERO, 7n, AGENT]);
  });

  it('buildWithdraw refuses a bad amount, a malformed recipient and a token not offered', () => {
    expect(() => buildWithdraw(CHIADO, { token: 'NATIVE', amount: 0n, to: AGENT })).toThrow();
    expect(() => buildWithdraw(CHIADO, { token: 'NATIVE', amount: 1n, to: 'x' })).toThrow();
    expect(() => buildWithdraw(CHIADO, { token: 'USDC', amount: 1n, to: AGENT })).toThrow();
  });

  it("sendWithdraw sends the agent's own credits to the agent's own account", async () => {
    const { keys, asked } = fakeKeys();
    const { state } = fakeState(CHIADO);
    const d = directOver(CHIADO, keys);
    const out = await sendWithdraw(state, await d.make(), { token: 'NATIVE', amount: 3n }, {
      pollMs: 1,
      waitMs: 1,
    });
    expect(out.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(asked).toHaveLength(1);
    const got = parseTransaction(d.sent[0] as ViemHex);
    expect(got.value ?? 0n).toBe(0n);
    const call = decodeFunctionData({ abi: FEE_VAULT_CLIENT_ABI, data: got.data as ViemHex });
    expect(call.args).toEqual([ZERO, 3n, AGENT]);
  });

  it('a withdraw to another account is refused by the KeyStore, whatever path built it', async () => {
    const { keys } = fakeKeys();
    const { state } = fakeState(CHIADO);
    const d = directOver(CHIADO, keys);
    const err = await sendDirect(state, await d.make(), {
      contract: 'vault',
      to: CHIADO.contracts.vault as Hex,
      value: 0n,
      functionName: 'withdraw',
      args: [ZERO, 3n, OTHER],
    }).catch((e: unknown) => e);
    expect((err as ChainError).code).toBe('signing_refused');
    expect(d.sent).toHaveLength(0);
  });
});

describe("the KeyStore's direct-mode allowlist matches the shipped chains and ABIs (no drift)", () => {
  it('every testnet deployment: the same Notary, vault and ERC-20 fee tokens', () => {
    const testnets = chainRegistry().filter((c) => c.testnet);
    expect(testnets.map((c) => c.chainId).sort()).toEqual(
      Object.keys(DIRECT_TX_ALLOWLIST).map(Number).sort(),
    );
    for (const c of testnets) {
      const allowed = DIRECT_TX_ALLOWLIST[c.chainId];
      expect(allowed?.notary).toBe(c.contracts.notary.toLowerCase());
      expect(allowed?.vault).toBe(c.contracts.vault.toLowerCase());
      expect([...(allowed?.feeTokens ?? [])].sort()).toEqual(
        c.feeTokens
          .map((t) => t.address)
          .filter((a): a is `0x${string}` => a !== null)
          .map((a) => a.toLowerCase())
          .sort(),
      );
    }
    expect(chainRegistry().some((c) => !c.testnet && DIRECT_TX_ALLOWLIST[c.chainId])).toBe(false);
  });

  it('the selectors are the client ABI functions', () => {
    const sel = (abi: Abi, name: string) => {
      const f = abi.find((x) => x.type === 'function' && x.name === name);
      if (f === undefined || f.type !== 'function') throw new Error(`no ${name}`);
      return toFunctionSelector(f);
    };
    expect({ ...DIRECT_TX_SELECTORS }).toEqual({
      notarizeDirect: sel(NOTARY_CLIENT_ABI as Abi, 'notarizeDirect'),
      notarizeBatch: sel(NOTARY_CLIENT_ABI as Abi, 'notarizeBatch'),
      acknowledge: sel(NOTARY_CLIENT_ABI as Abi, 'acknowledge'),
      acknowledgeBatch: sel(NOTARY_CLIENT_ABI as Abi, 'acknowledgeBatch'),
      deposit: sel(FEE_VAULT_CLIENT_ABI as Abi, 'deposit'),
      withdraw: sel(FEE_VAULT_CLIENT_ABI as Abi, 'withdraw'),
      approve: sel(erc20Abi as Abi, 'approve'),
    });
  });
});
