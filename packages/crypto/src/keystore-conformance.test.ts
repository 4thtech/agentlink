// M1-1g-h: the shared KeyStore conformance suite (testing.ts runKeyStoreConformance; 04 §2.1,
// §3.1.1; 07 §5.4) against MemoryKeyStore. The keychain KeyStore and its facade run the same suite
// in packages/node keystore-conformance.test.ts. The epoch moves the way it moves for this backend:
// owner advances through MemoryOwnerKeyStore.epochControl (M1-1g-d).
import { describe, it } from 'vitest';
import { encodeUtf8 } from './encoding.js';
import type { KeyStore } from './keystore-api.js';
import { MemoryKeyStore, MemoryOwnerKeyStore, runKeyStoreConformance } from './testing.js';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OWNER_SEED = Uint8Array.from({ length: 32 }, (_, i) => 77 ^ i);
const presence = () =>
  ({ kind: 'passphrase', secret: encodeUtf8('correct horse battery') }) as const;

runKeyStoreConformance(
  {
    name: 'MemoryKeyStore',
    seed: SEED,
    async open(epoch: number): Promise<KeyStore> {
      const keys = new MemoryKeyStore(SEED);
      const owner = new MemoryOwnerKeyStore(OWNER_SEED, presence());
      const control = owner.epochControl(keys);
      for (let n = 0; n < epoch; n += 1) {
        await control.advanceEpoch(n, await owner.unlock(presence()));
      }
      await owner.close();
      return keys;
    },
  },
  { describe, it },
);
