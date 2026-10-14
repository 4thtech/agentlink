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
// M1-1e (IR-M1-1e-1 M-1): ECDSA signing with a secret key. cardSig and cardAgentSig are signed
// through the KeyStore; everyone else verifies with the main entry (verifyAgentCard and friends).
export { signDigestEcdsa } from './ecdsa.js';
export { signTypedData } from './eip712.js';
export { signAgentCard } from './agent-card.js';
// M1-1f (04 §2.8): Argon2id, password() normalisation and the generated code, and the ALKS file
// KeyStore and ALKO owner wrap. They take or return a passphrase, a passphrase-derived kek, a seed
// or keychain entries, so only KeyStore backends reach them.
export { argon2id } from './argon2.js';
export { generateSecretCode, normalizeSecret } from './secret-code.js';
export {
  deriveKeystoreKek,
  newKeystoreKek,
  openKeystoreFile,
  openKeystoreFileWithKek,
  keystoreSecretUnlocks,
  openOwnerSeed,
  ownerSecretUnlocks,
  sealKeystoreFile,
  sealOwnerSeed,
} from './keystore-file.js';
