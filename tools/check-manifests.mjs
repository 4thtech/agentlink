// Manifest policy checks, run by `pnpm lint` (turbo task `check`) and therefore by CI.
//
// For every package.json in the repository (the root, every workspace package, anything nested):
//   1. "license" is exactly "MIT" (D-12).
//   2. No install-time lifecycle script: preinstall, install, postinstall, and also preprepare, prepare and
//      postprepare (a plain `pnpm install` runs those in the root and in workspace projects)
//      (AGENTS.md, ci-cd.md: no install scripts).
// For every package that is not private (it can be published):
//   3. publishConfig.access is "public", publishConfig.registry and publishConfig.tag are absent,
//      and a "repository" field exists (the release jobs refuse to publish otherwise).
// Package names (checkPackageName, OPS-REL-2):
//   4. No name, and no dependency name or alias target, in a retired npm scope (the third-party
//      `@agentlink` scope; tools/deps-check/policy.mjs RETIRED_SCOPES).
//   5. Only the packages in PUBLISHED may be non-private; every other package is "private": true.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRetiredScope, retiredScopeMessage } from './deps-check/policy.mjs';

const INSTALL_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
];
// .claude holds agent worktrees (other branches, untracked); they are not part of this tree.
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', '.turbo', 'coverage']);

/** Returns a list of human-readable problems for one parsed package.json. */
export function checkManifest(manifest) {
  const problems = [];

  if (manifest.license !== 'MIT') {
    problems.push(`"license" must be "MIT" (found ${JSON.stringify(manifest.license)})`);
  }

  const scripts = manifest.scripts ?? {};
  for (const name of INSTALL_SCRIPTS) {
    if (Object.hasOwn(scripts, name)) {
      problems.push(`must not declare a "${name}" script`);
    }
  }

  if (manifest.private !== true) {
    const publishConfig = manifest.publishConfig ?? {};
    if (publishConfig.access !== 'public') {
      problems.push('a publishable package needs publishConfig.access = "public"');
    }
    if (Object.hasOwn(publishConfig, 'registry')) {
      problems.push('publishConfig.registry must be absent');
    }
    if (Object.hasOwn(publishConfig, 'tag')) {
      problems.push('publishConfig.tag must be absent');
    }
    if (!manifest.repository) {
      problems.push('a publishable package needs a "repository" field');
    }
  }

  return problems;
}

/** The only packages that publish to npm (OPS-REL-1: the CLI, with its workspace packages bundled). */
export const PUBLISHED = ['@4thtech-io/agentlink'];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Name and visibility problems for one parsed package.json (OPS-REL-2). */
export function checkPackageName(manifest) {
  const problems = [];
  if (isRetiredScope(manifest.name ?? '')) {
    problems.push(`name: ${retiredScopeMessage(manifest.name)}`);
  }
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      // `npm:<name>@<range>` and `workspace:<name>@<range>` install <name>, whatever the key says.
      const target = /^(?:npm|workspace):(@?[^@]+)/.exec(String(spec))?.[1] ?? '';
      if (isRetiredScope(name) || isRetiredScope(target)) {
        problems.push(
          `${field}.${name}: ${retiredScopeMessage(isRetiredScope(name) ? name : target)}`,
        );
      }
    }
  }
  if (manifest.private !== true && !PUBLISHED.includes(manifest.name)) {
    problems.push(
      `${JSON.stringify(manifest.name)} must be "private": true; only ${PUBLISHED.join(', ')} publishes (OPS-REL-1, OPS-REL-2)`,
    );
  }
  return problems;
}

/** Finds every package.json under `dir`, skipping dependency and build output directories. */
export function findManifests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...findManifests(join(dir, entry.name)));
    } else if (entry.name === 'package.json') {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = findManifests(root).sort();
  let failed = 0;

  for (const file of files) {
    const shown = relative(root, file);
    let problems;
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      problems = [...checkManifest(manifest), ...checkPackageName(manifest)];
    } catch (error) {
      problems = [`cannot be read as JSON (${error.message})`];
    }
    for (const problem of problems) {
      console.error(`${shown}: ${problem}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`check-manifests: ${failed} problem(s) in ${files.length} package.json file(s).`);
    process.exit(1);
  }
  console.log(
    `check-manifests: ${files.length} package.json files OK (license MIT, no install scripts, names and visibility).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
