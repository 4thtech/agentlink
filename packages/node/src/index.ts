// @agentlink/node: Node implementations (07 §1). M1-8a: the OS keychain KeyStore (04 §2.2, 07 §9).
// The SQLite Store (M1-8b), the owner passphrase store (M1-8c), the local approval server (M1-8d)
// and the file KeyStore (M1-8f) land with their backlog tasks.
export const packageName = '@agentlink/node';

export { NodeKeyStoreError, type NodeKeyStoreErrorCode } from './errors.js';
export {
  KEYCHAIN_LINUX_STORE,
  KEYCHAIN_SERVICE,
  assertAgentId,
  keychainAccount,
  osKeychain,
  probeKeychain,
  selectKeyStoreBackend,
  type KeyStoreBackendKind,
  type KeyStoreSelection,
  type KeychainBackend,
  type KeychainItem,
  type KeychainProbe,
  type ProbeOptions,
} from './keychain.js';
export {
  KeychainKeyStore,
  createKeychainAgent,
  openRecordedKeyStore,
  type KeychainKeyStoreOptions,
} from './keychain-keystore.js';
