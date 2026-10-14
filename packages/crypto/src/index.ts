// @agentlink/crypto: the only package that reaches crypto primitives (04 §8.1). M1-1a adds the
// base layer: canonical encodings, hashing, JCS, randomness and wiping. M1-1e adds EIP-712 typed-data
// hashing, canonical ECDSA verification and the AgentCard; its signing functions are in
// @agentlink/crypto/keystore.
export const packageName = '@agentlink/crypto';

export { CryptoInputError, type CryptoInputErrorCode } from './errors.js';
export {
  MAX_UINT256,
  decodeBase64url,
  decodeHex,
  decodeHex0x,
  decodeUint256Decimal,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  encodeUint256Decimal,
  encodeUtf8,
  type ByteLengthOption,
} from './encoding.js';
export { concatBytes, equalBytes } from './bytes.js';
export { TAGS, keccak256, sha256, taggedHash } from './hash.js';
export {
  MAX_JSON_DEPTH,
  canonicalize,
  canonicalizeToBytes,
  parseJson,
  serializeNumber,
  type JsonObject,
  type JsonValue,
  type ParseJsonOptions,
} from './jcs.js';
export { randomBytes } from './random.js';
export { wipe } from './wipe.js';
// M1-1b: public keys, identities, BIP-340 verification and fingerprints. Everything that takes a
// master seed or a secret key is in the restricted subpath @agentlink/crypto/keystore (keystore.ts).
export { HKDF_SHA256_MAX_LENGTH, hkdfSha256 } from './hkdf.js';
export {
  KEY_LABELS,
  MASTER_SEED_LENGTH,
  MAX_KEY_EPOCH,
  evmAddressChecksummed,
  evmAddressFromPublicKey,
  kidFromEncPublicKey,
  type DerivedPublicKey,
  type KeyLabel,
  type PublicIdentity,
} from './keys.js';
export {
  BIP340_PUBLIC_KEY_LENGTH,
  BIP340_SIGNATURE_LENGTH,
  bip340Verify,
  isBip340PublicKey,
} from './bip340.js';
export {
  agentFingerprint,
  formatFingerprint,
  ownerFingerprint,
  type FingerprintForm,
} from './fingerprint.js';
// M1-1c: the envelope (04 §3.1, §3.1.1, §3.3). Public: structure, encodings and limits,
// envelopeHash, the AEAD additional data, the signature input and verification, and the CEK and
// payload operations, which take a per-envelope CEK but no long-term secret (04 §3.1.1:
// EnvelopeKeys.unwrapCek hands the CEK to core).
// Unwrapping a CEK with a recipient's secret key and signing an envelopeHash are in
// @agentlink/crypto/keystore. The deterministic test seam (testing.ts) is not exported from any entry.
export {
  AEAD_ALG,
  AEAD_CT_MAX_ENCODED_LENGTH,
  AEAD_CT_MAX_LENGTH,
  AEAD_IV_LENGTH,
  AEAD_TAG_LENGTH,
  CEK_LENGTH,
  ENVELOPE_ID_LENGTH,
  ENVELOPE_VERSION,
  HPKE_ENC_LENGTH,
  KID_LENGTH,
  MAX_RECIPIENTS,
  THREAD_ID_LENGTH,
  WRAPPED_CEK_LENGTH,
  envelopeAad,
  envelopeHash,
  envelopeSignatureInput,
  parseEnvelope,
  parseEnvelopeHeader,
  parseUnsignedEnvelope,
  verifyEnvelope,
  type Envelope,
  type EnvelopeAead,
  type EnvelopeHeader,
  type EnvelopeRecipient,
  type UnsignedEnvelope,
} from './envelope.js';
export { CEK_INFO_LABEL, cekInfo, wrapCek, type WrappedCek } from './hpke.js';
export { decryptPayload, encryptPayload, generateCek } from './aead.js';
// M1-1g: the key interfaces (types only; G-2, 04 §3.1.1, puts them here so transport-nostr and core
// can name them), public NIP-44 helpers, Nostr events and the gift wrap. The NIP-44 functions that
// take a secret or conversation key are in @agentlink/crypto/keystore; the in-memory KeyStores are
// in the test-only @agentlink/crypto/testing.
export {
  KeyStoreError,
  OWNER_SESSION_DEFAULT_TTL_MS,
  OWNER_SESSION_MAX_TTL_MS,
  type EnvelopeKeys,
  type EpochOptions,
  type KeyStore,
  type KeyStoreErrorCode,
  type OwnerKeyStore,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
  type UnlockOptions,
} from './keystore-api.js';
export {
  NIP44_MAX_PLAINTEXT_BYTES,
  NIP44_MIN_PLAINTEXT_BYTES,
  nip44PaddedLength,
} from './nip44.js';
export {
  NOSTR_KIND_AUTH,
  NOSTR_KIND_GIFT_WRAP,
  NOSTR_KIND_SEAL,
  nostrEventId,
  verifyNostrEvent,
  type NostrEvent,
  type UnsignedNostrEvent,
} from './nostr-event.js';
export { createGiftWrap } from './gift-wrap.js';
export {
  ECDSA_SIGNATURE_BYTES,
  decodeEcdsaSignature,
  encodeEcdsaSignature,
  recoverEvmAddress,
} from './ecdsa.js';
export {
  eip712EncodeType,
  eip712HashStruct,
  eip712TypeHash,
  hashTypedData,
  type TypedData,
  type TypedDataField,
  type TypedDataHashes,
  type TypedDataTypes,
} from './eip712.js';
export {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  agentCardJcsHash,
  agentCardNameHash,
  agentCardRelaysHash,
  hashAgentCard,
  parseAgentCard,
  parseAgentCardJson,
  verifyAgentCard,
  verifyCardAgentSig,
  verifyCardOwnerSig,
  type AgentCard,
  type AgentCardHashes,
} from './agent-card.js';
// M1-1f: the pairing proof and the safety code (04 §3.6, §3.6.1; only the commit-checked functions
// produce digits, IR-M1-1f-1 L-7), and the public constants of the
// file KeyStore and owner wrap (04 §2.8). Argon2id, password() and the ALKS / ALKO seal and open
// functions are in @agentlink/crypto/keystore.
export {
  INVITE_ID_LENGTH,
  INVITE_SECRET_LENGTH,
  PAIRING_HANDSHAKE_LABEL,
  PAIRING_PROOF_INFO,
  PAIRING_PROOF_LENGTH,
  derivePairingProofKey,
  hmacSha256,
  pairingProof,
  verifyPairingProof,
} from './pairing.js';
export {
  SAFETY_CODE_MODULUS,
  SAFETY_NONCE_LENGTH,
  SAFETY_TRANSCRIPT_LENGTH,
  checkSafetyCodeReveal,
  computeSafetyCode,
  safetyCodeCommit,
  safetyCodeForRole,
  type SafetyCode,
  type SafetyCodeInput,
} from './safety-code.js';
export type { Argon2idParams } from './argon2.js';
export {
  SECRET_CODE_LENGTH,
  SECRET_KINDS,
  type SecretKind,
  type SecretSource,
} from './secret-code.js';
export { KEYSTORE_KDF_BOUNDS, KEYSTORE_KDF_DEFAULTS } from './argon2.js';
export {
  type ExpectedOwner,
  type KeystoreEntry,
  type KeystoreFormat,
  type KeystoreKek,
  type KeystoreSecret,
  type KeystoreUnlockSecret,
  type SealOwnerSeedOptions,
} from './keystore-file.js';
