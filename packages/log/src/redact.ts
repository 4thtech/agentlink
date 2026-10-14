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
  for (const joined of wordRuns(parts)) {
    for (const name of SENSITIVE_JOINED) {
      if (joined === name || joined === `${name}s`) matched.add(name);
    }
  }
  if (matched.size === 0) return 'none';
  if (matched.size === 1 && matched.has('url')) {
    return parts.some((word) => CAPABILITY_URL_WORDS.has(word)) ? 'secret' : 'url';
  }
  if (matched.size === 1 && matched.has('code')) return 'code';
  return 'secret';
}

/**
 * Every run of consecutive words, joined, that could equal a sensitive name. Runs longer than the
 * longest name are cut off, so there are at most (words × MAX_NAME) of them: linear in the key.
 */
function* wordRuns(parts: readonly string[]): Generator<string> {
  for (let start = 0; start < parts.length; start += 1) {
    let joined = '';
    for (let end = start; end < parts.length; end += 1) {
      joined += parts[end];
      if (joined.length > MAX_NAME) break;
      yield joined;
    }
  }
}

/**
 * The work classifyKey does for `key`, as the number of word runs it compares (0 when the key is
 * classified without inspection). Lets tests bound the cost deterministically, without a clock.
 */
export function keyMatchingWork(key: string): number {
  if (key.length > MAX_KEY_LENGTH) return 0;
  let count = 0;
  const runs = wordRuns(words(key));
  while (runs.next().done !== true) count += 1;
  return count;
}

