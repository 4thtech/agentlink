// CLI entry: `node deps-check/index.mjs [root]` (wired into the tools `check` script, so `pnpm lint`
// and therefore `ci-gate` run it). Exits 1 with one line per problem.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './check.mjs';

function main() {
  const root = process.argv[2]
    ? resolve(process.argv[2])
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { problems, packages, files } = runChecks(root, { cache: true });
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(
      `deps-check: ${problems.length} boundary problem(s) in ${packages} package(s), ${files} source file(s).`,
    );
    process.exit(1);
  }
  // Sanity floor (policy.test.mjs asserts it too): an empty or misdetected repository must not pass.
  if (packages <= 10) {
    console.error(`deps-check: only ${packages} package(s) found; expected more than 10.`);
    process.exit(1);
  }
  console.log(
    `deps-check: ${packages} packages, ${files} source files OK (layering, primitive libraries, runtime-dependency allowlist, no cycles).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
