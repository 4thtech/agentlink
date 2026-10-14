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
