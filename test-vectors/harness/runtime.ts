// Runtime identity (M0-9 acceptance: "each runtime reports its identity, so a silent fallback to
// Node fails the run"). The answer comes from what the JavaScript engine itself exposes, never from
// the test configuration: the configuration only says which identity a project expects
// (`inject('vectorsRuntime')`), and vectors.test.ts fails when the two differ.

export type RuntimeId = 'node' | 'chromium' | 'firefox' | 'webkit' | 'workerd';

export interface RuntimeIdentity {
  /** The detected runtime, or 'unknown' when no rule matches. */
  readonly id: RuntimeId | 'unknown';
  /** Human-readable evidence for the report: the user agent and, in Node, the Node version. */
  readonly detail: string;
}

export function observeRuntime(): RuntimeIdentity {
  // Tests first (S2): implemented in the next commit.
  throw new Error('observeRuntime: not implemented yet');
}
