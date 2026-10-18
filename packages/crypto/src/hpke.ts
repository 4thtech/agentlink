// 04 §3.3 content-key wrapping (M1-1c): RFC 9180 HPKE, mode Base, with KEM DHKEM(X25519,
// HKDF-SHA256) 0x0020, KDF HKDF-SHA256 0x0001 and AEAD AES-256-GCM 0x0002, through @hpke/core
// (04 §8.1 allowlist; nothing here implements a primitive, I-8).
//
// - info = utf8("agentlink/v1/cek") || the envelope id as its raw 16 bytes; AAD empty.
// - One independent seal per recipient: enc (32 bytes) and wk (the 32-byte CEK sealed, 48 bytes).
// - Sender authenticity comes from the envelope `sig`, not from HPKE Auth mode (04 §3.3).
// - Every wrap is derived from the CEK (M1-1l, G-46, D-66): the ephemeral secret key of entry j is
//   ikm_j = HKDF-SHA256(ikm = CEK, salt = empty, info = "agentlink/v1/cek-eph" ‖ id ‖ pk_j, 32),
//   used as a raw X25519 secret key (clamped by the library). It reaches @hpke/core's `ekm` as an
//   imported key pair, never as bytes, which the library would route through RFC 9180
//   DeriveKeyPair. So the same (pk_j, id, CEK) always gives the same (enc_j, wk_j), and checkWrap
//   lets any holder of the CEK and pk_j recompute an entry and compare it byte for byte.
// - A CEK-derived ephemeral key seals exactly the 32-byte CEK, once: a wrap's HPKE context is never
//   used for `export` or a second message (04 §3.3, security conditions).
//
// All-zero shared secret (RFC 9180 §7.1.4, RFC 7748 §6.1): before any HPKE work, both directions
// compute the X25519 output with @noble/curves and refuse it when it is all zero (a small-order
// point, including the non-canonical encodings and those with the high bit set). WebCrypto is
// required to make the same check, but this does not rely on every runtime doing so.
//
// @hpke/core runs X25519, HKDF and AES-GCM on WebCrypto. Keys pass through WebCrypto CryptoKey
// objects, whose internal copies cannot be wiped (see wipe.ts); the byte copies made here are.
import {
  Aes256Gcm,
  CipherSuite,
  DecapError,
  DeserializeError,
  DhkemX25519HkdfSha256,
  EncapError,
  HkdfSha256,
  OpenError,
} from '@hpke/core';
import { x25519 } from '@noble/curves/ed25519.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { CEK_LENGTH, ENVELOPE_ID_LENGTH, HPKE_ENC_LENGTH, WRAPPED_CEK_LENGTH } from './envelope.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';
import { wipe } from './wipe.js';

/** 04 §3.3: the label that starts the HPKE info of a CEK wrap. */
export const CEK_INFO_LABEL = 'agentlink/v1/cek';
/** 04 §3.3: the HKDF label of a wrap's ephemeral secret key (info = label ‖ id ‖ pk_j). */
export const CEK_EPH_LABEL = 'agentlink/v1/cek-eph';

/** X25519 keys are 32 bytes (RFC 7748). */
const X25519_KEY_LENGTH = 32;
const EMPTY = new Uint8Array(0);

/** One recipient's CEK wrap: enc (32 bytes) and wk (48 bytes), raw. Base64url them for the envelope. */
export interface WrappedCek {
  readonly enc: Uint8Array;
  readonly wk: Uint8Array;
}

/** A multi-message seal (test seam): enc and the ciphertexts in sequence order. */
export interface HpkeSealed {
  readonly enc: Uint8Array;
  readonly ciphertexts: readonly Uint8Array[];
}

let suite: CipherSuite | undefined;

/** The one RFC 9180 suite of 04 §3.3, created on first use. */
function cipherSuite(): CipherSuite {
  suite ??= new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  return suite;
}

