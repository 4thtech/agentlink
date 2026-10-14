// Negative controls for the round-trip helper (IR-M1-2a-1 L-7): a parser that changes a value in a
// way `toEqual` ignores must still fail the round trip.
import { describe, expect, it } from 'vitest';
import { expectRoundTrip, type SafeParser } from './assert.js';
import { clone } from './fixtures.js';

const returning = (change: (value: unknown) => unknown): SafeParser => ({
  safeParse: (value) => ({ success: true, data: change(value) }),
});

describe('expectRoundTrip', () => {
  const value = { a: 1, b: [1, 2] };

  it('accepts a parser that returns the value unchanged', () => {
    expectRoundTrip(returning(clone), value);
  });

  it('rejects a parser that adds a key set to undefined', () => {
    expect(() => {
      expectRoundTrip(
        returning((v) => ({ ...(v as object), extra: undefined })),
        value,
      );
    }).toThrow();
  });

  it('rejects a parser that fills a sparse array slot', () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the point of this control
    const sparse = [1, , 3];
    expect(() => {
      expectRoundTrip(
        returning(() => [1, undefined, 3]),
        sparse,
      );
    }).toThrow();
  });

  it('rejects a parser that returns an instance of a class', () => {
    class Box {
      a = 1;
    }
    expect(() => {
      expectRoundTrip(
        returning(() => new Box()),
        { a: 1 },
      );
    }).toThrow();
  });
});
