// review-gate (.github/workflows/review-gate.yml): the path classes and the whole gate script.
//
// CHORE-CI-DOCS-FASTLANE (owner decision D2, 2026-10-25): `docs-site/**` is S1 (audit-rules.md §2.2,
// D-57), except the one generated status page, whose source docs/status.yaml is S0.
// OPS-FAST-LANE-2 (owner Decision 54): the class is computed from the paths; a missing or lower
// declaration only warns; the independent review line is required for S2 and sensitive paths only;
// S2 keeps its Threat note and Tests-first evidence. The rules come from tools/pr/classes.mjs, which
// lifts them out of the workflow; the gate script itself runs here against a fake GitHub API.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classify, classifyFiles, isSensitive } from '../pr/classes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const yml = readFileSync(join(root, '.github', 'workflows', 'review-gate.yml'), 'utf8');

// The script is the indented block after `script: |`.
const lines = yml.split('\n');
const start = lines.findIndex((line) => /^\s+script: \|\s*$/.test(line));
const block = lines.slice(start + 1);
const indent = /^\s*/.exec(block[0])[0].length;
const source = block.map((line) => (line.trim() === '' ? '' : line.slice(indent))).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
const script = new AsyncFunction('github', 'context', 'core', source);

const HEAD = 'a'.repeat(40);

/** Runs the gate on a fake PR; returns { failed, errors, warnings }. */
async function gate({
  files,
  body,
  author = 'talirezun',
  reviews = [],
  draft = false,
  freeze = '',
  changedFiles,
  userType = 'User',
  headRef = 'feature/x',
  headRepo = '4thtech/agentlink',
  eventHeadSha = HEAD,
  releaseBot = '',
}) {
  const errors = [];
  const warnings = [];
  let failed = false;
  const core = {
    info() {},
    warning: (m) => warnings.push(m),
    error: (m) => errors.push(m),
    setFailed: () => {
      failed = true;
    },
  };
  const listFiles = Symbol('listFiles');
  const listReviews = Symbol('listReviews');
  const github = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            draft,
            body,
            user: { login: author, type: userType },
            head: { sha: HEAD, ref: headRef, repo: { full_name: headRepo } },
            base: { repo: { full_name: '4thtech/agentlink' } },
            changed_files: changedFiles ?? files.length,
          },
        }),
        listFiles,
        listReviews,
      },
    },
    paginate: async (fn) =>
      fn === listFiles
        ? files.map((f) => (typeof f === 'string' ? { filename: f, status: 'modified' } : f))
        : reviews,
  };
  const context = {
    eventName: 'pull_request',
    repo: { owner: '4thtech', repo: 'agentlink' },
    payload: { pull_request: { number: 1, head: { sha: eventHeadSha } } },
  };
  const saved = {
    DEPLOY_FREEZE: process.env.DEPLOY_FREEZE,
    RELEASE_BOT_LOGIN: process.env.RELEASE_BOT_LOGIN,
  };
  process.env.DEPLOY_FREEZE = freeze;
  process.env.RELEASE_BOT_LOGIN = releaseBot;
  try {
    await script(github, context, core);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return { failed, errors, warnings };
}

const classBox = (cls) =>
  ['S0', 'S1', 'S2'].map((c) => `- [${c === cls ? 'x' : ' '}] **${c}**: x`).join('\n');
function body({ cls = null, review = '', threat = '', redSha = '' } = {}) {
  return [
    '## Task ID & summary\nX-1: test.',
    `## Security class\n${cls ? classBox(cls) : classBox(null)}`,
    `## Independent review\n${review}`,
    `## Threat note\n${threat}`,
    `## Tests-first evidence\n${redSha}`,
  ].join('\n\n');
}

