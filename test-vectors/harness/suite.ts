/** One value computed by the code under test, named by its field in the case's `expected`. */
export interface Comparison {
  readonly field: string;
  readonly actual: string;
}

/** What a suite sees of a case: its id and input, never its expected values. */
export interface SuiteInput {
  readonly id: string;
  readonly input: unknown;
}

/**
 * A suite module runs one vector case through the code under test and returns what it computed,
 * one entry per field of the case's `expected`. It never sees or supplies expected values: it gets
 * only the case's id and input, and harness/compare.ts reads `expected` from the committed vector
 * and judges every suite the same way. It must not import vector files or the registry (enforced by
 * eslint.config.mjs) and must use only APIs that exist in Node, browsers and workerd.
 */
export interface SuiteModule {
  evaluate(testCase: SuiteInput): Promise<readonly Comparison[]>;
  /**
   * Per-case test timeout in ms, for a suite whose cases are memory-hard and run longer than the
   * Vitest default on a loaded CI runner. Measured, never a guess: the suite's comment cites the
   * local and CI timings (test timeout policy, `docs/process/repo-reference.md`, M0-10e). Applied
   * by harness/vectors.test.ts to each case in every runtime the suite runs in. Omitted means the
   * project default.
   */
  readonly timeoutMs?: number;
}
