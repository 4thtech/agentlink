#!/usr/bin/env node
// W4-NEXT-PREVIEW (owner Decision 44 A1): checks for the preview lane of release.yml, which
// publishes every green state of the `wave-4` integration branch to npm `next` as a Changesets
// snapshot (`x.y.z-next.wave4.<UTC datetime>`, `.changeset/config.json` `snapshot`). Nothing the
// lane computes is committed, so there is no pre mode to exit when wave-4 merges into main.
//
//   node tools/release/next-preview.mjs check-tree --lane <main|wave-4> [--root <dir>]
//       Fails when the tree holds something that must not be released from that lane:
//       - both lanes: a package.json whose version is a preview snapshot (a leaked snapshot on
//         main would otherwise go to `latest` through publish-latest);
//       - wave-4: `.changeset/pre.json` in any mode (snapshots are refused in pre mode, and a
//         pre-mode file on wave-4 would reach main with the merge).
//   node tools/release/next-preview.mjs pending [--root <dir>]
//       Prints `pending=true` or `pending=false` (a step output line): whether `.changeset/` holds a
//       changeset (`*.md` other than README.md). `changeset version --snapshot` exits 1 without one,
//       so pack-preview checks first and publishes nothing for such a commit.
//   node tools/release/next-preview.mjs prepare-plan --in <plan.json> --out <plan.json>
//       pack-preview, before packing: the `changeset publish-plan` output with every release
//       moved to the `next` dist-tag (the CLI has no --tag for a plan, and artifact mode refuses
//       one at publish time). Refuses anything but `@4thtech-io/*` preview snapshots.
//   node tools/release/next-preview.mjs verify-plan --in <pack dir>/publish-plan.json
//       publish-preview, before publishing (the job with the OIDC token): every release is a
//       `@4thtech-io/*` preview snapshot on `next` with a tarball. Prints [{name, version}].
//
// Reads local files only; no network, no secrets. Exit 1 with `::error::` lines on any problem.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREVIEW_BRANCH = 'wave-4';
export const PREVIEW_TAG = 'next';
// `{tag}.wave4.{datetime}` on the calculated version. A main pre-mode prerelease is
// `x.y.z-next.<n>` (numeric second identifier), so the two schemes can never produce the same version.
const PREVIEW_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-next\.wave4\.[0-9]{14}$/;
const LEAKED_VERSION = /-next\.wave4\./;
const SCOPED_NAME = /^@4thtech-io\/[a-z0-9][a-z0-9._-]*$/;
const LANES = new Set(['main', PREVIEW_BRANCH]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', 'coverage']);

export function isPreviewVersion(version) {
  return typeof version === 'string' && PREVIEW_VERSION.test(version);
}

function releasesOf(planFile) {
  if (!planFile || typeof planFile !== 'object' || planFile.version !== 1) {
    throw new Error('not a Changesets publish plan (version 1)');
  }
  if (!Array.isArray(planFile.plan) || !planFile.plan.every(Array.isArray)) {
    throw new Error('not a Changesets publish plan (plan must be a list of chunks)');
  }
  return planFile.plan.flat();
}

function checkRelease(release) {
  const label = `${release?.name}@${release?.version}`;
  if (release?.kind !== 'publish') {
    throw new Error(
      `${label}: only publish entries are allowed, got ${JSON.stringify(release?.kind)}`,
    );
  }
  if (typeof release.name !== 'string' || !SCOPED_NAME.test(release.name)) {
    throw new Error(`${label}: only @4thtech-io/* packages are published`);
  }
  if (!isPreviewVersion(release.version)) {
    throw new Error(
      `${label}: not a preview snapshot (x.y.z-next.wave4.<datetime>); wave-4 never publishes a real release`,
    );
  }
}

/** The publish plan with every release on the `next` dist-tag. Throws on anything unexpected. */
export function preparePlan(planFile) {
  const releases = releasesOf(planFile);
  for (const release of releases) checkRelease(release);
  return {
    version: 1,
    plan: planFile.plan.map((chunk) => chunk.map((release) => ({ ...release, tag: PREVIEW_TAG }))),
  };
}

/** The packages a packed plan publishes, after checking each is a preview snapshot on `next`. */
export function verifyPackedPlan(planFile) {
  const releases = releasesOf(planFile);
  if (releases.length === 0) throw new Error('the packed plan has nothing to publish');
  return releases.map((release) => {
    checkRelease(release);
    if (release.tag !== PREVIEW_TAG) {
      throw new Error(
        `${release.name}@${release.version}: dist-tag must be ${PREVIEW_TAG}, got ${JSON.stringify(release.tag)}`,
      );
    }
    if (typeof release.tarball?.path !== 'string' || release.tarball.path === '') {
      throw new Error(`${release.name}@${release.version}: no tarball in the packed plan`);
    }
    return { name: release.name, version: release.version };
  });
}

function* manifests(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* manifests(join(dir, entry.name));
    } else if (entry.isFile() && entry.name === 'package.json') {
      yield join(dir, entry.name);
    }
  }
}

