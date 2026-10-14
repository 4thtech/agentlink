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
// M1-1f: the pairing proof and the safety code (04 §3.6, §3.6.1), and the public constants of the
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
  pairingDigest,
  safetyCodeCommit,
  safetyCodeForRole,
  safetyCodeFromDigest,
  safetyCodeTranscript,
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
export {
  KEYSTORE_KDF_BOUNDS,
  KEYSTORE_KDF_DEFAULTS,
  type ExpectedOwner,
  type KeystoreEntry,
  type KeystoreFormat,
  type KeystoreKek,
  type KeystoreSecret,
  type KeystoreUnlockSecret,
  type SealOwnerSeedOptions,
} from './keystore-file.js';
