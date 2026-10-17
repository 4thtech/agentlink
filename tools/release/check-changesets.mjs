#!/usr/bin/env node
// OPS-CI-2 / D-43: a pull request that changes a published package must carry a changeset.
// Runs `changeset status --since <base>`, which fails when a versioned workspace package changed
// since the merge base and no changeset was added. Versioned: the published `@4thtech-io/agentlink` and
// the private `@agentlink/*` libraries bundled into it (`.changeset/config.json`
// `privatePackages.version: true`, OPS-REL-1). Docs-only changes pass.
//
//   node tools/release/check-changesets.mjs --base origin/main
//
// The only exemption is the Changesets "Version packages" pull request itself (it consumes the
// changesets): branch `changeset-release/*`, opened by `github-actions[bot]`, in this repository.
// Environment (from the workflow, never interpolated into a shell): HEAD_REF, PR_AUTHOR, SAME_REPO.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

// OPS-CI-3: private tooling packages (top-level directories whose package.json is private) are
// versioned since OPS-REL-1, but a change that touches only them needs no changeset. A file in any
// other workspace package, published or private, keeps the requirement.
export const TOOLING_DIRS = ['tools', 'e2e'];

function isPrivatePackageDir(cwd, dir) {
  try {
    return JSON.parse(readFileSync(join(cwd, dir, 'package.json'), 'utf8')).private === true;
  } catch {
    return false;
  }
}

/** True when every changed file is in a private tooling package or in no workspace package. */
export function onlyToolingChanged(cwd, files) {
  if (files.length === 0) return false;
  let tooling = false;
  for (const file of files) {
    const parts = file.split('/');
    if (TOOLING_DIRS.includes(parts[0]) && parts.length > 1 && isPrivatePackageDir(cwd, parts[0])) {
      tooling = true;
      continue;
    }
    // Walk up to the nearest ancestor package.json below the repository root.
    for (let n = parts.length - 1; n >= 1; n--) {
      if (existsSync(join(cwd, ...parts.slice(0, n), 'package.json'))) return false;
    }
  }
  return tooling;
}

function changedFiles(cwd, base) {
  const result = spawnSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').filter(Boolean);
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
    if (onlyToolingChanged(cwd, changedFiles(cwd, base))) {
      log('Only private tooling packages (tools/, e2e/) changed: no changeset needed (OPS-CI-3).');
      return { ok: true, tooling: true };
    }
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
