/**
 * Upper bound for a suite's per-case `timeoutMs`. Vitest treats a timeout of 0 or less, or
 * Infinity, as no timeout, so a suite must declare a finite value in (0, MAX_SUITE_TIMEOUT_MS].
 */
export const MAX_SUITE_TIMEOUT_MS = 120_000;

/** Returns why a suite's `timeoutMs` is out of range, or undefined when it is omitted or valid. */
export function timeoutMsProblem(timeoutMs: number | undefined): string | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs))
    return `timeoutMs must be a finite number, got ${String(timeoutMs)}`;
  if (timeoutMs <= 0 || timeoutMs > MAX_SUITE_TIMEOUT_MS) {
    return `timeoutMs must be greater than 0 and at most ${String(MAX_SUITE_TIMEOUT_MS)}, got ${String(timeoutMs)}`;
  }
  return undefined;
}
