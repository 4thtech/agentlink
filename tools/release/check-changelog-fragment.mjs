#!/usr/bin/env node
// OPS-REL-4 / D-43 (docs/process/versioning.md §5): a pull request that changes user-visible
// behaviour, a spec or the process must add a changelog fragment (`changelog.d/<card-id>.md`, format in
// changelog.d/README.md) or, during the transition, a line under `## [Unreleased]` in CHANGELOG.md.
// Editing CHANGELOG.md [Unreleased] directly only warns (fragments avoid merge-queue conflicts).
//
//   node tools/release/check-changelog-fragment.mjs --base origin/main
//
// "Needs an entry" paths: CLI and library source (not tests), the foundation specs, the process
// docs (not the backlog), AGENTS.md. A refactor or other change that needs no entry adds a fragment
// with `section: none` and a one-line reason, which records the decision and is dropped at the roll.
// The Changesets "Version packages" pull request is exempt. Environment (from the workflow, never
// interpolated into a shell): HEAD_REF, PR_AUTHOR, SAME_REPO.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isVersionPackagesPr } from './check-changesets.mjs';

const NEEDS_ENTRY = [
  /^apps\/[^/]+\/src\/.+/,
  /^packages\/[^/]+\/src\/.+/,
  /^docs\/foundation\/.+/,
  /^docs\/process\/(?!backlog\.md$).+/,
  /^AGENTS\.md$/,
];
const TEST_FILE = /(\.test\.|\.spec\.|\/__tests__\/|\/test\/)/;
const FRAGMENT = /^changelog\.d\/(?!README\.md$)[^/]+\.md$/;

export function evaluateChangelog({ changed, unreleasedAdded, pr }) {
  if (isVersionPackagesPr(pr ?? {})) return { ok: true, errors: [], warnings: [] };
  const live = changed.filter((c) => c.status !== 'D');
  const hasFragment = live.some((c) => FRAGMENT.test(c.path));
  const editsChangelog = live.some((c) => c.path === 'CHANGELOG.md');
  const needs = live.some(
    (c) => NEEDS_ENTRY.some((re) => re.test(c.path)) && !TEST_FILE.test(c.path),
  );
  const errors = [];
  const warnings = [];
  if (needs && !hasFragment && unreleasedAdded === 0) {
    errors.push(
      'This PR changes user-visible behaviour, a spec or the process but adds no changelog entry: add a fragment changelog.d/<card-id>.md (see changelog.d/README.md; "section: none" with a reason if no entry is needed).',
    );
  }
  if (editsChangelog && unreleasedAdded > 0) {
    warnings.push(
      'CHANGELOG.md [Unreleased] was edited directly: prefer a fragment in changelog.d/ (see changelog.d/README.md) so parallel PRs do not conflict.',
    );
  }
  return { ok: errors.length === 0, errors, warnings };
}

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};

// Count added non-blank, non-heading CHANGELOG.md lines that sit above the first released section.
function countUnreleasedAdded(cwd, base) {
  const head = git(cwd, ['show', 'HEAD:CHANGELOG.md']).split('\n');
  const released = head.findIndex((l) => /^## \[\d/.test(l));
  const limit = released === -1 ? head.length : released; // 0-based index of the first released heading
  const diff = git(cwd, ['diff', '-U0', `${base}...HEAD`, '--', 'CHANGELOG.md']);
  let n = 0;
  let line = 0;
  for (const l of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
    } else if (l.startsWith('+') && !l.startsWith('+++')) {
      if (line - 1 < limit && l.slice(1).trim() !== '' && !/^#{1,6}\s/.test(l.slice(1))) n += 1;
      line += 1;
    }
  }
  return n;
}

export async function checkChangelogFragment({ cwd, base, pr, log = console.log }) {
  const out = git(cwd, ['diff', '--name-status', '--no-renames', `${base}...HEAD`]);
  const changed = out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
  const unreleasedAdded = changed.some((c) => c.path === 'CHANGELOG.md' && c.status !== 'D')
    ? countUnreleasedAdded(cwd, base)
    : 0;
  const result = evaluateChangelog({ changed, unreleasedAdded, pr });
  for (const w of result.warnings) log(`::warning file=CHANGELOG.md::${w}`);
  for (const e of result.errors) log(`::error::${e}`);
  if (result.ok && result.errors.length === 0) log('Changelog entry check passed.');
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--base');
  const base = i >= 0 ? argv[i + 1] : undefined;
  if (!base || argv.length !== 2 || base.startsWith('-')) {
    throw new Error('usage: check-changelog-fragment.mjs --base <git ref>');
  }
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = await checkChangelogFragment({
    cwd: repoRoot,
    base,
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
