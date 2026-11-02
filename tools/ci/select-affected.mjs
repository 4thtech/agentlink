#!/usr/bin/env node
// CHORE-CI-SPEED-2: which workspace packages a pull request must lint, typecheck, build and test.
//
// Input: the changed file names of the pull request (one per line, against its base). Output: either
// `full` (run everything, exactly as on `main`) or a list of packages for `turbo run --filter`.
// OPS-FAST-LANE-1 (owner decision 54, 2026-11-01): CI has two lanes. The fast lane (a pull request,
// a push to a feature branch, a merge group while the queue still exists) always goes through this
// selector (`fastLane` below); the heavy lane (a push to `main` or a release branch, HEAVY_REFS) runs
// everything and never reaches it, so a wrong answer here can only delay a failure to the push to
// `main`, whose run gates the release.
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
//   7. CHORE-CI-SPEED-3: each package job (PACKAGE_JOBS, short Linux jobs) runs when the selected
//      set holds one of the packages it tests. The selected set already holds every dependent, so a
//      change below a tested package reaches its job. A full run (rules 1 and 2) runs every one.
//   8. OPS-FAST-LANE-1: each heavy-lane job (HEAVY_LANE: the macOS and Windows legs, windows-smoke,
//      the full e2e scenario) runs in the fast lane only when a changed file is in its own area (the
//      explicit path lists below), whatever the package selection says. An unreadable or empty diff
//      runs every one; the heavy lane on `main` runs them all regardless.
//
// Usage: node tools/ci/select-affected.mjs <changed-files.txt>
// Writes test_scope, turbo_filters, needs_playwright and one run_<job> per package job and per
// heavy-lane job to $GITHUB_OUTPUT when it is set. ci.yml reads a missing run_<job> as `true`.
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
const DOCS =
  /^(docs\/|docs-site\/|knowledge\/|changelog\.d\/|\.changeset\/[^/]+\.md$|[^/]+\.md$|llms\.txt$|brand\/.+\.(?:png|jpe?g|gif|svg|webp)$)/;

// OPS-FAST-LANE-1: a push to one of these refs is the heavy lane (everything runs; release.yml
// requires that run's gate). Every other push, every pull request and every merge group is the
// fast lane.
export const HEAVY_REFS = Object.freeze(['refs/heads/main', 'refs/heads/wave-4']);

/**
 * CHORE-CI-DOCS-FASTLANE and OPS-FAST-LANE-1: what a diff may skip. `codeChanged` false = no job
 * but `checks` (the docs-only rule); `selector` true = the fast lane (affected packages, package
 * jobs by package, heavy-lane jobs by area). Every unknown (no file list, an empty diff, an event we
 * do not know) and every push to a HEAVY_REFS branch is the full suite. The merge queue, while it
 * still exists, is a fast lane like the pull request (owner decision 54 item 2: no merge queue).
 *
 * @param {{ event: string, ref?: string, files: string[] | null }} input
 * @returns {{ codeChanged: boolean, selector: boolean }}
 */
export function fastLane({ event, ref = '', files }) {
  const full = { codeChanged: true, selector: false };
  const known =
    event === 'pull_request' ||
    event === 'merge_group' ||
    (event === 'push' && !HEAVY_REFS.includes(ref));
  if (!known || files == null) return full;
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return full;
  return { codeChanged: !list.every((f) => DOCS.test(f)), selector: true };
}

// OPS-DOCS-FASTLANE (owner decision, 2026-11-02): a diff that holds only documentation runs the quick
// `docs-checks` job instead of install, build and the package suites. Narrower than DOCS on purpose;
// when unsure it is not docs-only. Only prose and images: Markdown and common image files under the
// doc trees, plus the root README.md, CHANGELOG.md and llms.txt. Excluded on purpose (they stay in
// the normal path): packages/, apps/, tools/, .github/ (even its *.md), e2e/, test-vectors/, package
// manifests and lockfiles, AGENTS.md, CLAUDE.md, .claude/, docs/status.yaml (the status generator and
// its tests, review-gate and release tooling read it), `.changeset/` (it decides versions), and any
// path a workspace package's source names (`coupledRefs`: a package test that reads a doc, such as the
// guide pages in apps/cli tests or docs/design/d1 in the ui tests). packages/*/README.md is excluded
// by the first rule: a package publishes its README.
const IMAGE = '(?:png|jpe?g|gif|svg|webp)';
const DOCS_ONLY = [
  new RegExp(`^docs/.+\\.(?:md|${IMAGE})$`),
  new RegExp(`^docs-site/.+\\.(?:md|${IMAGE})$`),
  /^knowledge\/.+\.md$/,
  /^changelog\.d\/.+\.md$/,
  new RegExp(`^brand/.+\\.${IMAGE}$`),
  /^(?:README|CHANGELOG)\.md$/,
  /^llms\.txt$/,
];

