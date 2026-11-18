// SEC-KS-712-ALLOWLIST, M1-4c-b, M1-1g-e (04 §3.1.1; 07 §6.2): the KeyStore signs only what its
// allowlist names, on both backends this package has: the keychain KeyStore (over an in-memory
// stand-in for the OS keychain) and the passphrase-locked file KeyStore (in a temp folder). The
// shared conformance suite checks each rule; this one asks, as the hostile-suite does, that on
// either backend typed data, a transaction and a drop request outside the list are refused with
// the one fixed sentence, that nothing is signed, and that what the list names still signs.
// No real keychain, no network, temp folders only.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DIRECT_TX_ALLOWLIST,
  DIRECT_TX_SELECTORS,
  DROP_REQUEST_REFUSED,
  TRANSACTION_REFUSED,
  TYPED_DATA_REFUSED,
  encodeUtf8,
  type Argon2idParams,
  type DirectTransaction,
  type DirectTxChain,
  type KeyStore,
} from '@4thtech-io/crypto';
import { deriveAgentId, newKeystoreKek } from '@4thtech-io/crypto/keystore';
import { describe, expect, it } from 'vitest';
import { fileKeychain, unlockFileAgent, writeAgentFile } from './file-keystore.js';
import { KeychainKeyStore } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';

describe('the KeyStore signs only what its allowlist names, on both backends (04 §3.1.1)', () => {
  const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const AGENT_ID = deriveAgentId(SEED);
  const FAST: Argon2idParams = Object.freeze({ memoryKiB: 19456, iterations: 2, parallelism: 1 });
  const PASSPHRASE = 'hostile suite passphrase';
  const chiado = DIRECT_TX_ALLOWLIST[10200] as DirectTxChain;
  const word = (value: bigint | string): string =>
    (typeof value === 'bigint' ? value.toString(16) : value.slice(2)).padStart(64, '0');
  const ZERO = `0x${'0'.repeat(40)}`;
  const tx = (over: Record<string, unknown> = {}): DirectTransaction =>
    ({
      type: 'eip1559',
      chainId: 10200,
      nonce: 4,
      gas: 90_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: chiado.vault,
      data: `${DIRECT_TX_SELECTORS.deposit}${word(ZERO)}${word(10n ** 17n)}`,
      value: 10n ** 17n,
      ...over,
    }) as DirectTransaction;
  const note = {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }],
      Note: [{ name: 'text', type: 'string' }],
    },
    primaryType: 'Note',
    domain: { name: 'Some other app' },
    message: { text: 'anything at all' },
  };
  const dropGet = { method: 'GET', url: 'https://drop.example/v1/x', body: new Uint8Array() };

  /** The same checks on whichever backend `store` is: refused with the fixed sentence, then still working. */
  async function keepsToItsAllowlist(store: KeyStore): Promise<void> {
    const refusal = async (call: () => Promise<unknown>) =>
      call().then(
        () => ({ code: 'signed', message: '' }),
        (error: { code?: string; message?: string }) => ({
          code: String(error.code),
          message: String(error.message),
        }),
      );
    expect(await refusal(() => store.sign712(note as never))).toEqual({
      code: 'typed_data_refused',
      message: TYPED_DATA_REFUSED.type_not_allowed,
    });
    expect(await refusal(() => store.signTransaction(tx({ to: `0x${'11'.repeat(20)}` })))).toEqual({
      code: 'transaction_refused',
      message: TRANSACTION_REFUSED.destination_not_allowed,
    });
    expect(await refusal(() => store.signTransaction(tx({ chainId: 1 })))).toEqual({
      code: 'transaction_refused',
      message: TRANSACTION_REFUSED.chain_not_allowed,
    });
    expect(await refusal(() => store.signDropRequest(dropGet as never, 1_700_000_000))).toEqual({
      code: 'invalid_argument',
      message: DROP_REQUEST_REFUSED,
    });
    // Control: a refusal leaves the store working, and what the allowlist names still signs.
    expect(await store.signTransaction(tx())).toMatch(/^0x02[0-9a-f]+$/);
  }

  it('the keychain KeyStore refuses typed data, a transaction and a drop request outside the list', async () => {
    const items = new Map<string, Uint8Array>([
      [keychainAccount(AGENT_ID, 'seed'), SEED.slice()],
      [keychainAccount(AGENT_ID, 'store-key'), new Uint8Array(32).fill(7)],
    ]);
    const keychain: KeychainBackend = {
      get: (account) => Promise.resolve(items.get(account)?.slice() ?? null),
      set: (account, value) => (items.set(account, value.slice()), Promise.resolve()),
      delete: (account) => Promise.resolve(items.delete(account)),
    };
    const store = await KeychainKeyStore.open(keychain, AGENT_ID, { keyEpoch: 0 });
    try {
      await keepsToItsAllowlist(store);
    } finally {
      await store.close();
    }
  });

  // The file KeyStore needs POSIX file modes (04 §2.8), so this is skipped on Windows.
  it.skipIf(process.platform === 'win32')(
    'the file KeyStore refuses typed data, a transaction and a drop request outside the list (skipped on Windows: needs POSIX file modes)',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agentlink-hostile-keystore-'));
      const dir = join(root, '.agentlink', 'keystore');
      const kek = await newKeystoreKek(
        'ALKS',
        { secret: encodeUtf8(PASSPHRASE), secretKind: 2, source: 'prompt' },
        FAST,
      );
      await writeAgentFile(dir, SEED, kek);
      const unlocked = await unlockFileAgent(AGENT_ID, {
        dir,
        env: {},
        prompt: () => Promise.resolve(encodeUtf8(PASSPHRASE)),
      });
      const store = await KeychainKeyStore.open(fileKeychain(unlocked), AGENT_ID, { keyEpoch: 0 });
      try {
        await keepsToItsAllowlist(store);
      } finally {
        await store.close();
        unlocked.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