/** True when `.changeset/` holds at least one changeset (any `*.md` except README.md). */
export function hasPendingChangesets(root) {
  const dir = join(root, '.changeset');
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { withFileTypes: true }).some(
    (e) => e.isFile() && e.name.endsWith('.md') && e.name.toLowerCase() !== 'readme.md',
  );
}

/** Problems that forbid a release from `lane` in the tree at `root` (empty when clean). */
export function checkTree({ root, lane }) {
  if (!LANES.has(lane))
    throw new Error(`unknown lane ${JSON.stringify(lane)} (main or ${PREVIEW_BRANCH})`);
  const problems = [];
  if (lane === PREVIEW_BRANCH && existsSync(join(root, '.changeset/pre.json'))) {
    problems.push(
      `.changeset/pre.json exists on ${PREVIEW_BRANCH}: the preview lane uses snapshots, never pre mode. Remove it (pnpm changeset pre exit, then delete the file) so it cannot reach main.`,
    );
  }
  for (const file of manifests(root)) {
    let version;
    try {
      version = JSON.parse(readFileSync(file, 'utf8')).version;
    } catch {
      continue; // fixtures may hold invalid JSON; a real manifest fails the build anyway
    }
    if (typeof version === 'string' && LEAKED_VERSION.test(version)) {
      problems.push(
        `${relative(root, file)} has the preview snapshot version ${version}; snapshot versions are never committed.`,
      );
    }
  }
  return problems;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!['--lane', '--root', '--in', '--out'].includes(flag) || value === undefined) {
      throw new Error(`unknown or incomplete option ${JSON.stringify(flag)}`);
    }
    opts[flag.slice(2)] = value;
  }
  return { command, opts };
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export function run(argv, log = console.log) {
  try {
    const { command, opts } = parse(argv);
    switch (command) {
      case 'pending': {
        log(`pending=${hasPendingChangesets(resolve(opts.root ?? '.'))}`);
        return 0;
      }
      case 'check-tree': {
        const root = resolve(opts.root ?? '.');
        const problems = checkTree({ root, lane: opts.lane });
        for (const problem of problems) log(`::error::${problem}`);
        if (problems.length > 0) return 1;
        log(`Tree is clean for a release from ${opts.lane}.`);
        return 0;
      }
      case 'prepare-plan': {
        if (!opts.in || !opts.out) throw new Error('prepare-plan needs --in and --out');
        const prepared = preparePlan(readJson(opts.in));
        writeFileSync(opts.out, `${JSON.stringify(prepared, null, 2)}\n`);
        return 0;
      }
      case 'verify-plan': {
        if (!opts.in) throw new Error('verify-plan needs --in');
        log(JSON.stringify(verifyPackedPlan(readJson(opts.in))));
        return 0;
      }
      default:
        throw new Error(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (error) {
    log(`::error::${error?.message ?? String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = run(process.argv.slice(2));
}