/** The longest run of words classifyKey ever compares, in characters. */
export const MAX_KEY_RUN = MAX_NAME;

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
// The separator also covers the spellings that parsers read as "//": a backslash (`https:\\host`)
// and JSON-escaped slashes (`https:\/\/host`, PHP and some Java encoders). A backslash ends the
// authority too: WHATWG parsers read it as '/' (`https://host\v2\key`).
const URL_PATTERN =
  /\b([a-z][a-z0-9+.-]{0,30})(:(?:\\{0,7}[\\/]){2})([^\s/\\?#"'<>`]*)[^\s"'<>`]*/gi;
// A string that is exactly one absolute URL (for URL-named fields).
const WHOLE_URL =
  /^\s*([a-z][a-z0-9+.-]{0,30})(:(?:\\{0,7}[\\/]){2})([^\s/\\?#"'<>`]*)[^\s"'<>`]*\s*$/i;
// Protocol-relative URLs (`//host/path`). The character before must not be a word character, ':'
// (that is an absolute URL), '/' or '\' (a longer run of slashes is a path). No lookbehind, for
// older browsers. The authority is read like an absolute URL's, so user info is dropped and an
// IPv6 host is kept. Scheme-less URLs (`host.tld/v2/key`) are an accepted residual risk.
const PROTOCOL_RELATIVE = /(^|[^\w:/\\])\/\/([^\s/\\?#"'<>`]+)[^\s"'<>`]*/g;
// Percent-encoded absolute URLs (a redirect target inside a query string), single or double encoded.
const ENCODED_URL =
  /\b(https?|wss?)(%(?:25)?3A%(?:25)?2F%(?:25)?2F)([A-Za-z0-9.-]{1,253}(?:%(?:25)?3A[0-9]{1,5})?)[^\s"'<>`&]*/gi;

/** The host part of an authority: user info (everything up to the last '@') is dropped. */
function host(authority: string): string {
  const at = authority.lastIndexOf('@');
  return at === -1 ? authority : authority.slice(at + 1);
}

function origin(scheme: string, authority: string): string {
  return `${scheme}://${host(authority)}`;
}

/**
 * The backslashes a stripped URL ended with. They may be the escape of the quote that follows
 * (`"see https://h/p\"x"`); dropping them would turn it into a real quote and end the value early.
 */
function trailingBackslashes(match: string): string {
  let end = match.length;
  while (end > 0 && match[end - 1] === '\\') end -= 1;
  return match.slice(end);
}

interface ValuePattern {
  /** The card rule (or extra rule) this pattern implements; used by the tests. */
  readonly rule: string;
  readonly apply: (text: string) => string;
}

/** A rule made of one global regex and its replacement. */
const regexRule = (
  rule: string,
  pattern: RegExp,
  replace: string | ((match: string, ...groups: string[]) => string),
): ValuePattern => ({
  rule,
  apply: (text) => text.replace(pattern, replace as (match: string, ...groups: string[]) => string),
});

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

/**
 * A name followed by `:` or `=` (quoted names too: `"name":`, and the escaped quotes of JSON that
 * is nested in a string, up to four levels: `\"name\":`, `\\\"name\\\":`). Only the name and
 * separator. Every repeat is bounded (a test checks the source), so the engine cannot backtrack
 * more than a constant amount per position.
 */
const NAME_SEPARATOR = /(\b[A-Za-z][A-Za-z0-9_.-]{0,63})(\\{0,16}["']?[ \t]{0,8}[:=][ \t]{0,8})/g;
/** The source of the regex that finds pairs, for the test that checks it has no unbounded repeat. */
export const PAIR_FINDER_SOURCE: string = NAME_SEPARATOR.source;
// JSON nested in a string n levels deep writes its quotes with 2^n - 1 backslashes: 1, 3, 7, 15.
const MAX_ESCAPES = 16;
const BARE_VALUE_END = /[\s"'&,;}]/;

/** Where a value ends, and the quoting that has to be kept around its replacement. */
interface ScannedValue {
  readonly end: number;
  /** The opening quote with its escaping backslashes (`"`, `\"`), or "". */
  readonly open: string;
  /** The closing quote with its escaping backslashes, or "" when the value has none. */
  readonly close: string;
}

/** Counts the characters the pair scanner reads, so tests can bound its cost without a clock. */
interface Meter {
  work: number;
}

/**
 * Whether a quote preceded by `run` backslashes is a real (unescaped) quote of JSON nested in a
 * string with `slashes` backslashes per quote. Each level doubles the backslashes and adds one for
 * the quote, so a real quote has `slashes + k * (2 * slashes + 2)` of them (k counts backslashes
 * that belong to the text), and an escaped quote of the inner string has any other number.
 * `slashes = 0` is plain JSON: an even run is a real quote, an odd run an escaped one.
 */
function isRealQuote(run: number, slashes: number): boolean {
  return run % (2 * slashes + 2) === slashes;
}

/**
 * A quoted value, JSON-aware. `slashes` backslashes before the opening quote mean JSON nested in a
 * string (`\"x\"`). Stops at the real closing quote or at a line break; a value that never closes is
 * redacted to the end of the line, however long (fails closed).
 */
function quotedValueEnd(text: string, start: number, slashes: number, meter: Meter): ScannedValue {
  const quote = text[start + slashes]!;
  const bodyStart = start + slashes + 1;
  const open = text.slice(start, bodyStart);
  let run = 0;
  let at = bodyStart;
  for (; at < text.length; at += 1) {
    meter.work += 1;
    const char = text[at]!;
    if (char === '\n' || char === '\r') break;
    if (char === '\\') {
      run += 1;
      continue;
    }
    if (char === quote && isRealQuote(run, slashes)) {
      return { end: at + 1, open, close: text.slice(at - slashes, at + 1) };
    }
    run = 0;
  }
  return { end: at, open, close: '' };
}

/**
 * An object or array: everything up to the matching bracket, skipping the strings inside it.
 * `level` is the backslash count of the quotes of the JSON it sits in (see isRealQuote). A value
 * that never closes is redacted to the end of the string (fails closed).
 */
function bracketedValueEnd(text: string, start: number, level: number, meter: Meter): ScannedValue {
  let depth = 0;
  let inString = '';
  let run = 0;
  let at = start;
  for (; at < text.length; at += 1) {
    meter.work += 1;
    const char = text[at]!;
    if (char === '\\') {
      run += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      if (isRealQuote(run, level)) {
        if (inString === '') inString = char;
        else if (char === inString) inString = '';
      }
    } else if (inString === '') {
      if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
        if (depth <= 0) return { end: at + 1, open: '', close: '' };
      }
    }
    run = 0;
  }
  return { end: at, open: '', close: '' };
}

/**
 * The value that starts at `start`: quoted (also JSON-escaped), an object or array, or a bare word
 * (up to the next separator, however long). `level` is the backslash count of the key's quotes.
 */
function scanValue(text: string, start: number, level: number, meter: Meter): ScannedValue {
  let slashes = 0;
  while (slashes < MAX_ESCAPES && text[start + slashes] === '\\') slashes += 1;
  const next = text[start + slashes];
  if (next === '"' || next === "'") return quotedValueEnd(text, start, slashes, meter);
  const first = text[start];
  if (first === '{' || first === '[') return bracketedValueEnd(text, start, level, meter);
  let at = start;
  while (at < text.length && !BARE_VALUE_END.test(text[at]!)) at += 1;
  meter.work += at - start;
  return { end: at, open: '', close: '' };
}

/**
 * `name=value`, `name: value` and `"name":"value"` pairs: the value is replaced when the name is
 * a sensitive key. One left-to-right scan; after a harmless pair the scan continues right after its
 * separator, so a pair inside its value ("failed: password=…") is still seen. After a replaced
 * value it continues at its end, so every character is scanned a constant number of times.
 */
function scanPairs(text: string, meter: Meter): string {
  const finder = new RegExp(NAME_SEPARATOR.source, 'g');
  let out = '';
  let copied = 0;
  const kinds = new Map<string, KeyClass>();
  for (;;) {
    const before = finder.lastIndex;
    const match = finder.exec(text);
    meter.work += match === null ? text.length - before : 1 + finder.lastIndex - before;
    if (match === null) break;
    const name = match[1]!;
    let kind = kinds.get(name);
    if (kind === undefined) {
      kind = classifyKey(name);
      kinds.set(name, kind);
    }
    if (kind === 'none' || kind === 'url') continue;
    const start = match.index + match[0].length;
    const level = /^\\*/.exec(match[2]!)![0].length;
    const { end, open, close } = scanValue(text, start, level, meter);
    if (end === start) continue;
    const bare = text.slice(start + open.length, end - close.length);
    if (kind === 'code' && (isAllowedCode(bare) || isAllowedCode(Number(bare)))) continue;
    out += `${text.slice(copied, start)}${open}${REDACTED}${close}`;
    copied = end;
    finder.lastIndex = end;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

function redactPairs(text: string): string {
  return scanPairs(text, { work: 0 });
}

/**
 * The work the pair scanner does on `text`: finder iterations plus the characters the finder and
 * the value scans read. Lets tests bound the cost per string deterministically, without a clock.
 */
export function pairScanWork(text: string): number {
  const meter: Meter = { work: 0 };
  scanPairs(text, meter);
  return meter.work;
}

export const VALUE_PATTERNS: readonly ValuePattern[] = [
  // An Authorization header line (any scheme, including AWS4-HMAC-SHA256 and Bearer): the whole value.
  regexRule(
    'authorization-header',
    /(\bauthorization\b["']?\s*[:=]\s*)[^\r\n]*/gi,
    `$1${REDACTED}`,
  ),
  // SigV4 authorization value wherever it appears, with or without the header name.
  regexRule('aws4-hmac-sha256', /\bAWS4-HMAC-SHA256\b[^\r\n]*/g, `AWS4-HMAC-SHA256 ${REDACTED}`),
  // SigV4 query parameters and headers: X-Amz-Signature, X-Amz-Credential, X-Amz-Security-Token,
  // also percent-encoded (`%3D`, `%253D`) inside another URL's query string.
  regexRule(
    'sigv4-params',
    /(X-Amz-(?:Signature|Credential|Security-Token)["']?\s*(?:[=:]|%(?:25)?3D)\s*)(?:(?!%(?:25)?26)[^&\s"',;]){1,4096}/gi,
    `$1${REDACTED}`,
  ),
  // Bearer tokens outside an Authorization header (for example in an error message).
  regexRule('bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`),
  // Basic credentials outside an Authorization line (header tuples, Object.entries(headers)).
  // The lookahead needs a digit, "+", "/" or "=", so "Basic authentication" is left alone.
  regexRule(
    'basic',
    /\bBasic\s+(?=[A-Za-z0-9+/]{0,512}[0-9+/=])[A-Za-z0-9+/]{8,512}={0,2}/g,
    `Basic ${REDACTED}`,
  ),
  // Local-UI session token in a relative URL or path (08 §1: `/?t=…`). Absolute URLs are already
  // reduced to their origin before this runs.
  regexRule('local-ui-token', /([?&#;]t=)[^&#\s"'<>`]+/g, `$1${REDACTED}`),
  // JWT: base64url header starting with eyJ ("{"), payload and signature.
  regexRule('jwt', /\beyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, REDACTED),
  // bech32 Nostr secret keys (nsec) and encrypted secret keys (NIP-49 ncryptsec), any case.
  regexRule('bech32-nsec', /(?:nsec|ncryptsec)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}/gi, REDACTED),
  // 64 or more hex digits, optionally 0x-prefixed: private scalars, seeds, file keys, salts and
  // SigV4 signatures. Also hits hashes and transaction IDs (accepted over-redaction).
  regexRule('hex64', /(?:0x)?[0-9a-fA-F]{64,}/g, REDACTED),
  // data: URIs carry file content inline.
  regexRule('data-uri', /\bdata:[^,\s"'<>`]{0,200},[^\s"'<>`]*/gi, `data:${REDACTED}`),
  {
    // `name=value`, `name: value`, `"name":"value"` with a sensitive name (password=…, a JSON dump
    // of { privateKey }). Quoted values are replaced up to the closing quote.
    rule: 'key-value',
    apply: redactPairs,
  },
  // Recovery code in hyphen-separated groups, any case ("ABCD-EFGH-…", "abcd-efgh-…").
  regexRule('recovery-code', /\b[A-Za-z0-9]{3,12}(?:-[A-Za-z0-9]{3,12}){1,7}\b/g, (run: string) =>
    redactGroups(run, '-'),
  ),
  // Recovery code in space-separated groups: upper case and digits only, so prose is not hit.
  regexRule('recovery-code', /\b[A-Z0-9]{3,12}(?: [A-Z0-9]{3,12}){1,7}\b/g, (run: string) =>
    redactGroups(run, ' '),
  ),
  // Recovery code without separators: 24 base32 characters (RFC 4648 alphabet), upper case, or
  // any case when it contains a digit, so a long camelCase identifier is not hit.
  regexRule('recovery-code', /\b[A-Za-z2-7]{24}\b/g, (run: string) =>
    run === run.toUpperCase() || /[2-7]/.test(run) ? REDACTED : run,
  ),
];

/**
 * Reduces every absolute URL in `text`, plain or percent-encoded, to its origin (scheme, host,
 * port). Paths carry RPC API keys, drop object IDs and signed-GET capabilities (04 §4); queries and
 * fragments carry signatures and file keys; user info carries passwords.
 */
export function stripUrls(text: string): string {
  return text
    .replace(URL_PATTERN, (match, scheme: string, separator: string, authority: string) => {
      // "C:\\Users": a drive letter and backslashes are a Windows path, not a URL.
      if (scheme.length === 1 && separator !== '://') return match;
      return origin(scheme, authority) + trailingBackslashes(match);
    })
    .replace(
      PROTOCOL_RELATIVE,
      (match, before: string, authority: string) =>
        `${before}//${host(authority)}${trailingBackslashes(match)}`,
    )
    .replace(ENCODED_URL, (_match, scheme: string, separator: string, hostname: string) => {
      return `${scheme}${separator}${hostname}`;
    });
}

/** Scrubs one string: oversized strings are replaced whole; then URLs, then every value pattern. */
export function redactString(text: string): string {
  if (text.length > MAX_STRING_LENGTH) return `${REDACTED} (string of ${text.length} characters)`;
  let out = stripUrls(text);
  for (const { apply } of VALUE_PATTERNS) out = apply(out);
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
  return match === null ? REDACTED : redactString(origin(match[1]!, match[3]!));
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
