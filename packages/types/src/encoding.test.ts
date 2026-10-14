// Field encodings (04 §2.5.1 "Encoding (byte-exact)", G-29 F02; 04 §3.1 base64url without padding).
// Non-canonical forms are rejected, never normalised: every schema here returns its input unchanged.
import { describe, expect, it } from 'vitest';
import {
  approvalIdSchema,
  base64url,
  base64urlBounded,
  base64urlByteLength,
  bip340SigHex,
  codePointLength,
  eip712SigHex,
  evmAddress,
  hex0xBytes,
  hexBytes,
  ijsonString,
  isWellFormedString,
  jsonObjectSchema,
  jsonValueSchema,
  sha256Hex,
  uint32,
  uint53,
  utf8ByteLength,
} from './index.js';
import { APPROVAL_ID, b64u, ID16 } from './testing/fixtures.js';

import { label } from './testing/assert.js';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success, label(v)).toBe(true);
const bad = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success, label(v)).toBe(false);

describe('base64url (no padding, canonical, exact byte length)', () => {
  it('computes the decoded byte length without decoding', () => {
    for (let n = 0; n <= 70; n++) expect(base64urlByteLength(b64u(n))).toBe(n);
  });

  it('accepts the exact lengths used by the protocol', () => {
    ok(base64url(16), ID16);
    expect(ID16).toHaveLength(22);
    ok(base64url(32), b64u(32));
    expect(b64u(32)).toHaveLength(43);
    ok(base64url(12), b64u(12));
    ok(base64url(48), b64u(48));
    ok(base64url(16), 'AQIDBAUGBwgJCgsMDQ4PEA'); // bytes 01..10
    ok(base64url(16), '-_-_-_-_-_-_-_-_-_-_-w'); // url-safe alphabet, canonical tail
  });

  it.each([
    ['padded', `${ID16}==`],
    ['single pad', `${b64u(32)}=`],
    ['standard alphabet +', `+${ID16.slice(1)}`],
    ['standard alphabet /', `/${ID16.slice(1)}`],
    ['whitespace', ` ${ID16.slice(1)}`],
    ['newline inside', `${ID16.slice(0, 10)}\n${ID16.slice(11)}`],
    ['non-zero trailing bits (len%4==2)', `${ID16.slice(0, -1)}B`],
    ['non-zero trailing bits (len%4==3)', `${b64u(32).slice(0, -1)}B`],
    ['impossible length (len%4==1)', 'AAAAA'],
    ['non-ASCII look-alike', `${ID16.slice(0, -1)}Ａ`],
  ])('rejects %s', (_label, value) => {
    bad(base64url(16), value);
    bad(base64url(32), value);
    expect(base64urlByteLength(value)).toBe(null);
  });

  it('rejects a canonical value of the wrong byte length', () => {
    bad(base64url(16), '');
    expect(base64urlByteLength('')).toBe(0);
    bad(base64url(16), b64u(15));
    bad(base64url(16), b64u(17));
    bad(base64url(32), b64u(31));
    bad(base64url(32), b64u(33));
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 16, [], {}, true]) bad(base64url(16), v);
  });

  it('bounds variable-length fields by decoded bytes', () => {
    const schema = base64urlBounded(16, 100);
    ok(schema, b64u(16));
    ok(schema, b64u(100));
    bad(schema, b64u(15));
    bad(schema, b64u(101));
    bad(schema, `${b64u(30)}==`);
  });
});