describe('review-gate path classes', () => {
  it('lifts the rules out of the workflow', () => {
    expect(classify('docs/foundation/04-security-and-crypto.md')).toBe(2);
  });

  it('a docs-site file is S1', () => {
    expect(classify('docs-site/guide/getting-started.md')).toBe(1);
    expect(classify('docs-site/technical/project/other.md')).toBe(1);
  });

  it('the generated status page is S0', () => {
    expect(classify('docs-site/technical/project/status-and-roadmap.md')).toBe(0);
  });

  it('only that exact page is exempt', () => {
    expect(classify('docs-site/technical/project/status-and-roadmap.md.bak')).toBe(1);
    expect(classify('docs-site/x/technical/project/status-and-roadmap.md')).toBe(1);
  });

  it('other docs stay as before', () => {
    expect(classify('docs/process/ci-cd.md')).toBe(1);
    expect(classify('docs/lessons/x.md')).toBe(0);
    expect(classify('knowledge/a.md')).toBe(0);
    expect(classify('README.md')).toBe(0);
    expect(classify('changelog.d/X.md')).toBe(0);
  });

  it('marks the AGENTS.md sensitive paths', () => {
    for (const p of [
      '.github/workflows/ci.yml',
      '.github/CODEOWNERS',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/settings.json',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'turbo.json',
      'renovate.json',
      'packages/x/.npmrc',
      'apps/y/.pnpmfile.cjs',
      '.gitleaks.toml',
      '.gitleaksignore',
      '.changeset/config.json',
      'tools/release/next-preview.mjs',
    ]) {
      expect(isSensitive(p), p).toBe(true);
      expect(classify(p), p).toBeGreaterThanOrEqual(1);
    }
    for (const p of [
      'packages/cli/package.json',
      'docs/process/x.md',
      'SECURITY.md',
      'tools/x.mjs',
      'tools/desktop-extension/build.mjs',
      '.changeset/x.md',
    ]) {
      expect(isSensitive(p), p).toBe(false);
    }
  });

  it('classifyFiles: the highest class wins; review only for S2 or sensitive', () => {
    expect(classifyFiles(['README.md'])).toMatchObject({ cls: 0, reviewRequired: false });
    expect(classifyFiles(['apps/cli/src/a.ts'])).toMatchObject({
      cls: 1,
      sensitive: false,
      reviewRequired: false,
    });
    expect(classifyFiles(['README.md', 'AGENTS.md'])).toMatchObject({
      cls: 1,
      sensitive: true,
      reviewRequired: true,
    });
    expect(classifyFiles(['packages/core/src/a.ts', 'README.md'])).toMatchObject({
      cls: 2,
      reviewRequired: true,
    });
  });
});

describe('review-gate: computed class, warnings for formalities (Decision 54)', () => {
  it('S0 with no ticked class passes with a warning', async () => {
    const r = await gate({ files: ['README.md'], body: body() });
    expect(r.failed).toBe(false);
    expect(r.warnings.join('\n')).toContain('computed class S0 applies');
  });

  it('S1 outside the sensitive paths passes without an IR line', async () => {
    const r = await gate({ files: ['apps/cli/src/a.ts'], body: body({ cls: 'S1' }) });
    expect(r).toEqual({ failed: false, errors: [], warnings: [] });
  });

  it('a lower declared class is a warning, not a failure', async () => {
    const r = await gate({ files: ['apps/cli/src/a.ts'], body: body({ cls: 'S0' }) });
    expect(r.failed).toBe(false);
    expect(r.warnings.join('\n')).toContain('declared S0, but the changed files are S1');
  });

  it('an empty body on an S1 path passes with a warning', async () => {
    const r = await gate({ files: ['packages/ui/src/a.tsx'], body: '' });
    expect(r.failed).toBe(false);
    expect(r.warnings.length).toBe(1);
  });

  it('a stated FAIL verdict still fails, at any class', async () => {
    const r = await gate({
      files: ['README.md'],
      body: body({ cls: 'S0', review: 'IR-X-1: verdict FAIL' }),
    });
    expect(r.failed).toBe(true);
    expect(r.errors.join('\n')).toContain('verdict is FAIL');
  });
});

