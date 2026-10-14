import type { VectorCase } from './registry';

/** One value computed by the code under test, next to the committed expected value. */
export interface Comparison {
  readonly field: string;
  readonly actual: string;
  readonly expected: string;
}

/**
 * A suite module runs one vector case through the code under test and returns what it computed.
 * It must not decide pass or fail itself: vectors.test.ts compares, so every suite is judged the
 * same way. It must use only APIs that exist in Node, browsers and workerd (no Node built-ins).
 */
export interface SuiteModule {
  evaluate(testCase: VectorCase): Promise<readonly Comparison[]>;
}