describe('hex and addresses (lowercase only)', () => {
  it('accepts lowercase hex of the exact length', () => {
    ok(hexBytes(32), 'ab'.repeat(32));
    ok(sha256Hex, '0123456789abcdef'.repeat(4));
    ok(bip340SigHex, 'ab'.repeat(64));
    ok(hex0xBytes(32), `0x${'ab'.repeat(32)}`);
    ok(eip712SigHex, `0x${'ab'.repeat(65)}`);
    ok(evmAddress, `0x${'ab'.repeat(20)}`);
  });

  it.each([
    ['uppercase', 'AB'.repeat(32)],
    ['mixed case', `Ab${'ab'.repeat(31)}`],
    ['0x prefix where none belongs', `0x${'ab'.repeat(32)}`],
    ['63 chars', 'a'.repeat(63)],
    ['65 chars', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['empty', ''],
  ])('sha256Hex rejects %s', (_l, v) => bad(sha256Hex, v));

  it('rejects 127 or 129 char and uppercase BIP-340 signatures', () => {
    bad(bip340SigHex, 'a'.repeat(127));
    bad(bip340SigHex, 'a'.repeat(129));
    bad(bip340SigHex, 'A'.repeat(128));
  });

  it.each([
    ['EIP-55 checksummed', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
    ['uppercase', `0x${'AB'.repeat(20)}`],
    ['uppercase 0X prefix', `0X${'ab'.repeat(20)}`],
    ['no prefix', 'ab'.repeat(20)],
    ['19 bytes', `0x${'ab'.repeat(19)}`],
    ['21 bytes', `0x${'ab'.repeat(21)}`],
    ['32-byte padded', `0x${'00'.repeat(12)}${'ab'.repeat(20)}`],
  ])('evmAddress rejects %s', (_l, v) => bad(evmAddress, v));

  it('rejects a 0x-hex value without the prefix or with the wrong length', () => {
    bad(hex0xBytes(32), 'ab'.repeat(32));
    bad(hex0xBytes(32), `0x${'ab'.repeat(31)}`);
    bad(eip712SigHex, `0x${'ab'.repeat(64)}`);
    bad(eip712SigHex, `0x${'AB'.repeat(65)}`);
  });
});

describe('integers (JSON integers in [0, 2^53 − 1])', () => {
  it('accepts the range ends', () => {
    ok(uint53, 0);
    ok(uint53, Number.MAX_SAFE_INTEGER);
    ok(uint32, 2 ** 32 - 1);
  });

  it.each([
    ['negative', -1],
    ['fraction', 1.5],
    ['2^53', 2 ** 53],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative zero', -0],
    ['numeric string', '1'],
    ['bigint', 1n],
    ['null', null],
  ])('uint53 rejects %s', (_l, v) => bad(uint53, v));

  it('uint32 rejects 2^32', () => bad(uint32, 2 ** 32));
});

describe('strings (I-JSON, RFC 7493)', () => {
  it('detects lone surrogates', () => {
    expect(isWellFormedString('a😀b')).toBe(true);
    expect(isWellFormedString('a\uD83Db')).toBe(false);
    expect(isWellFormedString('a\uDE00b')).toBe(false);
    expect(isWellFormedString('\uD83D')).toBe(false);
  });

  it('counts code points and UTF-8 bytes', () => {
    expect(codePointLength('a😀é')).toBe(3);
    expect(utf8ByteLength('a😀é你')).toBe(1 + 4 + 2 + 3);
    expect(utf8ByteLength('')).toBe(0);
  });

  it('bounds by code points and rejects lone surrogates', () => {
    const s = ijsonString({ max: 3 });
    ok(s, '😀😀😀');
    bad(s, '😀😀😀😀');
    bad(s, 'a\uD800');
    bad(s, 42);
  });
});

describe('approvalId (04 §3.4.1: apr_ + 16 random bytes, base64url)', () => {
  it('accepts the canonical form', () => {
    ok(approvalIdSchema, APPROVAL_ID);
  });

  it.each([
    ['no prefix', ID16],
    ['uppercase prefix', `APR_${ID16}`],
    ['short', `apr_${b64u(15)}`],
    ['padded', `apr_${ID16}==`],
    ['trailing bits', `apr_${ID16.slice(0, -1)}B`],
    ['hex body', `apr_${'ab'.repeat(16)}`],
  ])('rejects %s', (_l, v) => bad(approvalIdSchema, v));
});

describe('bounded JSON values (untrusted bodies, placeholders)', () => {
  it('accepts plain JSON data', () => {
    ok(jsonValueSchema, { a: [1, 'x', null, true, { b: -2.5 }] });
    ok(jsonObjectSchema, {});
  });

  it('rejects non-JSON values', () => {
    for (const v of [
      undefined,
      () => 1,
      Symbol('s'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      new Map(),
      'x\uD800',
      { k: undefined },
      { ['bad\uDC00key']: 1 },
    ]) {
      bad(jsonValueSchema, v);
    }
  });

  it('rejects a top-level array or scalar where an object is required', () => {
    bad(jsonObjectSchema, []);
    bad(jsonObjectSchema, 'x');
    bad(jsonObjectSchema, null);
  });

  it('rejects own __proto__ keys, deep nesting and cycles without throwing', () => {
    bad(jsonObjectSchema, JSON.parse('{"__proto__": {"polluted": true}}'));
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(() => jsonValueSchema.safeParse(deep)).not.toThrow();
    bad(jsonValueSchema, deep);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jsonValueSchema.safeParse(cyclic)).not.toThrow();
    bad(jsonValueSchema, cyclic);
  });

  it('rejects objects whose getters throw, without throwing', () => {
    const hostile = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => jsonValueSchema.safeParse(hostile)).not.toThrow();
    bad(jsonValueSchema, hostile);
  });
});