function assertLength(value: unknown, length: number, what: string): asserts value is Uint8Array {
  assertBytes(value, what);
  if (value.length !== length) {
    throw new CryptoInputError('invalid_length', `${what} must be ${length} bytes`);
  }
}

/** 04 §3.3: info = utf8("agentlink/v1/cek") || id (the envelope id's raw 16 bytes). */
export function cekInfo(envelopeId: Uint8Array): Uint8Array {
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, 'cekInfo: envelopeId');
  return concatBytes(encodeUtf8(CEK_INFO_LABEL), envelopeId);
}

/**
 * True when X25519(secretKey, publicKey) is not all zero. Any refusal by the library (it rejects
 * small-order points before the ladder) counts as all zero.
 */
function sharedSecretIsNonZero(secretKey: Uint8Array, publicKey: Uint8Array): boolean {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    return false;
  }
  try {
    let any = 0;
    for (const byte of shared) any |= byte;
    return any !== 0;
  } finally {
    wipe(shared);
  }
}

/** A WebCrypto X25519 key pair for @hpke/core from a raw secret key (public half via noble). */
async function importKeyPair(secretKey: Uint8Array) {
  const kem = cipherSuite().kem;
  const publicKey = x25519.getPublicKey(secretKey);
  const secretCopy = secretKey.slice();
  try {
    return {
      privateKey: await kem.importKey('raw', secretCopy.buffer, false),
      publicKey: await kem.importKey('raw', publicKey.buffer, true),
    };
  } finally {
    wipe(secretCopy);
  }
}

async function importPublicKey(publicKey: Uint8Array) {
  return cipherSuite().kem.importKey('raw', publicKey.slice().buffer, true);
}

/** An error that is not ours to explain: the runtime could not run the suite. No input in it. */
class HpkePlatformError extends Error {}

function platformError(cause: unknown): Error {
  return new HpkePlatformError('hpke: this runtime could not run X25519/HKDF-SHA256/AES-256-GCM', {
    cause,
  });
}

function isPlatformError(error: unknown): boolean {
  return error instanceof HpkePlatformError;
}

function openFailed(): CryptoInputError {
  return new CryptoInputError('open_failed', 'hpke: the wrapped key could not be opened');
}

/**
 * Seals `cek` to `recipientEncPublicKey` under a given raw X25519 ephemeral secret key, passed to
 * @hpke/core as an imported key pair (never as `ekm` bytes, which would go through DeriveKeyPair).
 * wrapCek calls it with the key derived from the CEK; the test seam calls it with a fixed key to
 * reproduce vectors. It seals exactly one message, the 32-byte CEK, and the context is dropped.
 */
export async function wrapCekWithEphemeralKey(
  recipientEncPublicKey: Uint8Array,
  envelopeId: Uint8Array,
  cek: Uint8Array,
  ephemeralSecretKey: Uint8Array,
): Promise<WrappedCek> {
  assertLength(recipientEncPublicKey, X25519_KEY_LENGTH, 'wrapCek: recipientEncPublicKey');
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, 'wrapCek: envelopeId');
  assertLength(cek, CEK_LENGTH, 'wrapCek: cek');
  assertLength(ephemeralSecretKey, X25519_KEY_LENGTH, 'wrapCek: ephemeralSecretKey');
  const sealed = await checkedSeal(recipientEncPublicKey, ephemeralSecretKey, cekInfo(envelopeId), [
    { aad: EMPTY, plaintext: cek },
  ]);
  const wk = sealed.ciphertexts[0];
  if (
    wk === undefined ||
    sealed.enc.length !== HPKE_ENC_LENGTH ||
    wk.length !== WRAPPED_CEK_LENGTH
  ) {
    throw platformError(undefined);
  }
  return Object.freeze({ enc: sealed.enc, wk });
}

