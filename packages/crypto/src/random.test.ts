// M1-1a: randomBytes comes only from globalThis.crypto.getRandomValues, never Math.random, and
// fails closed when no secure source exists. wipe() zeroes buffers in place (04 §8.3).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoInputError, randomBytes, wipe } from './index.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('randomBytes', () => {
  it('returns the requested number of bytes', () => {
    expect(randomBytes(0)).toHaveLength(0);
    expect(randomBytes(1)).toHaveLength(1);
    expect(randomBytes(32)).toHaveLength(32);
  });

  it('returns different bytes on each call', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(a).not.toEqual(b);
  });

  it('fills more than the 65536-byte getRandomValues limit in chunks', () => {
    const big = randomBytes(200_000);
    expect(big).toHaveLength(200_000);
    // The last chunk is filled too: 4096 zero bytes at the tail would be a 2^-32768 event.
    expect(big.subarray(big.length - 4096).some((b) => b !== 0)).toBe(true);
  });

  it('draws from globalThis.crypto.getRandomValues and never Math.random', () => {
    // The shared packages compile without DOM types, so the global is reached through a cast.
    const webCrypto = (
      globalThis as unknown as { crypto: { getRandomValues(array: Uint8Array): Uint8Array } }
    ).crypto;
    const source = vi.spyOn(webCrypto, 'getRandomValues');
    const weak = vi.spyOn(Math, 'random');
    randomBytes(16);
    expect(source).toHaveBeenCalled();
    expect(weak).not.toHaveBeenCalled();
  });

  it('fails closed when no secure source exists', () => {
    vi.stubGlobal('crypto', undefined);
    let caught: unknown;
    try {
      randomBytes(16);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoInputError);
    expect((caught as CryptoInputError).code).toBe('no_secure_random');
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects the length %s',
    (length) => {
      expect(() => randomBytes(length)).toThrow(CryptoInputError);
    },
  );

  it('rejects a non-number length', () => {
    expect(() => randomBytes('16' as unknown as number)).toThrow(CryptoInputError);
  });
});

describe('wipe', () => {
  it('zeroes every buffer it is given, in place', () => {
    const a = Uint8Array.of(1, 2, 3);
    const b = Uint8Array.of(4, 5);
    wipe(a, b);
    expect(a).toEqual(new Uint8Array(3));
    expect(b).toEqual(new Uint8Array(2));
  });

  it('zeroes only the visible bytes of a view', () => {
    const backing = Uint8Array.of(1, 2, 3, 4);
    wipe(backing.subarray(1, 3));
    expect(backing).toEqual(Uint8Array.of(1, 0, 0, 4));
  });

  it('skips null and undefined so cleanup paths can pass optional buffers', () => {
    const a = Uint8Array.of(1);
    expect(() => wipe(undefined, null, a)).not.toThrow();
    expect(a[0]).toBe(0);
  });

  it('refuses a value it cannot wipe instead of silently doing nothing', () => {
    expect(() => wipe('secret' as unknown as Uint8Array)).toThrow(CryptoInputError);
    expect(() => wipe([1, 2] as unknown as Uint8Array)).toThrow(CryptoInputError);
  });
});
