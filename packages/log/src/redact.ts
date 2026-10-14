// Redaction for log records (04 §1 I-7, §8 rule 4). Pure functions with no dependencies, so they
// run in Node, browsers and Workers. Two independent layers, both always on (there is no switch to
// turn them off):
//   1. by key name: the value of a sensitive field is replaced as a whole, whatever its type
//      (URL-named fields keep only the URL's origin; code-named fields keep only HTTP status and
//      system error codes);
//   2. by value pattern: every string that is logged (messages, field values, object keys, error
//      messages and stacks) is scrubbed of known secret shapes, `key=value` pairs with a sensitive
//      key, and every URL is reduced to its origin.
// Pattern matching is a safety net, not a licence: put variable data in fields, never in the message.

/** The replacement for anything redacted. */
export const REDACTED = '[REDACTED]';

/** Strings longer than this are replaced as a whole: real log text is short, and big strings are payloads. */
export const MAX_STRING_LENGTH = 16 * 1024;

/** Nesting depth after which values are replaced by a marker. */
export const MAX_DEPTH = 8;

/** Keys longer than this are treated as sensitive without inspecting them. */
export const MAX_KEY_LENGTH = 256;

/** Per-record budget of objects and arrays visited, and of entries kept per object, array, Map or Set. */
export const MAX_NODES = 10_000;
export const MAX_ENTRIES = 1_000;

/** Per-record budget of string characters scrubbed; strings beyond it become "[Truncated]". */
export const MAX_RECORD_CHARS = 256 * 1024;

const TRUNCATED = '[Truncated]';

// --- Layer 1: key names --------------------------------------------------------------------------

/**
 * Sensitive key names, in camelCase. The first fourteen are the M0-8 card's list; the rest cover
 * the same secrets under other common names (the owner passphrase, storage credentials, cookies,
 * signatures from SigV4 and 07 §7, bech32, mnemonic and extended-key forms). Adding a name here is
 * always safe; removing one is a reviewed security change.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  // Card list (M0-8). `url` keeps the URL's origin and `code` keeps status and error codes (below).
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
  'privKey',
  'priv',
  'auth',
  'jwt',
  'pwd',
  'session',
  'xpriv',
];

// Each sensitive name as lowercase letters only ("privateKey" -> "privatekey").
const SENSITIVE_JOINED: readonly string[] = SENSITIVE_KEYS.map((name) => name.toLowerCase());
// No run of words longer than this can equal a sensitive name or its plural.
const MAX_NAME = Math.max(...SENSITIVE_JOINED.map((name) => name.length)) + 1;

// Short or ambiguous names (public key, cache key) that are sensitive only as the whole key name,
// so publicKey and idempotencyKey stay readable. `sk` is the nostr-tools name for a secret key.
const SENSITIVE_WHOLE: ReadonlySet<string> = new Set([
  'key',
  'keys',
  'sig',
  'sigs',
  't',
  'sk',
  'pass',
  'pin',
]);

// Words that make a URL-named field a capability (a presigned or download link): fully redacted.
const CAPABILITY_URL_WORDS: ReadonlySet<string> = new Set(['signed', 'download', 'downloads']);

/** Splits a key into lowercase words: camelCase, PascalCase, snake_case, kebab-case, "X-Amz-Foo", "seed2". */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * How a field name is treated:
 * - `secret`: the value is replaced whole;
 * - `url`: only a URL's origin is kept (`relayUrl`); anything else under the key is replaced;
 * - `code`: only HTTP status codes and system error codes are kept (`statusCode`, Node `error.code`);
 * - `none`: the value is logged after pattern redaction.
 */
export type KeyClass = 'secret' | 'url' | 'code' | 'none';

/**
 * Classifies a field name. A key matches when any run of its words, joined, equals a sensitive name
 * or its plural: "privateKey", "PRIVATE_KEY", "agentPrivateKey", "privatekey", "accessTokens",
 * "X-Amz-Signature" and "seed2" all do; "publicKey" and "status" do not. Keys over 256 characters
 * are `secret` without inspection. The cost is linear in the key length.
 */
