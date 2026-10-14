// A deliberately leaking exercise: the negative control for the secret-canary check.
// It logs the shapeless canary under a key the logger does not know is sensitive, which is exactly
// the mistake the canary check exists to catch. testing.test.ts asserts it is reported; the PR for
// M0-8 also wired it into canary.test.ts once to show the CI job go red.

import type { CanaryRun } from '../src/testing.js';
import { KEY_ONLY_CANARY } from '../src/testing.js';

export function leakyExercise({ logger }: CanaryRun): void {
  logger.debug('stored the user note', { note: KEY_ONLY_CANARY.value });
}
