#!/usr/bin/env node
// DOCS-COMPACT-A: the private specs (01 commercial brief, 09 repositories and reuse) live in the
// private ops repo and are never committed here, under the old path (specs/) or the new
// one (specs/) or anywhere else. Run by `pnpm lint` (tools `check`). It fails on any tracked or
// untracked, not ignored, file with one of those names; an ignored local copy is fine.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUTS, PRIVATE_SPEC_NAMES } from './docs/paths.mjs';
import { listRepoFiles } from './check-no-solidity.mjs';

/** The offending paths among `files`. */
export function findPrivateDocs(files) {
  const specRoots = Object.values(LAYOUTS).map((l) => `${l.specs}/`);
  return files.filter((f) => {
    const name = f.split('/').pop().toLowerCase();
    if (PRIVATE_SPEC_NAMES.includes(name)) return true;
    // Any 01-* or 09-* file directly in a specs root (old or new layout).
    return specRoots.some(
      (r) => f.startsWith(r) && !f.slice(r.length).includes('/') && /^(01|09)-/.test(name),
    );
  });
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const found = findPrivateDocs(listRepoFiles(root));
  if (found.length) {
    console.error(
      `check-private-docs: private specs must never be committed to this public repo (they live in the private ops repo):\n- ${found.join('\n- ')}`,
    );
    process.exit(1);
  }
  console.log('check-private-docs: no private spec in the repository.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