describe('review-gate: the review stays required where the risk is', () => {
  it('sensitive S1 paths need the IR line', async () => {
    for (const f of [
      '.github/workflows/ci.yml',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/settings.json',
      'pnpm-lock.yaml',
    ]) {
      const r = await gate({ files: [f], body: body({ cls: 'S1' }) });
      expect(r.failed, f).toBe(true);
      expect(r.errors.join('\n'), f).toContain(
        'on sensitive paths: the "Independent review" section is empty',
      );
      const ok = await gate({
        files: [f],
        body: body({ cls: 'S1', review: 'IR-X-1-1: PASS at abc' }),
      });
      expect(ok.failed, f).toBe(false);
    }
  });

  it('a sensitive path declared S0 still needs the IR line', async () => {
    const r = await gate({ files: ['.github/workflows/ci.yml'], body: body({ cls: 'S0' }) });
    expect(r.failed).toBe(true);
  });

  it('S2 needs the IR line, the threat note and the tests-first evidence', async () => {
    const files = ['packages/core/src/a.ts'];
    const bare = await gate({ files, body: body({ cls: 'S2' }) });
    expect(bare.failed).toBe(true);
    const msg = bare.errors.join('\n');
    expect(msg).toContain('S2: the "Independent review" section is empty');
    expect(msg).toContain('"Threat note" section is empty');
    expect(msg).toContain('"Tests-first evidence" section is empty');
    const full = await gate({
      files,
      body: body({
        cls: 'S2',
        review: 'IR-X-1-1: PASS at abc',
        threat: 'Full note.',
        redSha: 'RED abc, pnpm test',
      }),
    });
    expect(full).toEqual({ failed: false, errors: [], warnings: [] });
  });

  it('S2 with an undeclared or lower class still needs the S2 evidence', async () => {
    for (const cls of [null, 'S0', 'S1']) {
      const r = await gate({
        files: ['test-vectors/x.json'],
        body: body({ cls, review: 'IR-X-1-1: PASS' }),
      });
      expect(r.failed, String(cls)).toBe(true);
      expect(r.errors.join('\n')).toContain('Threat note');
    }
  });

  it('S2 placeholders do not count as filled', async () => {
    const r = await gate({
      files: ['packages/crypto/src/a.ts'],
      body: body({ cls: 'S2', review: 'IR-X-1-1: PASS', threat: 'TODO', redSha: 'N/A' }),
    });
    expect(r.failed).toBe(true);
  });

  it('a higher declaration raises the class (content-rule S2 on an S1 path)', async () => {
    const r = await gate({ files: ['apps/cli/src/a.ts'], body: body({ cls: 'S2' }) });
    expect(r.failed).toBe(true);
    expect(r.errors.join('\n')).toContain('S2: the "Independent review" section is empty');
  });

  it('a truncated file list is S2 and sensitive', async () => {
    const r = await gate({ files: ['README.md'], body: body({ cls: 'S0' }), changedFiles: 3001 });
    expect(r.failed).toBe(true);
    expect(r.errors.join('\n')).toContain('S2: the "Independent review" section is empty');
  });

  it('DEPLOY_FREEZE still fails', async () => {
    const r = await gate({ files: ['README.md'], body: body({ cls: 'S0' }), freeze: 'true' });
    expect(r.failed).toBe(true);
  });

  it('a draft still fails fast', async () => {
    expect(
      (await gate({ files: ['README.md'], body: body({ cls: 'S0' }), draft: true })).failed,
    ).toBe(true);
  });
});

describe('review-gate: automated PRs keep the code-owner approval', () => {
  const approved = [{ user: { login: 'talirezun' }, state: 'APPROVED', commit_id: HEAD }];
  it('a Renovate lockfile PR needs an approval on the head commit', async () => {
    const r = await gate({ files: ['pnpm-lock.yaml'], body: '', author: 'renovate[bot]' });
    expect(r.failed).toBe(true);
    const ok = await gate({
      files: ['pnpm-lock.yaml'],
      body: '',
      author: 'renovate[bot]',
      reviews: approved,
    });
    expect(ok.failed).toBe(false);
  });

  it('an S1 bot PR outside the sensitive paths still needs it', async () => {
    const r = await gate({
      files: ['apps/cli/package.json'],
      body: '',
      author: 'github-actions[bot]',
    });
    expect(r.failed).toBe(true);
  });
});

