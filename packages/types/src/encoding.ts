// Field encodings shared by every schema (04 §2.5.1 "Encoding (byte-exact)", 04 §3.1).
//
// Rules:
// - A value in any non-canonical form is rejected, never normalised: no schema here trims, lowercases,
//   coerces or fills defaults, so a successful parse returns the input unchanged.
// - Pure ES2022: no Buffer, TextEncoder, atob or URL, so the same code runs in Node, browsers and
//   Workers. Nothing here decodes or hashes; byte lengths are computed from the text alone.
// - Validators never throw on hostile input (cycles, deep nesting, throwing getters); they report.
import { z } from 'zod';
import { APPROVAL_ID_PREFIX, BYTE_LENGTHS, MAX_JSON_DEPTH, MAX_JSON_NODES } from './constants.js';

// --- Strings -------------------------------------------------------------------------------------

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when the string has no lone surrogate (I-JSON, RFC 7493 §2.1; required for JCS). */
export const isWellFormedString = (s: string): boolean => !LONE_SURROGATE.test(s);

/** Number of Unicode code points (a surrogate pair counts once). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** UTF-8 byte length of a well-formed string (a lone surrogate counts as 3, as WTF-8). */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** An I-JSON string of `min`..`max` code points. */
export const ijsonString = ({ min = 0, max }: { min?: number; max: number }) =>
  z
    .string()
    .refine(isWellFormedString, { message: 'string contains a lone surrogate (not I-JSON)' })
    .refine((s) => {
      const n = codePointLength(s);
      return n >= min && n <= max;
    }, `string must be ${min}..${max} characters`);

// --- base64url ------------------------------------------------------------------------------------

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_CHARS = /^[A-Za-z0-9_-]*$/;

/**
 * The decoded byte length of a canonical base64url string without padding (RFC 4648 §5), or null if
 * the string is not canonical: other characters (padding `=`, `+`, `/`, whitespace), an impossible
 * length, or non-zero unused bits in the last character (two spellings of the same bytes).
 */
export function base64urlByteLength(s: string): number | null {
  if (typeof s !== 'string' || !B64URL_CHARS.test(s)) return null;
  const rem = s.length % 4;
  if (rem === 1) return null;
  if (rem !== 0) {
    const last = B64URL_ALPHABET.indexOf(s.charAt(s.length - 1));
    const unusedBits = rem === 2 ? 0x0f : 0x03;
    if ((last & unusedBits) !== 0) return null;
  }
  return Math.floor(s.length / 4) * 3 + (rem === 0 ? 0 : rem - 1);
}

/** Canonical base64url without padding of exactly `bytes` bytes. */
export const base64url = (bytes: number) =>
  z
    .string()
    .refine(
      (s) => base64urlByteLength(s) === bytes,
      `must be ${bytes} bytes as base64url without padding`,
    );

/** Canonical base64url without padding of `min`..`max` bytes. */
export const base64urlBounded = (min: number, max: number) =>
  z.string().refine((s) => {
    const n = base64urlByteLength(s);
    return n !== null && n >= min && n <= max;
  }, `must be ${min}..${max} bytes as base64url without padding`);

// --- hex and addresses ---------------------------------------------------------------------------

/** Lowercase hex of exactly `bytes` bytes, no prefix (04 §2.5.1). */
export const hexBytes = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `must be ${bytes * 2} lowercase hex characters`);

