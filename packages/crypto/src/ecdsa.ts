// Canonical secp256k1 ECDSA for EIP-712 signatures (04 §2.4.1): cardSig, cardAgentSig and, from
// M1-1j, Record and Receipt signatures from an EOA. The curve arithmetic is @noble/curves (04 §8.1
// allowlist); nothing here implements a primitive (I-8). What this file adds is the one canonical
// form and its checks, which libraries do not enforce on recovery: viem and noble accept a high `s`
// and a recovery id of 0 or 1.
//
// Errors never contain the input (I-7): see errors.ts.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { assertBytes } from './bytes.js';
import { decodeHex0x, encodeHex0x } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { evmAddressFromPublicKey } from './keys.js';
import { assertSecp256k1SecretKey } from './secp256k1-range.js';

/** Length of a canonical ECDSA signature r || s || v (04 §2.4.1). */
export const ECDSA_SIGNATURE_BYTES = 65;

/** secp256k1 group order n. */
const N = secp256k1.Point.CURVE().n;
/** EIP-2: s <= n/2 (n is odd, so this is floor(n / 2)). */
const HALF_N = N >> 1n;

const invalidSignature = (): CryptoInputError =>
  new CryptoInputError(
    'invalid_signature',
    'ECDSA signature must be r || s || v with r, s in [1, n - 1], s <= n/2 and v 27 or 28',
  );

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function assertDigest(digest: unknown, what: string): asserts digest is Uint8Array {
  assertBytes(digest, what);
  if (digest.length !== 32) {
    throw new CryptoInputError('invalid_argument', `${what} must be 32 bytes`);
  }
}

/** Throws unless `signature` is exactly the canonical 65-byte form of 04 §2.4.1. */
function assertCanonical(signature: Uint8Array): void {
  if (signature.length !== ECDSA_SIGNATURE_BYTES) throw invalidSignature();
  const r = toBigInt(signature.subarray(0, 32));
  const s = toBigInt(signature.subarray(32, 64));
  const v = signature[64];
  if (r < 1n || r >= N || s < 1n || s > HALF_N || (v !== 27 && v !== 28)) {
    throw invalidSignature();
  }
}

/**
 * Signs a 32-byte digest (an EIP-712 digest) with a secp256k1 secret key: deterministic ECDSA
 * (RFC 6979, no extra entropy), low `s`, returned as r || s || v with v in {27, 28}.
 *
 * For KeyStore implementations only (04 §8.1): the rest of the code signs through the KeyStore.
 * The key is read, never copied or retained here; the library's internal scalar copy cannot be
 * wiped (see wipe.ts on the limits of wiping in JavaScript).
 */
export function signDigestEcdsa(digest: Uint8Array, secretKey: Uint8Array): Uint8Array {
  assertDigest(digest, 'signDigestEcdsa: digest');
  // The same check and codes as every secp256k1 signer (IR-M1-1e-1 L-2).
  assertSecp256k1SecretKey(secretKey, 'signDigestEcdsa');
  let recovered: Uint8Array;
  try {
    recovered = secp256k1.sign(digest, secretKey, {
      prehash: false,
      lowS: true,
      extraEntropy: false,
      format: 'recovered',
    });
  } catch {
    // Unreachable after the range check; the library's message is never passed on (I-7).
    throw new CryptoInputError('invalid_argument', 'signDigestEcdsa: signing failed');
  }
  // noble's recovered form is recovery || r || s; ours is r || s || (27 + recovery).
  const recovery = recovered[0] as number;
  if (recovery !== 0 && recovery !== 1) {
    // r >= n as an x-coordinate: probability about 2^-128, and v cannot express it.
    throw new CryptoInputError('invalid_argument', 'signature has no 27/28 recovery id');
  }
  const out = new Uint8Array(ECDSA_SIGNATURE_BYTES);
  out.set(recovered.subarray(1, 65), 0);
  out[64] = 27 + recovery;
  assertCanonical(out);
  return out;
}

/**
 * Parses a signature in its JSON form, `0x` + 130 lowercase hex (04 §2.4.1), and checks the
 * canonical form: r and s in [1, n - 1], s <= n/2, v in {27, 28}. Anything else is refused, never
 * normalised: upper case, no `0x` or `0X`, 64 or 66 bytes, a high `s`, v in {0, 1}.
 */
export function decodeEcdsaSignature(text: string): Uint8Array {
  if (typeof text !== 'string') {
    throw new CryptoInputError('invalid_argument', 'decodeEcdsaSignature: text must be a string');
  }
  if (!/^0x[0-9a-f]{130}$/.test(text)) throw invalidSignature();
  const out = new Uint8Array(ECDSA_SIGNATURE_BYTES);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(text.slice(2 + 2 * i, 4 + 2 * i), 16);
  }
  assertCanonical(out);
  return out;
}

/** The JSON form `0x` + 130 lowercase hex of a canonical signature; refuses any other form. */
export function encodeEcdsaSignature(signature: Uint8Array): string {
  assertBytes(signature, 'encodeEcdsaSignature: signature');
  assertCanonical(signature);
  return encodeHex0x(signature);
}

/**
 * Recovers the signer's 20-byte EVM address from a 32-byte digest and a canonical 65-byte signature.
 * A non-canonical signature (including the malleated high-`s` twin of a valid one) is refused before
 * any recovery, as is one from which no public key can be recovered.
 */
export function recoverEvmAddress(digest: Uint8Array, signature: Uint8Array): Uint8Array {
  assertDigest(digest, 'recoverEvmAddress: digest');
  assertBytes(signature, 'recoverEvmAddress: signature');
  assertCanonical(signature);
  let publicKey: Uint8Array;
  try {
    const recovered = new Uint8Array(ECDSA_SIGNATURE_BYTES);
    recovered[0] = (signature[64] as number) - 27;
    recovered.set(signature.subarray(0, 64), 1);
    publicKey = secp256k1.Signature.fromBytes(recovered, 'recovered')
      .recoverPublicKey(digest)
      .toBytes(false);
  } catch {
    throw new CryptoInputError('invalid_signature', 'no public key recovers from this signature');
  }
  // The one address derivation (M1-1b, 04 §2.9; IR-M1-1e-1 L-2).
  return decodeHex0x(evmAddressFromPublicKey(publicKey), { length: 20 });
}
