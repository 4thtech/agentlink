// Manifest policy checks, run by `pnpm lint` (turbo task `check`) and therefore by CI.
//
// For every package.json in the repository (the root, every workspace package, anything nested):
//   1. "license" is exactly "MIT" (D-12).
//   2. No "preinstall", "install" or "postinstall" script (AGENTS.md, ci-cd.md: no install scripts).
// For every package that is not private (it can be published):
//   3. publishConfig.access is "public", publishConfig.registry and publishConfig.tag are absent,
//      and a "repository" field exists (the release jobs refuse to publish otherwise).

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', 'coverage']);

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
      problems = checkManifest(JSON.parse(readFileSync(file, 'utf8')));
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
    `check-manifests: ${files.length} package.json files OK (license MIT, no install scripts).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