/**
 * Test seam (04 §3.3): ikm_j = HKDF-SHA256(ikm = CEK, salt = empty, info =
 * utf8("agentlink/v1/cek-eph") ‖ id ‖ pk_j, 32), with `id` the raw 16-byte envelope id and `pk_j`
 * the raw 32-byte X25519 `enc` key of the entry. It is the entry's ephemeral X25519 secret key,
 * used as is (no RFC 9180 DeriveKeyPair). The caller wipes it. Not exported from any entry.
 */
export function deriveWrapEphemeralKey(
  recipientEncPublicKey: Uint8Array,
  envelopeId: Uint8Array,
  cek: Uint8Array,
): Uint8Array {
  assertLength(recipientEncPublicKey, X25519_KEY_LENGTH, 'cek-eph: recipientEncPublicKey');
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, 'cek-eph: envelopeId');
  assertLength(cek, CEK_LENGTH, 'cek-eph: cek');
  const info = concatBytes(encodeUtf8(CEK_EPH_LABEL), envelopeId, recipientEncPublicKey);
  return hkdfSha256(cek, EMPTY, info, X25519_KEY_LENGTH);
}

/**
 * 04 §3.3: seals the 32-byte CEK to one recipient's X25519 `agentEnc`/`ownerEnc` key, bound to the
 * envelope id through info, with the ephemeral key derived from the CEK, the id and that key
 * (`agentlink/v1/cek-eph`). Deterministic: the same (key, id, CEK) always gives the same bytes, and
 * a changed key or id gives a different `enc`. Call it once per recipient (04 §3.2). Refuses a
 * small-order recipient key (`invalid_public_key`). Inputs are not modified; the derived ephemeral
 * key is wiped.
 */
export async function wrapCek(
  recipientEncPublicKey: Uint8Array,
  envelopeId: Uint8Array,
  cek: Uint8Array,
): Promise<WrappedCek> {
  assertLength(recipientEncPublicKey, X25519_KEY_LENGTH, 'wrapCek: recipientEncPublicKey');
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, 'wrapCek: envelopeId');
  assertLength(cek, CEK_LENGTH, 'wrapCek: cek');
  const ephemeral = deriveWrapEphemeralKey(recipientEncPublicKey, envelopeId, cek);
  try {
    return await wrapCekWithEphemeralKey(recipientEncPublicKey, envelopeId, cek, ephemeral);
  } finally {
    wipe(ephemeral);
  }
}

/**
 * 04 §3.3 wrap check (G-46, D-66): recomputes the entry for `recipientEncPublicKey` from the CEK and
 * the envelope id (the same derivation as wrapCek) and compares `enc` and `wk` with `entry` byte for
 * byte. True means the holder of the matching secret key opens exactly this CEK; false is a
 * mismatch (the sender signed entries that carry different keys, 04 §3.1.1 step 8). It needs the
 * public key and the CEK only, never a secret key. Run it after the `kc` check. The core finds the
 * entry by `kid` and decodes its base64url `enc` and `wk`. A wrong-length or non-byte argument is
 * refused (`invalid_length`, `invalid_argument`), and a small-order key `invalid_public_key`, as in
 * wrapCek. Inputs are not modified.
 */
export async function checkWrap(
  recipientEncPublicKey: Uint8Array,
  envelopeId: Uint8Array,
  cek: Uint8Array,
  entry: WrappedCek,
): Promise<boolean> {
  assertLength(recipientEncPublicKey, X25519_KEY_LENGTH, 'checkWrap: recipientEncPublicKey');
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, 'checkWrap: envelopeId');
  assertLength(cek, CEK_LENGTH, 'checkWrap: cek');
  if (typeof entry !== 'object' || entry === null) {
    throw new CryptoInputError('invalid_argument', 'checkWrap: entry must be {enc, wk}');
  }
  const { enc, wk } = entry;
  assertLength(enc, HPKE_ENC_LENGTH, 'checkWrap: enc');
  assertLength(wk, WRAPPED_CEK_LENGTH, 'checkWrap: wk');
  // Copied before the await, so the bytes compared are the bytes passed in.
  const encCopy = enc.slice();
  const wkCopy = wk.slice();
  const expected = await wrapCek(recipientEncPublicKey, envelopeId, cek);
  // Both comparisons always run (no short-circuit on the first).
  const encEqual = equalBytes(expected.enc, encCopy);
  const wkEqual = equalBytes(expected.wk, wkCopy);
  return encEqual && wkEqual;
}

