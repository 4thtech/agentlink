// NIP-44 v2 encryption (04 §3.5, 07 §4.2; https://github.com/nostr-protocol/nips/blob/master/44.md).
// The primitives are @noble (04 §8.1): secp256k1 ECDH from @noble/curves, HKDF and HMAC-SHA256 from
// @noble/hashes, ChaCha20 from @noble/ciphers. This module only composes them as NIP-44 v2 says;
// it implements no primitive (I-8).
//
// nip44PaddedLength and the bounds are public and exported from the main entry. Every other
// function takes a secret key or a conversation key, so the package exports them only from the
// restricted subpath @agentlink/crypto/keystore (04 §8.1): other callers encrypt and decrypt through
// KeyStore.nip44Encrypt / nip44Decrypt, which derive the conversation key inside.
//
// Decryption follows NIP-44 v2 strictly: the payload size, version byte and base64 are checked
// first; the MAC is checked (constant time) before anything is decrypted; then the framing is
// checked exactly (declared length 1..65535, padded size equal to the padding rule, every padding
// byte zero) and the plaintext must be valid UTF-8. Errors are fixed sentences that never echo an
// input (I-7): a MAC failure and a framing failure share the code `decrypt_failed`.
import { chacha20 } from '@noble/ciphers/chacha.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { decodeUtf8, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { randomBytes } from './random.js';
import { isSecp256k1SecretKey } from './secp256k1-range.js';
import { wipe } from './wipe.js';

/** NIP-44 v2 plaintext bounds, in UTF-8 bytes. */
export const NIP44_MIN_PLAINTEXT_BYTES = 1;
export const NIP44_MAX_PLAINTEXT_BYTES = 65535;

const VERSION = 2;
const SALT = encodeUtf8('nip44-v2');
const NONCE_LENGTH = 32;
const MAC_LENGTH = 32;
/** Payload bounds of NIP-44 v2: base64 characters and decoded bytes. */
const MIN_PAYLOAD_CHARS = 132;
const MAX_PAYLOAD_CHARS = 87472;
const MIN_DATA_BYTES = 99;
const MAX_DATA_BYTES = 65603;
/** Upper bound for nip44PaddedLength, so the bit arithmetic stays in 32-bit range. */
const MAX_PADDED_INPUT = 2 ** 30;

function assertKey32(value: unknown, what: string): asserts value is Uint8Array {
  assertBytes(value, what);
  if (value.length !== 32) throw new CryptoInputError('invalid_length', `${what} must be 32 bytes`);
}

/**
 * NIP-44 v2 `calc_padded_len`: 32 for up to 32 bytes; above that, a multiple of a chunk that is 32
 * up to 256 bytes and one eighth of the next power of two after that. Public and non-secret.
 * Accepts any integer from 1 to 2^30 (the official vectors include 65536, one past the plaintext
 * maximum).
 */
export function nip44PaddedLength(unpaddedLength: number): number {
  if (
    typeof unpaddedLength !== 'number' ||
    !Number.isInteger(unpaddedLength) ||
    unpaddedLength < 1 ||
    unpaddedLength > MAX_PADDED_INPUT
  ) {
    throw new CryptoInputError(
      'invalid_argument',
      'nip44PaddedLength: the length must be an integer from 1 to 2^30',
    );
  }
  if (unpaddedLength <= 32) return 32;
  // floor(log2(n - 1)) + 1, exactly, without floating point.
  const nextPower = 2 ** (32 - Math.clz32(unpaddedLength - 1));
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLength - 1) / chunk) + 1);
}

/**
 * NIP-44 v2 conversation key: HKDF-extract(salt = utf8("nip44-v2"), ikm = the 32-byte x coordinate
 * of secretKey * lift_x(publicKey)). Symmetric between the two parties. Secret: KeyStore
 * implementations only, and wipe it when done.
 *
 * Refuses a secret key outside [1, n) (`invalid_argument`), keys that are not 32 bytes
 * (`invalid_length`) and a public key that is not an x coordinate on secp256k1
 * (`invalid_public_key`). Inputs are not modified.
 */
