// @agentlink/crypto: the only package that reaches crypto primitives (04 §8.1). M1-1a adds the
// base layer: canonical encodings, hashing, JCS, randomness and wiping. M1-1e adds EIP-712 typed-data
// hashing, canonical ECDSA and the AgentCard.
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
export {
  ECDSA_SIGNATURE_BYTES,
  decodeEcdsaSignature,
  encodeEcdsaSignature,
  recoverEvmAddress,
  signDigestEcdsa,
} from './ecdsa.js';
export {
  eip712EncodeType,
  eip712HashStruct,
  eip712TypeHash,
  hashTypedData,
  signTypedData,
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
  signAgentCard,
  verifyAgentCard,
  verifyCardAgentSig,
  verifyCardOwnerSig,
  type AgentCard,
  type AgentCardHashes,
} from './agent-card.js';
