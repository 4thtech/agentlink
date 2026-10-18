// M1-8b: core's StoreCipher for the Node store (07 §3.1): AES-256-GCM under the agent's store key with
// AAD bound to table, column and row key, and the keyed index digest, both in @4thtech-io/crypto. The
// store key enters non-extractable WebCrypto keys when the cipher is created; nothing here holds or
// returns its bytes.
import type { SealContext, Sealed, StoreCipher } from '@4thtech-io/core';
import { createStoreColumnCipher } from '@4thtech-io/crypto/keystore';

/** core's StoreCipher plus the index digest of 07 §3.1 (idempotency.request_digest, §3.3). */
export interface AgentStoreCipher extends StoreCipher {
  /** HMAC-SHA256 of `data` (for request_digest: JCS(args)) under the index key, 64 lowercase hex. */
  indexDigest(data: Uint8Array): Promise<string>;
  /** Drops the keys; every later call fails. */
  close(): void;
}

/** The cipher of one store. The caller still owns `storeKey` and wipes it when this resolves. */
export async function createAgentStoreCipher(storeKey: Uint8Array): Promise<AgentStoreCipher> {
  const cipher = await createStoreColumnCipher(storeKey);
  return Object.freeze({
    seal: async (context: SealContext, plaintext: string): Promise<Sealed> =>
      (await cipher.seal(context, plaintext)) as Sealed,
    open: (context: SealContext, sealed: Sealed): Promise<string> => cipher.open(context, sealed),
    indexDigest: (data: Uint8Array): Promise<string> => cipher.indexDigest(data),
    close: (): void => cipher.close(),
  });
}
