// M1-PAY-CONFIRM-a (04 §2.5.3 rule 5; D-132): the WebAuthn assertion signature check of a paid-action
// confirmation. The owner's passkey signs `authenticatorData ‖ SHA-256(clientDataJSON)` with the
// credential key stored at registration; this file reads that key (a COSE_Key, RFC 9052 §7, from the
// attested credential data of the registration's authenticator data) and verifies the signature.
//
// - Algorithms: ES256 (COSE alg -7, P-256 ECDSA over SHA-256, DER signature, high S accepted as
//   WebAuthn does) and EdDSA (COSE alg -8, Ed25519, strict RFC 8032 verification). Any other key
//   (RS256 included) is refused: the curve arithmetic is @noble/curves (04 §8.1 allowlist), which has
//   no RSA, and nothing here implements a primitive (I-8).
// - The COSE_Key decoder reads only the CBOR it needs (unsigned and negative integers, byte strings,
//   one map, definite lengths) and refuses anything else, a duplicate key, an extra key or trailing
//   bytes. A P-256 point must be on the curve.
// - signCount is not checked: platform passkeys commonly report 0, and the existing owner-presence
//   checks never used it. Replay is stopped by the single-use challenge (rule 2).
//
// Errors never contain the input (I-7): see errors.ts.
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { concatBytes, equalBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';
import { sha256 } from './hash.js';

/** COSE algorithm identifiers this verifier accepts. */
export const WEBAUTHN_ALG_ES256 = -7;
export const WEBAUTHN_ALG_EDDSA = -8;

const MAX_COSE_KEY = 256;
const FLAG_AT = 0x40;
/** rpIdHash (32) ‖ flags (1) ‖ signCount (4) ‖ aaguid (16) ‖ credentialIdLength (2). */
const ATTESTED_HEADER = 55;

const invalidKey = (): CryptoInputError =>
  new CryptoInputError('invalid_argument', 'webauthn: the credential public key is not supported');

type CborValue = bigint | Uint8Array | Map<bigint, CborValue>;

/** Reads one CBOR item at `at`; returns it and the offset after it. Refuses unsupported items. */
function readItem(bytes: Uint8Array, at: number, depth: number): [CborValue, number] {
  if (at >= bytes.length) throw invalidKey();
  const head = bytes[at] as number;
  const major = head >> 5;
  const info = head & 0x1f;
  let length: number;
  let next = at + 1;
  if (info < 24) length = info;
  else if (info === 24) {
    if (next + 1 > bytes.length) throw invalidKey();
    length = bytes[next] as number;
    if (length < 24) throw invalidKey(); // not the shortest form
    next += 1;
  } else if (info === 25) {
    if (next + 2 > bytes.length) throw invalidKey();
    length = ((bytes[next] as number) << 8) | (bytes[next + 1] as number);
    if (length < 256) throw invalidKey();
    next += 2;
  } else {
    throw invalidKey();
  }
  switch (major) {
    case 0:
      return [BigInt(length), next];
    case 1:
      return [-1n - BigInt(length), next];
    case 2: {
      if (next + length > bytes.length) throw invalidKey();
      return [bytes.slice(next, next + length), next + length];
    }
    case 5: {
      if (depth > 0 || length > 8) throw invalidKey();
      const map = new Map<bigint, CborValue>();
      for (let i = 0; i < length; i += 1) {
        const [key, afterKey] = readItem(bytes, next, depth + 1);
        if (typeof key !== 'bigint' || map.has(key)) throw invalidKey();
        const [value, afterValue] = readItem(bytes, afterKey, depth + 1);
        if (value instanceof Map) throw invalidKey();
        map.set(key, value);
        next = afterValue;
      }
      return [map, next];
    }
    default:
      throw invalidKey();
  }
}

/** A checked credential public key. */
export type WebauthnPublicKey =
  | { readonly alg: typeof WEBAUTHN_ALG_ES256; readonly point: Uint8Array }
  | { readonly alg: typeof WEBAUTHN_ALG_EDDSA; readonly point: Uint8Array };

function decodeAt(bytes: Uint8Array, at: number): [WebauthnPublicKey, number] {
  const [value, end] = readItem(bytes, at, 0);
  if (!(value instanceof Map)) throw invalidKey();
  const get = (k: bigint) => value.get(k);
  const kty = get(1n);
  const alg = get(3n);
  const crv = get(-1n);
  const x = get(-2n);
  if (alg === BigInt(WEBAUTHN_ALG_ES256)) {
    const y = get(-3n);
    if (
      value.size !== 5 ||
      kty !== 2n ||
      crv !== 1n ||
      !(x instanceof Uint8Array) ||
      x.length !== 32 ||
      !(y instanceof Uint8Array) ||
      y.length !== 32
    ) {
      throw invalidKey();
    }
    const point = concatBytes(new Uint8Array([0x04]), x, y);
    try {
      p256.Point.fromBytes(point).assertValidity();
    } catch {
      throw invalidKey();
    }
    return [{ alg: WEBAUTHN_ALG_ES256, point }, end];
  }
  if (alg === BigInt(WEBAUTHN_ALG_EDDSA)) {
    if (
      value.size !== 4 ||
      kty !== 1n ||
      crv !== 6n ||
      !(x instanceof Uint8Array) ||
      x.length !== 32
    ) {
      throw invalidKey();
    }
    return [{ alg: WEBAUTHN_ALG_EDDSA, point: x.slice() }, end];
  }
  throw invalidKey();
}

/** Decodes and checks a stored COSE_Key (exactly one key, no trailing bytes). */
export function decodeWebauthnPublicKey(coseKey: Uint8Array): WebauthnPublicKey {
  if (!(coseKey instanceof Uint8Array) || coseKey.length === 0 || coseKey.length > MAX_COSE_KEY) {
    throw invalidKey();
  }
  const [key, end] = decodeAt(coseKey, 0);
  if (end !== coseKey.length) throw invalidKey();
  return key;
}

/**
 * The credential public key (COSE_Key bytes) from a registration's authenticator data, after
 * checking that its attested credential ID is `credentialId`. Refuses authenticator data without
 * attested credential data and any key decodeWebauthnPublicKey refuses.
 */
export function webauthnPublicKeyFromAuthenticatorData(
  authenticatorData: Uint8Array,
  credentialId: Uint8Array,
): Uint8Array {
  const auth = authenticatorData;
  if (!(auth instanceof Uint8Array) || auth.length < ATTESTED_HEADER) throw invalidKey();
  if (((auth[32] as number) & FLAG_AT) === 0) throw invalidKey();
  const idLength = ((auth[53] as number) << 8) | (auth[54] as number);
  const keyAt = ATTESTED_HEADER + idLength;
  if (keyAt > auth.length || !equalBytes(auth.subarray(ATTESTED_HEADER, keyAt), credentialId)) {
    throw invalidKey();
  }
  const [, end] = decodeAt(auth, keyAt);
  if (end - keyAt > MAX_COSE_KEY) throw invalidKey();
  return auth.slice(keyAt, end);
}

/**
 * Rule 5: true only when `signature` is the credential key's signature over
 * `authenticatorData ‖ SHA-256(clientDataJSON)`. Any malformed input is false.
 */
export function verifyWebauthnSignature(
  coseKey: Uint8Array,
  authenticatorData: Uint8Array,
  clientDataJSON: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    if (
      !(authenticatorData instanceof Uint8Array) ||
      !(clientDataJSON instanceof Uint8Array) ||
      !(signature instanceof Uint8Array) ||
      signature.length === 0
    ) {
      return false;
    }
    const key = decodeWebauthnPublicKey(coseKey);
    const message = concatBytes(authenticatorData, sha256(clientDataJSON));
    if (key.alg === WEBAUTHN_ALG_ES256) {
      return p256.verify(signature, message, key.point, {
        format: 'der',
        lowS: false,
        prehash: true,
      });
    }
    return ed25519.verify(signature, message, key.point, { zip215: false });
  } catch {
    return false;
  }
}
