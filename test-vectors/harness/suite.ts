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
}
