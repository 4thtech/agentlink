// Redaction for log records (04 §1 I-7, §8.4). Pure functions with no dependencies, so they run in Node,
// browsers and Workers. Two independent layers, both always on (there is no switch to turn them off):
//   1. by key name: the value of a sensitive field is replaced as a whole, whatever its type;
//   2. by value pattern: every string that is logged (messages, field values, object keys, error
//      messages and stacks) is scrubbed of known secret shapes, and URLs lose their query string,
//      fragment and user info.
// Pattern matching is a safety net, not a licence: put variable data in fields, never in the message.

/** The replacement for anything redacted. */
export const REDACTED = '[REDACTED]';

/** Strings longer than this are replaced as a whole: real log text is short, and big strings are payloads. */
export const MAX_STRING_LENGTH = 16 * 1024;

/** Nesting depth after which values are replaced by a marker. */
export const MAX_DEPTH = 8;

// --- Layer 1: key names --------------------------------------------------------------------------

/**
 * Sensitive key names, in camelCase. The first fourteen are the M0-8 card's list; the rest cover
 * the same secrets under other common names (the owner passphrase, storage credentials, cookies,
 * signatures from SigV4 and 07 §7, bech32 and mnemonic forms). Adding a name here is always safe;
 * removing one is a reviewed security change.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  // Card list (M0-8)
  'seed',
  'secret',
  'privateKey',
  'fileKey',
  'cek',
  'salt',
  'url',
  'presigned',
  'payload',
  'plaintext',
  'body',
  'authorization',
  'token',
  'code',
  // Same secrets, other names
  'password',
  'passphrase',
  'mnemonic',
  'nsec',
  'credential',
  'cookie',
  'apiKey',
  'accessKey',
  'signature',
];

// Each sensitive name as lowercase letters only ("privateKey" -> "privatekey").
const SENSITIVE_JOINED: readonly string[] = SENSITIVE_KEYS.map((name) => name.toLowerCase());

// Bare "key" is ambiguous (public key, cache key) but in this code base usually a secret. It is
// sensitive only when it is the whole key name, so publicKey and idempotencyKey stay readable.
const SENSITIVE_WHOLE: ReadonlySet<string> = new Set(['key', 'keys', 'sig', 'sigs', 't']);

/** Splits a key into lowercase words: camelCase, PascalCase, snake_case, kebab-case, "X-Amz-Foo". */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * True when a field with this name must never be logged. A key is sensitive when any run of its
 * words, joined, equals a sensitive name or its plural: "privateKey", "PRIVATE_KEY", "agentPrivateKey",
 * "privatekey", "accessTokens" and "X-Amz-Signature" all are; "publicKey" and "status" are not.
 * Note that "statusCode" and "errorCode" are sensitive ("code" covers recovery and OAuth codes).
 */
export function isSensitiveKey(key: string): boolean {
  const parts = words(key);
  if (parts.length === 0) return false;
  if (SENSITIVE_WHOLE.has(parts.join(''))) return true;
  for (let start = 0; start < parts.length; start += 1) {
    let joined = '';
    for (let end = start; end < parts.length; end += 1) {
      joined += parts[end];
      for (const name of SENSITIVE_JOINED) {
        if (joined === name || joined === `${name}s`) return true;
      }
    }
  }
  return false;
}

// --- Layer 2: value patterns ---------------------------------------------------------------------
// Every quantifier that can repeat over a long input is bounded or anchored on a literal, so the
// cost stays linear in the (already capped) string length.

