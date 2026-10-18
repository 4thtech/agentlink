// OPS-REL-2 (IR-OPS-REL-1-1): the @agentlink npm scope belongs to a third party, so the workspace
// packages moved to @4thtech-io/* and stay private (only the CLI, @4thtech-io/agentlink, publishes).
// This scans every tracked file for a `<old scope>/<name>` reference, in any letter case and with or
// without regex escaping of the slash. History keeps the old names: CHANGELOG.md files and the
// decision-log rows of docs/foundation/00-README.md. Everything else must use the new scope.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The old scope without its slash, so this file does not match itself.
const OLD = '@agentlink';
// `<old scope>/`, `<old scope>\/` (regex source), `<old scope>\\\/` (regex in a string or regex).
const PATTERN = `${OLD}\\\\*/`;
const LINE = new RegExp(`${OLD}\\\\*/`, 'i');

const isHistory = (path, line) =>
  path === 'CHANGELOG.md' ||
  path.endsWith('/CHANGELOG.md') ||
  (path === 'docs/foundation/00-README.md' && /^\| D-\d+ /.test(line));

/** Tracked files that mention the old scope with a slash: [{ path, line }]. */
function oldScopeHits() {
  let out;
  try {
    out = execFileSync('git', ['grep', '-I', '-n', '-i', '-E', PATTERN, '--', '.'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status === 1) return []; // git grep: no match
    throw error;
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [path, number, ...rest] = row.split(':');
      return { path, number, line: rest.join(':') };
    });
}

/** The workspace manifests, from the pnpm-workspace.yaml package globs. */
function workspaceManifests() {
  const out = execFileSync('git', ['ls-files', '--', '*package.json'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((path) =>
      /^(packages|apps)\/[^/]+\/package\.json$|^(test-vectors|e2e|tools)\/package\.json$/.test(
        path,
      ),
    )
    .map((path) => ({ path, manifest: JSON.parse(readFileSync(join(root, path), 'utf8')) }));
}

describe('retired @agentlink npm scope (OPS-REL-2)', () => {
  it('the scan pattern matches the plain and the regex-escaped forms', () => {
    expect(LINE.test(`import x from '${OLD}/core'`)).toBe(true);
    expect(LINE.test(`find: /^${OLD}\\/crypto$/`)).toBe(true);
    expect(LINE.test(`/^${OLD}\\\\\\/crypto/`)).toBe(true);
    expect(LINE.test(`'${OLD.toUpperCase()}/core'`)).toBe(true);
    expect(LINE.test(`the ${OLD} scope`)).toBe(false);
  });

  it('no tracked file outside history names a package in the old scope', () => {
    const hits = oldScopeHits()
      .filter(({ path, line }) => !isHistory(path, line))
      .map(({ path, number, line }) => `${path}:${number}: ${line.trim().slice(0, 160)}`);
    expect(hits).toEqual([]);
  });

  it('every workspace package is in @4thtech-io and private, except the published CLI', () => {
    const manifests = workspaceManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(16);
    const problems = [];
    for (const { path, manifest } of manifests) {
      if (!manifest.name?.startsWith('@4thtech-io/')) {
        problems.push(`${path}: name ${JSON.stringify(manifest.name)} is not in @4thtech-io`);
      }
      if (manifest.name !== '@4thtech-io/agentlink' && manifest.private !== true) {
        problems.push(`${path}: must be "private": true`);
      }
    }
    expect(problems).toEqual([]);
  });
});
