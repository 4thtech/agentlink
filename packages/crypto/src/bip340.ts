// BIP-340 Schnorr signatures over secp256k1 (04 §2.1 Nostr and drop keys, §3.1 envelope `sig`,
// §2.5.1 owner-action `sig`). The scheme is @noble/curves (04 §8.1); nothing here implements it
// (I-8). Signing takes a secret key, so bip340Sign and bip340PublicKey are for KeyStore
// implementations only and are exported only from @4thtech-io/crypto/keystore; every other caller
// signs through the KeyStore. bip340Verify and isBip340PublicKey are public.
//
// BIP-340 has no high-s/low-s pair as ECDSA does: R is fixed to an even y, and verification
// requires r < p and s < n, so there is one valid encoding per (key, message, nonce). The low-s
// rule of 04 §2.4.1 is for ECDSA only.
import { schnorr } from '@noble/curves/secp256k1.js';
import { assertBytes } from './bytes.js';
import { encodeHex } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { randomBytes } from './random.js';
import { assertSecp256k1SecretKey } from './secp256k1-range.js';
import { wipe } from './wipe.js';

export const BIP340_PUBLIC_KEY_LENGTH = 32;
export const BIP340_SIGNATURE_LENGTH = 64;

function assertSecretKey(secretKey: unknown): asserts secretKey is Uint8Array {
  assertSecp256k1SecretKey(secretKey, 'bip340');
}

/** The 32-byte x-only public key of a secret key (1 <= key < n). */
export function bip340PublicKey(secretKey: Uint8Array): Uint8Array {
  assertSecretKey(secretKey);
  try {
    return schnorr.getPublicKey(secretKey);
  } catch {
    // The library's message is not ours to vouch for (I-7): replace it, keep no cause.
    throw new CryptoInputError('invalid_argument', 'bip340: no public key for this secret key');
  }
}

/**
 * BIP-340 signature (64 bytes) over `message` of any length. `auxRand` is the 32 bytes of
 * auxiliary randomness; by default fresh bytes from the platform CSPRNG, which BIP-340 recommends.
 * Pass it only to reproduce test vectors; production callers omit it. Inputs are not modified.
 */
export function bip340Sign(
  secretKey: Uint8Array,
  message: Uint8Array,
  auxRand?: Uint8Array,
): Uint8Array {
  assertSecretKey(secretKey);
  assertBytes(message, 'bip340Sign: message');
  if (auxRand !== undefined) {
    assertBytes(auxRand, 'bip340Sign: auxRand');
    if (auxRand.length !== 32) {
      throw new CryptoInputError('invalid_length', 'bip340Sign: auxRand must be 32 bytes');
    }
  }
  const aux = auxRand ?? randomBytes(32);
  try {
    return schnorr.sign(message, secretKey, aux);
  } catch {
    throw new CryptoInputError('invalid_argument', 'bip340Sign: signing failed');
  } finally {
    if (auxRand === undefined) wipe(aux);
  }
}

/**
 * BIP-340 verification. Returns false for any signature that does not verify, including a public
 * key that is not an x coordinate on the curve (or not below p), r >= p, s >= n and s = 0. Throws
 * CryptoInputError only for arguments of the wrong type or length.
 */
export function bip340Verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  assertBytes(publicKey, 'bip340Verify: publicKey');
  assertBytes(message, 'bip340Verify: message');
  assertBytes(signature, 'bip340Verify: signature');
  if (publicKey.length !== BIP340_PUBLIC_KEY_LENGTH) {
    throw new CryptoInputError('invalid_length', 'bip340Verify: publicKey must be 32 bytes');
  }
  if (signature.length !== BIP340_SIGNATURE_LENGTH) {
    throw new CryptoInputError('invalid_length', 'bip340Verify: signature must be 64 bytes');
  }
  try {
    return schnorr.verify(signature, message, publicKey);
  } catch {
    return false; // fail closed
  }
}

/**
 * True when `publicKey` is 32 bytes that lift to a point on secp256k1 (BIP-340 lift_x): an x
 * coordinate below p with a square y^2 = x^3 + 7. Use it to refuse a card or `from` key at parse
 * time; bip340Verify applies the same check.
 */
export function isBip340PublicKey(publicKey: Uint8Array): boolean {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== BIP340_PUBLIC_KEY_LENGTH) {
    return false;
  }
  try {
    schnorr.utils.lift_x(BigInt('0x' + encodeHex(publicKey)));
    return true;
  } catch {
    return false;
  }
}