// Absolute URLs: scheme://authority path ? query # fragment. The scheme is bounded to stay linear.
const URL_PATTERN =
  /\b([a-z][a-z0-9+.-]{0,30}):\/\/([^\s/?#"'<>`]*)([^\s?#"'<>`]*)(\?[^\s#"'<>`]*)?(#[^\s"'<>`]*)?/gi;

interface ValuePattern {
  /** The card rule (or extra rule) this pattern implements; used by the tests. */
  readonly rule: string;
  readonly pattern: RegExp;
  readonly replace: string | ((match: string, ...groups: string[]) => string);
}

// The base32 alphabets a recovery code may use: RFC 4648 (A-Z, 2-7) and Crockford (0-9, A-Z).
const RECOVERY_LENGTH = 24;
const RECOVERY_GROUP_SIZES: ReadonlySet<number> = new Set([3, 4, 6, 8, 12]);

/**
 * Recovery-code shape (04 §2.3: 120 bits as 24 base32 characters in groups). The grouping is not
 * specified yet, so within a run of separated groups this replaces every stretch of equal-sized
 * groups (3, 4, 6, 8 or 12 characters) that adds up to exactly 24 characters. UUIDs (8-4-4-4-12)
 * and dates are left alone. When M1-1 fixes the format, its canary pins the exact shape.
 */
function redactGroups(run: string, separator: '-' | ' '): string {
  const groups = run.split(separator);
  const out: string[] = [];
  let index = 0;
  while (index < groups.length) {
    const size = groups[index]!.length;
    let matched = 0;
    if (RECOVERY_GROUP_SIZES.has(size)) {
      const needed = RECOVERY_LENGTH / size;
      let count = 0;
      while (
        count < needed &&
        index + count < groups.length &&
        groups[index + count]!.length === size
      ) {
        count += 1;
      }
      if (count === needed) matched = needed;
    }
    if (matched > 0) {
      out.push(REDACTED);
      index += matched;
    } else {
      out.push(groups[index]!);
      index += 1;
    }
  }
  return out.join(separator);
}

export const VALUE_PATTERNS: readonly ValuePattern[] = [
  {
    // An Authorization header line (any scheme, including AWS4-HMAC-SHA256 and Bearer): the whole value.
    rule: 'authorization-header',
    pattern: /(\bauthorization\b["']?\s*[:=]\s*)[^\r\n]*/gi,
    replace: `$1${REDACTED}`,
  },
  {
    // SigV4 authorization value wherever it appears, with or without the header name.
    rule: 'aws4-hmac-sha256',
    pattern: /\bAWS4-HMAC-SHA256\b[^\r\n]*/g,
    replace: `AWS4-HMAC-SHA256 ${REDACTED}`,
  },
  {
    // SigV4 query parameters and headers: X-Amz-Signature, X-Amz-Credential, X-Amz-Security-Token.
    rule: 'sigv4-params',
    pattern: /\b(X-Amz-(?:Signature|Credential|Security-Token)["']?\s*[=:]\s*)[^&\s"',;]+/gi,
    replace: `$1${REDACTED}`,
  },
  {
    // Bearer tokens outside an Authorization header (for example in an error message).
    rule: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replace: `Bearer ${REDACTED}`,
  },
  {
    // Local-UI session token in a relative URL or path (08 §1: `/?t=…`). Absolute URLs lose their
    // whole query string before this runs.
    rule: 'local-ui-token',
    pattern: /([?&#;]t=)[^&#\s"'<>`]+/g,
    replace: `$1${REDACTED}`,
  },
  {
    // JWT: base64url header starting with eyJ ("{"), payload and signature.
    rule: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g,
    replace: REDACTED,
  },
  {
    // bech32 Nostr secret keys (nsec) and encrypted secret keys (NIP-49 ncryptsec), any case.
    rule: 'bech32-nsec',
    pattern: /(?:nsec|ncryptsec)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}/gi,
    replace: REDACTED,
  },
  {
    // 64 or more hex digits, optionally 0x-prefixed: private scalars, seeds, file keys, salts and
    // SigV4 signatures. Also hits hashes and transaction IDs; those are logged by prefix if needed.
    rule: 'hex64',
    pattern: /(?:0x)?[0-9a-fA-F]{64,}/g,
    replace: REDACTED,
  },
  {
    // data: URIs carry file content inline.
    rule: 'data-uri',
    pattern: /\bdata:[^,\s"'<>`]{0,200},[^\s"'<>`]*/gi,
    replace: `data:${REDACTED}`,
  },
  {
    // Recovery code in hyphen-separated groups, any case ("ABCD-EFGH-…", "abcd-efgh-…").
    rule: 'recovery-code',
    pattern: /\b[A-Za-z0-9]{3,12}(?:-[A-Za-z0-9]{3,12}){1,7}\b/g,
    replace: (run: string) => redactGroups(run, '-'),
  },
  {
    // Recovery code in space-separated groups: upper case and digits only, so prose is not hit.
    rule: 'recovery-code',
    pattern: /\b[A-Z0-9]{3,12}(?: [A-Z0-9]{3,12}){1,7}\b/g,
    replace: (run: string) => redactGroups(run, ' '),
  },
  {
    // Recovery code without separators: 24 base32 characters (RFC 4648 alphabet), upper case, or
    // any case when it contains a digit, so a long camelCase identifier is not hit.
    rule: 'recovery-code',
    pattern: /\b[A-Za-z2-7]{24}\b/g,
    replace: (run: string) => (run === run.toUpperCase() || /[2-7]/.test(run) ? REDACTED : run),
  },
];

/** Removes user info, query string and fragment from every absolute URL in `text`. */
export function stripUrls(text: string): string {
  return text.replace(URL_PATTERN, (_match, scheme: string, authority: string, path: string) => {
    const at = authority.lastIndexOf('@');
    const host = at === -1 ? authority : authority.slice(at + 1);
    return `${scheme}://${host}${path}`;
  });
}

/** Scrubs one string: oversized strings are replaced whole; then URLs, then every value pattern. */
export function redactString(text: string): string {
  if (text.length > MAX_STRING_LENGTH) return `${REDACTED} (string of ${text.length} characters)`;
  let out = stripUrls(text);
  for (const { pattern, replace } of VALUE_PATTERNS) {
    out = out.replace(pattern, replace as (match: string, ...groups: string[]) => string);
  }
  return out;
}

// --- Structured values ---------------------------------------------------------------------------

/** A JSON-compatible value: what every redacted value becomes. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const tag = (value: object): string => Object.prototype.toString.call(value);

function isBinary(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    tag(value) === '[object SharedArrayBuffer]'
  );
}

function redactError(error: Error, depth: number, seen: WeakSet<object>): JsonValue {
  const out: { [key: string]: JsonValue } = { name: redactString(String(error.name)) };
  out.message = redactString(String(error.message));
  if (typeof error.stack === 'string') out.stack = redactString(error.stack);
  if ('cause' in error && error.cause !== undefined) {
    out.cause = redactInner(error.cause, depth + 1, seen);
  }
  if (error instanceof AggregateError) {
    out.errors = redactInner(error.errors, depth + 1, seen);
  }
  // Own enumerable properties (code, status, response, config...) get the key rule like any object.
  for (const key of Object.keys(error)) {
    if (key in out) continue;
    out[redactString(key)] = isSensitiveKey(key)
      ? REDACTED
      : redactInner(readProperty(error, key), depth + 1, seen);
  }
  return out;
}

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return '[Unreadable]';
  }
}

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return redactString(value.toString());
    case 'undefined':
      return null;
    case 'symbol':
      return redactString(value.toString());
    case 'function':
      return '[Function]';
    default:
      break;
  }
  if (value === null) return null;
  const object = value as object;
  if (seen.has(object)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  // Raw bytes are never logged: they are keys, plaintext or ciphertext.
  if (isBinary(object)) return `${REDACTED} (bytes)`;
  if (object instanceof Date)
    return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
  if (tag(object) === '[object URL]') return redactString(String(object));
  if (object instanceof RegExp) return redactString(String(object));

  seen.add(object);
  try {
    if (object instanceof Error) return redactError(object, depth, seen);
    if (Array.isArray(object)) return object.map((item) => redactInner(item, depth + 1, seen));
    if (object instanceof Set) return [...object].map((item) => redactInner(item, depth + 1, seen));
    if (object instanceof Map) {
      const out: { [key: string]: JsonValue } = {};
      for (const [key, item] of object) {
        const name = typeof key === 'string' ? key : String(redactInner(key, depth + 1, seen));
        out[redactString(name)] = isSensitiveKey(name)
          ? REDACTED
          : redactInner(item, depth + 1, seen);
      }
      return out;
    }
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(object)) {
      out[redactString(key)] = isSensitiveKey(key)
        ? REDACTED
        : redactInner(readProperty(object, key), depth + 1, seen);
    }
    return out;
  } catch {
    return '[Unserializable]';
  } finally {
    // Only ancestors count as cycles; the same object twice side by side is logged twice.
    seen.delete(object);
  }
}

/**
 * Returns a JSON-compatible copy of `value` with every sensitive key replaced and every string
 * scrubbed. Handles nested objects, arrays, Maps, Sets, Errors (message, stack, cause), cycles,
 * byte arrays (never logged) and getters that throw. Never mutates its input. `toJSON` is not
 * called: it could hand back secrets under keys the key rule never sees.
 */
export function redact(value: unknown): JsonValue {
  return redactInner(value, 0, new WeakSet());
}