/** `0x` + lowercase hex of exactly `bytes` bytes (EIP-712 message form). */
export const hex0xBytes = (bytes: number) =>
  z
    .string()
    .regex(
      new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`),
      `must be 0x followed by ${bytes * 2} lowercase hex characters`,
    );

/** Canonical EVM address: `0x` + 40 lowercase hex, never EIP-55 checksummed (04 §2.5.1). */
export const evmAddress = hex0xBytes(20);
/**
 * EVM-native 32-byte values (card keys and hashes, `recordId`, `salt`, `termsHash`): `0x` + 64
 * lowercase hex. Nostr-native values stay bare hex (canonical-encodings rule).
 */
export const bytes32Hex = hex0xBytes(32);
/** SHA-256 digest as 64 lowercase hex characters (04 §3.4 "hex"). */
export const sha256Hex = hexBytes(BYTE_LENGTHS.sha256);
/** Nostr x-only public key as 64 lowercase hex characters (04 §2.5.1, §3.1). */
export const nostrPubkeyHex = hexBytes(32);
/** BIP-340 signature as 128 lowercase hex characters (04 §2.5.1, §3.1). */
export const bip340SigHex = hexBytes(BYTE_LENGTHS.bip340Sig);
/** EIP-712 signature (r ‖ s ‖ v) as `0x` + 130 lowercase hex characters (04 §2.4). */
export const eip712SigHex = hex0xBytes(BYTE_LENGTHS.eip712Sig);

/** Decodes canonical lowercase hex (no prefix) to bytes; null for anything else. */
function decodeLowerHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * True when a Nostr-native key (bare lowercase hex, e.g. OwnerAction `owner`, envelope `from`) and
 * an AgentCard key (`0x` + lowercase hex, e.g. `ownerNostr`, `agentNostr`) are the same 32 bytes.
 * Both must already be canonical; any other form is a mismatch (fail closed, never normalised).
 * Use this for "`owner` equals `ownerNostr`" (04 §2.5.1, §3.4.1) instead of ad-hoc string handling.
 */
export function sameNostrKey(nostrHex: unknown, cardBytes32: unknown): boolean {
  if (!nostrPubkeyHex.safeParse(nostrHex).success) return false;
  if (!bytes32Hex.safeParse(cardBytes32).success) return false;
  const a = decodeLowerHex(nostrHex as string);
  const b = decodeLowerHex((cardBytes32 as string).slice(2));
  if (a === null || b === null || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

// --- integers ------------------------------------------------------------------------------------

const notNegativeZero = (n: number) => !Object.is(n, -0);

/** JSON integer in [0, 2^53 − 1] (04 §2.5.1). Negative zero is rejected. */
export const uint53 = z
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .refine(notNegativeZero, 'must not be negative zero');

/** JSON integer in [0, 2^32 − 1] (Solidity uint32). */
export const uint32 = z
  .int()
  .min(0)
  .max(2 ** 32 - 1)
  .refine(notNegativeZero, 'must not be negative zero');

// --- identifiers ---------------------------------------------------------------------------------

/** `apr_` + 16 random bytes as canonical base64url (04 §3.4.1). */
export const approvalIdSchema = z
  .string()
  .refine(
    (s) =>
      s.startsWith(APPROVAL_ID_PREFIX) &&
      base64urlByteLength(s.slice(APPROVAL_ID_PREFIX.length)) === BYTE_LENGTHS.approvalId,
    'must be apr_ followed by 16 bytes as base64url without padding',
  );

// --- bounded free-form JSON ----------------------------------------------------------------------

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/**
 * Checks that `value` is plain JSON data: null, booleans, finite numbers, well-formed strings, arrays
 * and plain objects, with at most MAX_JSON_DEPTH levels and MAX_JSON_NODES values and no own
 * `__proto__` key. Iterative (no recursion), so hostile nesting cannot overflow the stack; a cycle
 * exhausts the node budget and is rejected. Any exception (a throwing getter, a revoked proxy) means
 * "not JSON".
 */
export function isBoundedJson(value: unknown): value is JsonValue {
  try {
    const stack: [unknown, number][] = [[value, 0]];
    let nodes = 0;
    while (stack.length > 0) {
      const [v, depth] = stack.pop() as [unknown, number];
      if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
      if (v === null || typeof v === 'boolean') continue;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) return false;
        continue;
      }
      if (typeof v === 'string') {
        if (!isWellFormedString(v)) return false;
        continue;
      }
      if (typeof v !== 'object') return false; // undefined, bigint, symbol, function
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) return false; // sparse or extra keys
        for (const item of v) stack.push([item, depth + 1]);
        continue;
      }
      if (!isPlainObject(v)) return false; // Date, Map, class instances, boxed primitives
      if (Object.getOwnPropertySymbols(v).length > 0) return false;
      for (const key of Object.keys(v)) {
        if (key === '__proto__' || !isWellFormedString(key)) return false;
        stack.push([(v as Record<string, unknown>)[key], depth + 1]);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Any bounded JSON value (see isBoundedJson). Returned by reference, unchanged. */
export const jsonValueSchema = z.custom<JsonValue>(isBoundedJson, {
  message: 'must be plain, bounded JSON data',
});

/** A bounded JSON object (not an array, not a scalar). */
export const jsonObjectSchema = z.custom<JsonObject>(
  (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && isBoundedJson(v),
  { message: 'must be a plain, bounded JSON object' },
);

/** UTF-8 size of the compact JSON form of an already validated value; Infinity if it cannot serialise. */
export function jsonByteLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? Number.POSITIVE_INFINITY : utf8ByteLength(text);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
