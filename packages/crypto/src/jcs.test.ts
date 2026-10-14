// M1-1a: RFC 8785 JSON Canonicalization Scheme, with a strict I-JSON (RFC 7493) parser in front of
// it. The cross-runtime RFC vectors live in test-vectors/jcs; these tests cover the API edges.
import { describe, expect, it } from 'vitest';
import {
  CryptoInputError,
  MAX_JSON_DEPTH,
  canonicalize,
  canonicalizeToBytes,
  encodeHex,
  parseJson,
  serializeNumber,
} from './index.js';

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

const jcsOfText = (text: string): string => canonicalize(parseJson(text));

describe('serializeNumber (RFC 8785 §3.2.2.3, ECMAScript Number::toString)', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [4.5, '4.5'],
    [0.002, '0.002'],
    [1e-7, '1e-7'],
    [0.000001, '0.000001'],
    [1e21, '1e+21'],
    [1e20, '100000000000000000000'],
    [1e30, '1e+30'],
    [Number('333333333.33333329'), '333333333.3333333'],
    [Number.MIN_VALUE, '5e-324'],
    [-Number.MAX_VALUE, '-1.7976931348623157e+308'],
    [2 ** 53, '9007199254740992'],
  ])('serialises %s as %s', (value, text) => {
    expect(serializeNumber(value)).toBe(text);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects %s', (n) => {
    rejects(() => serializeNumber(n), 'jcs_unsupported_value');
  });

  it('rejects a non-number', () => {
    rejects(() => serializeNumber(1n as unknown as number), 'jcs_unsupported_value');
  });
});

describe('canonicalize', () => {
  it('reproduces the RFC 8785 §3.2.2 example', () => {
    const value = {
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalize(value)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units, recursively, and keeps array order', () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 0, y: 1 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,{"y":1,"z":0}]},"b":1}',
    );
    // U+FFFF sorts after U+1F600 (surrogate pair D83D DE00), unlike in code-point order.
    expect(canonicalize({ '￿': 1, '😀': 2, '': 3 })).toBe('{"😀":2,"":3,"￿":1}');
  });

  it('escapes exactly as RFC 8785 §3.2.2.2 says', () => {
    expect(canonicalize('\u0000\u0007\b\t\n\u000b\f\r\u001f "\\/\u007fé ')).toBe(
      '"\\u0000\\u0007\\b\\t\\n\\u000b\\f\\r\\u001f \\"\\\\/\u007fé "',
    );
  });

  it('accepts null-prototype objects (what parseJson returns)', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value['b'] = 1;
    value['a'] = 2;
    expect(canonicalize(value)).toBe('{"a":2,"b":1}');
  });

  it('returns UTF-8 bytes from canonicalizeToBytes', () => {
    expect(encodeHex(canonicalizeToBytes({ ö: '€' }))).toBe('7b22c3b6223a22e282ac227d');
  });

  class Point {
    x = 1;
  }
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;

  it.each([
    ['undefined', undefined],
    ['an undefined property', { a: undefined }],
    ['an undefined array element', [1, undefined]],
    ['a sparse array', [1, , 3]], // eslint-disable-line no-sparse-arrays
    ['NaN', Number.NaN],
    ['Infinity', [Number.POSITIVE_INFINITY]],
    ['a bigint', { n: 1n }],
    ['a function', { f: () => 1 }],
    ['a symbol', Symbol('s')],
    ['a symbol key', { [Symbol('s')]: 1 }],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a Uint8Array', new Uint8Array(1)],
    ['a class instance', new Point()],
    ['a boxed string', Object('x') as unknown],
    ['a cycle', cyclic],
    ['a lone surrogate in a value', { a: '\ud800' }],
    ['a lone surrogate in a key', { '\udc00': 1 }],
    ['a reversed surrogate pair', '\ude00\ud83d'],
  ])('rejects %s', (_name, value) => {
    rejects(() => canonicalize(value), 'jcs_unsupported_value');
  });

  it('rejects nesting deeper than MAX_JSON_DEPTH', () => {
    let deep: unknown = 0;
    for (let i = 0; i < MAX_JSON_DEPTH; i += 1) deep = [deep];
    expect(() => canonicalize(deep)).not.toThrow();
    rejects(() => canonicalize([deep]), 'jcs_unsupported_value');
  });

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { k: 1 };
    expect(canonicalize([shared, shared])).toBe('[{"k":1},{"k":1}]');
  });
});

