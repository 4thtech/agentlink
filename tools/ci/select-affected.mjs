#!/usr/bin/env node
// CHORE-CI-SPEED-2: which workspace packages a pull request must lint, typecheck, build and test.
//
// Input: the changed file names of the pull request (one per line, against its base). Output: either
// `full` (run everything, exactly as on `main`) or a list of packages for `turbo run --filter`.
// The merge queue and pushes never call this script: ci.yml runs the full suite there, so a wrong
// answer here can only delay a failure to the queue, never let it reach `main`.
//
// Rules (docs/process/ci-cd.md, "What runs where"); when unsure, run everything:
//   1. No diff, or an empty one: full.
//   2. Global triggers: full. Any root file that is not `*.md` (root config, lockfile, dotfiles),
//      `.github/`, `tools/`, `test-vectors/`, the shared packages `types`, `crypto` and `core`, and
//      any path that belongs to no workspace package and is not a doc.
//   3. A file inside a workspace package selects that package and every package that depends on
//      it, transitively (dependencies, devDependencies, peer and optional).
//   4. Docs (`docs/`, `docs-site/`, `knowledge/`, `changelog.d/`, `.changeset/*.md`, root `*.md`)
//      select no package by themselves.
//   5. Any changed file also selects every package whose source names a path prefix of it (for
//      example `docs/design/d1/` in the ui token test): the doc-drift tests follow their docs
//      without a hand-kept list. Those packages are added without their dependents.
//   6. `@4thtech-io/tools` is always selected: docs-status, the knowledge links and size, the
//      retired-vocabulary scan and the manifest checks are its `check` and `test`.
//   7. CHORE-CI-SPEED-3: each heavy job (HEAVY_JOBS) runs when the selected set holds one of the
//      packages it tests. The selected set already holds every dependent, so a change below a
//      tested package reaches its job. A full run (rules 1 and 2) runs every job.
//
// Usage: node tools/ci/select-affected.mjs <changed-files.txt>
// Writes test_scope, turbo_filters, needs_playwright and one run_<job> per heavy job to
// $GITHUB_OUTPUT when it is set. ci.yml reads a missing run_<job> as `true`.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS_PACKAGE = '@4thtech-io/tools';

const FULL_PREFIXES = [
  '.github/',
  'tools/',
  'test-vectors/',
  'packages/types/',
  'packages/crypto/',
  'packages/core/',
];

// The same docs set as `detect`'s docs-only rule in ci.yml.
const DOCS = /^(docs\/|docs-site\/|knowledge\/|changelog\.d\/|\.changeset\/[^/]+\.md$|[^/]+\.md$)/;

const NAME = /^@4thtech-io\/[a-z0-9][a-z0-9-]*$/;

// CHORE-CI-SPEED-3: the heavy jobs of ci.yml and the workspace packages whose code each one runs
// (rule 7). `checks` follows the package list itself; `path-guard` and `node-os` run in the merge
// queue and on `main` only. A job is listed with every package its steps build or import outside
// the declared dependencies (the vectors harness imports chain; the e2e builds the invite site).
export const HEAVY_JOBS = Object.freeze({
  vectors: ['@4thtech-io/test-vectors', '@4thtech-io/chain'],
  keychain: ['@4thtech-io/node', '@4thtech-io/agentlink'],
  'relays-docker': ['@4thtech-io/node', '@4thtech-io/transport-nostr'],
  'storage-minio': ['@4thtech-io/storage'],
  'bundle-check': ['@4thtech-io/agentlink'],
  'e2e-deterministic': ['@4thtech-io/e2e', '@4thtech-io/chain', '@4thtech-io/invite'],
});

const allJobs = (run) => Object.fromEntries(Object.keys(HEAVY_JOBS).map((j) => [j, run]));

/**
 * @param {{ files: string[] | null, workspace: Array<{ name: string, dir: string, deps: string[],
 *   refs: string[], playwright: boolean }> }} input
 * @returns {{ scope: 'full', reason: string, jobs: Record<string, boolean> } |
 *   { scope: 'filtered', packages: string[], playwright: boolean, jobs: Record<string, boolean> }}
 */
export function selectAffected({ files, workspace }) {
  const result = selectPackages({ files, workspace });
  if (result.scope === 'full') return { ...result, jobs: allJobs(true) };
  const selected = new Set(result.packages);
  const jobs = Object.fromEntries(
    Object.entries(HEAVY_JOBS).map(([job, pkgs]) => [job, pkgs.some((p) => selected.has(p))]),
  );
  return { ...result, jobs };
}

/** The run_<job> lines for $GITHUB_OUTPUT, in HEAVY_JOBS order. */
export function jobOutputs(result) {
  return Object.keys(HEAVY_JOBS).map(
    (job) =>
      `run_${job.replaceAll('-', '_')}=${result.scope === 'full' || result.jobs[job] === true}`,
  );
}

