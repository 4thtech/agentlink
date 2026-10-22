// M1-4c-b: direct-mode sends sign through the KeyStore, end to end (07 §6.2; 05 §2.5; 04 §2.1, §8.1;
// D-123 Chiado top-up). The real chain code (sendDirect, sendDeposit, sendWithdraw,
// keyStoreDirectSigner) runs over an in-memory chain; the signer is a MemoryKeyStore, so the agent's
// EVM key never leaves a KeyStore. sendDirect checks every signed transaction it gets back: it must
// parse to exactly what was built and recover to the KeyStore's address, or nothing is broadcast.
// The keychain backend runs the same signTransaction cases in the shared conformance suite
// (packages/node).
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import {
  buildDeposit,
  getChainConfig,
  keyStoreDirectSigner,
  sendDeposit,
  sendDirect,
  sendWithdraw,
  type ChainConfig,
  type ChainState,
  type ContractTx,
  type DirectMode,
  type Hex,
} from '@4thtech-io/chain';
import { describe, expect, it } from 'vitest';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const CHIADO = getChainConfig(10200) as ChainConfig;
const ZERO = `0x${'0'.repeat(40)}` as Hex;
const H32 = `0x${'ab'.repeat(32)}` as Hex;

/** An in-memory chain that accepts every allowed call and mines it at once. */
function chain(config: ChainConfig) {
  const simulated: ContractTx[] = [];
  const state = {
    config,
    simulate: (tx: ContractTx) => {
      simulated.push(tx);
      return Promise.resolve({ ok: true as const, gas: 80_000n });
    },
    fees: () => Promise.resolve({ maxFeePerGas: 1_500_000_000n, maxPriorityFeePerGas: 1n }),
    pendingNonce: () => Promise.resolve(2),
    nativeBalance: () => Promise.resolve(10n ** 18n),
    txStatus: () => Promise.resolve('success' as const),
  } as unknown as ChainState;
  return { state, simulated };
}

async function directMode(keys: MemoryKeyStore) {
  const sent: Hex[] = [];
  const direct: DirectMode = {
    signer: await keyStoreDirectSigner(keys),
    broadcast: (raw) => {
      sent.push(raw);
      return Promise.resolve();
    },
  };
  return { direct, sent };
}

describe('direct mode signs through the KeyStore (M1-4c-b)', () => {
  it('the signer is the agent EVM address at any key epoch', async () => {
    const keys = new MemoryKeyStore(SEED, { keyEpoch: 3 });
    const { direct } = await directMode(keys);
    expect(direct.signer.address).toBe((await keys.getPublicBundle()).agentId);
    await keys.close();
  });

  it('notarizeBatch and acknowledge from the agent account: signed by the KeyStore, broadcast once each', async () => {
    const keys = new MemoryKeyStore(SEED);
    const agent = (await keys.getPublicBundle()).agentId as Hex;
    const { direct, sent } = await directMode(keys);
    const { state } = chain(CHIADO);
    const record = {
      signer: agent,
      envelopeHash: H32,
      recipientCommitment: H32,
      termsHash: H32,
      contentRef: H32,
      kind: 1,
      feeToken: ZERO,
      maxFee: 1_000n,
      nonce: 5n,
      deadline: 1_800_000_000n,
    };
    const receipt = { signer: agent, recordId: H32, receiptType: 1, salt: H32, deadline: 1_800_000_000n };
    const sig = `0x${'cd'.repeat(65)}`;
    const notary = CHIADO.contracts.notary as Hex;
    const a = await sendDirect(state, direct, {
      contract: 'notary',
      to: notary,
      value: 0n,
      functionName: 'notarizeBatch',
      args: [[record], [sig]],
    });
    const b = await sendDirect(state, direct, {
      contract: 'notary',
      to: notary,
      value: 0n,
      functionName: 'acknowledge',
      args: [receipt, sig],
    });
    const c = await sendDirect(state, direct, {
      contract: 'notary',
      to: notary,
      value: record.maxFee,
      functionName: 'notarizeDirect',
      args: [record],
    });
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    expect(sent).toHaveLength(3);
    for (const raw of sent) expect(raw).toMatch(/^0x02[0-9a-f]+$/);
    await keys.close();
  });

  it('sendDeposit tops up on Chiado: one native deposit signed by the KeyStore', async () => {
    const keys = new MemoryKeyStore(SEED, { keyEpoch: 1 });
    const { direct, sent } = await directMode(keys);
    const { state, simulated } = chain(CHIADO);
    const amount = 5n * 10n ** 16n;
    const out = await sendDeposit(
      state,
      direct,
      { token: 'NATIVE', amount },
      buildDeposit(CHIADO, { token: 'NATIVE', amount }),
      { pollMs: 1, waitMs: 1 },
    );
    expect(out.txHashes).toHaveLength(1);
    expect(simulated.map((t) => [t.functionName, t.value])).toEqual([['deposit', amount]]);
    expect(sent).toHaveLength(1);
    await keys.close();
  });

  it('sendWithdraw returns credits to the agent account, signed by the KeyStore', async () => {
    const keys = new MemoryKeyStore(SEED);
    const agent = (await keys.getPublicBundle()).agentId;
    const { direct, sent } = await directMode(keys);
    const { state, simulated } = chain(CHIADO);
    const out = await sendWithdraw(state, direct, { token: 'NATIVE', amount: 4n }, {
      pollMs: 1,
      waitMs: 1,
    });
    expect(out.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(simulated[0]?.args).toEqual([ZERO, 4n, agent]);
    expect(sent).toHaveLength(1);
    await keys.close();
  });

  it('the KeyStore refuses a mainnet and a withdraw to another account: nothing is broadcast', async () => {
    const keys = new MemoryKeyStore(SEED);
    const { direct, sent } = await directMode(keys);
    const mainnet = chain({ ...CHIADO, chainId: 100, key: 'gnosis', testnet: false });
    await expect(
      sendDirect(mainnet.state, direct, {
        contract: 'vault',
        to: CHIADO.contracts.vault as Hex,
        value: 1n,
        functionName: 'deposit',
        args: [ZERO, 1n],
      }),
    ).rejects.toMatchObject({ code: 'signing_refused' });
    const { state } = chain(CHIADO);
    await expect(
      sendDirect(state, direct, {
        contract: 'vault',
        to: CHIADO.contracts.vault as Hex,
        value: 0n,
        functionName: 'withdraw',
        args: [ZERO, 1n, `0x${'22'.repeat(20)}`],
      }),
    ).rejects.toMatchObject({ code: 'signing_refused' });
    expect(sent).toHaveLength(0);
    await keys.close();
  });
});
