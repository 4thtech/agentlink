// 04 §2.5.1 `storage.set` and 04 §2.2 `s3:<id>` (D-115; M1-9i-b2): the storage credential item and
// the digest that binds it to the owner-signed `storage.set`.
//   item   = JCS({"v":1,"salt","accessKeyId","secretAccessKey"}) as UTF-8 bytes, salt = 16 bytes as
//            base64url without padding
//   digest = HMAC-SHA256(key = the 16 raw salt bytes, msg = JCS({"accessKeyId","secretAccessKey"}))
//            as 64 lowercase hex
//
// The access key ID and the secret stay in bytes: the JCS form is written byte by byte from their
// UTF-8 (RFC 8785 string rules: `"` and `\` escaped, U+0008, U+0009, U+000A, U+000C and U+000D as
// \b \t \n \f \r, every other code point below U+0020 as \u00xx in lower-case hex, everything else as
// itself), so the secret never becomes a JS string (04 §2.2: "kept as Uint8Array"). Each value must
// be non-empty, at most 4 KiB, well-formed UTF-8 and is never normalised. Temporary credentials (a session token)
// have no field here and are refused by the item reader (M1).
//
// HMAC-SHA256 is @noble/hashes through pairing.ts; nothing here implements a primitive (I-8). Errors
// are fixed sentences that never contain the input (I-7). The vectors are in the `recovery-kit` suite
// (tools/vectors/generate_recovery_kit.py, an independent Python generator, D-82).
import { assertBytes, equalBytes } from './bytes.js';
import { decodeBase64url, encodeBase64url, encodeHex, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { hmacSha256 } from './pairing.js';
import { wipe } from './wipe.js';

/** The salt of an `s3:<id>` item: 16 CSPRNG bytes (04 §2.2). */
export const STORAGE_CREDENTIAL_SALT_LENGTH = 16;

/**
 * The most UTF-8 bytes a credential value may hold (proposed, owner confirms at merge; 04 §2.5.1):
 * with every byte written as a six-byte JCS escape, an item still fits the 64 KiB KeyStore item limit
 * (04 §2.8).
 */
export const STORAGE_CREDENTIAL_MAX_VALUE_BYTES = 4096;

/** S3 credentials as UTF-8 bytes (07 §5.2). Temporary credentials are refused in M1. */
export interface StorageCredential {
  readonly accessKeyId: Uint8Array;
  readonly secretAccessKey: Uint8Array;
}

/** The fields of an `s3:<id>` item (04 §2.2): the credential and its 16-byte salt. */
export interface StorageCredentialItemFields extends StorageCredential {
  readonly salt: Uint8Array;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const HEX_DIGITS = encodeUtf8('0123456789abcdef');
/** The short JCS escapes, by code point. */
const SHORT: Readonly<Record<number, number>> = Object.freeze({
  0x08: 0x62, // b
  0x09: 0x74, // t
  0x0a: 0x6e, // n
  0x0c: 0x66, // f
  0x0d: 0x72, // r
});
const UNSHORT: Readonly<Record<number, number>> = Object.freeze({
  0x22: QUOTE,
  0x5c: BACKSLASH,
  0x62: 0x08,
  0x74: 0x09,
  0x6e: 0x0a,
  0x66: 0x0c,
  0x72: 0x0d,
});

const ITEM_ACCESS = encodeUtf8('{"accessKeyId":');
const ITEM_SALT = encodeUtf8(',"salt":');
const ITEM_SECRET = encodeUtf8(',"secretAccessKey":');
const ITEM_END = encodeUtf8(',"v":1}');
const MESSAGE_END = encodeUtf8('}');

const notCanonical = (): CryptoInputError =>
  new CryptoInputError(
    'invalid_argument',
    'storage credential: the item is not the canonical JCS form of 04 §2.2',
  );

/** Unicode Table 3-7: well-formed UTF-8 (no overlong form, surrogate or code point above U+10FFFF). */
function isWellFormedUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] as number;
    if (b < 0x80) {
      i += 1;
      continue;
    }
    let need: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else return false;
    // A truncated sequence: the last continuation byte would be past the end.
    if (i + need >= bytes.length) return false;
    const second = bytes[i + 1] as number;
    if (second < lo || second > hi) return false;
    for (let k = 2; k <= need; k += 1) {
      const next = bytes[i + k] as number;
      if (next < 0x80 || next > 0xbf) return false;
    }
    i += need + 1;
  }
  return true;
}

