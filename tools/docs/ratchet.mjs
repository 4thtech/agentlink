// DOCS-COMPACT-A: allowlists that may only shrink (a ratchet). Used by check-ui-labels and
// check-spec-refs: today's misses are seeded into a JSON allowlist so only NEW misses fail; an entry
// that no longer occurs must be removed (so fixed misses cannot come back unnoticed); and an entry
// that is not in the base branch's copy of the allowlist fails (the list cannot grow in a PR).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads `{ "entries": [...] }`; a missing file is an empty list. */
export function readAllowlist(root, rel) {
  try {
    const data = JSON.parse(readFileSync(join(root, rel), 'utf8'));
    if (!Array.isArray(data.entries)) throw new Error(`${rel}: "entries" must be a list`);
    return data.entries;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function writeAllowlist(root, rel, note, entries) {
  const sorted = [...new Set(entries)].sort();
  writeFileSync(join(root, rel), `${JSON.stringify({ note, entries: sorted }, null, 2)}\n`);
}

// DOCS-PHASE-B: entries start with a repo path. A base branch that predates the folder rename holds
// them under the old names, so they are mapped to the new names before the growth comparison.
const RENAMED = [
  ['docs/foundation/', 'specs/'],
  ['docs/README.md', 'project/README.md'],
  ...['process', 'runbooks', 'lessons', 'design', 'explainers', 'releases'].map((d) => [
    `docs/${d}/`,
    `project/${d}/`,
  ]),
  ['docs-site/', 'docs/'],
];
export function renamedEntry(entry) {
  for (const [from, to] of RENAMED) if (entry.startsWith(from)) return to + entry.slice(from.length);
  return entry;
}

/**
 * The allowlist on the base ref (env DOCS_RATCHET_BASE, default origin/main), or null when git or
 * the ref or the file is not available there (then the growth check is skipped, with a note).
 */
export function baseAllowlist(root, rel, ref = process.env.DOCS_RATCHET_BASE ?? 'origin/main') {
  try {
    const text = execFileSync('git', ['show', `${ref}:${rel}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (JSON.parse(text).entries ?? []).map(renamedEntry);
  } catch {
    return null;
  }
}

/**
 * Compares today's misses with the allowlist. Returns { fresh, stale, grown }: `fresh` misses not in
 * the allowlist (fail), `stale` entries that no longer occur (fail: remove them), `grown` entries
 * not on the base (fail: the list may only shrink). `base` null skips the growth check.
 */
export function ratchet(misses, allowed, base) {
  const missSet = new Set(misses);
  const allowSet = new Set(allowed);
  return {
    fresh: [...missSet].filter((m) => !allowSet.has(m)).sort(),
    stale: [...allowSet].filter((a) => !missSet.has(a)).sort(),
    grown: base === null ? [] : [...allowSet].filter((a) => !base.includes(a)).sort(),
  };
}
