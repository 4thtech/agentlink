import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandLines, runScripts } from './workflow-run-steps.mjs';

// CHORE-DEPLOY-PATH-TRIGGERS: a workflow with an `on.push.paths` filter must start when any
// repo-local file it executes or reads at run time changes. PR #335 changed only
// .github/scripts/worker-logging-settings.jq, which both deploy workflows run in their logging
// read-back, and neither deploy started. This reads every workflow's push `paths` filter and the
// repo-local files its `run:` steps and local `uses: ./...` actions name, and fails on any that
// the filter does not cover.

const root = resolve(import.meta.dirname, '../..');
const workflowsDir = join(root, '.github/workflows');

/** The `on.push.paths` patterns of a workflow, or null when it has none. */
function pushPaths(source) {
  const on = /\non:\n((?: {2}.*\n|\s*\n)*)/.exec(`\n${source}`);
  if (!on) return null;
  const push = /(?:^|\n) {2}push:\n((?: {4}.*\n|\s*\n)*)/.exec(on[1]);
  if (!push) return null;
  const paths = /(?:^|\n) {4}paths:\n((?: {6}(?:- |#).*\n)*)/.exec(push[1]);
  if (!paths) return null;
  return [...paths[1].matchAll(/ {6}- (?:"([^"]*)"|'([^']*)'|(\S+))/g)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );
}

/** A GitHub filter pattern as a RegExp: `**` any characters, `*` any but `/`, `?` one character. */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i += 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True when the (positive-only) patterns cover a repo-relative file path. */
function covered(patterns, file) {
  if (patterns.some((p) => p.startsWith('!'))) {
    throw new Error('negated paths patterns are not supported by this check');
  }
  return patterns.some((p) => globToRegExp(p).test(file));
}

const PATH_TOKEN = /(?:^|[\s"'=(:])(?:\$\{?GITHUB_WORKSPACE\}?\/|\.\/)?(\.?[\w-]+(?:\/[\w.-]+)+)/g;

/**
 * The repo-local files a workflow executes or reads: paths named in its `run:` commands (bare,
 * `./`-prefixed or under `$GITHUB_WORKSPACE`) that exist in the repository, and every file of a
 * local action (`uses: ./...`). Markdown files are only ever named in messages (runbook pointers),
 * never run, so they are left out.
 */
function referencedFiles(source, repoRoot = root) {
  const found = new Set();
  const add = (path) => {
    const full = resolve(repoRoot, path);
    if (!full.startsWith(`${repoRoot}/`) || full.endsWith('.md') || !existsSync(full)) return;
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full, { recursive: true })) {
        const child = join(full, String(entry));
        if (statSync(child).isFile()) found.add(relative(repoRoot, child));
      }
    } else found.add(relative(repoRoot, full));
  };
  for (const { script } of runScripts(source)) {
    for (const line of commandLines(script)) {
      for (const m of line.matchAll(PATH_TOKEN)) add(m[1]);
    }
  }
  for (const m of source.matchAll(/uses: \.\/([^\s#]+)/g)) add(m[1]);
  return [...found].sort();
}

const workflows = readdirSync(workflowsDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ name: f, source: readFileSync(join(workflowsDir, f), 'utf8') }))
  .map((w) => ({ ...w, paths: pushPaths(w.source) }))
  .filter((w) => w.paths !== null);

describe('the helpers', () => {
  it('match GitHub filter globs', () => {
    expect(covered(['apps/drop/**'], 'apps/drop/src/index.ts')).toBe(true);
    expect(covered(['apps/drop/**'], 'apps/dropx/a.ts')).toBe(false);
    expect(covered(['.github/scripts/*.jq'], '.github/scripts/a.jq')).toBe(true);
    expect(covered(['.github/scripts/*.jq'], '.github/scripts/x/a.jq')).toBe(false);
    expect(covered(['package.json'], 'apps/package.json')).toBe(false);
  });

  it('read the push paths and the repo-local scripts a workflow runs', () => {
    const source = [
      'on:',
      '  push:',
      '    branches: [main]',
      '    paths:',
      '      - "apps/drop/**"',
      '      # a comment',
      "      - '.github/workflows/x.yml'",
      '  workflow_dispatch:',
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: ./.github/actions/setup-node-pnpm',
      '      - run: node tools/release/wait-for-ci.mjs --x',
      '      - run: |',
      '          program="$GITHUB_WORKSPACE/.github/scripts/worker-logging-settings.jq"',
      '          curl https://api.example/workers/scripts/x "$RUNNER_TEMP/b/index.js"',
      '',
    ].join('\n');
    expect(pushPaths(source)).toEqual(['apps/drop/**', '.github/workflows/x.yml']);
    const files = referencedFiles(source);
    expect(files).toContain('tools/release/wait-for-ci.mjs');
    expect(files).toContain('.github/scripts/worker-logging-settings.jq');
    expect(files).toContain('.github/actions/setup-node-pnpm/action.yml');
    expect(files.every((f) => existsSync(join(root, f)))).toBe(true);
  });
});

describe('push paths filters cover every repo-local file the workflow runs', () => {
  it('finds the deploy workflows', () => {
    expect(workflows.map((w) => w.name)).toEqual(
      expect.arrayContaining(['deploy-drop.yml', 'deploy-invite.yml', 'deploy-submitter.yml']),
    );
  });

  for (const { name, source, paths } of workflows) {
    it(`${name}: its own file and every script it runs start it`, () => {
      expect(paths).toContain(`.github/workflows/${name}`);
      const files = referencedFiles(source);
      if (name.startsWith('deploy-')) {
        // The two scripts PR #335 showed were missed: the extractor must keep finding them.
        expect(files).toContain('.github/scripts/worker-logging-settings.jq');
        expect(files).toContain('tools/release/wait-for-ci.mjs');
      }
      expect(files.filter((f) => !covered(paths, f))).toEqual([]);
    });
  }
});
