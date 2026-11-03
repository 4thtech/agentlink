// RELEASE-VERSION-ONLY-REUSE: is a release commit a pure version-bookkeeping commit relative to its
// first parent? Used by `wait-for-ci.mjs --reuse-version-only-parent` (release.yml `ci-green`) to reuse
// the parent's green CI verdict. The answer comes from the git trees of the two commits alone, never
// from a commit message, a PR title or an actor name. Any doubt (an unknown path, a parse error, a git
// error, a merge commit) answers "not version-only", and the caller falls back to the commit's own CI.
//
// Version-only means every entry of `git diff-tree <parent> <sha>` (no rename detection) is one of:
//   - `packages/<name>/package.json` or `apps/<name>/package.json`, modified, mode 100644 before and
//     after, where (a) the parsed JSON is equal to the parent's except the `version` value (a semver
//     string on both sides) and, in dependencies / devDependencies / peerDependencies /
//     optionalDependencies, the values of `@4thtech-io/*` keys whose range keeps its exact prefix
//     (`workspace:` and `^`/`~`) and changes only the semver; the key sets stay the same; and (b) every
//     changed text line is such a `version` or internal dependency line (this also rules out a duplicate
//     key that would override a field on parse);
//   - `CHANGELOG.md` at the root or in `packages/<name>/` or `apps/<name>/`, added or modified, a
//     regular file (mode 100644);
//   - `.changeset/<name>.md` or `changelog.d/<name>.md` (not README.md), deleted.
// At least one package.json must change, and the commit must have exactly one parent. Everything else
// (pnpm-lock.yaml, the root package.json, `.changeset/pre.json`, any new or other file, a mode change,
// a symlink, a submodule) makes it not version-only.

import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const SHA_RE = /^[0-9a-f]{40}$/;
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const SEMVER_RE = new RegExp(`^${SEMVER}$`);
const INTERNAL_NAME = /^@4thtech-io\/[a-z0-9._-]+$/;
const INTERNAL_RANGE = new RegExp(`^(workspace:)?([~^]?)(${SEMVER})$`);
const VERSION_LINE = new RegExp(String.raw`^\s*"version":\s*"${SEMVER}",?\s*$`);
const DEP_LINE = new RegExp(
  String.raw`^\s*"@4thtech-io\/[a-z0-9._-]+":\s*"(?:workspace:)?[~^]?${SEMVER}",?\s*$`,
);
const DEP_BLOCKS = new Set([
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]);
const PACKAGE_JSON = /^(packages|apps)\/[^/]+\/package\.json$/;
const CHANGELOG = /^((packages|apps)\/[^/]+\/)?CHANGELOG\.md$/;
const CONSUMED = /^(\.changeset|changelog\.d)\/(?!README\.md$)[^/]+\.md$/;
const REGULAR = '100644';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function depBlockProblems(name, before, after) {
  if (before === undefined && after === undefined) return [];
  if (!isObject(before) || !isObject(after)) return [`${name} added, removed or not an object`];
  const keys = Object.keys(before);
  if (!isDeepStrictEqual(keys.slice().sort(), Object.keys(after).sort())) {
    return [`${name}: a dependency was added or removed`];
  }
  const bad = [];
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (a === b) continue;
    const ma = INTERNAL_RANGE.exec(String(a));
    const mb = INTERNAL_RANGE.exec(String(b));
    if (
      !INTERNAL_NAME.test(key) ||
      typeof a !== 'string' ||
      typeof b !== 'string' ||
      !ma ||
      !mb ||
      ma[1] !== mb[1] ||
      ma[2] !== mb[2]
    ) {
      bad.push(`${name}.${key}: not an internal version bump`);
    }
  }
  return bad;
}