// OPS-UNSTICK-B: the Changesets "Version packages" PR opened by the release GitHub App is a mechanical
// S0 when its diff has the version shape: `packages|apps/*/package.json` version and internal
// dependency-range lines only, CHANGELOG.md files, and deleted `.changeset/*.md` / `changelog.d/*.md`.
// Anything else falls back to the automated-PR rule (a code-owner approval on the head commit).
describe('review-gate: mechanical version PR (OPS-UNSTICK-B)', () => {
  const BOT = 'agentlink-release[bot]';
  const pkg = (path, from = '0.4.9', to = '0.4.10', extra = '') => ({
    filename: path,
    status: 'modified',
    patch:
      `@@ -1,6 +1,6 @@\n {\n   "name": "@4thtech-io/x",\n-  "version": "${from}",\n+  "version": "${to}",\n` +
      `   "private": true,\n${extra}`,
  });
  const removed = (filename) => ({
    filename,
    status: 'removed',
    patch: '@@ -1,5 +0,0 @@\n----\n-x\n',
  });
  const versionFiles = () => [
    removed('.changeset/w7-id-b2.md'),
    removed('changelog.d/W7-ID-B0.md'),
    {
      filename: 'CHANGELOG.md',
      status: 'modified',
      patch: '@@ -1 +1,2 @@\n-## [Unreleased]\n+## [0.4.10] - 2026-11-02\n',
    },
    {
      filename: 'packages/crypto/CHANGELOG.md',
      status: 'modified',
      patch: '@@ -1 +1,2 @@\n+## 0.4.10\n',
    },
    pkg('packages/crypto/package.json'),
    pkg('packages/core/package.json'),
    pkg('apps/cli/package.json'),
    pkg('apps/drop/package.json'),
  ];
  const versionPr = (over = {}) =>
    gate({
      files: versionFiles(),
      body: 'Changesets body, no sections.',
      author: BOT,
      userType: 'Bot',
      headRef: 'changeset-release/main',
      releaseBot: BOT,
      ...over,
    });
  const approved = [{ user: { login: 'talirezun' }, state: 'APPROVED', commit_id: HEAD }];

  it('passes as S0 with no IR, threat note, tests-first evidence or approval', async () => {
    const r = await versionPr();
    expect(r).toEqual({ failed: false, errors: [], warnings: [] });
  });

  it('accepts internal dependency-range bumps', async () => {
    const files = versionFiles();
    files.push({
      filename: 'apps/invite/package.json',
      status: 'modified',
      patch:
        '@@ -10,4 +10,4 @@\n   "dependencies": {\n-    "@4thtech-io/core": "^0.4.9",\n+    "@4thtech-io/core": "^0.4.10",\n' +
        '-    "@4thtech-io/types": "workspace:0.4.9"\n+    "@4thtech-io/types": "workspace:0.4.10"\n   }\n',
    });
    expect((await versionPr({ files })).failed).toBe(false);
  });

  it('a non-version file makes it an ordinary automated PR (approval needed)', async () => {
    const files = [...versionFiles(), 'packages/crypto/src/a.ts'];
    const r = await versionPr({ files });
    expect(r.failed).toBe(true);
    expect(r.errors.join('\n')).toContain('APPROVED review on the current head commit');
    expect(r.warnings.join('\n')).toContain('packages/crypto/src/a.ts');
    expect(
      (await versionPr({ files, reviews: approved, body: body({ threat: 'n', redSha: 'r' }) }))
        .failed,
    ).toBe(false);
  });

  it('rejects package.json changes beyond version lines', async () => {
    for (const extra of [
      '+  "scripts": { "postinstall": "curl x | sh" },\n',
      '+    "@4thtech-io/core": "^0.4.10",\n',
      '-  "files": ["dist"],\n',
      '+    "left-pad": "1.3.0",\n',
    ]) {
      const files = [
        ...versionFiles(),
        pkg('packages/node/package.json', '0.4.9', '0.4.10', extra),
      ];
      expect((await versionPr({ files })).failed, extra).toBe(true);
    }
  });

  it('rejects a version value that is not a plain semver', async () => {
    const files = [...versionFiles(), pkg('packages/node/package.json', '0.4.9', 'file:../x')];
    expect((await versionPr({ files })).failed).toBe(true);
  });

  it('rejects a package.json without a patch (too large to diff)', async () => {
    const files = [
      ...versionFiles(),
      { filename: 'packages/node/package.json', status: 'modified' },
    ];
    expect((await versionPr({ files })).failed).toBe(true);
  });

  it('rejects the root package.json, added changesets, renames and non-markdown deletions', async () => {
    for (const f of [
      pkg('package.json'),
      { filename: '.changeset/new.md', status: 'added', patch: '@@ -0,0 +1 @@\n+x\n' },
      { filename: '.changeset/config.json', status: 'removed' },
      { filename: '.changeset/README.md', status: 'removed' },
      { filename: 'changelog.d/README.md', status: 'removed' },
      {
        filename: 'packages/core/CHANGELOG.md',
        previous_filename: 'packages/core/src/a.ts',
        status: 'renamed',
      },
      { filename: 'packages/core/src/CHANGELOG.md', status: 'added', patch: '@@ -0,0 +1 @@\n+x\n' },
      { filename: '.changeset/pre.json', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b\n' },
    ]) {
      const files = [...versionFiles(), f];
      expect((await versionPr({ files })).failed, f.filename).toBe(true);
    }
  });

  it('only for the configured release App, as a Bot, on changeset-release/* in this repository', async () => {
    for (const over of [
      { releaseBot: '' },
      { author: 'github-actions[bot]' },
      { author: 'talirezun', userType: 'User', releaseBot: 'talirezun' },
      { userType: 'User' },
      { headRef: 'feature/changeset-release/main' },
      { headRepo: 'someone/agentlink' },
    ]) {
      expect((await versionPr(over)).failed, JSON.stringify(over)).toBe(true);
    }
  });

  it('only when the head commit has not moved since the event', async () => {
    expect((await versionPr({ eventHeadSha: 'b'.repeat(40) })).failed).toBe(true);
  });

  it('a truncated file list is never mechanical', async () => {
    expect((await versionPr({ changedFiles: 3001 })).failed).toBe(true);
  });

  it('DEPLOY_FREEZE still fails it', async () => {
    expect((await versionPr({ freeze: 'true' })).failed).toBe(true);
  });
});
