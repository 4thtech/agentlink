// @4thtech-io/crypto/keystore: the restricted entry point for code that holds a master seed or a
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
// M1-1g: NIP-44 v2 under a given secret key or conversation key (KeyStore backends and the vector
// harness). The in-memory KeyStores are in the test-only subpath @4thtech-io/crypto/testing.
export {
  nip44ConversationKey,
  nip44DecryptWithKey,
  nip44EncryptWithKey,
  nip44MessageKeys,
  type Nip44MessageKeys,
} from './nip44.js';
// M1-1c: opening one recipient entry's CEK with the recipient's X25519 secret key, by envelope id
// (EnvelopeKeys.unwrapCek), and BIP-340 signing of an envelopeHash under the envelope tag
// (EnvelopeKeys.signEnvelopeHash), 04 §3.1.1 (G-2).
export { unwrapCek } from './hpke.js';
export { signEnvelopeHash } from './envelope.js';
// M1-1e (IR-M1-1e-1 M-1): ECDSA signing with a secret key. cardSig and cardAgentSig are signed
// through the KeyStore; everyone else verifies with the main entry (verifyAgentCard and friends).
export { signDigestEcdsa } from './ecdsa.js';
// M1-1g-e (IR-M1-6c-1): a drop request signed with the drop key, for KeyStore.signDropRequest.
export { signDropRequest } from './keystore-drop.js';
export { signTypedData } from './eip712.js';
export { signAgentCard } from './agent-card.js';
// M1-4d-d (D-102): `cardPop` with the agent's Nostr secret key, for KeyStore.signCardPop.
export { signCardPop } from './card-pop.js';
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
  openOwnerSeedWithoutCard,
  ownerSecretUnlocks,
  sealKeystoreFile,
  sealOwnerSeed,
} from './keystore-file.js';
// M1-1k (04 §2.3.1, §2.3.2, D-82): the owner seed blobs `ALKP` (passkey PRF wrap) and `ALKR`
// (recovery code). They take a PRF output, a recovery code or a seed, so only KeyStore backends and
// the console's owner store reach them.
export {
  derivePrfWrapKey,
  generateRecoveryCode,
  openPasskeySeed,
  openRecoverySeed,
  sealPasskeySeed,
  sealRecoverySeed,
} from './owner-seed-wrap.js';
// M1-8b (07 §3.1): the cipher of the local store's `enc` columns and its index key. It takes the store
// key, so only KeyStore backends (packages/node; the Durable Object in M2-3a) reach it.
export {
  createStoreColumnCipher,
  type StoreColumnCipher,
  type StoreColumnContext,
} from './store-cipher.js';
// M1-9i-b (04 §2.3.3, D-115): the recovery kit `ALKK` v1. Sealing takes the owner seed and the agent
// items, opening returns them, so only KeyStore backends (the export and import controls) reach it.
export {
  openRecoveryKit,
  sealRecoveryKit,
  type OpenRecoveryKitOptions,
  type OpenedRecoveryKit,
  type OpenedRecoveryKitAgent,
  type OpenedRecoveryKitItem,
  type RecoveryKitAgentInput,
  type RecoveryKitInput,
  type RecoveryKitItem,
  type RecoveryKitStoreSink,
  type RecoveryKitStoreSource,
  type RecoveryKitWrite,
} from './recovery-kit.js';
