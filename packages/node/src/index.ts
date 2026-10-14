// @agentlink/node: Node implementations (07 §1). M1-8a: the OS keychain KeyStore (04 §2.2, 07 §9).
// The SQLite Store (M1-8b), the owner passphrase store (M1-8c), the local approval server (M1-8d)
// and the file KeyStore (M1-8f) land with their backlog tasks.
//
// This entry is the fence around the agent seed (04 §8.1, IR-M1-8a-1 M-2): it exports only opaque
// entry points. The raw keychain backend, account names and the store key stay inside the package
// (fence.test.ts checks the exact export list).
export const packageName = '@agentlink/node';

export { NodeKeyStoreError, type NodeKeyStoreErrorCode } from './errors.js';
export {
  KEYCHAIN_SERVICE,
  assertAgentId,
  selectKeyStoreBackend,
  type KeyStoreBackendKind,
  type KeyStoreSelection,
  type KeychainProbe,
  type ProbeOptions,
} from './keychain.js';
export {
  createOsKeychainAgent,
  openAgentKeyStore,
  probeOsKeychain,
  type KeychainKeyStoreOptions,
} from './keychain-keystore.js';
