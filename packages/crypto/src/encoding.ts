// Canonical encodings (04 §2.4.1, §3.1). Every binary value has exactly one spelling, so every
// decoder here is strict: a non-canonical form is rejected, never normalised. These are the
// per-encoding codecs; which encoding a JSON path uses is decided per schema path in
// @4thtech-io/types (M1-2a), which builds on these.
//
// Errors never contain the input (I-7): see errors.ts.
import { assertBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';

/** Optional exact byte length a decoder enforces after a successful parse. */
export interface ByteLengthOption {
  readonly length?: number;
}

/** 2^256 - 1, the largest value a decimal `uint256` string may hold. */
export const MAX_UINT256: bigint = (1n << 256n) - 1n;

function checkLength(bytes: Uint8Array, options: ByteLengthOption | undefined): Uint8Array {
  const length = options?.length;
  if (length === undefined) return bytes;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new CryptoInputError('invalid_argument', 'length must be a non-negative integer');
  }
  if (bytes.length !== length) {
    throw new CryptoInputError('invalid_length', 'decoded value has the wrong byte length');
  }
  return bytes;
}

function assertText(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new CryptoInputError('invalid_argument', `${what} must be a string`);
  }
}

// --- hex -----------------------------------------------------------------------------------------

const HEX_DIGITS = '0123456789abcdef';

/** Value of one lowercase hex digit, or -1. Upper case is not canonical and is refused. */
function nibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  return -1;
}

