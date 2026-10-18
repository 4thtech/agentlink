// Negative control for the storage memory gate (IR-CI-memgate-1 H-1): the 1 GiB MinIO test gates
// `peakRetained` from memory-gate.fixture.ts at < 64 MiB. Settling the collector must remove only
// garbage, so a pipeline that keeps ~80 MiB referenced has to read at or above the limit, i.e. the
// gate would fail. Runs in the unit project (started with --expose-gc, vitest.config.ts) on every CI.
import { describe, expect, it } from 'vitest';
import { MiB, RETAINED_LIMIT, forceGc, sampler } from './memory-gate.fixture.js';

const BLOCK = 64 * 1024;

/**
 * Streams `total` bytes in 64 KiB blocks through a sink, sampling as the integration test does (on
 * every pull and every write, plus a forced sample at the end). With `keep`, the sink holds on to
 * every block it receives, as a leaking pipeline would.
 */
async function pipe(total: number, keep: boolean) {
  const s = sampler();
  const kept: Uint8Array[] = [];
  let sent = 0;
  let received = 0;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await s.sample();
      if (sent >= total) {
        controller.close();
        return;
      }
      const block = new Uint8Array(BLOCK).fill(sent / BLOCK);
      controller.enqueue(block);
      sent += BLOCK;
    },
  });
  await source.pipeTo(
    new WritableStream<Uint8Array>({
      async write(chunk) {
        await s.sample();
        received += chunk.length;
        if (keep) kept.push(chunk);
      },
    }),
  );
  await s.sample(true);
  return { peaks: s.peaks(), received, keptBytes: kept.reduce((n, c) => n + c.length, 0) };
}

describe('storage memory gate (negative control)', () => {
  it('runs with gc() exposed', () => {
    expect(forceGc, 'run with --expose-gc (vitest.config.ts unit project)').toBeTypeOf('function');
  });

  it('a sink that keeps ~80 MiB referenced reads at or above the 64 MiB limit', async () => {
    const run = await pipe(80 * MiB, true);
    expect(run.received).toBe(80 * MiB);
    expect(run.keptBytes).toBe(80 * MiB);
    expect(run.peaks.peakRetained).toBeGreaterThanOrEqual(RETAINED_LIMIT);
  });

  it('the same 80 MiB, released as it flows, reads below the limit', async () => {
    const run = await pipe(80 * MiB, false);
    expect(run.received).toBe(80 * MiB);
    expect(run.peaks.peakRetained).toBeGreaterThan(0);
    expect(run.peaks.peakRetained).toBeLessThan(RETAINED_LIMIT);
  });
});