function checkValue(value: unknown, what: string): asserts value is Uint8Array {
  assertBytes(value, `storage credential: ${what}`);
  if (value.length === 0) {
    throw new CryptoInputError('invalid_argument', `storage credential: ${what} must not be empty`);
  }
  if (value.length > STORAGE_CREDENTIAL_MAX_VALUE_BYTES) {
    throw new CryptoInputError('invalid_length', `storage credential: ${what} is too long`);
  }
  if (!isWellFormedUtf8(value)) {
    throw new CryptoInputError('invalid_utf8', `storage credential: ${what} must be UTF-8`);
  }
}

function checkFields(
  fields: unknown,
  withSalt: boolean,
): asserts fields is StorageCredentialItemFields {
  if (typeof fields !== 'object' || fields === null) {
    throw new CryptoInputError(
      'invalid_argument',
      'storage credential: the fields must be an object',
    );
  }
  const f = fields as Partial<StorageCredentialItemFields>;
  if (withSalt) {
    assertBytes(f.salt, 'storage credential: the salt');
    if (f.salt.length !== STORAGE_CREDENTIAL_SALT_LENGTH) {
      throw new CryptoInputError('invalid_length', 'storage credential: the salt must be 16 bytes');
    }
  }
  checkValue(f.accessKeyId, 'the access key ID');
  checkValue(f.secretAccessKey, 'the secret access key');
}

/** The JCS string form of a well-formed UTF-8 value, quotes included, into `out` at `at`. */
function writeString(out: Uint8Array, at: number, value: Uint8Array): number {
  let o = at;
  out[o++] = QUOTE;
  for (const b of value) {
    if (b === QUOTE || b === BACKSLASH) {
      out[o++] = BACKSLASH;
      out[o++] = b;
    } else if (b < 0x20) {
      out[o++] = BACKSLASH;
      const short = SHORT[b];
      if (short !== undefined) out[o++] = short;
      else {
        out.set([0x75, 0x30, 0x30, HEX_DIGITS[b >> 4] as number, HEX_DIGITS[b & 15] as number], o);
        o += 5;
      }
    } else out[o++] = b;
  }
  out[o++] = QUOTE;
  return o;
}

/** At most six bytes per value byte (\u00xx) plus the quotes. */
const stringBound = (value: Uint8Array): number => value.length * 6 + 2;

/** Writes `parts` (literal bytes, or a value to write as a JCS string) into one exact buffer. */
function assemble(parts: readonly (Uint8Array | { readonly string: Uint8Array })[]): Uint8Array {
  let bound = 0;
  for (const part of parts)
    bound += part instanceof Uint8Array ? part.length : stringBound(part.string);
  const work = new Uint8Array(bound);
  try {
    let o = 0;
    for (const part of parts) {
      if (part instanceof Uint8Array) {
        work.set(part, o);
        o += part.length;
      } else o = writeString(work, o, part.string);
    }
    return work.slice(0, o);
  } finally {
    wipe(work);
  }
}

/** JCS({"accessKeyId","secretAccessKey"}): the digest's message. The caller wipes it. */
function messageOf(fields: StorageCredential): Uint8Array {
  return assemble([
    ITEM_ACCESS,
    { string: fields.accessKeyId },
    ITEM_SECRET,
    { string: fields.secretAccessKey },
    MESSAGE_END,
  ]);
}

/**
 * 04 §2.5.1 `storage.set` `credentialDigest`: HMAC-SHA256 keyed by the 16 decoded salt bytes over
 * JCS({"accessKeyId","secretAccessKey"}), as 64 lowercase hex. Both values are UTF-8 bytes,
 * non-empty, at most 4 KiB and well-formed, never normalised. The inputs are not changed or kept.
 * A match against a stored digest is a MAC check: compare in constant time (equalBytes).
 */
export function credentialDigest(fields: StorageCredentialItemFields): string {
  checkFields(fields, true);
  const message = messageOf(fields);
  try {
    const mac = hmacSha256(fields.salt, message);
    try {
      return encodeHex(mac);
    } finally {
      wipe(mac);
    }
  } finally {
    wipe(message);
  }
}

/**
 * 04 §2.2: the `s3:<id>` item value, JCS JSON {"v":1,"salt","accessKeyId","secretAccessKey"} as UTF-8
 * bytes with `salt` as base64url. KeyStore backends only (it holds the secret); the caller wipes it.
 */
export function encodeStorageCredentialItem(fields: StorageCredentialItemFields): Uint8Array {
  checkFields(fields, true);
  return assemble([
    ITEM_ACCESS,
    { string: fields.accessKeyId },
    ITEM_SALT,
    { string: encodeUtf8(encodeBase64url(fields.salt)) },
    ITEM_SECRET,
    { string: fields.secretAccessKey },
    ITEM_END,
  ]);
}

