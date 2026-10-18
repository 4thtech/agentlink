// CLI: `node tools/sync-pin-check/index.mjs` from a full-history checkout. Fetches origin/sync
// (a missing branch passes with a notice), then runs the pin check against origin/main.
// Wired into .github/workflows/security.yml (job `sync-pin`); see docs/process/ci-cd.md.

import { execFileSync } from 'node:child_process';
import { readStubFromRef, runCheck } from './check.mjs';

const cwd = process.cwd();

try {
  execFileSync(
    'git',
    ['fetch', '--no-tags', 'origin', '+refs/heads/sync:refs/remotes/origin/sync'],
    { cwd, stdio: 'ignore' },
  );
} catch {
  // Branch missing (or unreachable): readStubFromRef then finds nothing and the check passes with a notice.
}

const result = runCheck({ cwd, mainRef: 'origin/main', readStub: () => readStubFromRef(cwd) });
if (result.notice) console.log(`::notice::${result.notice}`);
if (!result.ok) {
  console.error(`::error::${result.message}`);
  process.exit(1);
}
console.log(`sync-pin-check: ${result.message}`);
