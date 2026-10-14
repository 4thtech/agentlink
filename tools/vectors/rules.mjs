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
  const problems = [];
  const results = /** @type {{ testResults?: unknown }} */ (report ?? {}).testResults;
  if (!Array.isArray(results)) return ['the Vitest JSON report has no testResults'];
  if (suites.length === 0) problems.push('no vector suites found under test-vectors/');

  const passed = new Set();
  for (const file of results) {
    for (const assertion of file?.assertionResults ?? []) {
      const meta = assertion?.meta?.vectors;
      if (meta === undefined) continue;
      if (!required.includes(meta.runtime)) {
        problems.push(`a vector test ran in an unexpected runtime "${String(meta.runtime)}"`);
        continue;
      }
      if (assertion.status !== 'passed') continue;
      if (meta.kind === 'identity') passed.add(`${meta.runtime}\u0000identity`);
      if (meta.kind === 'case')
        passed.add(`${meta.runtime}\u0000${meta.suite}\u0000${meta.caseId}`);
    }
  }

  for (const runtime of required) {
    if (!passed.has(`${runtime}\u0000identity`)) {
      problems.push(`${runtime}: no passing runtime identity test`);
    }
    for (const { suite, caseIds } of suites) {
      const missing = caseIds.filter((id) => !passed.has(`${runtime}\u0000${suite}\u0000${id}`));
      if (missing.length > 0) {
        problems.push(`${runtime}: ${suite}: no passing result for ${missing.join(', ')}`);
      }
    }
  }
  return [...new Set(problems)];
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
  const problems = [];
  for (const [path, hash] of before) {
    if (!after.has(path)) problems.push(`test-vectors/${path} was deleted during the run`);
    else if (after.get(path) !== hash) problems.push(`test-vectors/${path} changed during the run`);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) problems.push(`test-vectors/${path} was created during the run`);
  }
  return problems;
}
