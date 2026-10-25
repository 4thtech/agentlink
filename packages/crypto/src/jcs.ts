// RFC 8785 JSON Canonicalization Scheme (JCS), and the strict parser in front of it.
//
// envelopeHash = sha256(JCS(envelope without "sig")) and the owner-action digest depend on these
// bytes (04 §3.1, §2.5.1), so the code refuses anything RFC 8785 or I-JSON (RFC 7493) says to
// refuse instead of guessing: duplicate property names, lone surrogates, NaN and Infinity, values
// JSON cannot represent. In-repo code rather than a dependency (gap G-12): it is serialisation, not
// a crypto primitive, no JCS library is on the 04 §8.1 allowlist, and none of the common ones rejects
// duplicate keys or lone surrogates. It is checked against the RFC's own vectors in every runtime
// (test-vectors/jcs).
//
// Numbers use ECMAScript Number::toString, which is exactly the serialisation RFC 8785 §3.2.2.3
// specifies; every supported runtime implements it to the ECMAScript specification, and the
// Appendix B vectors check that in each one.
import { CryptoInputError } from './errors.js';
import { encodeUtf8, isWellFormedText } from './encoding.js';

/** A JSON value as parseJson returns it and canonicalize accepts it. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** A JSON object. parseJson returns objects with a null prototype, so any key is an own key. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * The deepest nesting of arrays and objects parseJson and canonicalize accept. Protocol objects are
 * a few levels deep; the limit keeps recursion far from the stack limit of every runtime.
 */
export const MAX_JSON_DEPTH = 128;

/** Options for parseJson. */
export interface ParseJsonOptions {
  /**
   * Refuse every number token that is not a protocol integer: `0|[1-9][0-9]*` on the token text and
   * at most 2^53 - 1 (04 §2.4.1). Default false (RFC 8259 numbers, as JCS needs).
   */
  readonly integersOnly?: boolean;
  /**
   * Refuse every object member name written with an escape sequence, at any depth (04 §2.5.1
   * "Received text", D-128): a `\u` escape such as the one for `a` in `agent`, a short escape such
   * as `\/`, any backslash. Escapes in string values are unaffected. Default false: RFC 8785 and
   * generic JSON allow escaped names.
   */
  readonly plainMemberNames?: boolean;
}

const invalidJson = (message: string): CryptoInputError =>
  new CryptoInputError('invalid_json', message);
const unsupported = (message: string): CryptoInputError =>
  new CryptoInputError('jcs_unsupported_value', message);

// --- parse ---------------------------------------------------------------------------------------

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const INTEGER_TOKEN = /^(?:0|[1-9][0-9]*)$/;

/** Value of one hex digit of a \u escape (either case, as RFC 8259 allows), or -1. */
function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

