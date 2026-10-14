// 04 §3.3 content-key wrapping (M1-1c): RFC 9180 HPKE, mode Base, with KEM DHKEM(X25519,
// HKDF-SHA256) 0x0020, KDF HKDF-SHA256 0x0001 and AEAD AES-256-GCM 0x0002, through @hpke/core
// (04 §8.1 allowlist; nothing here implements a primitive, I-8).
//
// - info = utf8("agentlink/v1/cek") || the envelope id as its raw 16 bytes; AAD empty.
// - One independent seal per recipient: enc (32 bytes) and wk (the 32-byte CEK sealed, 48 bytes).
// - Sender authenticity comes from the envelope `sig`, not from HPKE Auth mode (04 §3.3).
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
import { assertBytes, concatBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { CEK_LENGTH, ENVELOPE_ID_LENGTH, HPKE_ENC_LENGTH, WRAPPED_CEK_LENGTH } from './envelope.js';
import { CryptoInputError } from './errors.js';
import { randomBytes } from './random.js';
import { wipe } from './wipe.js';

/** 04 §3.3: the label that starts the HPKE info of a CEK wrap. */
export const CEK_INFO_LABEL = 'agentlink/v1/cek';

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
 * Seals `cek` to `recipientEncPublicKey` under a given ephemeral secret key. wrapCek calls it with
 * fresh random bytes; the test seam calls it with a fixed key to reproduce vectors.
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
 * 04 §3.3: seals the 32-byte CEK to one recipient's X25519 `agentEnc`/`ownerEnc` key, bound to the
 * envelope id through info, with a fresh ephemeral key. Call it once per recipient (04 §3.2).
 * Refuses a small-order recipient key (`invalid_public_key`). Inputs are not modified.
 */
export async function wrapCek(
  recipientEncPublicKey: Uint8Array,
  envelopeId: Uint8Array,
  cek: Uint8Array,
): Promise<WrappedCek> {
  // Checked before drawing randomness, so a bad argument costs nothing.
  assertLength(recipientEncPublicKey, X25519_KEY_LENGTH, 'wrapCek: recipientEncPublicKey');
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, 'wrapCek: envelopeId');
  assertLength(cek, CEK_LENGTH, 'wrapCek: cek');
  const ephemeral = randomBytes(X25519_KEY_LENGTH);
  try {
    return await wrapCekWithEphemeralKey(recipientEncPublicKey, envelopeId, cek, ephemeral);
  } finally {
    wipe(ephemeral);
  }
}

/**
 * KeyStore implementations only (@agentlink/crypto/keystore; KeyStore.hpkeOpen, 03 §3): opens one
 * recipient's wrap with that recipient's X25519 secret key and returns the 32-byte CEK. Every
 * failure to open (another recipient, another envelope id, a tampered enc or wk, an all-zero shared
 * secret) is the same `open_failed`. Wipe the CEK when done. Inputs are not modified.
 */
export async function unwrapCek(
  recipientEncSecretKey: Uint8Array,
  envelopeId: Uint8Array,
  wrapped: WrappedCek,
): Promise<Uint8Array> {
  assertLength(recipientEncSecretKey, X25519_KEY_LENGTH, 'unwrapCek: recipientEncSecretKey');
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, 'unwrapCek: envelopeId');
  if (typeof wrapped !== 'object' || wrapped === null) {
    throw new CryptoInputError('invalid_argument', 'unwrapCek: wrapped must be {enc, wk}');
  }
  const { enc, wk } = wrapped;
  assertLength(enc, HPKE_ENC_LENGTH, 'unwrapCek: enc');
  assertLength(wk, WRAPPED_CEK_LENGTH, 'unwrapCek: wk');
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
 * failure to open is `open_failed`. Not exported from any entry; unwrapCek is the public path.
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
