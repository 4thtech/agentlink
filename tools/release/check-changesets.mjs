#!/usr/bin/env node
// OPS-CI-2 / D-43: a pull request that changes a published package must carry a changeset.
// Runs `changeset status --since <base>`, which fails when a non-private workspace package changed
// since the merge base and no changeset was added. Docs-only changes and private packages pass.
//
//   node tools/release/check-changesets.mjs --base origin/main
//
// The only exemption is the Changesets "Version packages" pull request itself (it consumes the
// changesets): branch `changeset-release/*`, opened by `github-actions[bot]`, in this repository.
// Environment (from the workflow, never interpolated into a shell): HEAD_REF, PR_AUTHOR, SAME_REPO.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function isVersionPackagesPr({ headRef, author, sameRepo }) {
  return (
    sameRepo === true &&
    author === 'github-actions[bot]' &&
    typeof headRef === 'string' &&
    headRef.startsWith('changeset-release/')
  );
}

export async function checkChangesets({ cwd, base, changesetBin, pr, log = console.log }) {
  if (isVersionPackagesPr(pr ?? {})) {
    log('Changesets "Version packages" pull request: no changeset needed.');
    return { ok: true, skipped: true };
  }
  const result = spawnSync(process.execPath, [changesetBin, 'status', `--since=${base}`], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', CI: 'true' },
  });
  log(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim());
  if (result.status !== 0) {
    log(
      '::error::A published package changed without a changeset (D-43). Run `pnpm changeset` and commit the file.',
    );
    return { ok: false };
  }
  return { ok: true };
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--base');
  const base = i >= 0 ? argv[i + 1] : undefined;
  if (!base || argv.length !== 2 || base.startsWith('-')) {
    throw new Error('usage: check-changesets.mjs --base <git ref>');
  }
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = await checkChangesets({
    cwd: repoRoot,
    base,
    changesetBin: join(repoRoot, 'node_modules', '@changesets', 'cli', 'bin.js'),
    pr: {
      headRef: process.env.HEAD_REF ?? '',
      author: process.env.PR_AUTHOR ?? '',
      sameRepo: process.env.SAME_REPO === 'true',
    },
  });
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.log(`::error::${error?.message ?? String(error)}`);
    process.exit(1);
  });
}
