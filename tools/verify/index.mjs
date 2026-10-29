#!/usr/bin/env node
// W4-VERIFY: `pnpm verify`, the local gate. Runs what CI's `checks` job runs, for the packages your
// change affects (tools/ci/select-affected.mjs, same rules), in one pass, and stops at the first red
// step. Ends with a short summary to paste into the PR.
//
// Steps: one turbo call (build typecheck lint check test + the affected filters), prettier --check on
// the changed files, deps-check, and the journey e2e when e2e is selected.
// Diff base: origin/wave-4 while the branch sits on top of it, else origin/main; `--base <ref>` overrides.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspace } from '../ci/select-affected.mjs';
import { buildPlan, parseChanged, pickBase, summarize } from './plan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

function chooseBase() {
  // `pnpm verify --base <ref>` overrides the choice (for example a stacked branch).
  const i = process.argv.indexOf('--base');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const has = (ref) => git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).ok;
  const hasWave4 = has('origin/wave-4');
  let wave4Closer;
  if (hasWave4 && has('origin/main')) {
    const w = git('merge-base', 'HEAD', 'origin/wave-4').out.trim();
    const m = git('merge-base', 'HEAD', 'origin/main').out.trim();
    // wave-4's merge base is at or past main's: the branch is built on wave-4.
    wave4Closer = Boolean(w) && (w === m || git('merge-base', '--is-ancestor', m, w).ok);
  } else {
    wave4Closer = hasWave4;
  }
  return pickBase({ hasWave4, wave4Closer });
}

function changedFiles(base) {
  const mb = git('merge-base', 'HEAD', base);
  if (!mb.ok) return null;
  const diff = git('diff', '--name-only', '--no-renames', mb.out.trim());
  const untracked = git('ls-files', '--others', '--exclude-standard');
  if (!diff.ok) return null;
  return parseChanged(diff.out, untracked.out);
}

// The pnpm that started us (`pnpm verify` sets npm_execpath; pnpm 12 ships a native binary, older
// ones a script), else `pnpm` on PATH.
function pnpmCommand() {
  const exec = process.env.npm_execpath;
  if (!exec || !/^pnpm/.test(basename(exec))) return ['pnpm', []];
  return /\.[cm]?js$/.test(exec) ? [process.execPath, [exec]] : [exec, []];
}

function run(step) {
  const [pnpm, pnpmArgs] = pnpmCommand();
  const [cmd, args] =
    step.cmd === 'node'
      ? [process.execPath, step.args]
      : [pnpm, [...pnpmArgs, ...(step.cmd === 'turbo' ? ['exec', 'turbo'] : []), ...step.args]];
  console.log(`\n== ${step.label}`);
  const t = Date.now();
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...step.env },
  });
  if (r.error) console.error(`could not start ${cmd}: ${r.error.message}`);
  return { id: step.id, label: step.label, ok: r.status === 0, ms: Date.now() - t };
}

function main() {
  const base = chooseBase();
  const files = changedFiles(base) ?? [];
  if (files.length === 0) console.log(`No diff against ${base}: running the full suite.`);
  const plan = buildPlan({
    files,
    workspace: loadWorkspace(root),
    allBrowsers: process.argv.join(' ').includes('--browsers all'),
    journey: existsSync(join(root, 'e2e/test/journey')),
    wave3: existsSync(join(root, 'e2e/test/local-app-wave3.test.ts')),
    exists: (f) => existsSync(join(root, f)),
  });
  const results = [];
  const skipped = [];
  for (const step of plan.steps) {
    if (results.some((r) => !r.ok)) skipped.push(step.id);
    else results.push(run(step));
  }
  console.log(`\n${'-'.repeat(60)}`);
  console.log(
    summarize({ base, files, scope: plan.scope, packages: plan.packages, results, skipped }),
  );
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main();