function selectPackages({ files, workspace }) {
  if (files == null) return { scope: 'full', reason: 'the diff could not be read' };
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return { scope: 'full', reason: 'the diff is empty' };

  const byName = new Map(workspace.map((p) => [p.name, p]));
  const owner = (file) =>
    workspace.find((p) => p.dir !== '.' && (file === p.dir || file.startsWith(`${p.dir}/`)));

  const changed = new Set();
  for (const file of list) {
    if (FULL_PREFIXES.some((p) => file.startsWith(p))) {
      return { scope: 'full', reason: `global trigger: ${file}` };
    }
    if (!file.includes('/') && !file.endsWith('.md')) {
      return { scope: 'full', reason: `root file: ${file}` };
    }
    const pkg = owner(file);
    if (pkg) {
      changed.add(pkg.name);
      continue;
    }
    if (DOCS.test(file)) continue;
    return { scope: 'full', reason: `outside every workspace package: ${file}` };
  }

  // Rule 3: dependents, transitively.
  const selected = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of workspace) {
      if (!selected.has(p.name) && p.deps.some((d) => selected.has(d))) {
        selected.add(p.name);
        grew = true;
      }
    }
  }

  // Rule 5: packages whose sources name a changed path.
  for (const p of workspace) {
    if (p.refs.some((ref) => list.some((file) => file.startsWith(ref)))) selected.add(p.name);
  }

  // Rule 6.
  if (byName.has(TOOLS_PACKAGE)) selected.add(TOOLS_PACKAGE);

  const packages = [...selected].sort();
  return {
    scope: 'filtered',
    packages,
    playwright: packages.some((n) => byName.get(n)?.playwright === true),
  };
}

export function turboFilters(packages) {
  return packages
    .map((name) => {
      if (!NAME.test(name))
        throw new Error(`not a workspace package name: ${JSON.stringify(name)}`);
      return `--filter=${name}`;
    })
    .join(' ');
}

// --- reading the real workspace ---------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.wrangler', 'artifacts']);
const SOURCE = /\.(?:[cm]?[jt]s|tsx)$/;
// A repository path as it appears in a string, a template or a comment: `docs/…`, `../../docs/…`.
const PATH_REF =
  /(?:^|[\s'"`(/])((?:docs|docs-site|knowledge|packages|apps|e2e|tools|test-vectors)\/[A-Za-z0-9_.\-/]*)/g;
const PLAYWRIGHT = /['"](?:playwright|@playwright\/test|@vitest\/browser[^'"]*)['"]/;

function workspaceDirs(root) {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const block = yaml.split(/^packages:\s*$/m)[1] ?? '';
  const globs = [];
  for (const line of block.split('\n')) {
    const m = /^\s+-\s+['"]?([^'"#\s]+)['"]?/.exec(line);
    if (m) globs.push(m[1]);
    else if (/^\S/.test(line)) break;
  }
  const dirs = [];
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const parent = g.slice(0, -2);
      if (!existsSync(join(root, parent))) continue;
      for (const d of readdirSync(join(root, parent)).sort()) {
        if (existsSync(join(root, parent, d, 'package.json'))) dirs.push(`${parent}/${d}`);
      }
    } else if (!/[*?{}[\]!]/.test(g)) {
      if (existsSync(join(root, g, 'package.json'))) dirs.push(g);
    } else {
      throw new Error(`unsupported workspace glob in pnpm-workspace.yaml: ${g}`);
    }
  }
  return dirs;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry) && st.size < 2_000_000) out.push(full);
  }
  return out;
}

export function loadWorkspace(root) {
  const dirs = workspaceDirs(root);
  const manifests = dirs.map((dir) => ({
    dir,
    json: JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')),
  }));
  const names = new Set(manifests.map((m) => m.json.name));
  return manifests.map(({ dir, json }) => {
    const all = {
      ...json.dependencies,
      ...json.devDependencies,
      ...json.peerDependencies,
      ...json.optionalDependencies,
    };
    const refs = new Set();
    let playwright = false;
    for (const file of walk(join(root, dir), [])) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(PATH_REF)) refs.add(m[1]);
      if (PLAYWRIGHT.test(text)) playwright = true;
    }
    // A package's own paths are covered by rule 3.
    const own = `${dir}/`;
    return {
      name: json.name,
      dir,
      deps: Object.keys(all)
        .filter((d) => names.has(d) && d !== json.name)
        .sort(),
      // A bare top-level directory (`packages/`, `docs/`) or a `docs/.`-style fragment names no
      // particular file; keeping it would select the package for every change under that root.
      refs: [...refs]
        .filter((r) => {
          const rest = r.slice(r.indexOf('/') + 1);
          return !r.startsWith(own) && rest.length >= 2 && !rest.startsWith('.');
        })
        .sort(),
      playwright,
    };
  });
}

// --- CLI ---------------------------------------------------------------------------------------

function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let files = null;
  if (argv[0] && existsSync(argv[0])) files = readFileSync(argv[0], 'utf8').split('\n');
  const result = selectAffected({ files, workspace: loadWorkspace(root) });
  const out = {
    test_scope: result.scope,
    turbo_filters: result.scope === 'filtered' ? turboFilters(result.packages) : '',
    needs_playwright: result.scope === 'full' ? 'true' : String(result.playwright),
  };
  if (result.scope === 'full') console.log(`Full suite: ${result.reason}`);
  else console.log(`Affected packages (${result.packages.length}): ${result.packages.join(' ')}`);
  const jobs = jobOutputs(result);
  console.log(`Heavy jobs: ${jobs.join(' ')}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(out)
        .map(([k, v]) => `${k}=${v}\n`)
        .concat(jobs.map((line) => `${line}\n`))
        .join(''),
    );
  }
}

const invoked = process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '';
if (invoked) main(process.argv.slice(2));