/**
 * OPS-DOCS-FASTLANE: is every changed file documentation, in the fast lane, and not read by any
 * package's code or tests? Unknown or empty diffs, and the heavy lane, are never docs-only.
 *
 * @param {{ event: string, ref?: string, files: string[] | null, coupledRefs?: string[] }} input
 * @returns {boolean}
 */
export function docsOnly({ event, ref = '', files, coupledRefs = [] }) {
  if (!fastLane({ event, ref, files }).selector || files == null) return false;
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return false;
  return list.every(
    (f) =>
      !f.split('/').includes('..') &&
      DOCS_ONLY.some((re) => re.test(f)) &&
      !coupledRefs.some((r) => f.startsWith(r)),
  );
}

const NAME = /^@4thtech-io\/[a-z0-9][a-z0-9-]*$/;

// CHORE-CI-SPEED-3: the short Linux jobs of ci.yml and the workspace packages whose code each one
// runs (rule 7). `checks` follows the package list itself. A job is listed with every package its
// steps build or import outside the declared dependencies (the vectors harness imports chain).
export const PACKAGE_JOBS = Object.freeze({
  vectors: ['@4thtech-io/test-vectors', '@4thtech-io/chain'],
  keychain: ['@4thtech-io/node', '@4thtech-io/agentlink'],
  'relays-docker': ['@4thtech-io/node', '@4thtech-io/transport-nostr'],
  'storage-minio': ['@4thtech-io/storage'],
  'bundle-check': ['@4thtech-io/agentlink'],
});

// Root files that change what gets installed: a new dependency can break one OS or the packed CLI.
export const INSTALL_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.nvmrc',
  '.node-version',
]);
// A code file whose own name says it is Windows code (`windows-entry.test.ts`, `win32-paths.ts`).
const WINDOWS_NAME = /(?:^|[/._-])(?:win|windows|win32)(?:[/._-]|$)/i;
const WINDOWS_JOBS = new Set(['windows-smoke', 'node-os']);

// OPS-FAST-LANE-1 (rule 8): the heavy-lane jobs and the path prefixes that make the fast lane run
// them. `keychain-os` is the macOS and Windows legs of `keychain` (its Linux leg is a package job).
// Every heavy-lane job also runs for INSTALL_FILES; windows-smoke and node-os also run for any
// non-doc file with a Windows name. Keep this explicit: select-affected.test.mjs pins it.
export const HEAVY_LANE = Object.freeze({
  'windows-smoke': [
    'apps/cli/src/harness/',
    'apps/cli/src/runtime/',
    'apps/cli/src/mcp/',
    'apps/cli/src/commands/init',
    'apps/cli/src/commands/global-install',
    'apps/cli/src/commands/ui',
    'apps/cli/src/main.ts',
    'apps/cli/src/cli.ts',
    'apps/cli/src/index.ts',
    'apps/cli/src/node-check',
    'apps/cli/scripts/',
    'apps/cli/bundle.config.mjs',
    'apps/cli/package.json',
    'e2e/test/cli-first-run-smoke.test.ts',
  ],
  'node-os': [
    'packages/node/src/inbox-folder',
    'packages/node/src/allowed-path',
    'packages/node/src/owner-send-folder',
    'packages/node/src/agent-folder-lock',
    'packages/node/src/file-keystore',
    'packages/node/src/inter-process-lock',
    'packages/node/src/approval-os',
    'packages/node/src/keychain',
    'packages/node/src/os-keychain',
    'packages/node/src/local-ui/api/files',
    'packages/node/package.json',
    'packages/node/vitest.config',
    'packages/core/src/path-guard',
    'packages/core/src/files/',
    // The keys the node suite stores and reads back on each OS come from crypto (KeyStore).
    'packages/crypto/',
  ],
  'path-guard': ['packages/node/src/allowed-path', 'packages/core/src/path-guard'],
  'keychain-os': [
    'packages/crypto/',
    'packages/node/src/file-keystore',
    'packages/node/src/keychain',
    'packages/node/src/os-keychain',
    'packages/node/package.json',
    'apps/cli/test/two-process.keychain',
    'apps/cli/test/one-shot-exit.keychain',
  ],
  'e2e-deterministic': [
    'e2e/src/',
    'e2e/prompt-injection/',
    'e2e/vitest.config.ts',
    'e2e/test/pair-and-message',
    'e2e/test/negotiate-and-agree',
    'e2e/test/files-and-proof',
    'e2e/test/files-proof-scenario',
    'e2e/test/world.ts',
    'e2e/test/support.ts',
    'e2e/test/fixtures/',
  ],
});

