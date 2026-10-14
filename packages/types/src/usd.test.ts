// USD amounts (04 §2.4.1 "USD amount" row; 06 §3; G-7, G-32): one spelling, exact decimal arithmetic
// in integer micro-dollars, never a binary float.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_USD_MICROS,
  USD_DECIMALS,
  addUsd,
  compareDecimalWithUsd,
  compareUsd,
  formatUsd,
  isUsdAmount,
  parseUsd,
  roundUpToCents,
  roundUpUsdToCents,
  sumUsdMicros,
  usdAmountSchema,
} from './index.js';
import { expectAccept, expectReject } from './testing/assert.js';
import { BAD_USD_STRINGS } from './testing/fixtures.js';

const GOOD_USD_STRINGS = [
  '0',
  '5',
  '1',
  '0.5',
  '0.1',
  '2.5',
  '0.01',
  '0.000001',
  '1.000001',
  '123456789',
  '999999999',
  '999999999.999999',
];

describe('USD amount spelling (04 §2.4.1)', () => {
  it.each(GOOD_USD_STRINGS)('accepts %j', (s) => {
    expect(isUsdAmount(s)).toBe(true);
    expectAccept(usdAmountSchema, s);
  });

  it.each(BAD_USD_STRINGS)('rejects %j', (s) => {
    expect(isUsdAmount(s)).toBe(false);
    expectReject(usdAmountSchema, s);
  });

  it.each([5, 0, 0.5, 1e3, null, undefined, true, 5n, ['5'], { usd: '5' }])(
    'rejects the non-string %s (a JSON number is never a USD amount)',
    (v) => {
      expect(isUsdAmount(v)).toBe(false);
      expectReject(usdAmountSchema, v);
    },
  );

  it('fixes precision at 6 decimals and the maximum at 999 999 999.999999', () => {
    expect(USD_DECIMALS).toBe(6);
    expect(MAX_USD_MICROS).toBe(999_999_999_999_999n);
    expect(formatUsd(MAX_USD_MICROS)).toBe('999999999.999999');
  });
});

describe('parseUsd and formatUsd: exact micro-dollars', () => {
  it.each([
    ['0', 0n],
    ['5', 5_000_000n],
    ['2.5', 2_500_000n],
    ['0.1', 100_000n],
    ['0.000001', 1n],
    ['1.000001', 1_000_001n],
    ['999999999.999999', 999_999_999_999_999n],
  ] as const)('%s is %s micro-dollars, both ways', (text, micros) => {
    expect(parseUsd(text)).toBe(micros);
    expect(formatUsd(micros)).toBe(text);
  });

  it.each(BAD_USD_STRINGS)('parseUsd throws on %j instead of guessing', (s) => {
    expect(() => parseUsd(s)).toThrow(RangeError);
  });

  it('parseUsd throws on a JSON number', () => {
    expect(() => parseUsd(5 as unknown as string)).toThrow();
  });

  it.each([-1n, MAX_USD_MICROS + 1n])('formatUsd throws on %s micro-dollars', (m) => {
    expect(() => formatUsd(m)).toThrow(RangeError);
  });

  it('formatUsd refuses a JS number (no binary floats anywhere)', () => {
    expect(() => formatUsd(0.1 as unknown as bigint)).toThrow(TypeError);
  });

  it('formatUsd always writes the single canonical spelling, and parseUsd reads it back', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_USD_MICROS }), (m) => {
        const text = formatUsd(m);
        expect(isUsdAmount(text)).toBe(true);
        expect(parseUsd(text)).toBe(m);
      }),
      { numRuns: 500, seed: 0x05d },
    );
  });
});

