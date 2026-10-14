// @agentlink/crypto: the only package that reaches crypto primitives (04 §8.1). M1-1a adds the
// base layer: canonical encodings, hashing, JCS, randomness and wiping.
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
