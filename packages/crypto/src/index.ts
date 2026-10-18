// @4thtech-io/crypto: the only package that reaches crypto primitives (04 §8.1). M1-1a adds the
// base layer: canonical encodings, hashing, JCS, randomness and wiping. M1-1e adds EIP-712 typed-data
// hashing, canonical ECDSA verification and the AgentCard; its signing functions are in
// @4thtech-io/crypto/keystore.
export const packageName = '@4thtech-io/crypto';

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
export { TAGS, createSha256, keccak256, sha256, taggedHash, type Sha256Hasher } from './hash.js';
// M1-27a (D-48): the encrypted-drop request signature (verification and the unsigned event; the
// drop key signs in a KeyStore) and the drop's URL MAC (07 §5.4, 04 §4).
export {
  DROP_AUTH_DOMAIN,
  DROP_AUTH_KIND,
  DROP_AUTH_MAX_HEADER_LENGTH,
  DROP_AUTH_MAX_SKEW_SECONDS,
  DROP_AUTH_MAX_URL_LENGTH,
  DROP_AUTH_METHODS,
  DROP_AUTH_SCHEME,
  DROP_MAX_PART,
  DROP_OBJECT_ID_LENGTH,
  DROP_URL_KEY_LENGTH,
  DROP_URL_MAC_LABEL,
  DROP_URL_MAC_LENGTH,
  dropAuthEvent,
  dropUrlMac,
  encodeDropAuthorization,
  verifyDropAuthorization,
  verifyDropUrlMac,
  type DropAuthFailure,
  type DropAuthRequest,
  type DropAuthResult,
  type DropUrlFields,
  type DropUrlPurpose,
} from './drop-auth.js';
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
// M1-21 (D-32): termsHash = sha256(JCS(terms)), bare hex (04 §3.4). The terms schema is in
// @4thtech-io/types; this hashes the JSON object it is given.
export { termsHash, verifyTermsHash } from './terms-hash.js';
export { wipe } from './wipe.js';
// M1-1b: public keys, identities, BIP-340 verification and fingerprints. Everything that takes a
// master seed or a secret key is in the restricted subpath @4thtech-io/crypto/keystore (keystore.ts).
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
  senderCode,
  type FingerprintForm,
} from './fingerprint.js';
// M1-1c: the envelope (04 §3.1, §3.1.1, §3.3). Public: structure, encodings and limits,
// envelopeHash, the AEAD additional data, the signature input and verification, and the CEK and
// payload operations, which take a per-envelope CEK but no long-term secret (04 §3.1.1:
// EnvelopeKeys.unwrapCek hands the CEK to core).
// Unwrapping a CEK with a recipient's secret key and signing an envelopeHash are in
// @4thtech-io/crypto/keystore. The deterministic test seam (testing.ts) is not exported from any entry.
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
  KEY_COMMITMENT_LENGTH,
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
// M1-1l (G-46, D-66): the CEK-derived wraps and their check, and the key commitment check, so the
// core can tell a `kc` mismatch from a failed tag (04 §3.1.1 steps 5 and 8).
export {
  CEK_EPH_LABEL,
  CEK_INFO_LABEL,
  cekInfo,
  checkWrap,
  wrapCek,
  type WrappedCek,
} from './hpke.js';
export {
  PAYLOAD_COMMIT_LABEL,
  PAYLOAD_KEY_LABEL,
  checkKeyCommitment,
  decryptPayload,
  encryptPayload,
  generateCek,
} from './aead.js';
// M1-1g: the key interfaces (types only; G-2, 04 §3.1.1, puts them here so transport-nostr and core
// can name them), public NIP-44 helpers, Nostr events and the gift wrap. The NIP-44 functions that
// take a secret or conversation key are in @4thtech-io/crypto/keystore; the in-memory KeyStores are
// in the test-only @4thtech-io/crypto/testing.
export {
  KeyStoreError,
  OWNER_SESSION_DEFAULT_TTL_MS,
  OWNER_SESSION_MAX_TTL_MS,
  type EnvelopeKeys,
  type EpochOptions,
  type KeyEpochControl,
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
// M1-1j: the OCC v2 proof types (05 §3.1, §4; 04 §5), the recipient commitment and the EIP-3009
// typed data. The revoke struct waits for G-20 (M1-1i-b).
export {
  OCC_V2_DOMAIN_NAME,
  OCC_V2_DOMAIN_VERSION,
  RECEIPT_TYPES,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  RECORD_TYPES,
  REGISTRATION_TYPES,
  REVOCATION_TYPES,
  hashReceipt,
  hashReceiveWithAuthorization,
  hashRecord,
  hashRegistration,
  hashRevocation,
  occV2Domain,
  parseReceipt,
  parseReceiveWithAuthorization,
  parseRecord,
  parseRegistration,
  parseRevocation,
  receiptTypedData,
  receiveWithAuthorizationTypedData,
  recipientCommitment,
  recordStructHash,
  recordTypedData,
  registrationTypedData,
  revocationTypedData,
  type OccReceipt,
  type OccRecord,
  type OccRegistration,
  type OccRevocation,
  type OccV2Domain,
  type ProofTypeHashes,
  type ReceiveWithAuthorization,
  type TokenDomain,
} from './proof-types.js';
// M1-1k (04 §2.3, D-82): the passkey PRF salt and the public header of an `ALKP` blob (owner key and
// credential ID). Sealing and opening the owner seed blobs are in @4thtech-io/crypto/keystore.
export {
  ownerPrfSalt,
  readPasskeyBlobHeader,
  type ExpectedOwnerNostr,
  type PasskeyBlobHeader,
  type RecoveryCodeSecret,
} from './owner-seed-wrap.js';
// M1-1f: the pairing proof and the safety code (04 §3.6, §3.6.1; only the commit-checked functions
// produce digits, IR-M1-1f-1 L-7), and the public constants of the
// file KeyStore and owner wrap (04 §2.8). Argon2id, password() and the ALKS / ALKO seal and open
// functions are in @4thtech-io/crypto/keystore.
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
// M1-1d: ALF1 STREAM file encryption (04 §4, D-80): push-based sealer and opener, Web Streams
// transforms and whole-buffer helpers. The fixed-nonce-prefix sealer is in the test seam only.
export {
  ALF1_DEFAULT_CHUNK_SIZE,
  ALF1_FILE_KEY_LENGTH,
  ALF1_HEADER_LENGTH,
  ALF1_MAX_CHUNKS,
  ALF1_MAX_CHUNK_SIZE,
  ALF1_MIN_CHUNK_SIZE,
  ALF1_NONCE_PREFIX_LENGTH,
  ALF1_TAG_LENGTH,
  ALF1_VERSION,
  alf1DecryptStream,
  alf1EncryptStream,
  createAlf1Opener,
  createAlf1Sealer,
  openAlf1,
  sealAlf1,
  type Alf1Digests,
  type Alf1Finished,
  type Alf1OpenOptions,
  type Alf1Opened,
  type Alf1Processor,
  type Alf1Readable,
  type Alf1Sealed,
  type Alf1TransformStream,
  type Alf1Writable,
} from './stream.js';