export function classifyKey(key: string): KeyClass {
  if (key.length > MAX_KEY_LENGTH) return 'secret';
  const parts = words(key);
  const named = parts.filter((word) => !/^[0-9]+$/.test(word));
  if (named.length === 0) return 'none';
  if (SENSITIVE_WHOLE.has(named.join(''))) return 'secret';
  const matched = new Set<string>();
  for (let start = 0; start < parts.length; start += 1) {
    let joined = '';
    for (let end = start; end < parts.length; end += 1) {
      joined += parts[end];
      if (joined.length > MAX_NAME) break;
      for (const name of SENSITIVE_JOINED) {
        if (joined === name || joined === `${name}s`) matched.add(name);
      }
    }
  }
  if (matched.size === 0) return 'none';
  if (matched.size === 1 && matched.has('url')) {
    return parts.some((word) => CAPABILITY_URL_WORDS.has(word)) ? 'secret' : 'url';
  }
  if (matched.size === 1 && matched.has('code')) return 'code';
  return 'secret';
}

/** True when a field with this name is never logged as is (see classifyKey). */
export function isSensitiveKey(key: string): boolean {
  return classifyKey(key) !== 'none';
}

// HTTP status codes and Node/system error codes. These shapes cannot be a recovery code (24 base32
// characters), a pairing code (6 digits) or an OAuth code.
const ERROR_CODE = /^(?:E[A-Z]{2,12}|ERR_[A-Z0-9_]{3,64})$/;

function isAllowedCode(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 100 && value <= 599;
  return typeof value === 'string' && ERROR_CODE.test(value);
}

// --- Layer 2: value patterns ---------------------------------------------------------------------
// Every quantifier that can repeat over a long input is bounded or anchored on a literal, so the
// cost stays linear in the (already capped) string length.