export function nip44ConversationKey(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  assertKey32(secretKey, 'nip44: the secret key');
  assertKey32(publicKey, 'nip44: the public key');
  if (!isSecp256k1SecretKey(secretKey)) {
    throw new CryptoInputError('invalid_argument', 'nip44: the secret key is out of range');
  }
  const compressed = concatBytes(Uint8Array.of(0x02), publicKey);
  let shared: Uint8Array;
  try {
    // Point.fromBytes refuses an x at or above p and an x with no point (lift_x of BIP-340).
    secp256k1.Point.fromBytes(compressed).assertValidity();
  } catch {
    throw new CryptoInputError('invalid_public_key', 'nip44: the public key is not on secp256k1');
  }
  try {
    shared = secp256k1.getSharedSecret(secretKey, compressed, true);
  } catch {
    // The library's message is not ours to vouch for (I-7): replace it, keep no cause.
    throw new CryptoInputError('invalid_argument', 'nip44: no shared secret for these keys');
  }
  try {
    return extract(sha256, shared.subarray(1, 33), SALT);
  } finally {
    wipe(shared);
  }
}

/** The per-message keys of NIP-44 v2. Secret; wipe each when done. */
export interface Nip44MessageKeys {
  readonly chachaKey: Uint8Array;
  readonly chachaNonce: Uint8Array;
  readonly hmacKey: Uint8Array;
}

/**
 * NIP-44 v2 `get_message_keys`: HKDF-expand(prk = conversationKey, info = nonce, L = 76), split
 * 32 / 12 / 32. Secret: KeyStore implementations only.
 */
export function nip44MessageKeys(conversationKey: Uint8Array, nonce: Uint8Array): Nip44MessageKeys {
  assertKey32(conversationKey, 'nip44: the conversation key');
  assertKey32(nonce, 'nip44: the nonce');
  const okm = expand(sha256, conversationKey, nonce, 76);
  try {
    return {
      chachaKey: okm.slice(0, 32),
      chachaNonce: okm.slice(32, 44),
      hmacKey: okm.slice(44, 76),
    };
  } finally {
    wipe(okm);
  }
}

function wipeKeys(keys: Nip44MessageKeys): void {
  wipe(keys.chachaKey, keys.chachaNonce, keys.hmacKey);
}

function macOf(hmacKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
}

/**
 * NIP-44 v2 encryption under a conversation key. Returns the base64 payload
 * (version 2 || nonce || ciphertext || MAC). `nonce` exists only to reproduce test vectors: a
 * reused nonce reuses the keystream, so production callers omit it and get 32 fresh CSPRNG bytes.
 *
 * Refuses a plaintext with a lone surrogate (`invalid_utf8`) and one outside 1..65535 UTF-8 bytes
 * (`invalid_length`). Secret: KeyStore implementations only.
 */
export function nip44EncryptWithKey(
  conversationKey: Uint8Array,
  plaintext: string,
  nonce?: Uint8Array,
): string {
  assertKey32(conversationKey, 'nip44: the conversation key');
  if (nonce !== undefined) assertKey32(nonce, 'nip44: the nonce');
  if (typeof plaintext !== 'string') {
    throw new CryptoInputError('invalid_argument', 'nip44: the plaintext must be a string');
  }
  // A UTF-8 encoding is never shorter than the UTF-16 one, so this refuses huge input early.
  if (plaintext.length > NIP44_MAX_PLAINTEXT_BYTES) {
    throw new CryptoInputError('invalid_length', 'nip44: the plaintext must be 1 to 65535 bytes');
  }
  const unpadded = encodeUtf8(plaintext);
  const length = unpadded.length;
  if (length < NIP44_MIN_PLAINTEXT_BYTES || length > NIP44_MAX_PLAINTEXT_BYTES) {
    wipe(unpadded);
    throw new CryptoInputError('invalid_length', 'nip44: the plaintext must be 1 to 65535 bytes');
  }
  const padded = new Uint8Array(2 + nip44PaddedLength(length));
  padded[0] = length >> 8;
  padded[1] = length & 0xff;
  padded.set(unpadded, 2);
  wipe(unpadded);
  const n = nonce ?? randomBytes(NONCE_LENGTH);
  const keys = nip44MessageKeys(conversationKey, n);
  try {
    const ciphertext = chacha20(keys.chachaKey, keys.chachaNonce, padded);
    const mac = macOf(keys.hmacKey, n, ciphertext);
    return encodeBase64(concatBytes(Uint8Array.of(VERSION), n, ciphertext, mac));
  } finally {
    wipeKeys(keys);
    wipe(padded);
  }
}