function hexBody(text: string, start: number): Uint8Array {
  if ((text.length - start) % 2 !== 0) {
    throw new CryptoInputError('invalid_hex', 'hex must have an even number of digits');
  }
  const out = new Uint8Array((text.length - start) / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = nibble(text.charCodeAt(start + 2 * i));
    const lo = nibble(text.charCodeAt(start + 2 * i + 1));
    if (hi < 0 || lo < 0) {
      throw new CryptoInputError('invalid_hex', 'hex must use only the digits 0-9 and a-f');
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Bytes as bare lowercase hex (Nostr keys, BIP-340 signatures, digests under a Nostr key). */
export function encodeHex(bytes: Uint8Array): string {
  assertBytes(bytes, 'encodeHex: bytes');
  let out = '';
  for (const byte of bytes) out += HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!;
  return out;
}

/**
 * Parses bare lowercase hex. Refuses upper or mixed case, a `0x` or `0X` prefix, an odd number of
 * digits, whitespace anywhere and, with `length`, any other byte length.
 */
export function decodeHex(text: string, options?: ByteLengthOption): Uint8Array {
  assertText(text, 'decodeHex: text');
  return checkLength(hexBody(text, 0), options);
}

/**
 * Bytes as `0x` + lowercase hex (values that are EIP-712 fields or ABI values). Empty bytes are
 * refused: no 04 §2.4.1 path carries an empty `0x` value (every row has a fixed length, and an
 * ERC-1271 signature is a non-empty, even number of hex characters).
 */
export function encodeHex0x(bytes: Uint8Array): string {
  assertBytes(bytes, 'encodeHex0x: bytes');
  if (bytes.length === 0) {
    throw new CryptoInputError('invalid_argument', 'encodeHex0x: a 0x value has at least one byte');
  }
  return '0x' + encodeHex(bytes);
}

/**
 * Parses `0x` + lowercase hex. Refuses a missing prefix, `0X`, upper or mixed case (EIP-55
 * checksums are for display only), an odd number of digits, whitespace, `0x` with no digits (see
 * encodeHex0x) and, with `length`, any other byte length.
 */
export function decodeHex0x(text: string, options?: ByteLengthOption): Uint8Array {
  assertText(text, 'decodeHex0x: text');
  if (!text.startsWith('0x')) {
    throw new CryptoInputError('invalid_hex', '0x hex must start with a lowercase 0x');
  }
  if (text.length === 2) {
    throw new CryptoInputError('invalid_hex', '0x hex must have at least one byte');
  }
  return checkLength(hexBody(text, 2), options);
}

// --- base64url without padding (RFC 4648 §5) ------------------------------------------------------

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Value of one base64url character, or -1. `+`, `/` and `=` are not in the alphabet. */
function sextet(code: number): number {
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 71; // a-z
  if (code >= 48 && code <= 57) return code + 4; // 0-9
  if (code === 45) return 62; // -
  if (code === 95) return 63; // _
  return -1;
}

/** Bytes as base64url without padding (04 §3.1). */
export function encodeBase64url(bytes: Uint8Array): string {
  assertBytes(bytes, 'encodeBase64url: bytes');
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += BASE64URL[n >> 18]! + BASE64URL[(n >> 12) & 63]! + BASE64URL[(n >> 6) & 63]!;
    out += BASE64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += BASE64URL[n >> 18]! + BASE64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += BASE64URL[n >> 18]! + BASE64URL[(n >> 12) & 63]! + BASE64URL[(n >> 6) & 63]!;
  }
  return out;
}

/**
 * Parses base64url without padding. Refuses `=` padding, `+` and `/`, any other character
 * (whitespace included), a length of 4n+1 characters, non-zero trailing bits (so each byte string
 * has exactly one spelling) and, with `length`, any other byte length.
 */
export function decodeBase64url(text: string, options?: ByteLengthOption): Uint8Array {
  assertText(text, 'decodeBase64url: text');
  if (text.length % 4 === 1) {
    throw new CryptoInputError('invalid_base64url', 'base64url has an impossible length');
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i += 1) {
    const value = sextet(text.charCodeAt(i));
    if (value < 0) {
      throw new CryptoInputError(
        'invalid_base64url',
        'base64url must use only A-Z a-z 0-9 - _, without padding',
      );
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o] = (buffer >> bits) & 0xff;
      o += 1;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) {
    throw new CryptoInputError('invalid_base64url', 'base64url has non-zero trailing bits');
  }
  return checkLength(out, options);
}

// --- decimal uint256 -----------------------------------------------------------------------------

// At most 78 digits: 2^256 - 1 has 78. The cap keeps BigInt() away from huge inputs.
const UINT256_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

/** A uint256 as a decimal string: `0` or digits without a leading zero. */
export function encodeUint256Decimal(value: bigint): string {
  if (typeof value !== 'bigint') {
    throw new CryptoInputError('invalid_argument', 'encodeUint256Decimal: value must be a bigint');
  }
  if (value < 0n || value > MAX_UINT256) {
    throw new CryptoInputError('invalid_uint256', 'value is outside the uint256 range');
  }
  return value.toString(10);
}

/**
 * Parses a decimal uint256 (04 §2.4.1). Accepts exactly `^(0|[1-9][0-9]*)$` up to 2^256 - 1:
 * signs, leading zeros, fractions, exponents, whitespace and non-ASCII digits are refused.
 */
export function decodeUint256Decimal(text: string): bigint {
  assertText(text, 'decodeUint256Decimal: text');
  if (!UINT256_DECIMAL.test(text)) {
    throw new CryptoInputError(
      'invalid_uint256',
      'uint256 must be decimal digits without sign, leading zero or whitespace',
    );
  }
  const value = BigInt(text);
  if (value > MAX_UINT256) {
    throw new CryptoInputError('invalid_uint256', 'value is outside the uint256 range');
  }
  return value;
}

// --- UTF-8 ---------------------------------------------------------------------------------------

interface TextEncoderLike {
  encode(input: string): Uint8Array;
}
interface TextDecoderLike {
  decode(input: Uint8Array): string;
}
interface TextCodecGlobals {
  TextEncoder: new () => TextEncoderLike;
  TextDecoder: new (
    label: string,
    options: { fatal: boolean; ignoreBOM: boolean },
  ) => TextDecoderLike;
}

let encoder: TextEncoderLike | undefined;
let decoder: TextDecoderLike | undefined;

/** True when `text` has no lone surrogate, i.e. it is a sequence of Unicode scalar values. */
export function isWellFormedText(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Text as UTF-8. Refuses text with a lone surrogate instead of silently writing U+FFFD, which is
 * what TextEncoder does: two different strings must never encode to the same bytes.
 */
export function encodeUtf8(text: string): Uint8Array {
  assertText(text, 'encodeUtf8: text');
  if (!isWellFormedText(text)) {
    throw new CryptoInputError('invalid_utf8', 'text contains a lone surrogate');
  }
  encoder ??= new (globalThis as unknown as TextCodecGlobals).TextEncoder();
  return encoder.encode(text);
}

/**
 * UTF-8 bytes as text. Refuses malformed UTF-8 (invalid bytes, overlong forms, encoded
 * surrogates, truncated sequences) and keeps a leading byte-order mark as U+FEFF rather than
 * dropping it, so decoding never loses bytes.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  assertBytes(bytes, 'decodeUtf8: bytes');
  decoder ??= new (globalThis as unknown as TextCodecGlobals).TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  try {
    return decoder.decode(bytes);
  } catch {
    throw new CryptoInputError('invalid_utf8', 'bytes are not well-formed UTF-8');
  }
}