/**
 * KeyStore implementations only (@4thtech-io/crypto/keystore): opens one recipient entry with that
 * recipient's X25519 secret key and returns the 32-byte CEK. The argument order follows
 * `EnvelopeKeys.unwrapCek(wrapped, envelopeId, {epoch?})` (04 §3.1.1, G-2): it takes the 16-byte
 * envelope id and builds `info` itself, never an `info` from the caller, so it cannot open an HPKE
 * seal made for another context (IR-M1-1c-1 F5). It has no epoch: the KeyStore picks the secret key
 * for the entry's epoch. Every failure to open (another recipient, another envelope id, a tampered
 * enc or wk, an all-zero shared secret) is the same `open_failed`. Wipe the CEK after the payload
 * AEAD. Inputs are not modified.
 */
export async function unwrapCek(
  recipientEncSecretKey: Uint8Array,
  wrapped: WrappedCek,
  envelopeId: Uint8Array,
): Promise<Uint8Array> {
  assertLength(recipientEncSecretKey, X25519_KEY_LENGTH, 'unwrapCek: recipientEncSecretKey');
  if (typeof wrapped !== 'object' || wrapped === null) {
    throw new CryptoInputError('invalid_argument', 'unwrapCek: wrapped must be {enc, wk}');
  }
  const { enc, wk } = wrapped;
  assertLength(enc, HPKE_ENC_LENGTH, 'unwrapCek: enc');
  assertLength(wk, WRAPPED_CEK_LENGTH, 'unwrapCek: wk');
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, 'unwrapCek: envelopeId');
  const cek = await hpkeOpen(recipientEncSecretKey, enc, cekInfo(envelopeId), EMPTY, wk);
  if (cek.length !== CEK_LENGTH) {
    wipe(cek);
    throw new CryptoInputError('invalid_length', 'unwrapCek: the CEK must be 32 bytes');
  }
  return cek;
}

/**
 * Test seam and the sealing core: one sender context (mode Base) under a fixed ephemeral secret
 * key, sealing `messages` in order (sequence numbers 0, 1, ...). Not exported from any entry.
 */
export async function hpkeSealSequence(
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array,
  info: Uint8Array,
  messages: readonly { readonly aad: Uint8Array; readonly plaintext: Uint8Array }[],
): Promise<HpkeSealed> {
  assertLength(recipientPublicKey, X25519_KEY_LENGTH, 'hpke: recipientPublicKey');
  assertLength(ephemeralSecretKey, X25519_KEY_LENGTH, 'hpke: ephemeralSecretKey');
  assertBytes(info, 'hpke: info');
  return checkedSeal(recipientPublicKey, ephemeralSecretKey, info, messages);
}

/**
 * The one sealing path. Copies every caller-owned buffer once, before any await, then refuses an
 * all-zero shared secret (RFC 9180 §7.1.4) on the copies before any HPKE or WebCrypto work, and
 * seals the same copies, so a buffer changed during an await cannot swap in a key after the check.
 */
async function checkedSeal(
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array,
  info: Uint8Array,
  messages: readonly { readonly aad: Uint8Array; readonly plaintext: Uint8Array }[],
): Promise<HpkeSealed> {
  for (const message of messages) {
    assertBytes(message.aad, 'hpke: aad');
    assertBytes(message.plaintext, 'hpke: plaintext');
  }
  const publicKey = recipientPublicKey.slice();
  const secretKey = ephemeralSecretKey.slice();
  const infoCopy = info.slice();
  const copies = messages.map((m) => ({ aad: m.aad.slice(), plaintext: m.plaintext.slice() }));
  try {
    if (!sharedSecretIsNonZero(secretKey, publicKey)) {
      throw new CryptoInputError(
        'invalid_public_key',
        'hpke: the recipient key is a small-order X25519 point (all-zero shared secret)',
      );
    }
    return await sealSequence(publicKey, secretKey, infoCopy, copies);
  } finally {
    wipe(secretKey, ...copies.map((m) => m.plaintext));
  }
}

