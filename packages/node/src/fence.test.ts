// IR-M1-8a-1 M-2: the package entry is the fence around the agent seed (04 §8.1). It exports only
// opaque entry points: a KeyStore, an agent ID, a probe result. Nothing that returns raw keychain
// bytes (the backend, account names, the store key) is reachable from `@4thtech-io/node`, so the CLI
// and MCP tool code cannot read a seed through it. Deep imports into dist/ or src/ are refused by
// package.json `exports` and by deps-check and ESLint (IR-M1-1f-1 L-2).
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

describe('@4thtech-io/node entry (the 04 §8.1 fence)', () => {
  it('exports exactly the opaque entry points', () => {
    expect(Object.keys(entry).sort()).toEqual([
      // U3-c (06 §6): the agent folder lock's file name (no path).
      'AGENT_OPEN_LOCK_FILE',
      // M1-8d: the local approval server's address constant (08 §1).
      'APPROVAL_SERVER_HOST',
      // U3-c: the folder lock's fixed-text error.
      'AgentFolderLockError',
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
      // M1-8f: the file KeyStore's two environment variable names (07 §9.2), not their values.
      'PASSPHRASE_ENV',
      'PASSPHRASE_FILE_ENV',
      // M1-4a: the address-checked RPC fetch (no lookup, CA or route seam).
      'RPC_FETCH_MAX_BYTES',
      'RpcFetchError',
      // M1-15: the SSRF-safe download (no lookup, CA or route seam).
      'SAFE_FETCH_TIMEOUT_MS',
      'SafeFetchError',
      // M1-9t (D-78): `owner add-agent`, a prompting entry point like initOwner.
      'addAgentToOwner',
      'assertAgentId',
      // M1-9z: `owner change-code`, a prompting entry point like initOwner (no seed or item seam).
      // M1-8f: the file KeyStore's prompting entry points (no directory, KDF, kek or probe seam).
      'changeFileKeyStorePassphrase',
      'changeOwnerCode',
      'createFileKeyStoreAgent',
      'createInboxFile',
      'createOsKeychainAgent',
      'decideReviewedApprovals',
      // U3-d: removes the keychain items of an agent the app just created (agentId-derived names
      // only; never the owner's items), when it could not be completed.
      'discardNewOsKeychainAgent',
      // W4-RENAME-REACHES-CONTACTS (D-141): an opaque token of a KeyStore this package opened; only
      // this package turns it into an epoch control (key-epoch.ts), for the app host's rename.
      'epochKeysOf',
      // M1-9x: a store-only boolean (owner item present); no bytes, no secret, nothing unlocked.
      'hasOwnerOnMachine',
      // M1-9z: a store-only boolean (a leftover owner-code change); nothing unlocked.
      'hasUnfinishedOwnerCodeChange',
      // U3-c (06 §6): the shared folder lock while an agent is open (no key, no store).
      'holdAgentFolderShared',
      'initOwner',
      'nodeHostResolver',
      'nodeNip11Fetcher',
      'nodeRelayConnector',
      'nodeRpcFetch',
      'nodeSafeFetch',
      'openAgentKeyStore',
      'openAgentStore',
      'openAllowedFile',
      // M1-11b-6: a store-only boolean (no owner anywhere: card, owner items, owner files).
      'ownerSetupAvailable',
      'packageName',
      // U3-c: counts from clear store columns, read-only (no key, no cipher).
      'peekAgentStore',
      'performOwnerOperation',
      // W4-LIVE-STATUS (04 §2.5): signal 0 to a valid pid, a boolean back; no key, no seam.
      'pidAlive',
      'probeOsKeychain',
      'resolveAllowedFile',
      'selectKeyStoreBackend',
      // M1-36b-2-c: the Send folder for an existing agent; the owner signs through the given
      // owner operation (performOwnerOperation in the CLI), nothing is unlocked here.
      'setUpSendFolder',
      // M1-8d: the local approval server entry point (no owner-store or opener seam).
      'startApprovalServer',
      'unlockFileKeyStoreAgent',
      // U3-c (card U3-e uses it): removal takes the folder lock exclusive.
      'withAgentFolderExclusive',
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
      // M1-11b-6: the keychain seam of ownerSetupAvailable stays inside.
      'ownerSetupAvailableWith',
      'noOwnerAnywhere',
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
      // M1-4a: the RPC fetch test seams and the shared safe-fetch internals stay internal.
      'createRpcFetchWith',
      'resolvePinned',
      'pinnedTls',
      'systemLookup',
      'openAllowedFileWith',
      // M1-8f: the file backend's raw entries, reader, writer and test seams stay internal.
      'fileKeychain',
      'createFileAgent',
      'unlockFileAgent',
      'changeFileAgentPassphrase',
      'writeAgentFile',
      'readKeystoreFile',
      'writeKeystoreFile',
      'createFileKeyStoreAgentWith',
      'recordedBackend',
      'secretOpensAnyAgentFile',
      // M1-36b-2-c: the Send folder internals stay inside.
      'prepareSendFolder',
      'signFirstPolicy',
      'isSendFolderBody',
    ]) {
      expect(names).not.toContain(name);
    }
  });
});
