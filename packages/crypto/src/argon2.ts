// Argon2id v1.3 (RFC 9106), the password KDF of the owner passphrase wrap, the file KeyStore and the
// recovery code (04 §2.3, §2.8). The primitive is @noble/hashes (04 §8.1, D-54): nothing here
// implements it (I-8). Node's built-in crypto.argon2 is not on the allowlist and is not used (04 §2.8,
// open owner question). The async variant yields to the event loop, so an MCP server can answer
// `initialize` while an unlock runs (04 §2.8). @noble/hashes zeroes its working memory and H0 when it
// finishes; the output is the caller's to wipe.
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { assertBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';

/** Argon2id cost: memory in KiB (m), iterations (t) and lanes (p). */
export interface Argon2idParams {
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

/**
 * Hard ceiling for any Argon2id run in this package: the 04 §2.8 read cap (m ≤ 256 MiB). It stops a
 * planted header, or a mistaken caller, from exhausting memory; RFC 9106's own lower bounds apply
 * below it. The file formats add their floor and tighter caps on top (KEYSTORE_KDF_BOUNDS).
 */
const MAX_MEMORY_KIB = 262144;
const MAX_ITERATIONS = 0xffffffff;
const MAX_PARALLELISM = 0xffffff;
const MIN_SALT_LENGTH = 8;
const MIN_OUTPUT_LENGTH = 4;
const MAX_OUTPUT_LENGTH = 1024;

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Throws unless the parameters are within RFC 9106 (m ≥ 8p) and the 256 MiB ceiling. */
export function assertArgon2idParams(params: Argon2idParams, what: string): void {
  if (
    typeof params !== 'object' ||
    params === null ||
    !isIntegerIn(params.parallelism, 1, MAX_PARALLELISM) ||
    !isIntegerIn(params.iterations, 1, MAX_ITERATIONS) ||
    !isIntegerIn(params.memoryKiB, 8 * params.parallelism, MAX_MEMORY_KIB)
  ) {
    throw new CryptoInputError(
      'invalid_argument',
      `${what}: Argon2id parameters must be integers with p >= 1, t >= 1 and 8p <= m <= 262144 KiB`,
    );
  }
}

interface Argon2idExtras {
  /** RFC 9106 secret value K (empty = none). */
  readonly secret: Uint8Array;
  /** RFC 9106 associated data X (empty = none). */
  readonly ad: Uint8Array;
  readonly length: number;
}

/** The one call into @noble/hashes; argon2id and the test seam both come through here. */
export async function argon2idRaw(
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams,
  extras: Argon2idExtras,
): Promise<Uint8Array> {
  assertBytes(password, 'argon2id: password');
  assertBytes(salt, 'argon2id: salt');
  assertBytes(extras.secret, 'argon2id: secret');
  assertBytes(extras.ad, 'argon2id: ad');
  if (salt.length < MIN_SALT_LENGTH) {
    throw new CryptoInputError('invalid_argument', 'argon2id: salt must be at least 8 bytes');
  }
  assertArgon2idParams(params, 'argon2id');
  if (!isIntegerIn(extras.length, MIN_OUTPUT_LENGTH, MAX_OUTPUT_LENGTH)) {
    throw new CryptoInputError('invalid_argument', 'argon2id: length must be 4 to 1024 bytes');
  }
  return argon2idAsync(password, salt, {
    m: params.memoryKiB,
    t: params.iterations,
    p: params.parallelism,
    version: 0x13,
    dkLen: extras.length,
    ...(extras.secret.length > 0 ? { key: extras.secret } : {}),
    ...(extras.ad.length > 0 ? { personalization: extras.ad } : {}),
  });
}

/**
 * Argon2id v1.3 with no secret value (K) and no associated data (X), 32-byte output: the KDF of
 * 04 §2.3 and §2.8. `password` is the output of normalizeSecret, never raw text. Inputs are not
 * modified; wipe the result when done.
 */
export function argon2id(
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  return argon2idRaw(password, salt, params, {
    secret: new Uint8Array(0),
    ad: new Uint8Array(0),
    length: 32,
  });
}
