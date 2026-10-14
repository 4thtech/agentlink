import type { VectorCase } from './registry';

/** One value computed by the code under test, named by its field in the case's `expected`. */
export interface Comparison {
  readonly field: string;
  readonly actual: string;
}

/**
 * A suite module runs one vector case through the code under test and returns what it computed,
 * one entry per field of the case's `expected`. It never supplies expected values and never decides
 * pass or fail: harness/compare.ts reads `expected` from the committed vector and judges every
 * suite the same way. It must use only APIs that exist in Node, browsers and workerd (no Node
 * built-ins).
 */
export interface SuiteModule {
  evaluate(testCase: VectorCase): Promise<readonly Comparison[]>;
}
