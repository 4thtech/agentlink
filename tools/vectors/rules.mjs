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
 * The only suites that may run in fewer than all runtimes, each with its spec reason
 * (IR-M1-1h-1 Q7, IR-M1-1h-2 F-E). Adding one is a reviewed change to this file.
 */
export const RUNTIME_EXCEPTIONS = Object.freeze({
  'keystore-file': '04 §2.8: the file KeyStore runs in Node only',
});

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
 * An implemented suite may leave single cases to a later card (pending-suites.json `cases`, M1-7d):
 * each such case records a passing `kind: 'pending-case'` marker instead of a result. Fail closed in
 * the same way: a failed marker leaves the case missing, and a case with both a marker and a passing
 * result is a problem.
 *
 * A suite may declare `runtimes` (its vector file's `runtimes.only`, citing a spec runtime table;
 * IR-M1-1h-1 Q7). It then needs exactly those runtimes, and any result from another runtime is a
 * problem.
 *
 * @param {unknown} report Parsed Vitest JSON report.
 * @param {ReadonlyArray<{ suite: string, caseIds: readonly string[] | null, runtimes?: readonly string[] }>} suites
 *   From the vector files; `caseIds` is null when a file has no `cases` array.
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
  const pendingCase = new Set();
  const ranCases = new Set();
  const ranIn = new Set();
  for (const file of results) {
    for (const assertion of file?.assertionResults ?? []) {
      const meta = assertion?.meta?.vectors;
      if (meta === undefined) continue;
      if (!required.includes(meta.runtime)) {
        problems.push(`a vector test ran in an unexpected runtime "${String(meta.runtime)}"`);
        continue;
      }
      if (meta.kind === 'case') ranCases.add(meta.suite);
      if (meta.kind === 'case' || meta.kind === 'pending' || meta.kind === 'pending-case')
        ranIn.add(`${meta.runtime}\u0000${meta.suite}`);
      if (assertion.status !== 'passed') continue;
      if (meta.kind === 'identity') passed.add(`${meta.runtime}\u0000identity`);
      if (meta.kind === 'pending') pending.add(`${meta.runtime}\u0000${meta.suite}`);
      if (meta.kind === 'case')
        passed.add(`${meta.runtime}\u0000${meta.suite}\u0000${meta.caseId}`);
      // A single case left to a later card (pending-suites.json `cases`): it ran nothing.
      if (meta.kind === 'pending-case')
        pendingCase.add(`${meta.runtime}\u0000${meta.suite}\u0000${meta.caseId}`);
    }
  }
  for (const key of pendingCase) {
    if (passed.has(key)) {
      const [, suite, caseId] = key.split('\u0000');
      problems.push(`${String(suite)}: case ${String(caseId)} reported as pending but also ran`);
    }
  }

  for (const { suite, runtimes, runtimesSource } of suites) {
    if (runtimes === undefined) continue;
    if (!Object.hasOwn(RUNTIME_EXCEPTIONS, suite)) {
      problems.push(`${suite}: declares runtimes but is not in RUNTIME_EXCEPTIONS`);
    }
    if (
      !Array.isArray(runtimes) ||
      runtimes.length === 0 ||
      runtimes.some((r) => !required.includes(r))
    ) {
      problems.push(`${suite}: declares unknown runtimes`);
    }
    if (typeof runtimesSource !== 'string' || runtimesSource.trim() === '') {
      problems.push(`${suite}: declares runtimes without a reason`);
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
    for (const { suite, caseIds, runtimes } of suites) {
      if (!Array.isArray(caseIds)) continue;
      if (Array.isArray(runtimes) && !runtimes.includes(runtime)) {
        if (ranIn.has(`${runtime}\u0000${suite}`)) {
          problems.push(`${runtime}: ${suite}: ran outside its declared runtimes`);
        }
        continue;
      }
      if (pending.has(`${runtime}\u0000${suite}`)) {
        if (ranCases.has(suite)) problems.push(`${suite}: reported as pending but ran cases`);
        continue;
      }
      const missing = caseIds.filter(
        (id) =>
          !passed.has(`${runtime}\u0000${suite}\u0000${id}`) &&
          !pendingCase.has(`${runtime}\u0000${suite}\u0000${id}`),
      );
      if (missing.length > 0) {
        problems.push(`${runtime}: ${suite}: no passing result for ${missing.join(', ')}`);
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * The suites reported as pending in every runtime they run in, with the card that implements them.
 * For display only; checkCoverage decides pass or fail.
 *
 * @param {unknown} report Parsed Vitest JSON report.
 * @param {ReadonlyArray<{ suite: string, runtimes?: readonly string[] }>} [suites] Declared runtimes.
 * @param {readonly string[]} [required]
 * @returns {Map<string, string>} suite -> card
 */
export function pendingSuites(report, suites = [], required = REQUIRED_RUNTIMES) {
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
    const declared = suites.find((s) => s.suite === suite)?.runtimes;
    const needed = Array.isArray(declared) ? declared : required;
    if (needed.every((runtime) => runtimes.has(runtime))) out.set(suite, card);
  }
  return out;
}

/**
 * The single cases reported as pending in every runtime their suite runs in: suite -> card and ids.
 * For display only; checkCoverage decides pass or fail.
 *
 * @param {unknown} report Parsed Vitest JSON report.
 * @param {ReadonlyArray<{ suite: string, runtimes?: readonly string[] }>} [suites] Declared runtimes.
 * @param {readonly string[]} [required]
 * @returns {Map<string, { card: string, ids: string[] }>}
 */
export function pendingCases(report, suites = [], required = REQUIRED_RUNTIMES) {
  const seen = new Map();
  const results = /** @type {{ testResults?: unknown }} */ (report ?? {}).testResults;
  for (const file of Array.isArray(results) ? results : []) {
    for (const assertion of file?.assertionResults ?? []) {
      const meta = assertion?.meta?.vectors;
      if (meta?.kind !== 'pending-case' || assertion.status !== 'passed') continue;
      const key = `${String(meta.suite)}\u0000${String(meta.caseId)}`;
      const entry = seen.get(key) ?? { card: String(meta.detail), runtimes: new Set() };
      entry.runtimes.add(meta.runtime);
      seen.set(key, entry);
    }
  }
  const out = new Map();
  for (const [key, { card, runtimes }] of seen) {
    const [suite, caseId] = key.split('\u0000');
    const declared = suites.find((s) => s.suite === suite)?.runtimes;
    const needed = Array.isArray(declared) ? declared : required;
    if (!needed.every((runtime) => runtimes.has(runtime))) continue;
    const entry = out.get(suite) ?? { card, ids: [] };
    entry.ids.push(caseId);
    out.set(suite, entry);
  }
  return out;
}

/**
 * Pending cases only shrink, like pending suites (M1-7d). Each `cases` entry of pending-suites.json
 * names a card, a phase and a non-empty list of distinct case ids. Compared with the base branch, a
 * case may be pending only if it did not run there: it was pending there under the same card and
 * phase, or its whole suite was pending there (and the cases keep that suite's phase), or the suite
 * is new. A suite that ran all its cases on the base can never start skipping one.
 *
 * @param {{ cases: ReadonlyMap<string, { card?: unknown, phase?: unknown, ids?: unknown }> }} head
 * @param {{ pending: ReadonlyMap<string, { phase?: unknown }>, cases: ReadonlyMap<string, { card?: unknown, phase?: unknown, ids?: unknown }>, suites: ReadonlySet<string> }} base
 * @returns {string[]} Problems.
 */
export function checkPendingCaseShrinks(head, base) {
  const problems = [];
  for (const [suite, entry] of head.cases) {
    if (!CARD.test(String(entry?.card)) || !PHASE.test(String(entry?.phase))) {
      problems.push(
        `${suite}: a pending-cases entry needs a card (e.g. M1-1a) and a phase (e.g. M1a)`,
      );
    }
    const ids = entry?.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.some((id) => typeof id !== 'string' || id === '') ||
      new Set(ids).size !== ids.length
    ) {
      problems.push(`${suite}: a pending-cases entry needs a non-empty list of distinct case ids`);
      continue;
    }
    const before = base.cases.get(suite);
    if (before !== undefined) {
      if (before.card !== entry.card || before.phase !== entry.phase) {
        problems.push(
          `${suite}: its pending cases changed card or phase from ${String(before.card)}/${String(before.phase)}; an existing entry can only shrink`,
        );
      }
      const earlier = new Set(Array.isArray(before.ids) ? before.ids : []);
      const added = ids.filter((id) => !earlier.has(id));
      if (added.length > 0 && !base.pending.has(suite)) {
        problems.push(
          `${suite}: cases ${added.join(', ')} ran on the base; pending cases only shrink`,
        );
      }
    } else if (base.pending.has(suite)) {
      // Suite -> cases transition (IR-M1-7d-1 F-3): the leftover cases keep the suite's phase, so
      // they cannot move to a later card's phase and leave its release gate. checkPendingCards then
      // ties that phase to the card's backlog phase.
      const suiteEntry = /** @type {{ phase?: unknown } | undefined} */ (base.pending.get(suite));
      if (suiteEntry?.phase !== entry.phase) {
        problems.push(
          `${suite}: pending cases must keep the phase ${String(suiteEntry?.phase)} the suite had on the base, not ${String(entry.phase)}`,
        );
      }
    } else if (base.suites.has(suite)) {
      problems.push(`${suite}: ran all its cases on the base branch; pending cases only shrink`);
    }
  }
  return problems;
}

/** The `cases` entries keyed for checkPendingCards and checkPendingGate. */
export function pendingCaseEntries(cases) {
  return new Map([...cases].map(([suite, entry]) => [`${suite} (pending cases)`, entry]));
}

const CARD = /^M[0-9]+-[0-9A-Za-z]+(-[0-9A-Za-z]+)*$/;
const PHASE = /^M[0-9]+[a-z]?$/;

/**
 * Pending suites only shrink (IR-M1-1h-1 F2). Compared with the base branch (main), a suite may be
 * newly pending only if its vectors are new too: a suite that had vectors on the base without
 * being pending (implemented, so its cases ran) can never become pending again, which would hide a
 * regression. Entries must name a card and a phase.
 *
 * @param {{ pending: ReadonlyMap<string, { card?: unknown, phase?: unknown }> }} head
 * @param {{ pending: ReadonlyMap<string, unknown>, suites: ReadonlySet<string> }} base
 * @returns {string[]} Problems.
 */
export function checkPendingShrinks(head, base) {
  const problems = [];
  for (const [suite, entry] of head.pending) {
    if (!CARD.test(String(entry?.card)) || !PHASE.test(String(entry?.phase))) {
      problems.push(`${suite}: a pending entry needs a card (e.g. M1-1a) and a phase (e.g. M1a)`);
    }
    if (!base.pending.has(suite) && base.suites.has(suite)) {
      problems.push(
        `${suite}: has vectors on the base branch and was not pending there; pending suites only shrink`,
      );
    }
    // An existing entry is frozen: moving its card or phase could slip it past a gate (IR-M1-1h-2 F-B).
    const before = /** @type {{ card?: unknown, phase?: unknown } | undefined} */ (
      base.pending.get(suite)
    );
    if (before !== undefined && (before.card !== entry?.card || before.phase !== entry?.phase)) {
      problems.push(
        `${suite}: its pending entry changed from ${String(before.card)}/${String(before.phase)} to ${String(entry?.card)}/${String(entry?.phase)}; an existing entry can only be removed`,
      );
    }
  }
  return problems;
}

/**
 * Card -> phase, read from docs/process/backlog.md: each `#### <card> · …` heading followed by a
 * `**Phase:** <phase>` field before the next heading.
 *
 * @param {string} backlog
 * @returns {Map<string, string>}
 */
export function cardPhases(backlog) {
  const phases = new Map();
  let card;
  for (const line of backlog.split('\n')) {
    const heading = /^#### (\S+) · /.exec(line);
    if (heading) {
      card = heading[1];
      continue;
    }
    if (/^#{1,4} /.test(line)) card = undefined;
    const phase = /\*\*Phase:\*\* (M[0-9]+[a-z]?)/.exec(line);
    if (card !== undefined && phase && !phases.has(card)) phases.set(card, phase[1]);
  }
  return phases;
}

/**
 * Every pending entry names a backlog card, and its phase is that card's phase (IR-M1-1h-2 F-B).
 *
 * @param {{ pending: ReadonlyMap<string, { card?: unknown, phase?: unknown }> }} head
 * @param {ReadonlyMap<string, string>} phases From cardPhases().
 * @returns {string[]} Problems.
 */
export function checkPendingCards(head, phases) {
  const problems = [];
  for (const [suite, entry] of head.pending) {
    const phase = phases.get(String(entry?.card));
    if (phase === undefined) {
      problems.push(`${suite}: card ${String(entry?.card)} has no Phase in the backlog`);
    } else if (phase !== entry?.phase) {
      problems.push(
        `${suite}: phase ${String(entry?.phase)} differs from card ${String(entry?.card)}'s backlog phase ${phase}`,
      );
    }
  }
  return problems;
}

/**
 * Release gate (IR-M1-1h-1 F2): no suite of a gated phase may be pending. At the M1a gate every
 * M1a suite must be implemented, so a release fails while one is still pending.
 *
 * @param {{ pending: ReadonlyMap<string, { card?: unknown, phase?: unknown }> }} head
 * @param {readonly string[]} phases
 * @param {ReadonlyMap<string, string>} [cards] Card -> phase from the backlog (cardPhases()).
 * @returns {string[]} Problems.
 */
export function checkPendingGate(head, phases, cards = new Map()) {
  const problems = [];
  for (const [suite, entry] of head.pending) {
    // The phase comes from the card in the backlog, never from the pending entry (IR-M1-1h-2 F-B).
    const phase = cards.get(String(entry?.card));
    if (phase === undefined) {
      problems.push(`${suite}: card ${String(entry?.card)} has no Phase in the backlog`);
    } else if (phases.includes(phase)) {
      problems.push(
        `${suite} is still pending (${String(entry?.card)}, phase ${phase}): every ${phase} suite must be implemented before a release`,
      );
    }
  }
  return problems;
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
