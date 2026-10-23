// CHORE-VECTORS-TIMEOUT-RANGE: Vitest treats a timeout of 0 or less, or Infinity, as no timeout, so
// a suite's `timeoutMs` must be a finite number in (0, 120000]. Node project only: pure checks.
import { describe, expect, it } from 'vitest';
import { MAX_SUITE_TIMEOUT_MS, timeoutMsProblem } from './timeout';
import { suiteModules } from './suites/index';

describe('timeoutMsProblem', () => {
  it('accepts an omitted timeout and values inside (0, 120000]', () => {
    expect(timeoutMsProblem(undefined)).toBeUndefined();
    expect(timeoutMsProblem(1)).toBeUndefined();
    expect(timeoutMsProblem(60_000)).toBeUndefined();
    expect(timeoutMsProblem(120_000)).toBeUndefined();
  });

  it.each([
    ['0', 0],
    ['a negative number', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['120001', 120_001],
  ])('rejects %s', (_label, value) => {
    expect(timeoutMsProblem(value)).toEqual(expect.any(String));
  });

  it('caps at 120000', () => {
    expect(MAX_SUITE_TIMEOUT_MS).toBe(120_000);
  });
});

describe('shipped suites', () => {
  for (const [name, suite] of suiteModules) {
    it(`${name}: timeoutMs is omitted or within (0, ${String(MAX_SUITE_TIMEOUT_MS)}]`, () => {
      expect(timeoutMsProblem(suite.timeoutMs)).toBeUndefined();
    });
  }
});
