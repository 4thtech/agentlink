// Range check for secp256k1 secret keys (04 §2.1 rejection loop; BIP-340 secret keys). Internal:
// not exported from the package. The curve order is hard-coded, so the check does not depend on
// the library it guards (IR-M1-1b-1 I-1); a unit test pins it to @noble/curves' order.
import { assertBytes } from './bytes.js';
import { decodeHex } from './encoding.js';
import { CryptoInputError } from './errors.js';

/** secp256k1 group order n (SEC 2 v2 §2.4.1), big-endian. */
export const SECP256K1_ORDER_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';

const ORDER = decodeHex(SECP256K1_ORDER_HEX);

/**
 * True when `bytes` is 32 bytes whose big-endian value k satisfies 1 <= k < n. Computed without a
 * data-dependent branch or early exit: the borrow of (k - n) says k < n, and an OR of all bytes
 * says k != 0. Best effort only, like every timing property in JavaScript.
 */
export function isSecp256k1SecretKey(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length !== ORDER.length) return false;
  let borrow = 0;
  let any = 0;
  for (let i = ORDER.length - 1; i >= 0; i -= 1) {
    const byte = bytes[i] as number;
    any |= byte;
    borrow = ((byte - (ORDER[i] as number) - borrow) >>> 31) & 1;
  }
  return (borrow & (any !== 0 ? 1 : 0)) === 1;
}

/**
 * The one secret-key check for every secp256k1 signer (BIP-340 and ECDSA, IR-M1-1e-1 L-2), with one
 * set of codes: `invalid_argument` (not a Uint8Array), `invalid_length` (not 32 bytes) and
 * `invalid_argument` (not in [1, n - 1]). `what` names the caller; the key never appears in errors.
 */
export function assertSecp256k1SecretKey(
  secretKey: unknown,
  what: string,
): asserts secretKey is Uint8Array {
  assertBytes(secretKey, `${what}: the secret key`);
  if (secretKey.length !== 32) {
    throw new CryptoInputError('invalid_length', `${what}: the secret key must be 32 bytes`);
  }
  if (!isSecp256k1SecretKey(secretKey)) {
    throw new CryptoInputError('invalid_argument', `${what}: the secret key is out of range`);
  }
}
