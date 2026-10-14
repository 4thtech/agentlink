// M1-1a: canonical encodings (04 §2.4.1, §3.1). Every binary value has exactly one spelling, and
// non-canonical forms are rejected on parse, never normalised.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  MAX_UINT256,
  decodeBase64url,
  decodeHex,
  decodeHex0x,
  decodeUint256Decimal,
  decodeUtf8,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  encodeUint256Decimal,
  encodeUtf8,
} from './index.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

function rejects(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected a CryptoInputError').toBeInstanceOf(CryptoInputError);
  expect((caught as CryptoInputError).code).toBe(code);
}

describe('bare lowercase hex', () => {
  it('round-trips bytes as lowercase hex', () => {
    expect(encodeHex(bytes())).toBe('');
    expect(encodeHex(bytes(0, 1, 0xab, 0xff))).toBe('0001abff');
    expect(decodeHex('0001abff')).toEqual(bytes(0, 1, 0xab, 0xff));
    expect(decodeHex('')).toEqual(bytes());
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeHex(encodeHex(all))).toEqual(all);
  });

  it.each([
    ['upper case', 'ABCD'],
    ['mixed case', 'aBcd'],
    ['odd length', 'abc'],
    ['0x prefix on a bare-hex value', '0xabcd'],
    ['0X prefix', '0Xabcd'],
    ['leading whitespace', ' abcd'],
    ['trailing newline', 'abcd\n'],
    ['inner space', 'ab cd'],
    ['non-hex letter', 'abcg'],
    ['full-width digit', 'ab００'],
    ['sign', '-abc'],
  ])('rejects %s', (_name, text) => {
    rejects(() => decodeHex(text), 'invalid_hex');
  });

  it('enforces an exact byte length when one is given', () => {
    expect(decodeHex('00'.repeat(32), { length: 32 })).toHaveLength(32);
    rejects(() => decodeHex('00'.repeat(31), { length: 32 }), 'invalid_length');
    rejects(() => decodeHex('00'.repeat(33), { length: 32 }), 'invalid_length');
  });

  it('refuses a non-string or non-bytes argument', () => {
    rejects(() => decodeHex(42 as unknown as string), 'invalid_argument');
    rejects(() => encodeHex('ab' as unknown as Uint8Array), 'invalid_argument');
  });
});

describe('0x + lowercase hex', () => {
  const address = '0x0180ec93ae3effd2535292dd293f5e4bb3ea2876';

  it('round-trips with the lowercase 0x prefix', () => {
    expect(encodeHex0x(bytes(0xde, 0xad))).toBe('0xdead');
    expect(decodeHex0x('0xdead')).toEqual(bytes(0xde, 0xad));
    expect(encodeHex0x(decodeHex0x(address, { length: 20 }))).toBe(address);
  });

  it.each([
    ['a missing prefix', '0180ec93ae3effd2535292dd293f5e4bb3ea2876'],
    ['0X', '0X0180ec93ae3effd2535292dd293f5e4bb3ea2876'],
    ['an EIP-55 checksum', '0x0180EC93Ae3effd2535292DD293f5E4bB3Ea2876'],
    ['upper case', '0x0180EC93AE3EFFD2535292DD293F5E4BB3EA2876'],
    ['odd length', '0xabc'],
    ['whitespace', '0x dead'],
    ['a trailing space', '0xdead '],
    ['a double prefix', '0x0xdead'],
  ])('rejects %s', (_name, text) => {
    rejects(() => decodeHex0x(text), 'invalid_hex');
  });

  it('enforces an exact byte length when one is given', () => {
    rejects(() => decodeHex0x(address, { length: 32 }), 'invalid_length');
    expect(decodeHex0x('0x' + 'ab'.repeat(32), { length: 32 })).toHaveLength(32);
  });
});

describe('base64url without padding', () => {
  // RFC 4648 §10, in the URL-safe alphabet with the padding removed.
  it.each([
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes and decodes RFC 4648 %j', (plain, encoded) => {
    expect(encodeBase64url(ascii(plain))).toBe(encoded);
    expect(decodeBase64url(encoded)).toEqual(ascii(plain));
  });

  it('uses - and _ for 62 and 63', () => {
    expect(encodeBase64url(bytes(0xfb, 0xff))).toBe('-_8');
    expect(decodeBase64url('-_8')).toEqual(bytes(0xfb, 0xff));
    expect(encodeBase64url(bytes(0xff, 0xff, 0xfe))).toBe('___-');
  });

  it('round-trips every byte value and every length up to 64', () => {
    for (let length = 0; length <= 64; length += 1) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      expect(decodeBase64url(encodeBase64url(data))).toEqual(data);
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeBase64url(encodeBase64url(all))).toEqual(all);
  });

  it.each([
    ['padding (one =)', 'Zm8='],
    ['padding (two =)', 'Zg=='],
    ['padding on a full quantum', 'Zm9v===='],
    ['+ from the standard alphabet', 'Zm+v'],
    ['/ from the standard alphabet', 'Zm/v'],
    ['non-zero trailing bits (2 chars)', 'Zh'],
    ['non-zero trailing bits (3 chars)', 'Zm9'],
    ['an impossible length (4n+1)', 'Zm9vY'],
    ['a single character', 'Z'],
    ['whitespace', 'Zm9v Zg'],
    ['a trailing newline', 'Zm9v\n'],
    ['a non-ASCII character', 'Zm9vé'],
    ['a dot', 'Zm9.'],
  ])('rejects %s', (_name, text) => {
    rejects(() => decodeBase64url(text), 'invalid_base64url');
  });

  it('enforces an exact byte length when one is given', () => {
    const sixteen = encodeBase64url(new Uint8Array(16));
    expect(sixteen).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    expect(decodeBase64url(sixteen, { length: 16 })).toHaveLength(16);
    rejects(() => decodeBase64url(sixteen, { length: 12 }), 'invalid_length');
  });
});

