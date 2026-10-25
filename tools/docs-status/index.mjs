// CLI entry: `node docs-status/index.mjs [--check] [root]`. Without --check it regenerates the
// status blocks in README.md, the docs-site status page and (when present) the knowledge base from
// docs/status.yaml. With --check (wired into the tools `check` script, so `pnpm lint` and
// therefore `ci-gate` run it) it changes nothing and exits 1 when any generated block has drifted.
// `--counts` prints the backlog card counts on demand (they are not committed anywhere).

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backlogCountsText, run } from './status.mjs';

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const counts = args.includes('--counts');
  const rest = args.filter((arg) => arg !== '--check' && arg !== '--counts');
  const root = rest[0]
    ? resolve(rest[0])
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (counts) {
    const text = backlogCountsText(root);
    if (text === null) {
      console.error('docs-status: docs/process/backlog.md is missing');
      process.exit(1);
    }
    console.log(text);
    return;
  }
  const { problems, changed, skipped } = run({ root, check });
  for (const note of skipped) console.log(`docs-status: ${note}`);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`docs-status: ${problem}`);
    console.error(`docs-status: ${problems.length} problem(s).`);
    process.exit(1);
  }
  if (check) {
    console.log('docs-status: README, docs-site and knowledge status match docs/status.yaml.');
  } else {
    console.log(
      changed.length > 0
        ? `docs-status: updated ${changed.join(', ')}.`
        : 'docs-status: everything already matches docs/status.yaml.',
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