describe('compareUsd, addUsd and sumUsdMicros: exact decimal arithmetic', () => {
  it('compares as decimals, not as strings or floats', () => {
    expect(compareUsd('1', '0.999999')).toBe(1);
    expect(compareUsd('0.999999', '1')).toBe(-1);
    expect(compareUsd('5', '5')).toBe(0);
    expect(compareUsd('10', '9')).toBe(1); // string order would say "10" < "9"
    expect(compareUsd('0.1', '0.000001')).toBe(1);
  });

  it('agrees with integer comparison on arbitrary amounts', () => {
    const micros = fc.bigInt({ min: 0n, max: MAX_USD_MICROS });
    fc.assert(
      fc.property(micros, micros, (a, b) => {
        expect(compareUsd(formatUsd(a), formatUsd(b))).toBe(a < b ? -1 : a > b ? 1 : 0);
      }),
      { numRuns: 300, seed: 0x0c0 },
    );
  });

  it('negative control: binary floats get 0.1 + 0.2 wrong; addUsd does not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addUsd('0.1', '0.2')).toBe('0.3');
    expect(addUsd('0.000001', '0.999999')).toBe('1');
    expect(addUsd('5', '0')).toBe('5');
  });

  it('addUsd throws when the sum leaves the USD range', () => {
    expect(() => addUsd('999999999.999999', '0.000001')).toThrow(RangeError);
  });

  it.each([
    ['1.0', '1'],
    ['1', '0.10'],
    ['1', 1],
  ] as const)('compareUsd and addUsd throw on a non-canonical operand (%j, %j)', (a, b) => {
    expect(() => compareUsd(a, b as string)).toThrow();
    expect(() => compareUsd(b as string, a)).toThrow();
    expect(() => addUsd(a, b as string)).toThrow();
  });

  it('sumUsdMicros adds exactly, with no upper bound on the sum (budget ledger)', () => {
    expect(sumUsdMicros([])).toBe(0n);
    expect(sumUsdMicros(Array.from({ length: 10 }, () => '0.1'))).toBe(1_000_000n);
    expect(sumUsdMicros(['999999999.999999', '999999999.999999'])).toBe(1_999_999_999_999_998n);
  });

  it('sumUsdMicros throws if any entry is not a canonical USD amount (a broken ledger is never 0)', () => {
    expect(() => sumUsdMicros(['0.1', '0.10'])).toThrow(RangeError);
    expect(() => sumUsdMicros(['0.1', 0.1 as unknown as string])).toThrow();
  });
});

describe('rounding up to whole cents ("Remember for this contact", 06 §3)', () => {
  it.each([
    [0n, 0n],
    [1n, 10_000n],
    [2_500_000n, 2_500_000n],
    [2_500_001n, 2_510_000n],
    [2_509_999n, 2_510_000n],
    [2_510_000n, 2_510_000n],
  ] as const)('%s micro-dollars round up to %s', (m, r) => {
    expect(roundUpToCents(m)).toBe(r);
  });

  it.each([
    ['2.5', '2.5'],
    ['2.501', '2.51'],
    ['2.509999', '2.51'],
    ['0.000001', '0.01'],
    ['0.1', '0.1'],
    ['7', '7'],
  ] as const)('%s is written as %s', (text, rounded) => {
    expect(roundUpUsdToCents(text)).toBe(rounded);
  });

  it('throws when rounding up leaves the USD range, and on negative input', () => {
    expect(() => roundUpUsdToCents('999999999.999999')).toThrow(RangeError);
    expect(() => roundUpToCents(-1n)).toThrow(RangeError);
  });
});

describe('compareDecimalWithUsd: a terms price of any size against a USD limit (04 §2.4.1)', () => {
  it.each([
    ['1500.00', '1', 1],
    ['0.5', '0.5', 0],
    ['0.50', '0.5', 0],
    ['1.000000', '1', 0],
    ['0.999999', '1', -1],
    ['0.000001', '0.000001', 0],
    ['250', '250.5', -1],
    ['250.50', '250.5', 0],
    ['999999999.999999', '999999999.999999', 0],
    ['1000000000', '999999999.999999', 1],
  ] as const)('%s vs %s is %i', (amount, usd, expected) => {
    expect(compareDecimalWithUsd(amount, usd)).toBe(expected);
  });

  it('handles an amount far above any limit without overflow or rejection', () => {
    expect(compareDecimalWithUsd('9'.repeat(10_000), '999999999.999999')).toBe(1);
    expect(compareDecimalWithUsd(`${'9'.repeat(400)}.123456`, '0')).toBe(1);
  });

  it('agrees with the exact USD comparison wherever both are defined', () => {
    const micros = fc.bigInt({ min: 0n, max: MAX_USD_MICROS });
    fc.assert(
      fc.property(micros, micros, fc.boolean(), (a, b, pad) => {
        // The terms grammar allows trailing zeros: write `a` with all 6 decimals when `pad`.
        const whole = a / 1_000_000n;
        const frac = (a % 1_000_000n).toString().padStart(6, '0');
        const amount = pad ? `${whole}.${frac}` : formatUsd(a);
        expect(compareDecimalWithUsd(amount, formatUsd(b))).toBe(a < b ? -1 : a > b ? 1 : 0);
      }),
      { numRuns: 300, seed: 0xd3c },
    );
  });

  it.each(['01', '1.', '1e3', '-1', '1.0000001', '', ' 1', '.5', '0x10', '１'])(
    'throws on the terms amount %j (not ^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$)',
    (amount) => {
      expect(() => compareDecimalWithUsd(amount, '1')).toThrow(RangeError);
    },
  );

  it('throws on a non-canonical USD limit', () => {
    expect(() => compareDecimalWithUsd('1', '1.0')).toThrow(RangeError);
    expect(() => compareDecimalWithUsd(1 as unknown as string, '1')).toThrow();
  });
});