async function sealSequence(
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array,
  info: Uint8Array,
  messages: readonly { readonly aad: Uint8Array; readonly plaintext: Uint8Array }[],
): Promise<HpkeSealed> {
  // Only reached through checkedSeal, with copies already checked. The ephemeral key is ours: if WebCrypto cannot import it, the runtime lacks the suite. The
  // recipient key is input: a runtime that refuses it (one that rejects a non-canonical encoding,
  // say) refuses an input, the same refusal in every runtime.
  let ekm;
  try {
    ekm = await importKeyPair(ephemeralSecretKey);
  } catch (error) {
    throw platformError(error);
  }
  let recipientKey;
  try {
    recipientKey = await importPublicKey(recipientPublicKey);
  } catch {
    throw new CryptoInputError('invalid_public_key', 'hpke: the recipient key was refused');
  }
  let sender;
  try {
    sender = await cipherSuite().createSenderContext({
      recipientPublicKey: recipientKey,
      ekm,
      info,
    });
  } catch (error) {
    if (error instanceof EncapError) {
      throw new CryptoInputError('invalid_public_key', 'hpke: the recipient key was refused');
    }
    throw platformError(error);
  }
  const ciphertexts: Uint8Array[] = [];
  try {
    for (const message of messages) {
      ciphertexts.push(new Uint8Array(await sender.seal(message.plaintext, message.aad)));
    }
  } catch (error) {
    throw platformError(error);
  }
  return Object.freeze({
    enc: new Uint8Array(sender.enc),
    ciphertexts: Object.freeze(ciphertexts),
  });
}

/**
 * Test seam and the opening core: single-shot open (mode Base, sequence number 0) with the
 * recipient's raw X25519 secret key. Refuses an all-zero shared secret before any HPKE work. Every
 * failure to open is `open_failed`. Not exported from any entry (it takes any info); unwrapCek
 * is the only path a KeyStore exposes.
 */
export async function hpkeOpen(
  recipientSecretKey: Uint8Array,
  enc: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  assertLength(recipientSecretKey, X25519_KEY_LENGTH, 'hpke: recipientSecretKey');
  assertLength(enc, HPKE_ENC_LENGTH, 'hpke: enc');
  assertBytes(info, 'hpke: info');
  assertBytes(aad, 'hpke: aad');
  assertBytes(ciphertext, 'hpke: ciphertext');
  // Copy every caller-owned buffer once, before any await: the check and the open use the same
  // bytes, so a buffer changed during an await cannot swap in a small-order enc after the check.
  const secretKey = recipientSecretKey.slice();
  const encCopy = enc.slice();
  const infoCopy = info.slice();
  const aadCopy = aad.slice();
  const ciphertextCopy = ciphertext.slice();
  try {
    if (!sharedSecretIsNonZero(secretKey, encCopy)) throw openFailed();
    let recipientKey;
    try {
      recipientKey = await importKeyPair(secretKey);
    } catch (error) {
      throw platformError(error);
    }
    const plaintext = await cipherSuite().open(
      { recipientKey, enc: encCopy, info: infoCopy },
      ciphertextCopy,
      aadCopy,
    );
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof CryptoInputError || isPlatformError(error)) throw error;
    // The recipient key already imported, so a refused enc (DeserializeError) is input, like a
    // refused DH (DecapError) or a failed tag (OpenError).
    if (
      error instanceof OpenError ||
      error instanceof DecapError ||
      error instanceof DeserializeError
    ) {
      throw openFailed();
    }
    throw platformError(error);
  } finally {
    wipe(secretKey);
  }
}
