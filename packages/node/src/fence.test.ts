// IR-M1-8a-1 M-2: the package entry is the fence around the agent seed (04 §8.1). It exports only
// opaque entry points: a KeyStore, an agent ID, a probe result. Nothing that returns raw keychain
// bytes (the backend, account names, the store key) is reachable from `@agentlink/node`, so the CLI
// and MCP tool code cannot read a seed through it. Deep imports into dist/ or src/ are refused by
// package.json `exports` and by deps-check and ESLint (IR-M1-1f-1 L-2).
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

describe('@agentlink/node entry (the 04 §8.1 fence)', () => {
  it('exports exactly the opaque entry points', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'KEYCHAIN_SERVICE',
      'LOCAL_APPROVAL_LIFETIME_S',
      'MAX_APPROVAL_BATCH_ITEMS',
      // M1-5b-b: the relay connector, resolver and NIP-11 fetcher (no seam, no CA or route option).
      'NIP11_TIMEOUT_MS',
      'NodeKeyStoreError',
      // M1-8b: the store entry returns the Store and its cipher, never the store key.
      'NodeStoreError',
      'assertAgentId',
      'createOsKeychainAgent',
      'decideReviewedApprovals',
      'initOwner',
      'nodeHostResolver',
      'nodeNip11Fetcher',
      'nodeRelayConnector',
      'openAgentKeyStore',
      'openAgentStore',
      'packageName',
      'performOwnerOperation',
      'probeOsKeychain',
      'selectKeyStoreBackend',
    ]);
  });

  it('exports no raw backend, account builder, store-key access or KeyStore class', () => {
    const names = Object.keys(entry);
    for (const name of [
      'osKeychain',
      'keychainAccount',
      'probeKeychain',
      'createKeychainAgent',
      'openRecordedKeyStore',
      'KeychainKeyStore',
      // M1-8c: no owner store, session, owner item, seed or prompt seam (I-4).
      'KeychainOwnerKeyStore',
      'storeOwnerSeed',
      'readOwnerItem',
      'runOwnerOperation',
      'decideReviewedWith',
      'initOwnerWith',
      'ttyOwnerTerminal',
      'openAgentStoreWith',
      'createAgentStoreCipher',
      'SqliteStore',
      // M1-5b-b: the test seams (extra CA, route to a local port, injected lookup) stay internal.
      'createRelayConnectorWith',
      'createNip11FetcherWith',
      'createHostResolverWith',
    ]) {
      expect(names).not.toContain(name);
    }
  });
});