const allJobs = (map, run) => Object.fromEntries(Object.keys(map).map((j) => [j, run]));

/**
 * Rule 8: which heavy-lane jobs the fast lane runs for these changed files.
 * @param {string[] | null} files
 * @returns {Record<string, boolean>}
 */
export function heavyLane(files) {
  if (files == null) return allJobs(HEAVY_LANE, true);
  const list = files.map((f) => f.trim()).filter(Boolean);
  if (list.length === 0) return allJobs(HEAVY_LANE, true);
  const hit = (job, prefixes) =>
    list.some(
      (f) =>
        INSTALL_FILES.includes(f) ||
        prefixes.some((p) => f.startsWith(p)) ||
        (WINDOWS_JOBS.has(job) && !DOCS.test(f) && WINDOWS_NAME.test(f)),
    );
  return Object.fromEntries(
    Object.entries(HEAVY_LANE).map(([job, prefixes]) => [job, hit(job, prefixes)]),
  );
}

/**
 * @param {{ files: string[] | null, workspace: Array<{ name: string, dir: string, deps: string[],
 *   refs: string[], playwright: boolean }> }} input
 * @returns {{ scope: 'full', reason: string, jobs: Record<string, boolean>,
 *   heavy: Record<string, boolean> } | { scope: 'filtered', packages: string[], playwright: boolean,
 *   jobs: Record<string, boolean>, heavy: Record<string, boolean> }}
 */
export function selectAffected({ files, workspace }) {
  const result = selectPackages({ files, workspace });
  const heavy = heavyLane(files);
  if (result.scope === 'full') return { ...result, jobs: allJobs(PACKAGE_JOBS, true), heavy };
  const selected = new Set(result.packages);
  const jobs = Object.fromEntries(
    Object.entries(PACKAGE_JOBS).map(([job, pkgs]) => [job, pkgs.some((p) => selected.has(p))]),
  );
  return { ...result, jobs, heavy };
}

/** The run_<job> lines for $GITHUB_OUTPUT: PACKAGE_JOBS, then HEAVY_LANE, in map order. */
export function jobOutputs(result) {
  const key = (job) => `run_${job.replaceAll('-', '_')}`;
  return [
    ...Object.keys(PACKAGE_JOBS).map(
      (job) => `${key(job)}=${result.scope === 'full' || result.jobs[job] === true}`,
    ),
    // A missing answer runs the job (fail towards running).
    ...Object.keys(HEAVY_LANE).map((job) => `${key(job)}=${result.heavy?.[job] !== false}`),
  ];
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
    if (!file.includes('/') && !DOCS.test(file)) {
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

// `--scope <event> <ref> <changed-files.txt>`: the fast-lane decision for ci.yml's `detect`. A missing
// or unreadable list is an unknown diff (full suite). Never throws towards "skip".
function scope(argv) {
  const [event, ref, listFile] = argv;
  const files =
    listFile && existsSync(listFile) ? readFileSync(listFile, 'utf8').split('\n') : null;
  const lane = fastLane({ event, ref, files });
  // Paths that a package (other than tools, whose checks `docs-checks` runs) names in its sources.
  // An unreadable workspace means not docs-only.
  let docs;
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const coupledRefs = loadWorkspace(root)
      .filter((p) => p.name !== TOOLS_PACKAGE)
      .flatMap((p) => p.refs);
    docs = docsOnly({ event, ref, files, coupledRefs });
  } catch {
    docs = false;
  }
  // Three lines on stdout; ci.yml validates them before it writes its outputs.
  console.log(`e2e_relevant=${lane.codeChanged}`);
  console.log(`use_selector=${lane.selector}`);
  console.log(`docs_only=${docs && !lane.codeChanged}`);
}

function main(argv) {
  if (argv[0] === '--scope') return scope(argv.slice(1));
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
