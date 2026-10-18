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
      // M1-8d: the local approval server's address constant (08 §1).
      'APPROVAL_SERVER_HOST',
      // M1-15: the allowed-folder and inbox file guards (fixed-text errors, no seams).
      'AllowedPathError',
      'KEYCHAIN_SERVICE',
      'LOCAL_APPROVAL_LIFETIME_S',
      'MAX_APPROVAL_BATCH_ITEMS',
      // M1-5b-b: the relay connector, resolver and NIP-11 fetcher (no seam, no CA or route option).
      'NIP11_TIMEOUT_MS',
      'NodeKeyStoreError',
      // M1-8b: the store entry returns the Store and its cipher, never the store key.
      'NodeStoreError',
      // M1-15: the SSRF-safe download (no lookup, CA or route seam).
      'SAFE_FETCH_TIMEOUT_MS',
      'SafeFetchError',
      // M1-9t (D-78): `owner add-agent`, a prompting entry point like initOwner.
      'addAgentToOwner',
      'assertAgentId',
      // M1-9z: `owner change-code`, a prompting entry point like initOwner (no seed or item seam).
      'changeOwnerCode',
      'createInboxFile',
      'createOsKeychainAgent',
      'decideReviewedApprovals',
      // M1-9x: a store-only boolean (owner item present); no bytes, no secret, nothing unlocked.
      'hasOwnerOnMachine',
      // M1-9z: a store-only boolean (a leftover owner-code change); nothing unlocked.
      'hasUnfinishedOwnerCodeChange',
      'initOwner',
      'nodeHostResolver',
      'nodeNip11Fetcher',
      'nodeRelayConnector',
      'nodeSafeFetch',
      'openAgentKeyStore',
      'openAgentStore',
      'openAllowedFile',
      'packageName',
      'performOwnerOperation',
      'probeOsKeychain',
      'resolveAllowedFile',
      'selectKeyStoreBackend',
      // M1-8d: the local approval server entry point (no owner-store or opener seam).
      'startApprovalServer',
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
      'addAgentWith',
      'ttyOwnerTerminal',
      'openAgentStoreWith',
      'createAgentStoreCipher',
      'SqliteStore',
      // M1-5b-b: the test seams (extra CA, route to a local port, injected lookup) stay internal.
      'createRelayConnectorWith',
      'createNip11FetcherWith',
      'createHostResolverWith',
      // M1-8d: the approval server's test seams (owner store, opener, notifier) stay internal.
      'startApprovalServerWith',
      'osBrowserOpener',
      'osNotifier',
      // M1-15: the safe-fetch test seams stay internal.
      'createSafeFetchWith',
      'openAllowedFileWith',
    ]) {
      expect(names).not.toContain(name);
    }
  });
});