// Absolute URLs: scheme://authority, then the rest (path, query, fragment), which is never logged.
const URL_PATTERN = /\b([a-z][a-z0-9+.-]{0,30}):\/\/([^\s/?#"'<>`]*)[^\s"'<>`]*/gi;
// A string that is exactly one absolute URL (for URL-named fields).
const WHOLE_URL = /^\s*([a-z][a-z0-9+.-]{0,30}):\/\/([^\s/?#"'<>`]*)[^\s"'<>`]*\s*$/i;
// Percent-encoded absolute URLs (a redirect target inside a query string), single or double encoded.
const ENCODED_URL =
  /\b(https?|wss?)(%(?:25)?3A%(?:25)?2F%(?:25)?2F)([A-Za-z0-9.-]{1,253}(?:%(?:25)?3A[0-9]{1,5})?)[^\s"'<>`&]*/gi;

function origin(scheme: string, authority: string): string {
  const at = authority.lastIndexOf('@');
  return `${scheme}://${at === -1 ? authority : authority.slice(at + 1)}`;
}

interface ValuePattern {
  /** The card rule (or extra rule) this pattern implements; used by the tests. */
  readonly rule: string;
  readonly pattern: RegExp;
  readonly replace: string | ((match: string, ...groups: string[]) => string);
}

// TODO(M1-1): 04 §2.3 fixes the length (24 base32 characters) but not the grouping or alphabet.
// When M1-1 pins the format, replace these heuristics with one exact rule and add its canary.
const RECOVERY_LENGTH = 24;
const RECOVERY_GROUP_SIZES: ReadonlySet<number> = new Set([3, 4, 6, 8, 12]);

/**
 * Recovery-code shape (04 §2.3: 120 bits as 24 base32 characters in groups). Within a run of
 * separated groups this replaces every stretch of equal-sized groups (3, 4, 6, 8 or 12 characters)
 * that adds up to exactly 24 characters. UUIDs (8-4-4-4-12) and dates are left alone.
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

/** `name<sep>value` inside a string: the value is replaced when the name is a sensitive key. */
const KEY_VALUE =
  /(\b[A-Za-z][A-Za-z0-9_.-]{0,63})(["']?\s*[:=]\s*)("[^"\r\n]{0,2048}"?|'[^'\r\n]{0,2048}'?|[^\s"'&,;}]{1,512})/g;

function redactPair(match: string, name: string, separator: string, value: string): string {
  const kind = classifyKey(name);
  if (kind === 'none' || kind === 'url') {
    // The value may hold the next pair ("failed: password=…"): look inside it too. The value is
    // shorter than the match, so the recursion ends.
    return `${name}${separator}${value.replace(new RegExp(KEY_VALUE.source, 'g'), redactPair)}`;
  }
  const bare = value.replace(/^["']|["']$/g, '');
  if (kind === 'code' && (isAllowedCode(bare) || isAllowedCode(Number(bare)))) return match;
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : '';
  const closing = quote !== '' && value.length > 1 && value.endsWith(quote) ? quote : '';
  return `${name}${separator}${quote}${REDACTED}${closing}`;
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
    // SigV4 query parameters and headers: X-Amz-Signature, X-Amz-Credential, X-Amz-Security-Token,
    // also percent-encoded (`%3D`, `%253D`) inside another URL's query string.
    rule: 'sigv4-params',
    pattern:
      /(X-Amz-(?:Signature|Credential|Security-Token)["']?\s*(?:[=:]|%(?:25)?3D)\s*)(?:(?!%(?:25)?26)[^&\s"',;]){1,4096}/gi,
    replace: `$1${REDACTED}`,
  },
  {
    // Bearer tokens outside an Authorization header (for example in an error message).
    rule: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replace: `Bearer ${REDACTED}`,
  },
  {
    // Basic credentials outside an Authorization line (header tuples, Object.entries(headers)).
    // The lookahead needs a digit, "+", "/" or "=", so "Basic authentication" is left alone.
    rule: 'basic',
    pattern: /\bBasic\s+(?=[A-Za-z0-9+/]{0,512}[0-9+/=])[A-Za-z0-9+/]{8,512}={0,2}/g,
    replace: `Basic ${REDACTED}`,
  },
  {
    // Local-UI session token in a relative URL or path (08 §1: `/?t=…`). Absolute URLs are already
    // reduced to their origin before this runs.
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
    // SigV4 signatures. Also hits hashes and transaction IDs (accepted over-redaction).
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
    // `name=value`, `name: value`, `"name":"value"` with a sensitive name (password=…, a JSON dump
    // of { privateKey }). Quoted values are replaced up to the closing quote.
    rule: 'key-value',
    pattern: KEY_VALUE,
    replace: redactPair,
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

/**
 * Reduces every absolute URL in `text`, plain or percent-encoded, to its origin (scheme, host,
 * port). Paths carry RPC API keys, drop object IDs and signed-GET capabilities (04 §4); queries and
 * fragments carry signatures and file keys; user info carries passwords.
 */
export function stripUrls(text: string): string {
  return text
    .replace(URL_PATTERN, (_match, scheme: string, authority: string) => origin(scheme, authority))
    .replace(ENCODED_URL, (_match, scheme: string, separator: string, host: string) => {
      return `${scheme}${separator}${host}`;
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

interface Walk {
  /** Ancestors of the current value, for cycle detection. */
  readonly seen: WeakSet<object>;
  /** Objects and arrays visited so far in this record. */
  nodes: number;
  /** String characters scrubbed so far in this record. */
  chars: number;
}

const tag = (value: object): string => Object.prototype.toString.call(value);

function isBinary(value: object): boolean {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    tag(value) === '[object SharedArrayBuffer]'
  );
}

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return '[Unreadable]';
  }
}

/** A URL-named field: the origin of a URL, otherwise redacted. */
function urlOrigin(value: unknown): JsonValue {
  let text: string;
  try {
    text =
      typeof value === 'string'
        ? value
        : typeof value === 'object' && value !== null && tag(value) === '[object URL]'
          ? String(value)
          : '';
  } catch {
    return REDACTED;
  }
  const match = WHOLE_URL.exec(text);
  return match === null ? REDACTED : redactString(origin(match[1]!, match[2]!));
}

/** One named field: the key rule first, then the value (never throws). */
function redactField(key: string, read: () => unknown, depth: number, walk: Walk): JsonValue {
  try {
    switch (classifyKey(key)) {
      case 'secret':
        return REDACTED;
      case 'url':
        return urlOrigin(read());
      case 'code': {
        const value = read();
        return isAllowedCode(value) ? (value as number | string) : REDACTED;
      }
      default:
        return redactInner(read(), depth + 1, walk);
    }
  } catch {
    return '[Unserializable]';
  }
}

/** Redacts entries one by one, keeping at most MAX_ENTRIES. */
function redactEntries(
  entries: Iterable<[string, () => unknown]>,
  depth: number,
  walk: Walk,
  into: { [key: string]: JsonValue } = {},
): { [key: string]: JsonValue } {
  let count = 0;
  for (const [key, read] of entries) {
    if (count >= MAX_ENTRIES) {
      into['…'] = TRUNCATED;
      break;
    }
    count += 1;
    if (Object.hasOwn(into, key)) continue;
    // defineProperty, not assignment: a "__proto__" key must stay a plain field.
    const name =
      key.length > MAX_KEY_LENGTH
        ? `${REDACTED} (key of ${key.length} characters)`
        : redactString(key);
    Object.defineProperty(into, name, {
      value: redactField(key, read, depth, walk),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return into;
}

function redactItems(items: Iterable<unknown>, depth: number, walk: Walk): JsonValue[] {
  const out: JsonValue[] = [];
  for (const item of items) {
    if (out.length >= MAX_ENTRIES) {
      out.push(TRUNCATED);
      break;
    }
    out.push(safely(() => redactInner(item, depth + 1, walk)));
  }
  return out;
}

function safely(run: () => JsonValue): JsonValue {
  try {
    return run();
  } catch {
    return '[Unserializable]';
  }
}

function* ownEntries(object: object): Generator<[string, () => unknown]> {
  for (const key of Object.keys(object)) yield [key, () => readProperty(object, key)];
}

function redactError(error: Error, depth: number, walk: Walk): JsonValue {
  const out: { [key: string]: JsonValue } = {
    name: safely(() => redactString(String(error.name))),
    message: safely(() => redactString(String(error.message))),
  };
  const stack = readProperty(error, 'stack');
  if (typeof stack === 'string') out.stack = redactString(stack);
  const cause = readProperty(error, 'cause');
  if (cause !== undefined) out.cause = safely(() => redactInner(cause, depth + 1, walk));
  if (error instanceof AggregateError) {
    out.errors = safely(() => redactInner(error.errors, depth + 1, walk));
  }
  // Own enumerable properties (code, status, response, config...) get the key rule like any object.
  return redactEntries(ownEntries(error), depth, walk, out);
}

function redactInner(value: unknown, depth: number, walk: Walk): JsonValue {
  switch (typeof value) {
    case 'string':
      walk.chars += value.length;
      return walk.chars > MAX_RECORD_CHARS ? TRUNCATED : redactString(value);
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
  if (walk.seen.has(object)) return '[Circular]';
  if (depth >= MAX_DEPTH || walk.nodes >= MAX_NODES) return TRUNCATED;
  walk.nodes += 1;

  walk.seen.add(object);
  try {
    // Raw bytes are never logged: they are keys, plaintext or ciphertext.
    if (isBinary(object)) return `${REDACTED} (bytes)`;
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? 'Invalid Date' : object.toISOString();
    }
    if (tag(object) === '[object URL]' || object instanceof RegExp) {
      return redactString(String(object));
    }
    if (object instanceof Error) return redactError(object, depth, walk);
    if (Array.isArray(object)) return redactItems(object, depth, walk);
    if (object instanceof Set) return redactItems(object, depth, walk);
    if (object instanceof Map) {
      const entries = function* (): Generator<[string, () => unknown]> {
        for (const [key, item] of object) {
          const name = typeof key === 'string' ? key : String(redactInner(key, depth + 1, walk));
          yield [name, () => item];
        }
      };
      return redactEntries(entries(), depth, walk);
    }
    return redactEntries(ownEntries(object), depth, walk);
  } catch {
    // A hostile value (a Proxy whose traps throw) loses only itself, never its siblings.
    return '[Unserializable]';
  } finally {
    // Only ancestors count as cycles; the same object twice side by side is logged twice.
    walk.seen.delete(object);
  }
}

/**
 * Returns a JSON-compatible copy of `value` with every sensitive key replaced and every string
 * scrubbed. Handles nested objects, arrays, Maps, Sets, Errors (message, stack, cause), cycles,
 * byte arrays (never logged), getters and Proxy traps that throw, and a size budget. Never mutates
 * its input. `toJSON` is not called: it could hand back secrets under keys the key rule never sees.
 */
export function redact(value: unknown): JsonValue {
  return redactInner(value, 0, { seen: new WeakSet(), nodes: 0, chars: 0 });
}
