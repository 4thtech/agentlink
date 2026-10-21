// M1-1g-h: the shared KeyStore conformance suite (@4thtech-io/crypto/testing runKeyStoreConformance;
// 04 §2.1, §3.1.1; 07 §5.4) against every KeyStore backend this package has: the keychain KeyStore
// and the frozen facade openRecordedKeyStore returns. Both run over an in-memory keychain double,
// so the suite runs headless on CI. The keychain store's epoch is the one recorded in the agent's
// `identity` row, so a store "after an advance" is one opened at that epoch. MemoryKeyStore runs the
// same suite in packages/crypto.
import { runKeyStoreConformance } from '@4thtech-io/crypto/testing';
import { deriveAgentId } from '@4thtech-io/crypto/keystore';
import { describe, it } from 'vitest';
import { KeychainKeyStore, openRecordedKeyStore } from './keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from './keychain.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const AGENT_ID = deriveAgentId(SEED);

/** An in-memory keychain holding one agent's seed and store key. */
class MemoryKeychain implements KeychainBackend {
  readonly #items = new Map<string, Uint8Array>();

  constructor() {
    this.#items.set(keychainAccount(AGENT_ID, 'seed'), SEED.slice());
    this.#items.set(keychainAccount(AGENT_ID, 'store-key'), new Uint8Array(32).fill(7));
  }

  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.#items.get(account)?.slice() ?? null);
  }

  set(account: string, value: Uint8Array): Promise<void> {
    this.#items.set(account, value.slice());
    return Promise.resolve();
  }

  delete(account: string): Promise<boolean> {
    return Promise.resolve(this.#items.delete(account));
  }
}

runKeyStoreConformance(
  {
    name: 'KeychainKeyStore',
    seed: SEED,
    open: (keyEpoch) => KeychainKeyStore.open(new MemoryKeychain(), AGENT_ID, { keyEpoch }),
  },
  { describe, it },
);

runKeyStoreConformance(
  {
    name: 'the KeyStore facade (openRecordedKeyStore)',
    seed: SEED,
    open: (keyEpoch) =>
      openRecordedKeyStore('keychain', AGENT_ID, { keychain: new MemoryKeychain() }, { keyEpoch }),
  },
  { describe, it },
);
