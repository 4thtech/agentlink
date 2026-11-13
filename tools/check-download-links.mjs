// REL-LINKS-3: the public Mac download links must never name a version, so no release makes them stale.
// They point at https://github.com/4thtech/agentlink/releases/latest/download/AgentLink-mac-<arch>.dmg.
// Fails on `4thtech/agentlink/releases/download/v...` (also in docs/, except docs/foundation) or a versioned .dmg name (AgentLink-0.5.2-mac-arm64.dmg, or
// AgentLink-<version>-mac-x64.dmg) in README.md, llms.txt, docs-site, knowledge and apps/invite/src.
// Test files are skipped: they may spell out the bad shapes on purpose.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STABLE_BASE = 'https://github.com/4thtech/agentlink/releases/latest/download';

// Only this project's releases: a link to another project's `releases/download/v...` is not a problem.
// A version is a number, with or without `v`, or a placeholder (`<version>`, `{version}`, `$VERSION`).
const VERSIONED_URL = /4thtech\/agentlink\/releases\/download\/(?:v|\d|<|\{|\$)/;
const VERSIONED_NAME = /AgentLink-v?(?:\d|<|\{|\$)[^\s`'")]*-mac-(?:arm64|x64)\.dmg/;

/** Returns the problems of one file's text (empty when it is fine). */
export function checkText(file, text) {
  const problems = [];
  // The process docs under docs/ describe the versioned names on purpose (the updater needs them),
  // so there only the download URL is checked.
  const namesAllowed = file.startsWith('docs/');
  text.split('\n').forEach((line, i) => {
    if (VERSIONED_URL.test(line)) {
      problems.push(
        `${file}:${i + 1}: versioned download link; use ${STABLE_BASE}/AgentLink-mac-<arch>.dmg`,
      );
    }
    if (!namesAllowed && VERSIONED_NAME.test(line)) {
      problems.push(`${file}:${i + 1}: versioned .dmg name; use AgentLink-mac-<arch>.dmg`);
    }
  });
  return problems;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Returns [repo-relative path, text] for every file the check covers. */
export function collectFiles(root) {
  const files = [join(root, 'README.md'), join(root, 'llms.txt')];
  for (const dir of ['docs-site', 'knowledge', 'docs', join('apps', 'invite', 'src')]) {
    files.push(...walk(join(root, dir)));
  }
  return (
    files
      .filter(
        (f) =>
          /\.(md|txt|ts|tsx|mts|js|mjs|json|vue|html)$/.test(f) && !/\.test\.[cm]?[jt]sx?$/.test(f),
      )
      // docs/foundation is decision history.
      .filter((f) => !relative(root, f).split('\\').join('/').startsWith('docs/foundation/'))
      .filter((f) => existsSync(f))
      .map((f) => [relative(root, f).split('\\').join('/'), readFileSync(f, 'utf8')])
  );
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = collectFiles(root);
  const problems = files.flatMap(([file, text]) => checkText(file, text));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`check-download-links: ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log(`check-download-links: ${files.length} files OK.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