/**
 * NIP-44 v2 decryption under a conversation key: the plaintext, or a CryptoInputError.
 * `invalid_payload`: empty, `#`-prefixed (reserved), outside 132..87472 characters, not strict
 * padded base64, decoded size outside 99..65603 bytes or a version other than 2.
 * `decrypt_failed`: the MAC does not verify, or the authenticated plaintext is badly framed or not
 * UTF-8. Secret: KeyStore implementations only.
 */
export function nip44DecryptWithKey(conversationKey: Uint8Array, payload: string): string {
  assertKey32(conversationKey, 'nip44: the conversation key');
  if (typeof payload !== 'string') {
    throw new CryptoInputError('invalid_argument', 'nip44: the payload must be a string');
  }
  if (payload.length === 0 || payload.startsWith('#')) {
    throw new CryptoInputError('invalid_payload', 'nip44: unknown encryption version');
  }
  if (payload.length < MIN_PAYLOAD_CHARS || payload.length > MAX_PAYLOAD_CHARS) {
    throw new CryptoInputError('invalid_payload', 'nip44: invalid payload size');
  }
  const data = decodeBase64(payload);
  if (data.length < MIN_DATA_BYTES || data.length > MAX_DATA_BYTES) {
    throw new CryptoInputError('invalid_payload', 'nip44: invalid data size');
  }
  if (data[0] !== VERSION) {
    throw new CryptoInputError('invalid_payload', 'nip44: unknown encryption version');
  }
  const nonce = data.subarray(1, 1 + NONCE_LENGTH);
  const ciphertext = data.subarray(1 + NONCE_LENGTH, data.length - MAC_LENGTH);
  const mac = data.subarray(data.length - MAC_LENGTH);
  const keys = nip44MessageKeys(conversationKey, nonce);
  let padded: Uint8Array | undefined;
  try {
    if (!equalBytes(macOf(keys.hmacKey, nonce, ciphertext), mac)) {
      throw new CryptoInputError('decrypt_failed', 'nip44: decryption failed');
    }
    padded = chacha20(keys.chachaKey, keys.chachaNonce, ciphertext);
    return unpad(padded);
  } finally {
    wipeKeys(keys);
    wipe(padded);
  }
}

function unpad(padded: Uint8Array): string {
  const failed = (): CryptoInputError =>
    new CryptoInputError('decrypt_failed', 'nip44: decryption failed');
  if (padded.length < 2) throw failed();
  const length = ((padded[0] as number) << 8) | (padded[1] as number);
  if (length < NIP44_MIN_PLAINTEXT_BYTES || padded.length !== 2 + nip44PaddedLength(length)) {
    throw failed();
  }
  let extra = 0;
  for (let i = 2 + length; i < padded.length; i += 1) extra |= padded[i] as number;
  if (extra !== 0) throw failed();
  try {
    return decodeUtf8(padded.subarray(2, 2 + length));
  } catch {
    throw failed();
  }
}

// --- base64 (RFC 4648 §4, with padding), as NIP-44 v2 uses it --------------------------------------

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_STRICT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += (BASE64[n >> 18] as string) + (BASE64[(n >> 12) & 63] as string);
    out += (BASE64[(n >> 6) & 63] as string) + (BASE64[n & 63] as string);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += (BASE64[n >> 18] as string) + (BASE64[(n >> 12) & 63] as string) + '==';
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += (BASE64[n >> 18] as string) + (BASE64[(n >> 12) & 63] as string);
    out += (BASE64[(n >> 6) & 63] as string) + '=';
  }
  return out;
}

/**
 * Strict padded base64: only the RFC 4648 §4 alphabet, a length that is a multiple of 4, `=` only as
 * the final padding, and zero trailing bits, so each byte string has exactly one spelling.
 */
function decodeBase64(text: string): Uint8Array {
  const invalid = (): CryptoInputError =>
    new CryptoInputError('invalid_payload', 'nip44: the payload is not valid base64');
  if (!BASE64_STRICT.test(text)) throw invalid();
  const body = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < body.length; i += 1) {
    buffer = (buffer << 6) | BASE64.indexOf(body.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (buffer >> bits) & 0xff;
      o += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw invalid();
  return out;
}
