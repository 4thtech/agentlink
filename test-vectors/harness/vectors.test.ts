// The one set of vector tests. The same file runs in every project of vitest.config.ts: Node,
// Chromium, Firefox, WebKit (Playwright) and workerd (Workers pool). Each test records the runtime
// it observed in `task.meta`, and tools/vectors/check.mjs requires a passing result for every
// (runtime, suite, case) triple, so a project that silently runs somewhere else, or not at all,
// fails `pnpm vectors:check`. A suite may declare fewer runtimes (`runtimes.only`, citing a spec
// runtime table, written by its generator), and then needs exactly those.
import { describe, expect, inject, test } from 'vitest';
import pending from '../pending-suites.json';
import { compareToVector } from './compare';
import { vectorFiles, type VectorCase } from './registry';
import { observeRuntime, type RuntimeId } from './runtime';
import { suiteModules } from './suites/index';

declare module 'vitest' {
  interface ProvidedContext {
    /** The runtime this project must run in; set per project in vitest.config.ts. */
    vectorsRuntime: RuntimeId;
  }
  interface TaskMeta {
    vectors?: {
      readonly kind: 'identity' | 'case' | 'pending' | 'pending-case';
      readonly runtime: string;
      readonly detail?: string;
      readonly suite?: string;
      readonly caseId?: string;
    };
  }
}

const expectedRuntime = inject('vectorsRuntime');
const pendingSuites: ReadonlyMap<string, { readonly card: string; readonly phase: string }> =
  new Map(Object.entries(pending.suites));
const pendingCases: ReadonlyMap<
  string,
  { readonly card: string; readonly phase: string; readonly ids: readonly string[] }
> = new Map(Object.entries(pending.cases));

test('runtime identity', ({ task }) => {
  const observed = observeRuntime();
  task.meta.vectors = { kind: 'identity', runtime: observed.id, detail: observed.detail };
  expect(expectedRuntime, 'the project must provide vectorsRuntime').toBeTypeOf('string');
  expect(observed.id, `observed: ${observed.detail}`).toBe(expectedRuntime);
});

test('at least one vector suite is committed', () => {
  expect(vectorFiles.length).toBeGreaterThan(0);
});

// A pending entry with no vector file is stale; it must not linger once a suite is renamed or gone.
test('every pending suite has a committed vector file', () => {
  const committed = new Set(vectorFiles.map(({ file }) => file.suite));
  expect([...pendingSuites.keys()].filter((suite) => !committed.has(suite))).toEqual([]);
});

for (const { directory, file } of vectorFiles) {
  describe(`${directory} v${String(file.version)}`, () => {
    const suite = suiteModules.get(file.suite);
    const cases: readonly VectorCase[] = Array.isArray(file.cases) ? file.cases : [];
    const pendingEntry = pendingSuites.get(file.suite);
    const runsHere = file.runtimes === undefined || file.runtimes.only.includes(expectedRuntime);

    // A suite is either implemented (a module runs every case) or pending (no module yet, M1-1h).
    // Both at once fails, so the pending entry goes away when the module lands (fail closed).
    test('has a suite module and a matching directory', () => {
      expect(file.suite).toBe(directory);
      if (pendingEntry === undefined) {
        expect(suite, `no suite module registered for "${file.suite}"`).toBeDefined();
      } else {
        expect(
          suite,
          `"${file.suite}" has a module: remove it from test-vectors/pending-suites.json`,
        ).toBeUndefined();
      }
    });

    // A suite with no cases proves nothing (IR-M0-9-1 F04).
    test('has at least one case', () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    // Outside its declared runtimes a suite records nothing; check.mjs requires nothing there.
    if (!runsHere) return;

    if (pendingEntry !== undefined) {
      // Recorded per runtime; tools/vectors/check.mjs reports the suite as pending, not passed.
      test(`pending: not yet implemented (${pendingEntry.card})`, ({ task }) => {
        task.meta.vectors = {
          kind: 'pending',
          runtime: observeRuntime().id,
          suite: file.suite,
          detail: pendingEntry.card,
        };
        expect(suite).toBeUndefined();
        expect(cases.length).toBeGreaterThan(0);
      });
      return;
    }

    // Single cases left to a later card (pending-suites.json `cases`, M1-7d): every listed id must
    // be a case of this file, and each records a pending marker instead of running.
    const pendingIds = new Set<string>(pendingCases.get(file.suite)?.ids ?? []);
    test('every pending case is a case of this file', () => {
      const ids = new Set(cases.map((c) => c.id));
      expect([...pendingIds].filter((id) => !ids.has(id))).toEqual([]);
    });

    for (const testCase of cases) {
      if (pendingIds.has(testCase.id)) {
        const card = pendingCases.get(file.suite)?.card ?? '';
        test(`${testCase.id} (pending: ${card})`, ({ task }) => {
          task.meta.vectors = {
            kind: 'pending-case',
            runtime: observeRuntime().id,
            suite: file.suite,
            caseId: testCase.id,
            detail: card,
          };
          expect(suite, `"${file.suite}" has pending cases but no module`).toBeDefined();
        });
        continue;
      }
      // A memory-hard suite declares a measured per-case timeout (SuiteModule.timeoutMs); this file
      // runs in every project, so the same limit holds in every runtime.
      const options = suite?.timeoutMs === undefined ? {} : { timeout: suite.timeoutMs };
      test(testCase.id, options, async ({ task }) => {
        task.meta.vectors = {
          kind: 'case',
          runtime: observeRuntime().id,
          suite: file.suite,
          caseId: testCase.id,
        };
        if (suite === undefined) throw new Error(`no suite module for "${file.suite}"`);
        // The suite gets only the id and input; the expected values come from the committed vector
        // and are compared here (IR-M0-9-1 F03).
        const computed = await suite.evaluate(
          Object.freeze({ id: testCase.id, input: testCase.input }),
        );
        const problems = compareToVector(testCase.expected, computed);
        expect(problems, testCase.source).toEqual([]);
      });
    }
  });
}
