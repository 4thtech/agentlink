// OPS-UNSTICK-A (IR F3): a tiny vitest reporter for tools/ci/quarantine.mjs. Vitest's JSON report
// does not list unhandled errors, so a quarantined flake and an unhandled error in the same run
// would look like "only the quarantined test failed". This records the run's unhandled error count
// and end reason in `<vitest root>/.vitest-run.json`, or in $VITEST_RUN_RECORD when set.
// It reads nothing but the counts; it writes no test content or error text.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default class VitestRunReporter {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.root = process.cwd();
  }

  onInit(ctx) {
    if (typeof ctx?.config?.root === 'string') this.root = ctx.config.root;
  }

  onTestRunEnd(_testModules, unhandledErrors, reason) {
    const file = this.env.VITEST_RUN_RECORD || join(this.root, '.vitest-run.json');
    const count = Array.isArray(unhandledErrors) ? unhandledErrors.length : 0;
    writeFileSync(file, JSON.stringify({ unhandledErrors: count, reason: String(reason ?? '') }));
  }
}
