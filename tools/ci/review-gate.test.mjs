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

  it('INSTALLER-1: the one-line installers are S2 and sensitive, and so is the site that serves them', () => {
    for (const p of ['installer/install.sh', 'installer/install.ps1', 'installer/README.md']) {
      expect(classify(p), p).toBe(2);
      expect(isSensitive(p), p).toBe(true);
    }
    for (const p of [
      'apps/invite/vite.config.ts',
      'apps/invite/site/_headers',
      'apps/invite/src/main.ts',
      'tools/installer/install-sh.test.mjs',
      'tools/installer/fixtures.mjs',
    ]) {
      expect(isSensitive(p), p).toBe(true);
    }
    expect(classify('apps/invite/site/_headers')).toBe(1);
    expect(isSensitive('apps/invitex/a.ts')).toBe(false);
    expect(isSensitive('tools/installerx.mjs')).toBe(false);
    expect(classifyFiles(['installer/install.sh'])).toMatchObject({ cls: 2, reviewRequired: true });
  });

  it('INSTALLER-1: CODEOWNERS and audit-rules §2.2 list the installer paths', () => {
    const codeowners = readFileSync(join(root, '.github/CODEOWNERS'), 'utf8');
    for (const path of ['/installer/', '/apps/invite/', '/tools/installer/']) {
      expect(codeowners).toMatch(
        new RegExp(`^${path.replaceAll('/', '\\/')}\\s+@talirezun @denisjazbec$`, 'm'),
      );
    }
    const rules = readFileSync(join(root, 'docs/process/audit-rules.md'), 'utf8');
    expect(rules).toMatch(/^\| `installer\/\*\*` \| S2 \|/m);
  });

  it('D-145: the desktop apps and the core desktop host are S2, and CODEOWNERS and audit-rules list them', () => {
    for (const p of [
      'apps/desktop/package.json',
      'apps/desktop/src/main/main.ts',
      'apps/cli/src/desktop/host.ts',
    ]) {
      expect(classify(p), p).toBe(2);
    }
    expect(classify('apps/cli/src/commands/ui.ts')).toBe(1);
    expect(classify('apps/desktopx/a.ts')).toBe(0);
    expect(classifyFiles(['apps/desktop/src/main/main.ts'])).toMatchObject({
      cls: 2,
      reviewRequired: true,
    });
    const codeowners = readFileSync(join(root, '.github/CODEOWNERS'), 'utf8');
    for (const path of ['/apps/desktop/', '/apps/cli/src/desktop/']) {
      expect(codeowners).toMatch(
        new RegExp(`^${path.replaceAll('/', '\\/')}\\s+@talirezun @denisjazbec$`, 'm'),
      );
    }
    const rules = readFileSync(join(root, 'docs/process/audit-rules.md'), 'utf8');
    expect(rules).toMatch(/^\| `apps\/desktop\/\*\*`, `apps\/cli\/src\/desktop\/\*\*` \| S2 \|/m);
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

// OPS-UNSTICK-A (report RC-2, RC-5, C3): with cancel-in-progress, a close/reopen or an edit that
// adds the IR line cancelled the run in flight and left a cancelled required check (#772, #770,
// #761). Runs now queue: the newest pending run replaces an older pending one, nothing in flight is
// cancelled, and the last run reads the PR's current state, so the final state is what counts.
describe('review-gate and pr-hygiene: no cancelled required checks', () => {
  const hygiene = readFileSync(join(root, '.github', 'workflows', 'pr-hygiene.yml'), 'utf8');
  for (const [name, text] of [
    ['review-gate', yml],
    ['pr-hygiene', hygiene],
  ]) {
    it(`${name} never cancels a run in progress`, () => {
      expect(text).toMatch(/\nconcurrency:\n {2}group: [^\n]+\n {2}cancel-in-progress: false\n/);
      expect(text).not.toMatch(/cancel-in-progress: true/);
    });
  }

  it('review-gate re-runs when the body is edited and reads the current PR, not the payload', () => {
    expect(yml).toMatch(/types: \[opened, edited, synchronize, reopened, ready_for_review\]/);
    expect(source).toMatch(/github\.rest\.pulls\.get\(/);
  });
});

// OPS-UNSTICK-A (IR F1): tools/ci/ holds the test quarantine and CI gate scripts; a change there can
// relax a gate, so it is S1, sensitive and code-owned.
describe('review-gate: tools/ci is sensitive', () => {
  it('classes tools/ci files S1 and sensitive', () => {
    for (const f of ['tools/ci/quarantine.json', 'tools/ci/quarantine.mjs', 'tools/ci/x/y.mjs']) {
      expect(classify(f), f).toBe(1);
      expect(isSensitive(f), f).toBe(true);
    }
    expect(isSensitive('tools/cix/a.mjs')).toBe(false);
  });

  it('CODEOWNERS owns /tools/ci/', () => {
    const owners = readFileSync(join(root, '.github', 'CODEOWNERS'), 'utf8');
    expect(owners).toMatch(/^\/tools\/ci\/\s+@talirezun @denisjazbec$/m);
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
  // Not mechanical: falls back to the automated-PR rule, so it fails without an approval, and says why.
  const notMechanical = (r, label) => {
    expect(r.failed, label).toBe(true);
    expect(r.warnings.join('\n'), label).toContain('without the version shape');
  };

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
        '@@ -10,4 +10,4 @@\n   "dependencies": {\n-    "@4thtech-io/core": "^0.4.9",\n' +
        '-    "@4thtech-io/types": "workspace:0.4.9"\n+    "@4thtech-io/core": "^0.4.10",\n' +
        '+    "@4thtech-io/types": "workspace:0.4.10"\n   }\n',
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
      notMechanical(await versionPr({ files }), extra);
    }
  });

  it('rejects a dependency that moves between blocks (Fable IR, low)', async () => {
    const files = [
      ...versionFiles(),
      {
        filename: 'apps/invite/package.json',
        status: 'modified',
        patch:
          '@@ -10,8 +10,8 @@\n   "dependencies": {\n-    "@4thtech-io/core": "^0.4.9"\n+    "@4thtech-io/types": "^0.4.10"\n' +
          '   },\n   "devDependencies": {\n-    "@4thtech-io/types": "^0.4.9"\n+    "@4thtech-io/core": "^0.4.10"\n   }\n',
      },
    ];
    notMechanical(await versionPr({ files }));
  });

  it('rejects a version value that is not a plain semver', async () => {
    const files = [...versionFiles(), pkg('packages/node/package.json', '0.4.9', 'file:../x')];
    notMechanical(await versionPr({ files }));
  });

  it('rejects a package.json without a patch (too large to diff)', async () => {
    const files = [
      ...versionFiles(),
      { filename: 'packages/node/package.json', status: 'modified' },
    ];
    notMechanical(await versionPr({ files }));
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
      notMechanical(await versionPr({ files }), f.filename);
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

  it('ignores RELEASE_BOT_LOGIN when it names a generic bot (Fable IR, low)', async () => {
    for (const generic of ['github-actions[bot]', 'renovate[bot]', 'dependabot[bot]']) {
      const r = await versionPr({ author: generic, releaseBot: generic });
      expect(r.failed, generic).toBe(true);
      expect(r.warnings.join('\n'), generic).not.toContain('without the version shape');
    }
  });

  it('only when the head commit has not moved since the event', async () => {
    notMechanical(await versionPr({ eventHeadSha: 'b'.repeat(40) }));
  });

  it('a truncated file list is never mechanical', async () => {
    notMechanical(await versionPr({ changedFiles: 3001 }));
  });

  it('DEPLOY_FREEZE still fails it', async () => {
    expect((await versionPr({ freeze: 'true' })).failed).toBe(true);
  });
});
