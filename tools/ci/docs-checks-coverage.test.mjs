// OPS-DOCS-FASTLANE drift guard: a docs-only pull request skips `checks`, so every tools script or
// test that reads the real doc trees must run in the `docs-checks` job of ci.yml (or be listed below
// with the reason it does not need to). A new doc-reading test fails here until someone decides.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tools = join(root, 'tools');

// A path built from a doc tree, or the root README.md / llms.txt, in a join/resolve/URL call.
const READS_DOCS =
  /(?:join|resolve|URL)\([^)\n]*['"`/](?:docs|docs-site|knowledge|changelog\.d)[/'"`]|['"`](?:llms\.txt|README\.md)['"`]\)|['"`]llms\.txt['"`]/;

// Files that match but do not read the repository's real docs (each needs a reason).
const NOT_NEEDED = {
  'ci/select-affected.test.mjs': 'path strings as classifier inputs; its own CI wiring tests',
  'ci/review-gate.test.mjs': 'path strings as classifier inputs',
  'pr/open-pr.test.mjs': 'path strings as classifier inputs',
  'desktop-extension/desktop-extension.test.mjs': "the extension folder's own README",
  'release/release-body.test.mjs': 'scratch directories with fixture notes',
  'release/roll-changelog.test.mjs': 'scratch directories',
  'release/check-changelog-fragment.test.mjs': 'scratch directories',
  'dogfood/dogfood.test.mjs': 'passes the docs directory as a path argument only',
  'vectors/check-pending.mjs': 'runs in the `vectors` job (reads docs/process/backlog.md)',
  'vectors/check-generators.mjs': 'runs in the `vectors` job (reads test-vectors/README.md)',
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const at = yml.indexOf('\n  docs-checks:\n');
const rest = yml.slice(at + 1);
const jobText = rest.slice(0, rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/) + 1);
const tokens = new Set(
  jobText
    .split(/\s+/)
    .map((t) => t.replace(/^tools\//, ''))
    .filter(Boolean),
);

describe('docs-checks covers every doc-reading tools script and test', () => {
  const candidates = walk(tools)
    .map((f) => relative(tools, f))
    .filter(
      (f) =>
        f.endsWith('.mjs') &&
        (f.endsWith('.test.mjs') || /(^|\/)(check-[^/]*|index)\.mjs$/.test(f)),
    )
    .filter((f) => READS_DOCS.test(readFileSync(join(tools, f), 'utf8')));

  it('finds the known readers (the detector works)', () => {
    for (const f of [
      'vocabulary.test.mjs',
      'check-knowledge-links.mjs',
      'docs-status/status.test.mjs',
    ]) {
      expect(candidates, f).toContain(f);
    }
  });

  it.each(candidates)('%s runs in docs-checks or is listed with a reason', (f) => {
    const dir = dirname(f);
    const covered = tokens.has(f) || (dir !== '.' && tokens.has(dir));
    if (covered) {
      expect(NOT_NEEDED[f], `${f} is covered; drop it from NOT_NEEDED`).toBeUndefined();
    } else {
      expect(NOT_NEEDED[f], `${f} reads docs but docs-checks does not run it`).toBeTypeOf('string');
    }
  });

  it('every NOT_NEEDED entry still exists and still matches the detector', () => {
    for (const f of Object.keys(NOT_NEEDED)) expect(candidates, f).toContain(f);
  });

  it('docs-checks runs the Solidity scan (Markdown is scanned too)', () => {
    expect(tokens.has('check-no-solidity.mjs')).toBe(true);
  });
});
