// The one set of vector tests. The same file runs in every project of vitest.config.ts: Node,
// Chromium, Firefox, WebKit (Playwright) and workerd (Workers pool). Each test records the runtime
// it observed in `task.meta`, and tools/vectors/check.mjs requires a passing result for every
// (runtime, suite, case) triple, so a project that silently runs somewhere else, or not at all,
// fails `pnpm vectors:check`.
import { describe, expect, inject, test } from 'vitest';
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
      readonly kind: 'identity' | 'case';
      readonly runtime: string;
      readonly detail?: string;
      readonly suite?: string;
      readonly caseId?: string;
    };
  }
}

const expectedRuntime = inject('vectorsRuntime');

test('runtime identity', ({ task }) => {
  const observed = observeRuntime();
  task.meta.vectors = { kind: 'identity', runtime: observed.id, detail: observed.detail };
  expect(expectedRuntime, 'the project must provide vectorsRuntime').toBeTypeOf('string');
  expect(observed.id, `observed: ${observed.detail}`).toBe(expectedRuntime);
});

test('at least one vector suite is committed', () => {
  expect(vectorFiles.length).toBeGreaterThan(0);
});

for (const { directory, file } of vectorFiles) {
  describe(`${directory} v${String(file.version)}`, () => {
    const suite = suiteModules.get(file.suite);
    const cases: readonly VectorCase[] = Array.isArray(file.cases) ? file.cases : [];

    test('has a suite module and a matching directory', () => {
      expect(file.suite).toBe(directory);
      expect(suite, `no suite module registered for "${file.suite}"`).toBeDefined();
    });

    // A suite with no cases proves nothing (IR-M0-9-1 F04).
    test('has at least one case', () => {
      expect(cases.length).toBeGreaterThan(0);
    });

    for (const testCase of cases) {
      test(testCase.id, async ({ task }) => {
        task.meta.vectors = {
          kind: 'case',
          runtime: observeRuntime().id,
          suite: file.suite,
          caseId: testCase.id,
        };
        if (suite === undefined) throw new Error(`no suite module for "${file.suite}"`);
        // Expected values come from the committed vector only; the suite returns what it computed.
        const problems = compareToVector(testCase.expected, await suite.evaluate(testCase));
        expect(problems, testCase.source).toEqual([]);
      });
    }
  });
}
