// @agentlink/crypto/testing: test-only entry point (IR-M1-1g-1 M-2). The in-memory KeyStores hold a
// master seed in plain memory for their whole life and are NOT FOR PRODUCTION. tools/deps-check
// (TEST_ONLY_ENTRY_POINTS) allows this subpath only in test files (`*.test.*`), the vector harness
// and e2e/, and refuses it in every production source file, packages/node included. Production
// code uses a real KeyStore backend (keychain, file or Worker).
export {
  MemoryKeyStore,
  MemoryOwnerKeyStore,
  type MemoryKeyStoreOptions,
} from './memory-keystore.js';