/** Reads one JCS string at `at` (strictly the forms writeString produces); returns it and the end. */
function readString(item: Uint8Array, at: number): { value: Uint8Array; end: number } {
  if (item[at] !== QUOTE) throw notCanonical();
  const out = new Uint8Array(Math.max(0, item.length - at));
  let o = 0;
  let i = at + 1;
  try {
    for (;;) {
      if (i >= item.length) throw notCanonical();
      const b = item[i] as number;
      if (b === QUOTE) break;
      if (b < 0x20) throw notCanonical();
      if (b !== BACKSLASH) {
        out[o++] = b;
        i += 1;
        continue;
      }
      const e = item[i + 1];
      if (e === 0x75) {
        // \u00xx, lower-case hex, only for a code point below U+0020 without a short form.
        const digits = item.subarray(i + 2, i + 6);
        if (digits.length !== 4 || digits[0] !== 0x30 || digits[1] !== 0x30) throw notCanonical();
        const high = HEX_DIGITS.indexOf(digits[2] as number);
        const low = HEX_DIGITS.indexOf(digits[3] as number);
        if (high < 0 || high > 1 || low < 0) throw notCanonical();
        const c = high * 16 + low;
        if (SHORT[c] !== undefined) throw notCanonical();
        out[o++] = c;
        i += 6;
        continue;
      }
      const c = e === undefined ? undefined : UNSHORT[e];
      if (c === undefined) throw notCanonical();
      out[o++] = c;
      i += 2;
    }
    return { value: out.slice(0, o), end: i + 1 };
  } finally {
    wipe(out);
  }
}

function expectAt(item: Uint8Array, at: number, literal: Uint8Array): number {
  if (at + literal.length > item.length) throw notCanonical();
  for (let k = 0; k < literal.length; k += 1) {
    if (item[at + k] !== literal[k]) throw notCanonical();
  }
  return at + literal.length;
}

/**
 * 04 §2.2: reads an `s3:<id>` item that is exactly its canonical JCS form (key order, no
 * whitespace, the JCS escapes only, `v` = 1, a canonical 16-byte base64url salt, non-empty UTF-8
 * values, no other key such as a session token). Returns fresh copies; the caller wipes them.
 * KeyStore backends only (it returns the secret).
 */
export function parseStorageCredentialItem(item: Uint8Array): StorageCredentialItemFields {
  assertBytes(item, 'storage credential: the item');
  let accessKeyId: Uint8Array | undefined;
  let saltText: Uint8Array | undefined;
  let secretAccessKey: Uint8Array | undefined;
  let salt: Uint8Array | undefined;
  try {
    let at = expectAt(item, 0, ITEM_ACCESS);
    ({ value: accessKeyId, end: at } = readString(item, at));
    at = expectAt(item, at, ITEM_SALT);
    ({ value: saltText, end: at } = readString(item, at));
    at = expectAt(item, at, ITEM_SECRET);
    ({ value: secretAccessKey, end: at } = readString(item, at));
    at = expectAt(item, at, ITEM_END);
    if (at !== item.length) throw notCanonical();
    // The salt is public: it may become text. Only base64url characters can decode.
    if (saltText.some((b) => b >= 0x80)) throw notCanonical();
    try {
      salt = decodeBase64url(String.fromCharCode(...saltText), {
        length: STORAGE_CREDENTIAL_SALT_LENGTH,
      });
    } catch {
      throw notCanonical();
    }
    const fields = { salt, accessKeyId, secretAccessKey };
    checkFields(fields, true);
    // Belt and braces: the reader above accepts only canonical forms; the bytes must round-trip.
    const again = encodeStorageCredentialItem(fields);
    try {
      if (!equalBytes(again, item)) throw notCanonical();
    } finally {
      wipe(again);
    }
    return fields;
  } catch (error) {
    wipe(accessKeyId, secretAccessKey, salt);
    throw error;
  } finally {
    wipe(saltText);
  }
}

/**
 * The `credentialDigest` of a stored `s3:<id>` item (04 §2.5.1: own storage reads `ready` only when
 * it matches the signed `storage.set`). The item must be exactly its canonical form. The core
 * compares the result with the signed digest in constant time (equalBytes over the decoded bytes,
 * never `===` on the hex), as for every MAC check.
 */
export function credentialDigestOfItem(item: Uint8Array): string {
  const fields = parseStorageCredentialItem(item);
  try {
    return credentialDigest(fields);
  } finally {
    wipe(fields.salt, fields.accessKeyId, fields.secretAccessKey);
  }
}
