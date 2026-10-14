// The rules `pnpm vectors:check` enforces on top of the Vitest exit code (M0-9). Pure functions, so
// tools/vectors/rules.test.mjs can prove each one fails when it should.

/**
 * Every runtime the vectors must pass in (04 §8.2: Node, browsers through Playwright, Workers).
 * Deliberately kept here and not read from test-vectors/vitest.config.ts: dropping a runtime from the
 * config must fail the check, not quietly shrink it.
 */
export const REQUIRED_RUNTIMES = Object.freeze([
  'node',
  'chromium',
  'firefox',
  'webkit',
  'workerd',
]);

/**
 * Checks a Vitest JSON report against the committed suites.
 * Each vector test records `meta.vectors = { kind, runtime, suite?, caseId? }`, where `runtime` is
 * what the engine reported (test-vectors/harness/runtime.ts), not what the config asked for.
 *
 * @param {unknown} report Parsed Vitest JSON report.
 * @param {ReadonlyArray<{ suite: string, caseIds: readonly string[] }>} suites From the vector files.
 * @param {readonly string[]} [required]
 * @returns {string[]} Problems; empty when every runtime passed its identity check and every case.
 */
export function checkCoverage(report, suites, required = REQUIRED_RUNTIMES) {
  // Tests first (S2): implemented in the next commit.
  void report;
  void suites;
  void required;
  throw new Error('checkCoverage: not implemented yet');
}

/**
 * Compares two snapshots (relative path -> content hash) of test-vectors/. Tests read the vectors;
 * they never write or regenerate them (docs/process/development-process.md §10).
 *
 * @param {ReadonlyMap<string, string>} before
 * @param {ReadonlyMap<string, string>} after
 * @returns {string[]} One line per added, removed or changed file.
 */
export function diffSnapshots(before, after) {
  // Tests first (S2): implemented in the next commit.
  void before;
  void after;
  throw new Error('diffSnapshots: not implemented yet');
}
