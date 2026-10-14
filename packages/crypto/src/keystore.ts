// @agentlink/crypto/keystore: the restricted entry point for code that holds a master seed or a
// secret key (04 §8.1: secret-key operations go through the KeyStore interface). Every function here
// takes a seed or a secret key, or returns one. Only KeyStore backends may import this subpath:
// tools/deps-check/policy.mjs (RESTRICTED_ENTRY_POINTS) allows it in packages/node and the vector
// harness, and ESLint and deps-check refuse it everywhere else (IR-M1-1b-1 M-1). Everything that
// works on public values stays in the main entry.
export {
  deriveAgentId,
  deriveKey,
  derivePublicIdentity,
  derivePublicKey,
  deriveSecretKey,
} from './keys.js';
export { bip340PublicKey, bip340Sign } from './bip340.js';
