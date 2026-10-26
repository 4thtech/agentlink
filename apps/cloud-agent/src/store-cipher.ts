// M2-3a: core's StoreCipher for the Durable Object store (07 §3.1): AES-256-GCM under the store key
// with AAD bound to table, column and row key, and the keyed index digest, both in
// @4thtech-io/crypto (the same sealed form as the Node store, M1-8b). The store key is derived from
// the agent seed inside the Worker KeyStore for this call only; it enters non-extractable WebCrypto
// keys and is wiped. Nothing here holds or returns its bytes.
import type { SealContext, Sealed, StoreCipher } from '@4thtech-io/core';
import { createStoreColumnCipher } from '@4thtech-io/crypto/keystore';
import type { WorkerKeyStore } from './worker-keystore.js';

export interface CloudStoreCipher extends StoreCipher {
  indexDigest(data: Uint8Array): Promise<string>;
  /** Drops the keys; every later call fails. */
  close(): void;
}

/** The store cipher of the agent behind `keyStore`. Close it when the run ends. */
export async function openStoreCipher(keyStore: WorkerKeyStore): Promise<CloudStoreCipher> {
  const cipher = await keyStore.withStoreKey((storeKey) => createStoreColumnCipher(storeKey));
  return Object.freeze({
    seal: async (context: SealContext, plaintext: string): Promise<Sealed> =>
      (await cipher.seal(context, plaintext)) as Sealed,
    open: (context: SealContext, sealed: Sealed): Promise<string> => cipher.open(context, sealed),
    indexDigest: (data: Uint8Array): Promise<string> => cipher.indexDigest(data),
    close: (): void => cipher.close(),
  });
}
