// 04 §3.6.2 (D-139): short invite links. One 32-byte link secret K gives, through HKDF-SHA256 with
// two distinct info strings, the drop lookup ID (16 bytes, the only value that ever leaves the
// device) and the invite key (32 bytes). The invite object `ALI1` v1 is:
//   "ALI1" ‖ u8 version=1 ‖ nonce 12 B ‖ AES-256-GCM(inviteKey, nonce, plaintext, AAD = header ‖ lookupId)
//   plaintext = u32be(n) ‖ P ‖ zero bytes, padded to the next multiple of 1 024 bytes,
// where P is the n-byte D-69 payload before base64url (1 ≤ n ≤ 16 384). The largest object is
// 17 + 17 408 + 16 = 17 441 bytes. HKDF is one-way, so the lookup ID reveals nothing about the key.
//
// Nothing here implements a primitive (I-8): HKDF is @noble/hashes and AES-GCM is WebCrypto. Every
// object-level failure is `undefined` (never a partial payload); the link secret and the derived key
// are wiped once used, and neither is ever logged or put in an error (I-1, I-7).
import { aes256GcmOpen, aes256GcmSeal, AES_GCM_NONCE_LENGTH } from './aes-gcm.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';
import { randomBytes } from './random.js';
import { wipe } from './wipe.js';

/** The link secret K (04 §3.6.2): 32 CSPRNG bytes per invite, never reused. */
export const SHORT_INVITE_SECRET_LENGTH = 32;
/** The drop lookup ID: 16 bytes (22 base64url characters). */
export const SHORT_INVITE_LOOKUP_ID_LENGTH = 16;
/** The largest D-69 payload P an object carries (the inflate input, 04 §3.6). */
export const SHORT_INVITE_MAX_PAYLOAD = 16_384;
/** The largest `ALI1` object: header 17 + padded plaintext 17 408 + tag 16. */
export const SHORT_INVITE_MAX_OBJECT = 17_441;
/** The smallest object that can open: the header and a tag. */
export const SHORT_INVITE_MIN_OBJECT = 33;

const ID_INFO = 'agentlink/v1/short-invite/id';
const KEY_INFO = 'agentlink/v1/short-invite/key';
const MAGIC = [0x41, 0x4c, 0x49, 0x31]; // "ALI1"
const VERSION = 1;
const HEADER_LENGTH = 4 + 1 + AES_GCM_NONCE_LENGTH; // 17
const PAD = 1_024;
const KEY_LENGTH = 32;

function assertSecret(secret: Uint8Array): void {
  assertBytes(secret, 'short invite: secret');
  if (secret.length !== SHORT_INVITE_SECRET_LENGTH) {
    throw new CryptoInputError('invalid_length', 'short invite: the secret must be 32 bytes');
  }
}

/** A fresh link secret K from the CSPRNG. The caller wipes it once the link was returned. */
export function generateShortInviteSecret(): Uint8Array {
  return randomBytes(SHORT_INVITE_SECRET_LENGTH);
}

/** `lookupId = HKDF-SHA256(K, "", "agentlink/v1/short-invite/id", 16)`. */
export function shortInviteLookupId(secret: Uint8Array): Uint8Array {
  assertSecret(secret);
  return hkdfSha256(secret, new Uint8Array(0), encodeUtf8(ID_INFO), SHORT_INVITE_LOOKUP_ID_LENGTH);
}

function inviteKey(secret: Uint8Array): Uint8Array {
  return hkdfSha256(secret, new Uint8Array(0), encodeUtf8(KEY_INFO), KEY_LENGTH);
}

/** A sealed invite object and the drop ID it is stored under. */
export interface SealedShortInvite {
  readonly lookupId: Uint8Array;
  readonly object: Uint8Array;
}

/**
 * Seals the D-69 payload `payload` (1 to 16 384 bytes) under the key derived from `secret`, with a
 * fresh nonce. Does not wipe `secret` (the caller still needs it for the link) but wipes the key.
 */
export async function sealShortInvite(
  secret: Uint8Array,
  payload: Uint8Array,
): Promise<SealedShortInvite> {
  assertSecret(secret);
  assertBytes(payload, 'short invite: payload');
  if (payload.length < 1 || payload.length > SHORT_INVITE_MAX_PAYLOAD) {
    throw new CryptoInputError(
      'invalid_length',
      'short invite: the payload must be 1 to 16 384 bytes',
    );
  }
  const lookupId = shortInviteLookupId(secret);
  const key = inviteKey(secret);
  const padded = Math.ceil((4 + payload.length) / PAD) * PAD;
  const plaintext = new Uint8Array(padded);
  new DataView(plaintext.buffer).setUint32(0, payload.length, false);
  plaintext.set(payload, 4);
  try {
    const nonce = randomBytes(AES_GCM_NONCE_LENGTH);
    const header = concatBytes(new Uint8Array(MAGIC), new Uint8Array([VERSION]), nonce);
    const sealed = await aes256GcmSeal(key, nonce, plaintext, concatBytes(header, lookupId));
    return { lookupId, object: concatBytes(header, sealed) };
  } finally {
    wipe(key, plaintext);
  }
}

/**
 * Opens an `ALI1` object fetched under the lookup ID derived from `secret`. Returns P, or
 * `undefined` for anything else (04 §3.6.2: another magic or version, a size outside the bounds, a
 * tag or AAD failure, n = 0, n above 16 384 or the plaintext, a non-zero padding byte).
 */
export async function openShortInvite(
  secret: Uint8Array,
  object: Uint8Array,
): Promise<Uint8Array | undefined> {
  assertSecret(secret);
  assertBytes(object, 'short invite: object');
  if (object.length < SHORT_INVITE_MIN_OBJECT || object.length > SHORT_INVITE_MAX_OBJECT) {
    return undefined;
  }
  if (!equalBytes(object.subarray(0, 4), new Uint8Array(MAGIC)) || object[4] !== VERSION) {
    return undefined;
  }
  const header = object.subarray(0, HEADER_LENGTH);
  const nonce = object.subarray(5, HEADER_LENGTH);
  const lookupId = shortInviteLookupId(secret);
  const key = inviteKey(secret);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = await aes256GcmOpen(
      key,
      nonce,
      object.subarray(HEADER_LENGTH),
      concatBytes(header, lookupId),
    );
    if (plaintext === undefined || plaintext.length < 4) return undefined;
    const n = new DataView(plaintext.buffer, plaintext.byteOffset, 4).getUint32(0, false);
    if (n === 0 || n > SHORT_INVITE_MAX_PAYLOAD || n > plaintext.length - 4) return undefined;
    for (let i = 4 + n; i < plaintext.length; i += 1) {
      if (plaintext[i] !== 0) return undefined;
    }
    return plaintext.slice(4, 4 + n);
  } finally {
    wipe(key);
    if (plaintext !== undefined) wipe(plaintext);
  }
}