class Parser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly integersOnly: boolean,
    private readonly plainMemberNames: boolean,
  ) {}

  parseDocument(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) throw invalidJson('JSON text has trailing content');
    return value;
  }

  /** RFC 8259 whitespace only: space, tab, line feed, carriage return. Not a BOM or NBSP. */
  private skipWhitespace(): void {
    for (;;) {
      const code = this.text.charCodeAt(this.index);
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
      this.index += 1;
    }
  }

  private parseValue(depth: number): JsonValue {
    const code = this.text.charCodeAt(this.index);
    if (code === 0x7b) return this.parseObject(depth + 1); // {
    if (code === 0x5b) return this.parseArray(depth + 1); // [
    if (code === 0x22) return this.parseString(); // "
    if (code === 0x2d || (code >= 0x30 && code <= 0x39)) return this.parseNumber();
    if (this.text.startsWith('true', this.index)) return this.literal(4, true);
    if (this.text.startsWith('false', this.index)) return this.literal(5, false);
    if (this.text.startsWith('null', this.index)) return this.literal(4, null);
    throw invalidJson('JSON text has an unexpected character or ends early');
  }

  private literal<T>(length: number, value: T): T {
    this.index += length;
    return value;
  }

  private expect(code: number, message: string): void {
    if (this.text.charCodeAt(this.index) !== code) throw invalidJson(message);
    this.index += 1;
  }

  private parseObject(depth: number): JsonObject {
    if (depth > MAX_JSON_DEPTH) throw invalidJson('JSON text is nested too deeply');
    this.index += 1; // {
    // A null prototype makes every key, `__proto__` included, an ordinary own property.
    const object = Object.create(null) as Record<string, JsonValue>;
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x7d) {
      this.index += 1;
      return object;
    }
    for (;;) {
      if (this.text.charCodeAt(this.index) !== 0x22) {
        throw invalidJson('JSON object keys must be strings');
      }
      const start = this.index;
      // Compared after unescaping, so "a" and "a" are the same name (RFC 7493 §2.3).
      const key = this.parseString();
      // On the raw token, not the value (04 §2.5.1, D-128): a name spelled with any escape.
      if (this.plainMemberNames && this.text.slice(start, this.index).includes('\\')) {
        throw invalidJson('JSON object member name is written with an escape sequence');
      }
      if (seen.has(key)) throw invalidJson('JSON object has a duplicate property name');
      seen.add(key);
      this.skipWhitespace();
      this.expect(0x3a, 'JSON object is missing a colon');
      this.skipWhitespace();
      object[key] = this.parseValue(depth);
      this.skipWhitespace();
      const code = this.text.charCodeAt(this.index);
      this.index += 1;
      if (code === 0x7d) return object; // }
      if (code !== 0x2c) throw invalidJson('JSON object is missing a comma or closing brace');
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): JsonValue[] {
    if (depth > MAX_JSON_DEPTH) throw invalidJson('JSON text is nested too deeply');
    this.index += 1; // [
    const array: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text.charCodeAt(this.index) === 0x5d) {
      this.index += 1;
      return array;
    }
    for (;;) {
      array.push(this.parseValue(depth));
      this.skipWhitespace();
      const code = this.text.charCodeAt(this.index);
      this.index += 1;
      if (code === 0x5d) return array; // ]
      if (code !== 0x2c) throw invalidJson('JSON array is missing a comma or closing bracket');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const text = this.text;
    this.index += 1; // opening quote
    let out = '';
    let runStart = this.index;
    for (;;) {
      const code = text.charCodeAt(this.index);
      if (Number.isNaN(code)) throw invalidJson('JSON string is not terminated');
      if (code === 0x22) break;
      if (code < 0x20) throw invalidJson('JSON string contains a raw control character');
      if (code !== 0x5c) {
        this.index += 1;
        continue;
      }
      out += text.slice(runStart, this.index);
      out += this.parseEscape();
      runStart = this.index;
    }
    out += text.slice(runStart, this.index);
    this.index += 1; // closing quote
    // Raw or escaped, a lone surrogate is not a Unicode string (RFC 8785 §3.2.2.2, RFC 7493 §2.1).
    if (!isWellFormedText(out)) throw invalidJson('JSON string contains a lone surrogate');
    return out;
  }

  /** Reads one escape sequence starting at the backslash; returns the code unit it stands for. */
  private parseEscape(): string {
    const code = this.text.charCodeAt(this.index + 1);
    this.index += 2;
    switch (code) {
      case 0x22:
        return '"';
      case 0x5c:
        return '\\';
      case 0x2f:
        return '/';
      case 0x62:
        return '\b';
      case 0x66:
        return '\f';
      case 0x6e:
        return '\n';
      case 0x72:
        return '\r';
      case 0x74:
        return '\t';
      case 0x75: {
        let unit = 0;
        for (let k = 0; k < 4; k += 1) {
          const digit = hexDigit(this.text.charCodeAt(this.index + k));
          if (digit < 0) throw invalidJson('JSON \\u escape needs four hex digits');
          unit = (unit << 4) | digit;
        }
        this.index += 4;
        return String.fromCharCode(unit);
      }
      default:
        throw invalidJson('JSON string has an unknown escape');
    }
  }

  private parseNumber(): number {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (match === null) throw invalidJson('JSON number is malformed');
    this.index += match[0].length;
    // ECMAScript StringToNumber rounds correctly in every runtime.
    const value = Number(match[0]);
    // On the token, not the value: `1.0`, `1e3` and `-0` parse to integers (04 §2.4.1).
    if (this.integersOnly && (!INTEGER_TOKEN.test(match[0]) || !Number.isSafeInteger(value))) {
      throw invalidJson('JSON number must be an integer token in [0, 2^53 - 1]');
    }
    // I-JSON: a number that overflows to Infinity cannot be represented, so it is refused.
    if (!Number.isFinite(value)) throw invalidJson('JSON number is outside the double range');
    return value;
  }
}