describe('decimal uint256', () => {
  const max = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

  it('round-trips 0, small values and the maximum', () => {
    expect(decodeUint256Decimal('0')).toBe(0n);
    expect(decodeUint256Decimal('1')).toBe(1n);
    expect(decodeUint256Decimal('1760000000')).toBe(1760000000n);
    expect(decodeUint256Decimal(max)).toBe(MAX_UINT256);
    expect(encodeUint256Decimal(0n)).toBe('0');
    expect(encodeUint256Decimal(MAX_UINT256)).toBe(max);
  });

  it.each([
    ['the empty string', ''],
    ['a leading zero', '01'],
    ['two zeros', '00'],
    ['a minus sign', '-1'],
    ['minus zero', '-0'],
    ['a plus sign', '+1'],
    ['a fraction', '1.0'],
    ['an exponent', '1e3'],
    ['leading whitespace', ' 1'],
    ['trailing whitespace', '1 '],
    ['hex', '0x1'],
    ['a full-width digit', '１'],
    ['an underscore separator', '1_000'],
    ['2^256', '115792089237316195423570985008687907853269984665640564039457584007913129639936'],
    ['a very long number', '9'.repeat(1000)],
  ])('rejects %s', (_name, text) => {
    rejects(() => decodeUint256Decimal(text), 'invalid_uint256');
  });

  it('refuses to encode values outside [0, 2^256 - 1] or non-bigints', () => {
    rejects(() => encodeUint256Decimal(-1n), 'invalid_uint256');
    rejects(() => encodeUint256Decimal(MAX_UINT256 + 1n), 'invalid_uint256');
    rejects(() => encodeUint256Decimal(1 as unknown as bigint), 'invalid_argument');
  });
});

describe('UTF-8', () => {
  it('encodes and decodes well-formed text', () => {
    expect(encodeHex(encodeUtf8('é€😀'))).toBe('c3a9e282acf09f9880');
    expect(decodeUtf8(decodeHex('c3a9e282acf09f9880'))).toBe('é€😀');
    expect(encodeUtf8('')).toEqual(bytes());
  });

  it('keeps a byte-order mark instead of stripping it', () => {
    expect(decodeUtf8(bytes(0xef, 0xbb, 0xbf, 0x61))).toBe('﻿a');
    expect(encodeUtf8('﻿a')).toEqual(bytes(0xef, 0xbb, 0xbf, 0x61));
  });

  it.each([
    ['a lone high surrogate', 'a\ud800'],
    ['a lone low surrogate', '\udc00a'],
    ['a reversed pair', '\ude00\ud83d'],
  ])('refuses to encode %s', (_name, text) => {
    rejects(() => encodeUtf8(text), 'invalid_utf8');
  });

  it.each([
    ['an invalid byte', [0xff]],
    ['an overlong encoding', [0xc0, 0x80]],
    ['an encoded surrogate', [0xed, 0xa0, 0x80]],
    ['a truncated sequence', [0xe2, 0x82]],
    ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
  ])('refuses to decode %s', (_name, values) => {
    rejects(() => decodeUtf8(Uint8Array.from(values)), 'invalid_utf8');
  });
});

describe('errors carry no input (I-7)', () => {
  const canary = 'c0ffee' + 'SECRETCANARY'.toLowerCase() + 'XyZ';

  it.each([
    ['decodeHex', () => decodeHex(canary)],
    ['decodeHex0x', () => decodeHex0x('0x' + canary)],
    ['decodeBase64url', () => decodeBase64url(canary + '==')],
    ['decodeUint256Decimal', () => decodeUint256Decimal(canary)],
    ['encodeUtf8', () => encodeUtf8(canary + '\ud800')],
  ])('%s does not echo its input', (_name, fn) => {
    let caught: unknown;
    try {
      fn();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoInputError);
    const shown = `${String(caught)} ${(caught as Error).message} ${JSON.stringify(caught)}`;
    expect(shown.toLowerCase()).not.toContain('secretcanary');
    expect(shown).not.toContain('c0ffee');
  });
});
