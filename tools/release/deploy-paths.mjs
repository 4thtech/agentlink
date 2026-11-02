#!/usr/bin/env node
// OPS-UNSTICK-A: which commits on main change a deploy workflow's service.
//
// A service's inputs are its workflow's `on.push.paths` (tools/release/deploy-path-triggers.test.mjs
// keeps every file a run reads in that list). A newer commit on main that touches none of them builds
// the same bundle for this service, so a run is "behind" only when a NEWER commit changes one of
// those paths. Used by:
//   - deploy-production (`head-check`): skip production only when a newer commit on main changes
//     this service; otherwise deploy (this run's bundle is what main's head builds for it);
//   - catch-up-deploy.mjs: which live runs already cover main's head for this service.
//
//   node tools/release/deploy-paths.mjs head-check --workflow deploy-drop.yml
//
// Needs the full history of main (actions/checkout with `fetch-depth: 0`); main's head is read from
// refs/remotes/origin/main as the checkout fetched it. A deploy job holds its concurrency group
// before it checks out, so a newer run's production job always sees this run's commit and the
// reverse. Environment: GITHUB_SHA, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY (both optional for tests).
// Fails closed: an unreadable head, a commit that is not on main, or a missing paths filter exits 1.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SHA_RE = /^[0-9a-f]{40}$/;
export const WORKFLOW_FILE = /^[A-Za-z0-9_-]+\.ya?ml$/;

/** The `on.push.paths` patterns of a workflow, or null when it has none. */
export function pushPaths(source) {
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

/** GitHub filter patterns as git glob pathspecs (`**`, `*`, `?` mean the same in both). */
export function pathspecs(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('the workflow has no on.push.paths filter');
  }
  return patterns.map((p) => {
    if (typeof p !== 'string' || p === '' || p.startsWith('!')) {
      throw new Error(`unsupported paths pattern ${JSON.stringify(p)}`);
    }
    return `:(glob)${p}`;
  });
}

/** The pathspecs of a deploy workflow in the checkout at `cwd`. */
export function workflowSpecs(workflow, cwd = process.cwd()) {
  if (!WORKFLOW_FILE.test(workflow ?? '')) throw new Error('bad workflow file name');
  return pathspecs(pushPaths(readFileSync(join(cwd, '.github/workflows', workflow), 'utf8')));
}

/** Read-only git queries on the checkout at `cwd`. */
export function gitRunner({ cwd = process.cwd(), exec = execFileSync } = {}) {
  const git = (args) =>
    exec('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const exitOf = (args) => {
    try {
      git(args);
      return 0;
    } catch (error) {
      return typeof error?.status === 'number' ? error.status : -1;
    }
  };
  return {
    /** main's head as the checkout fetched it. */
    head: () => git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']),
    /** Commits after `from` up to `to` that change the paths, newest first. */
    newerTouching: (from, to, specs) => {
      const out = git(['rev-list', `${from}..${to}`, '--', ...specs]);
      return out === '' ? [] : out.split('\n');
    },
    /** The newest commit up to `ref` that changes the paths, or null. */
    lastTouch: (ref, specs) => git(['rev-list', '-n', '1', ref, '--', ...specs]) || null,
    /** true / false whether `sha` contains `ancestor`; null when either is unknown here. */
    contains: (sha, ancestor) => {
      if (!SHA_RE.test(sha ?? '') || !SHA_RE.test(ancestor ?? '')) return null;
      const code = exitOf(['merge-base', '--is-ancestor', ancestor, sha]);
      if (code === 0) return true;
      if (code === 1) return false;
      return null;
    },
  };
}

/**
 * Is this run's commit still what main's head builds for the service?
 * Returns { current, head, newer } (newer: commits after `sha` that change the service).
 */
export function headCheck({ git, sha, specs }) {
  if (!SHA_RE.test(sha ?? '')) throw new Error('GITHUB_SHA is malformed');
  let head;
  try {
    head = git.head();
  } catch {
    head = '';
  }
  if (typeof head !== 'string' || !SHA_RE.test(head)) {
    throw new Error('could not read the head of main');
  }
  if (head === sha) return { current: true, head, newer: [] };
  if (git.contains(head, sha) !== true) {
    throw new Error(`${sha} is not on main (head ${head})`);
  }
  const newer = git.newerTouching(sha, head, specs);
  return { current: newer.length === 0, head, newer };
}

function writer(file) {
  if (!file) return () => {};
  return (line) => appendFileSync(file, `${line}\n`);
}

/** The command line. Returns the exit code. */
export function run({ argv, env, cwd = process.cwd(), git, log = console.log }) {
  try {
    if (argv.length !== 3 || argv[0] !== 'head-check' || argv[1] !== '--workflow') {
      throw new Error('usage: deploy-paths.mjs head-check --workflow <workflow file name>');
    }
    const workflow = argv[2];
    const specs = workflowSpecs(workflow, cwd);
    const sha = env.GITHUB_SHA;
    const result = headCheck({ git: git ?? gitRunner({ cwd }), sha, specs });
    const output = writer(env.GITHUB_OUTPUT);
    const summary = writer(env.GITHUB_STEP_SUMMARY);
    output(`current=${result.current}`);
    if (result.current && result.head !== sha) {
      log(
        `::notice::main moved on to ${result.head}, but no newer commit changes this service's paths; this run deploys ${sha}, which is what main's head builds for it.`,
      );
      summary(
        `**Deploys main's state:** main moved on to \`${result.head}\`, but no newer commit changes this service, so this run's bundle (\`${sha}\`) is what main's head builds; it deploys.`,
      );
    } else if (!result.current) {
      const newest = result.newer[0];
      log(
        `::warning::${result.newer.length} newer commit(s) on main change this service (newest ${newest}); this run did not change production. The run for ${newest}, or the catch-up job, deploys it.`,
      );
      summary(
        `**Superseded by \`${newest}\`:** this run did not change production: ${result.newer.length} newer commit(s) on main change this service. See the catch-up job for the run deploying there.`,
      );
    }
    return 0;
  } catch (error) {
    log(`::error::Deploy head check failed: ${error?.message ?? String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run({ argv: process.argv.slice(2), env: process.env });
}
