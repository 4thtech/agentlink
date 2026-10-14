// Tests of the canary helper itself, including its permanent negative control: a deliberately
// leaking exercise must be reported, so the canary check can never pass vacuously.

import { describe, expect, it } from 'vitest';
import { leakyExercise } from '../test/leaky-fixture.js';
import { captureConsole, runtimeConsole } from './console.js';
import {
  assertNoCanaryLeaks,
  CANARIES,
  captureOutput,
  findCanaryLeaks,
  KEY_ONLY_CANARY,
  PATTERN_CANARIES,
  runCanaryCheck,
} from './testing.js';

const canary = { name: 'test', value: 'canary-test-secret-123' };

describe('canary helper', () => {
  it('NEGATIVE CONTROL: reports the deliberately leaking fixture', async () => {
    const leaks = await runCanaryCheck({ canaries: CANARIES, exercise: leakyExercise });
    expect(leaks).toEqual([{ canary: KEY_ONLY_CANARY.name, source: 'log:debug', index: 0 }]);
    await expect(
      assertNoCanaryLeaks({ canaries: CANARIES, exercise: leakyExercise }),
    ).rejects.toThrow(/secret canary leaked into output: key-only in log:debug line 0/);
  });

  it('the failure message names the canary but never contains its value', async () => {
    const error = await assertNoCanaryLeaks({ canaries: CANARIES, exercise: leakyExercise }).catch(
      (e: Error) => e,
    );
    expect(String(error)).not.toContain(KEY_ONLY_CANARY.value);
  });

  it('every pattern canary leaks when written raw, so each one is a live check', async () => {
    const lines = await captureOutput(({ sink }) => {
      for (const entry of PATTERN_CANARIES) sink('info', entry.value);
    });
    const found = new Set(findCanaryLeaks(lines, PATTERN_CANARIES).map((leak) => leak.canary));
    expect([...found].sort()).toEqual(PATTERN_CANARIES.map((entry) => entry.name).sort());
  });

  it('catches output that bypasses the logger through the console', async () => {
    const leaks = await runCanaryCheck({
      canaries: [canary],
      exercise: () => {
        runtimeConsole()?.log?.('debug dump', { value: canary.value });
      },
    });
    expect(leaks).toEqual([{ canary: 'test', source: 'console:log', index: 0 }]);
  });

  it('matches case-insensitively and other encodings via forms', () => {
    const lines = [
      { source: 'log:info', line: canary.value.toUpperCase() },
      { source: 'log:info', line: 'Y2FuYXJ5LWJhc2U2NA' },
    ];
    expect(findCanaryLeaks(lines, [{ ...canary, forms: ['Y2FuYXJ5LWJhc2U2NA'] }])).toHaveLength(2);
  });

  it('restores the console even when the exercise throws', async () => {
    const before = runtimeConsole()?.error;
    await expect(
      captureOutput(() => {
        throw new Error('exercise failed');
      }),
    ).rejects.toThrow('exercise failed');
    expect(runtimeConsole()?.error).toBe(before);
  });

  it('fails an exercise that writes fewer lines than expected', async () => {
    await expect(runCanaryCheck({ canaries: [canary], exercise: () => undefined })).rejects.toThrow(
      /0 lines/,
    );
  });

  it('rejects canaries that are empty, short or not verbatim in JSON', () => {
    expect(() => findCanaryLeaks([], [])).toThrow(/no canaries/);
    expect(() => findCanaryLeaks([], [{ name: 'short', value: 'abc' }])).toThrow(/8 characters/);
    expect(() => findCanaryLeaks([], [{ name: 'quote', value: 'has"quote-inside' }])).toThrow(
      /printable ASCII/,
    );
  });

  it('captureConsole hands over console output and restores the originals', () => {
    const seen: string[] = [];
    const original = runtimeConsole()?.warn;
    const restore = captureConsole((method, data) => seen.push(`${method} ${String(data[0])}`));
    runtimeConsole()?.warn?.('hello');
    restore();
    expect(seen).toEqual(['warn hello']);
    expect(runtimeConsole()?.warn).toBe(original);
  });
});
