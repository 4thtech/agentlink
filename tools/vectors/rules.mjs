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
 * A suite whose vectors are committed before its code (M1-1h) records a passing `kind: 'pending'`
 * marker instead of case results. For such a (runtime, suite) pair no case result is required.
 * Fail closed: the marker only passes while the suite has no module (harness/vectors.test.ts), a
 * runtime without the marker still needs every case, and a suite with both a marker and any case
 * result is a problem.
 *
 * @param {unknown} report Parsed Vitest JSON report.
 * @param {ReadonlyArray<{ suite: string, caseIds: readonly string[] | null }>} suites From the vector
 *   files; `caseIds` is null when a file has no `cases` array.
 * @param {readonly string[]} [required]
 * @returns {string[]} Problems; empty when every runtime passed its identity check and every case.
 */
export function checkCoverage(report, suites, required = REQUIRED_RUNTIMES) {
  const problems = [];
  const results = /** @type {{ testResults?: unknown }} */ (report ?? {}).testResults;
  if (!Array.isArray(results)) return ['the Vitest JSON report has no testResults'];
  if (suites.length === 0) problems.push('no vector suites found under test-vectors/');

  const passed = new Set();
  const pending = new Set();
  const ranCases = new Set();
  for (const file of results) {
    for (const assertion of file?.assertionResults ?? []) {
      const meta = assertion?.meta?.vectors;
      if (meta === undefined) continue;
      if (!required.includes(meta.runtime)) {
        problems.push(`a vector test ran in an unexpected runtime "${String(meta.runtime)}"`);
        continue;
      }
      if (meta.kind === 'case') ranCases.add(meta.suite);
      if (assertion.status !== 'passed') continue;
      if (meta.kind === 'identity') passed.add(`${meta.runtime}\u0000identity`);
      if (meta.kind === 'pending') pending.add(`${meta.runtime}\u0000${meta.suite}`);
      if (meta.kind === 'case')
        passed.add(`${meta.runtime}\u0000${meta.suite}\u0000${meta.caseId}`);
    }
  }

  // A suite with no cases (or no readable cases array) proves nothing (IR-M0-9-1 F04).
  for (const { suite, caseIds } of suites) {
    if (!Array.isArray(caseIds) || caseIds.length === 0) problems.push(`${suite}: no cases`);
  }

  for (const runtime of required) {
    if (!passed.has(`${runtime}\u0000identity`)) {
      problems.push(`${runtime}: no passing runtime identity test`);
    }
    for (const { suite, caseIds } of suites) {
      if (!Array.isArray(caseIds)) continue;
      if (pending.has(`${runtime}\u0000${suite}`)) {
        if (ranCases.has(suite)) problems.push(`${suite}: reported as pending but ran cases`);
        continue;
      }
      const missing = caseIds.filter((id) => !passed.has(`${runtime}\u0000${suite}\u0000${id}`));
      if (missing.length > 0) {
        problems.push(`${runtime}: ${suite}: no passing result for ${missing.join(', ')}`);
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * The suites reported as pending in every required runtime, with the card that implements them.
 * For display only; checkCoverage decides pass or fail.
 *
 * @param {unknown} report Parsed Vitest JSON report.
 * @param {readonly string[]} [required]
 * @returns {Map<string, string>} suite -> card
 */
export function pendingSuites(report, required = REQUIRED_RUNTIMES) {
  const seen = new Map();
  const results = /** @type {{ testResults?: unknown }} */ (report ?? {}).testResults;
  for (const file of Array.isArray(results) ? results : []) {
    for (const assertion of file?.assertionResults ?? []) {
      const meta = assertion?.meta?.vectors;
      if (meta?.kind !== 'pending' || assertion.status !== 'passed') continue;
      const entry = seen.get(meta.suite) ?? { card: String(meta.detail), runtimes: new Set() };
      entry.runtimes.add(meta.runtime);
      seen.set(meta.suite, entry);
    }
  }
  const out = new Map();
  for (const [suite, { card, runtimes }] of seen) {
    if (required.every((runtime) => runtimes.has(runtime))) out.set(suite, card);
  }
  return out;
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
