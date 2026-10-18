// No Solidity source in this public repository (D-19, D-83, AGENTS.md hard rules). Run by
// `pnpm lint` (turbo task `check`) and therefore by CI.
//
// The OCC v2 contracts live in the private 4thtech/occ-v2-contracts; this repository holds only the
// exported ABI JSON (packages/occ-v2-abi). .gitignore already ignores `*.sol`; this check also
// catches a force-added file and Solidity source saved under another extension. It fails on:
//   - any tracked or untracked (not ignored) file whose name ends in `.sol`, in any letter case;
//   - any such file with a `pragma solidity` line (at a line start).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Larger files are skipped by the pragma scan (no source file is this big). */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export const isSolidityPath = (path) => /\.sol$/i.test(path);

export const hasSolidityPragma = (text) => /^[ \t]*pragma[ \t]+solidity\b/m.test(text);

/** Tracked files plus untracked files that are not ignored, relative to `root`. */
export function listRepoFiles(root) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(out.split('\0').filter(Boolean))].filter(
    (path) => !path.startsWith('.claude/worktrees/'),
  );
}

/** The offending files among `files` (paths relative to `root`), each with a reason. */
export function findSolidity(root, files) {
  const found = [];
  for (const path of files) {
    if (isSolidityPath(path)) {
      found.push(`${path}: a .sol file`);
      continue;
    }
    // One read, no exists/stat check first (no check-then-use race): a missing path or a
    // directory throws and is skipped.
    let bytes;
    try {
      bytes = readFileSync(join(root, path));
    } catch {
      continue;
    }
    if (bytes.length > MAX_SCAN_BYTES || bytes.includes(0)) continue;
    if (hasSolidityPragma(bytes.toString('utf8'))) found.push(`${path}: Solidity source (pragma)`);
  }
  return found;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = listRepoFiles(root);
  const found = findSolidity(root, files);
  if (found.length) {
    for (const line of found) console.error(`check-no-solidity: ${line}`);
    console.error(
      'check-no-solidity: Solidity source stays in the private occ-v2-contracts repository; import only its ABI release (packages/occ-v2-abi).',
    );
    process.exit(1);
  }
  console.log(`check-no-solidity: ${files.length} files, no Solidity source. OK.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