describe('parseJson (strict RFC 8259 + I-JSON)', () => {
  it('parses every JSON value type and top-level scalars', () => {
    expect(jcsOfText(' {"a" : [1, -2.5e1, "x", true, false, null, {}, []]} ')).toBe(
      '{"a":[1,-25,"x",true,false,null,{},[]]}',
    );
    expect(parseJson('"s"')).toBe('s');
    expect(parseJson('0')).toBe(0);
    expect(parseJson('null')).toBe(null);
    expect(parseJson('\t\n\r true')).toBe(true);
  });

  it('decodes escapes, including surrogate pairs and upper-case \\u digits', () => {
    expect(parseJson('"\\u00E9\\ud83d\\uDE00\\/\\b\\f\\n\\r\\t\\"\\\\"')).toBe('é😀/\b\f\n\r\t"\\');
  });

  it('serialises -0 as 0 and keeps large integers as doubles', () => {
    expect(jcsOfText('[-0, 0.0, 1E2, 12345678901234567890]')).toBe(
      '[0,0,100,12345678901234567000]',
    );
  });

  it('keeps __proto__ as an ordinary own key', () => {
    const value = parseJson('{"__proto__":{"polluted":true},"a":1}');
    expect(Object.keys(value as object)).toEqual(['__proto__', 'a']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(canonicalize(value)).toBe('{"__proto__":{"polluted":true},"a":1}');
  });

  it.each([
    ['the empty text', ''],
    ['only whitespace', '  '],
    ['a byte-order mark', '﻿{}'],
    ['a trailing comma in an object', '{"a":1,}'],
    ['a trailing comma in an array', '[1,]'],
    ['a missing value', '{"a":}'],
    ['single quotes', "{'a':1}"],
    ['an unquoted key', '{a:1}'],
    ['a comment', '{"a":1/* c */}'],
    ['trailing text', '{} x'],
    ['two values', '1 2'],
    ['a leading zero', '01'],
    ['a leading plus', '+1'],
    ['a bare fraction', '.5'],
    ['a dangling point', '1.'],
    ['a dangling exponent', '1e'],
    ['a hex number', '0x10'],
    ['NaN', 'NaN'],
    ['Infinity', '-Infinity'],
    ['a number that overflows to Infinity', '1e400'],
    ['a raw control character in a string', '"a\u0001b"'],
    ['a raw newline in a string', '"a\nb"'],
    ['an unknown escape', '"\\x41"'],
    ['a short \\u escape', '"\\u12"'],
    ['a non-hex \\u escape', '"\\u12g4"'],
    ['an unterminated string', '"abc'],
    ['a non-JSON space (NBSP)', ' {}'],
    ['a vertical tab', '\u000b{}'],
    ['True', 'True'],
    ['a truncated literal', 'nul'],
    ['a lone high surrogate escape', '{"a":"\\ud800"}'],
    ['a lone low surrogate escape', '["\\udc00x"]'],
    ['a lone surrogate escape in a key', '{"\\udbff":1}'],
    ['a reversed surrogate pair', '"\\ude00\\ud83d"'],
    ['a raw lone surrogate', '"\ud800"'],
    ['a duplicate key', '{"a":1,"a":2}'],
    ['a duplicate key with the same value', '{"a":1,"b":2,"a":1}'],
    ['a nested duplicate key', '{"x":[{"k":true,"k":false}]}'],
    ['a duplicate key spelt with an escape', '{"a":1,"\\u0061":2}'],
    ['a duplicate __proto__ key', '{"__proto__":1,"__proto__":2}'],
  ])('rejects %s', (_name, text) => {
    rejects(() => parseJson(text), 'invalid_json');
  });

  it('rejects nesting deeper than MAX_JSON_DEPTH without overflowing the stack', () => {
    const ok = '['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH);
    expect(() => parseJson(ok)).not.toThrow();
    rejects(() => parseJson('[' + ok + ']'), 'invalid_json');
    rejects(() => parseJson('['.repeat(100_000)), 'invalid_json');
  });

  it('refuses a non-string argument', () => {
    rejects(() => parseJson(42 as unknown as string), 'invalid_argument');
  });

  it('does not echo the text in its errors (I-7)', () => {
    let caught: unknown;
    try {
      parseJson('{"secret":"SECRETCANARY", oops}');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoInputError);
    expect(String(caught)).not.toContain('SECRETCANARY');
    expect(String(caught)).not.toContain('oops');
  });
});

describe('parseJson integersOnly (M1-1e, 04 §2.4.1)', () => {
  const strict = { integersOnly: true } as const;

  it('accepts protocol integers', () => {
    expect(parseJson('{"a":0,"b":[1,9007199254740991]}', strict)).toEqual({
      a: 0,
      b: [1, 9007199254740991],
    });
  });

  it.each([
    '1.0',
    '1e3',
    '1E3',
    '10e-1',
    '-0',
    '-1',
    '0.5',
    '9007199254740991.4',
    '9007199254740992',
    '9007199254740993',
    '100000000000000000000',
  ])('refuses the token %s, also nested', (token) => {
    rejects(() => parseJson(token, strict), 'invalid_json');
    rejects(() => parseJson(`{"a":[{"b":${token}}]}`, strict), 'invalid_json');
  });

  it('leaves the default parser unchanged', () => {
    expect(parseJson('[1.0,1e3,-0,-1]')).toEqual([1, 1000, -0, -1]);
    expect(parseJson('[1.0]', { integersOnly: false })).toEqual([1]);
  });
});