/**
 * Parses JSON text strictly: RFC 8259 grammar only (no comments, trailing commas, single quotes,
 * BOM, NaN, leading zeros or non-JSON whitespace), and the I-JSON rules RFC 8785 relies on: no
 * duplicate property names (compared after unescaping), no lone surrogates, no number outside the
 * double range, nesting at most MAX_JSON_DEPTH. Objects come back with a null prototype.
 *
 * With `integersOnly` (M1-1e), every number token must also be a protocol integer (04 §2.4.1): it
 * matches `0|[1-9][0-9]*` on the token text, so `1.0`, `1e3`, `-0` and `9007199254740991.4` are
 * refused whatever value they parse to, and its value is at most 2^53 - 1. Use it for JSON text
 * whose numbers are all such integers, such as the card JSON form (04 §2.4).
 */
export function parseJson(text: string, options?: ParseJsonOptions): JsonValue {
  if (typeof text !== 'string') {
    throw new CryptoInputError('invalid_argument', 'parseJson: text must be a string');
  }
  return new Parser(
    text,
    options?.integersOnly === true,
    options?.plainMemberNames === true,
  ).parseDocument();
}

/**
 * The 04 §2.5.1 "Received text" parse (D-128, M1-1h-b) for every owner-signed object and the text
 * that carries one: a SignedOwnerAction of any op, the envelope (04 §3.1.1 step 3) and the card
 * JSON form (04 §2.4). It is parseJson with `integersOnly` and `plainMemberNames`: before any schema
 * or signature check, it refuses a duplicate member name at any depth (RFC 7493 §2.3), a member
 * name written with any escape, and every number token that is not a protocol integer. Callers
 * verify the value it returns for the exact text received, never an object another layer parsed,
 * and never normalise or re-serialise a refused text to make it verify.
 */
export function parseReceivedJson(text: string): JsonValue {
  return parseJson(text, { integersOnly: true, plainMemberNames: true });
}

// --- canonicalize --------------------------------------------------------------------------------

/**
 * Serialises a number as RFC 8785 §3.2.2.3 requires (ECMAScript Number::toString; -0 becomes 0).
 * NaN and Infinity are refused.
 */
export function serializeNumber(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw unsupported('JCS numbers must be finite');
  }
  return Object.is(value, -0) ? '0' : String(value);
}

/** RFC 8785 §3.2.2.2 string serialisation; the caller has checked that `text` is well-formed. */
function quote(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += '\\\\';
    else if (code >= 0x20) out += text[i];
    else if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else out += '\\u00' + (code < 0x10 ? '0' : '') + code.toString(16);
  }
  return out + '"';
}

function serializeString(text: string): string {
  if (!isWellFormedText(text)) throw unsupported('JCS strings must not contain lone surrogates');
  return quote(text);
}

/** UTF-16 code-unit order (RFC 8785 §3.2.3), which is what `<` on strings compares. */
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function serialize(value: unknown, depth: number, path: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'string':
      return serializeString(value);
    case 'object':
      break;
    default:
      // undefined, bigint, function, symbol: JSON has no such value, and dropping or coercing it
      // would change what is signed.
      throw unsupported('JCS input contains a value JSON cannot represent');
  }
  if (depth + 1 > MAX_JSON_DEPTH) throw unsupported('JCS input is nested too deeply');
  if (path.has(value)) throw unsupported('JCS input contains a cycle');
  path.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) throw unsupported('JCS input contains a sparse array');
        items.push(serialize(value[i], depth + 1, path));
      }
      return '[' + items.join(',') + ']';
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      // Date, Map, typed arrays, boxed primitives, class instances: no implicit toJSON.
      throw unsupported('JCS input contains an object that is not a plain object');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw unsupported('JCS input contains a symbol key');
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort(byCodeUnits)
      .map((key) => serializeString(key) + ':' + serialize(record[key], depth + 1, path));
    return '{' + members.join(',') + '}';
  } finally {
    path.delete(value);
  }
}

/**
 * RFC 8785 canonical JSON text for a JSON value: no whitespace, object members sorted by the UTF-16
 * code units of their names, numbers per ECMAScript, strings with the minimal escapes. Refuses
 * anything that is not exactly JSON (undefined, functions, bigint, symbols, non-plain objects,
 * sparse arrays, cycles, non-finite numbers, lone surrogates) instead of dropping or coercing it.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, 0, new Set());
}

/** The UTF-8 bytes of canonicalize(value): what gets hashed and signed. */
export function canonicalizeToBytes(value: unknown): Uint8Array {
  return encodeUtf8(canonicalize(value));
}