/** Problems in a package.json change; empty when only versions changed. Exported for tests. */
export function packageJsonProblems(beforeText, afterText, diffText) {
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return ['not valid JSON'];
  }
  if (!isObject(before) || !isObject(after)) return ['not a JSON object'];
  const bad = [];
  if (typeof before.version !== 'string' || !SEMVER_RE.test(before.version)) {
    bad.push('the old version is not semver');
  }
  if (typeof after.version !== 'string' || !SEMVER_RE.test(after.version)) {
    bad.push('the new version is not semver');
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'version') continue;
    if (DEP_BLOCKS.has(key)) bad.push(...depBlockProblems(key, before[key], after[key]));
    else if (!isDeepStrictEqual(before[key], after[key])) bad.push(`field "${key}" changed`);
  }
  // The text, too: every changed line is a version or internal dependency line.
  let inHunk = false;
  let changed = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    const sign = line[0];
    if (sign !== '+' && sign !== '-') continue;
    changed += 1;
    const body = line.slice(1);
    if (!VERSION_LINE.test(body) && !DEP_LINE.test(body)) {
      bad.push('a changed line is not a version or internal dependency line');
      break;
    }
  }
  if (changed === 0) bad.push('no changed lines');
  return bad;
}

// `git diff-tree -r -z --raw`: ":<old mode> <new mode> <old blob> <new blob> <status>\0<path>\0".
function parseRaw(out) {
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const meta = parts[i];
    const path = parts[i + 1];
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/.exec(meta);
    if (!m || !path) throw new Error(`unexpected diff-tree output ${JSON.stringify(meta)}`);
    entries.push({
      oldMode: m[1],
      newMode: m[2],
      oldBlob: m[3],
      newBlob: m[4],
      status: m[5],
      path,
    });
  }
  if (parts.at(-1) !== '') throw new Error('unexpected diff-tree output');
  return entries;
}

/**
 * Classifies commit `sha` (which must be the checked-out HEAD in `cwd`). Never throws.
 * Returns { versionOnly, parent?, reasons }.
 */
export function classifyVersionOnly({ cwd = process.cwd(), sha, git } = {}) {
  const run =
    git ??
    ((...args) =>
      execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      }).toString());
  const no = (...reasons) => ({ versionOnly: false, reasons });
  try {
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) return no('the commit sha is malformed');
    const head = run('rev-parse', '--verify', 'HEAD^{commit}').trim();
    if (head !== sha) return no(`the checked-out HEAD ${head} is not ${sha}`);
    const [self, ...parents] = run('rev-list', '--parents', '-n', '1', sha).trim().split(' ');
    if (self !== sha) return no('could not read the commit');
    if (parents.length !== 1 || !SHA_RE.test(parents[0])) {
      return no(`the commit has ${parents.length} parents, not exactly one`);
    }
    const parent = parents[0];
    const entries = parseRaw(
      run('diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-abbrev', parent, sha),
    );
    if (entries.length === 0) return no('the commit changes nothing');
    const reasons = [];
    let packageJsons = 0;
    for (const e of entries) {
      const { path, status, oldMode, newMode } = e;
      if (PACKAGE_JSON.test(path)) {
        if (status !== 'M' || oldMode !== REGULAR || newMode !== REGULAR) {
          reasons.push(`${path}: ${status} ${oldMode}->${newMode}, not a modified regular file`);
          continue;
        }
        packageJsons += 1;
        const diff = run(
          'diff',
          '-U0',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          parent,
          sha,
          '--',
          path,
        );
        const problems = packageJsonProblems(
          run('cat-file', 'blob', e.oldBlob),
          run('cat-file', 'blob', e.newBlob),
          diff,
        );
        reasons.push(...problems.map((p) => `${path}: ${p}`));
      } else if (CHANGELOG.test(path)) {
        const ok =
          (status === 'A' && newMode === REGULAR) ||
          (status === 'M' && oldMode === REGULAR && newMode === REGULAR);
        if (!ok) reasons.push(`${path}: ${status} ${oldMode}->${newMode}, not a regular CHANGELOG`);
      } else if (CONSUMED.test(path)) {
        if (status !== 'D') reasons.push(`${path}: ${status}, not removed`);
      } else {
        reasons.push(`${path}: not part of a version change`);
      }
    }
    if (packageJsons === 0) reasons.push('no package.json version change');
    return reasons.length === 0 ? { versionOnly: true, parent, reasons } : no(...reasons);
  } catch (error) {
    return no(`classification failed: ${error?.message ?? String(error)}`);
  }
}
