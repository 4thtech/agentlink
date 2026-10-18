// IR-M1-5a-1 L-1: randomPastTimestamp draws its offset by rejection sampling, so the offset is
// uniform over [0, 2 days] with no modulo bias. Sample tests cannot see a 4e-5 bias, so this file
// fakes the CSPRNG (@4thtech-io/crypto randomBytes) and checks the rejection branch directly.
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ draws: [] as number[], calls: 0 }));

vi.mock('@4thtech-io/crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('@4thtech-io/crypto')>();
  return {
    ...original,
    randomBytes: (length: number) => {
      const value = fake.draws.shift();
      if (value === undefined || length !== 4) return original.randomBytes(length);
      fake.calls += 1;
      return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
    },
  };
});

const { GIFT_WRAP_MAX_BACKDATE_SECONDS, randomPastTimestamp } = await import('./index.js');

const NOW = 1_760_000_000;
const RANGE = GIFT_WRAP_MAX_BACKDATE_SECONDS + 1;
/** The largest multiple of RANGE that fits in 32 bits: draws at or above it are discarded. */
const LIMIT = Math.floor(2 ** 32 / RANGE) * RANGE;

function drawWith(...values: number[]): number {
  fake.draws = [...values];
  fake.calls = 0;
  return randomPastTimestamp(NOW);
}

afterEach(() => {
  fake.draws = [];
});

describe('randomPastTimestamp rejection sampling (IR-M1-5a-1 L-1)', () => {
  it('discards a draw of 0xFFFFFFFF (at or above the limit) and uses the next one', () => {
    expect(0xffffffff).toBeGreaterThanOrEqual(LIMIT);
    expect(drawWith(0xffffffff, 1)).toBe(NOW - 1);
    expect(fake.calls).toBe(2);
  });

  it('discards a draw equal to the limit, and keeps the draw just below it', () => {
    expect(drawWith(LIMIT, 7)).toBe(NOW - 7);
    expect(fake.calls).toBe(2);
    // LIMIT - 1 is the top of the last full block: offset RANGE - 1 = 2 days exactly.
    expect(drawWith(LIMIT - 1)).toBe(NOW - GIFT_WRAP_MAX_BACKDATE_SECONDS);
    expect(fake.calls).toBe(1);
  });

  it('keeps drawing while draws are out of range', () => {
    expect(drawWith(0xffffffff, LIMIT, LIMIT + 1, 0)).toBe(NOW);
    expect(fake.calls).toBe(4);
  });

  it('maps an accepted draw by its remainder', () => {
    expect(drawWith(RANGE + 5)).toBe(NOW - 5);
    expect(drawWith(0)).toBe(NOW);
  });
});
