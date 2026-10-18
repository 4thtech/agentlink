// The memory measurement behind the storage 1 GiB gate (M1-6b, M1-1d limit), shared by the MinIO
// integration test and its negative control (memory-gate.test.ts), so both run the same code.
// Test-only: excluded from the build (tsconfig.json), never shipped.

interface NodeProcess {
  memoryUsage: {
    (): { readonly heapUsed: number; readonly arrayBuffers: number };
    rss(): number;
  };
}
const nodeProcess = (globalThis as { process?: NodeProcess }).process;

export const MiB = 1024 * 1024;
/** The retained-after-GC limit of the gate (M1-1d). */
export const RETAINED_LIMIT = 64 * MiB;

export const rss = (): number => nodeProcess?.memoryUsage.rss() ?? 0;
/** JS heap in use plus ArrayBuffer memory: the buffers the process actually holds (M1-1d gate). */
export const held = (): number => {
  const m = nodeProcess?.memoryUsage();
  return m === undefined ? 0 : m.heapUsed + m.arrayBuffers;
};

/** `gc()` when the process runs with --expose-gc (vitest.config.ts), else undefined. */
export const forceGc = (globalThis as { gc?: () => void }).gc;

/** Yields one macrotask, so work the collector left for later (freeing ArrayBuffer memory) can finish. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Yield-and-collect rounds before the reading. */
export const SETTLE_ROUNDS = 3;

/**
 * Held memory after the collector has settled: `gc()`, then SETTLE_ROUNDS times a yield and `gc()`,
 * then the reading. A reading right after a single `gc()` still counts ArrayBuffer memory that the
 * collection found dead but has not released yet (V8 frees it after the pause); on CI that put up to
 * ~45 MiB of garbage in the figure (retained download 27-70 MiB across runs, failed at 73 MB).
 * Settling removes only garbage: whatever the caller still references is in the reading
 * (memory-gate.test.ts is the negative control).
 */
export async function settledHeld(gc: () => void): Promise<number> {
  gc();
  for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
    await nextTask();
    gc();
  }
  return held();
}

/**
 * Peak memory, sampled as bytes flow: RSS and held (heapUsed + arrayBuffers) every 32 calls, and,
 * when `gc()` is exposed, held after a settled forced collection every 256 calls and on a forced
 * sample (`peakRetained`, see settledHeld): what the pipeline keeps alive rather than garbage the
 * collector has not reached or released yet. The stream waits for each sample, so the pipeline's
 * buffers stay referenced while it is taken.
 */
export function sampler() {
  let peakRss = rss();
  let peakHeld = held();
  let peakRetained = 0;
  let calls = 0;
  return {
    async sample(force = false): Promise<void> {
      calls += 1;
      if (!force && (calls & 31) !== 0) return;
      peakRss = Math.max(peakRss, rss());
      peakHeld = Math.max(peakHeld, held());
      if (forceGc !== undefined && (force || (calls & 255) === 0)) {
        peakRetained = Math.max(peakRetained, await settledHeld(forceGc));
      }
    },
    peaks: () => ({ peakRss, peakHeld, peakRetained }),
  };
}
