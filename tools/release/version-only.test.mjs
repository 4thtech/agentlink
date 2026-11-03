import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyVersionOnly } from './version-only.mjs';
import { parseArgs, run as runCommand, waitForGreen } from './wait-for-ci.mjs';

// RELEASE-VERSION-ONLY-REUSE: ci-green may reuse the parent's green CI verdict when the release
// commit differs from its first parent only by version bookkeeping. The classification comes from
// the git trees alone (a real fixture repository here), never from a commit message or PR title.

const pkg = (version, extra = {}) => ({
  name: '@4thtech-io/core',
  version,
  type: 'module',
  scripts: { build: 'tsc -b', test: 'vitest run' },
  dependencies: { '@4thtech-io/crypto': 'workspace:^0.4.10', viem: '2.21.0' },
  devDependencies: { vitest: '3.2.4' },
  ...extra,
});
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

describe('classifyVersionOnly on a fixture repository', () => {
  let dir;
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  // Paths inside the temporary fixture repository, not the real doc trees.
  const remove = (path) => rmSync(join(dir, path));
  const commit = (msg = 'chore: version packages') => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };
  const classify = (sha) =>
    classifyVersionOnly({ cwd: dir, sha: sha ?? git('rev-parse', 'HEAD').trim() });
  let base;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'version-only-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    write('package.json', json({ name: 'root', private: true, version: '0.0.0' }));
    write('packages/core/package.json', json(pkg('0.4.10')));
    write('packages/core/src/index.ts', 'export const x = 1;\n');
    write('packages/crypto/package.json', json({ name: '@4thtech-io/crypto', version: '0.4.10' }));
    write('packages/core/CHANGELOG.md', '# core\n');
    write('CHANGELOG.md', '# AgentLink\n');
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('.changeset/config.json', '{}\n');
    write('.changeset/brave-fox.md', '---\n"@4thtech-io/core": patch\n---\n\nFix.\n');
    write('changelog.d/README.md', 'fragments\n');
    write('changelog.d/123-fix.md', '- Fixed.\n');
    base = commit('base');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const versionBump = () => {
    write('packages/core/package.json', json(pkg('0.4.11')));
    write('packages/crypto/package.json', json({ name: '@4thtech-io/crypto', version: '0.4.11' }));
    write('packages/core/CHANGELOG.md', '# core\n\n## 0.4.11\n\n- Fix.\n');
    write('CHANGELOG.md', '# AgentLink\n\n## 0.4.11\n');
    remove('.changeset/brave-fox.md');
    remove('changelog.d/123-fix.md');
  };

  it('accepts a Changesets version commit and names its parent', () => {
    versionBump();
    commit();
    const r = classify();
    expect(r.versionOnly).toBe(true);
    expect(r.parent).toBe(base);
  });

  it('accepts an internal dependency version bump that keeps its workspace: and range prefix', () => {
    versionBump();
    write(
      'packages/core/package.json',
      json(
        pkg('0.4.11', {
          dependencies: { '@4thtech-io/crypto': 'workspace:^0.4.11', viem: '2.21.0' },
        }),
      ),
    );
    commit();
    expect(classify().versionOnly).toBe(true);
  });

  it('accepts a new package CHANGELOG.md', () => {
    versionBump();
    write('packages/crypto/CHANGELOG.md', '# crypto\n\n## 0.4.11\n');
    commit();
    expect(classify().versionOnly).toBe(true);
  });

  it('ignores the commit message: a "Version packages" title does not make a code change version-only', () => {
    write('packages/core/src/index.ts', 'export const x = 2;\n');
    commit('CHORE: Version packages');
    expect(classify().versionOnly).toBe(false);
  });

  it('rejects a sneaky code change hidden among version bumps', () => {
    versionBump();
    write('packages/core/src/index.ts', 'export const x = 1; fetch("https://evil.example");\n');
    commit();
    const r = classify();
    expect(r.versionOnly).toBe(false);
    expect(r.reasons.join('\n')).toContain('packages/core/src/index.ts');
  });

  it('rejects a lockfile change that adds a dependency', () => {
    versionBump();
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  evil@1.0.0: {}\n");
    commit();
    const r = classify();
    expect(r.versionOnly).toBe(false);
    expect(r.reasons.join('\n')).toContain('pnpm-lock.yaml');
  });

  it('rejects a scripts field change in package.json', () => {
    versionBump();
    write(
      'packages/core/package.json',
      json(
        pkg('0.4.11', { scripts: { build: 'tsc -b', test: 'vitest run', prepack: 'node x.js' } }),
      ),
    );
    commit();
    expect(classify().versionOnly).toBe(false);
  });

  it('rejects a new external dependency, a changed external range and a dropped workspace: prefix', () => {
    for (const dependencies of [
      { '@4thtech-io/crypto': 'workspace:^0.4.10', viem: '2.21.0', evil: '1.0.0' },
      { '@4thtech-io/crypto': 'workspace:^0.4.10', viem: '2.22.0' },
      { '@4thtech-io/crypto': '^0.4.11', viem: '2.21.0' },
      { '@4thtech-io/crypto': 'workspace:~0.4.11', viem: '2.21.0' },
      {
        '@4thtech-io/crypto': 'workspace:^0.4.10',
        '@4thtech-io/evil': 'workspace:^0.4.10',
        viem: '2.21.0',
      },
    ]) {
      git('reset', '-q', '--hard', base);
      versionBump();
      write('packages/core/package.json', json(pkg('0.4.11', { dependencies })));
      commit();
      expect(classify().versionOnly, JSON.stringify(dependencies)).toBe(false);
    }
  });

  it('rejects a duplicate key that would override a field on parse', () => {
    versionBump();
    const text = json(pkg('0.4.11')).replace(
      '"version": "0.4.11",',
      '"version": "0.4.11",\n  "scripts": { "prepack": "node x.js" },',
    );
    write('packages/core/package.json', text);
    commit();
    expect(classify().versionOnly).toBe(false);
  });

  it('rejects a version value that is not semver', () => {
    write('packages/core/package.json', json(pkg('0.4.11 || evil')));
    commit();
    expect(classify().versionOnly).toBe(false);
  });

  it('rejects the root package.json, a new file, a kept or added changeset and pre.json', () => {
    const cases = [
      () => write('package.json', json({ name: 'root', private: true, version: '0.0.1' })),
      () => write('packages/core/postinstall.js', 'x\n'),
      () => write('.changeset/new-one.md', '---\n---\n'),
      () => write('.changeset/pre.json', '{"mode":"pre","tag":"next"}\n'),
      () => remove('changelog.d/README.md'),
      () => write('packages/core/README.md', 'changed\n'),
    ];
    for (const change of cases) {
      git('reset', '-q', '--hard', base);
      versionBump();
      change();
      commit();
      expect(classify().versionOnly, String(change)).toBe(false);
    }
  });

  it('rejects a mode change and a symlinked CHANGELOG.md', () => {
    versionBump();
    chmodSync(join(dir, 'packages/core/package.json'), 0o755);
    commit();
    expect(classify().versionOnly).toBe(false);

    git('reset', '-q', '--hard', base);
    versionBump();
    remove('packages/core/CHANGELOG.md');
    symlinkSync('../../pnpm-lock.yaml', join(dir, 'packages/core/CHANGELOG.md'));
    commit();
    expect(classify().versionOnly).toBe(false);
  });

  it('rejects a commit without package.json changes and an empty commit', () => {
    remove('.changeset/brave-fox.md');
    commit();
    expect(classify().versionOnly).toBe(false);
    commit('empty');
    expect(classify().versionOnly).toBe(false);
  });

  it('rejects a merge commit and a root commit', () => {
    git('checkout', '-q', '-b', 'side');
    write('packages/core/src/index.ts', 'export const x = 3;\n');
    commit('side');
    git('checkout', '-q', 'main');
    versionBump();
    commit();
    git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    expect(classify().versionOnly).toBe(false);

    const root = git('rev-list', '--max-parents=0', 'HEAD').trim();
    expect(classify(root).versionOnly).toBe(false);
  });

  it('fails closed when the sha is not the checked-out HEAD or does not exist', () => {
    versionBump();
    commit();
    expect(classify(base).versionOnly).toBe(false);
    expect(classify('f'.repeat(40)).versionOnly).toBe(false);
  });
});

// The ci-green side: reuse only when the parent's push runs on main are green on BOTH gates.
const REPO = '4thtech/agentlink';
const SHA = 'a'.repeat(40);
const PARENT = 'c'.repeat(40);
const REQUIRE = [
  { workflow: 'ci.yml', job: 'ci-gate (push)' },
  { workflow: 'security.yml', job: 'security-gate' },
];

// verdicts: { [sha]: { ci: 'success' | 'failure' | 'pending' | 'missing', security: ... } }
function fakeApi(verdicts) {
  const ids = { ci: 1, security: 2 };
  return async (pathWithQuery) => {
    const [path, query = ''] = pathWithQuery.split('?');
    const params = new URLSearchParams(query);
    const m = /\/actions\/workflows\/(ci|security)\.yml\/runs$/.exec(path);
    if (m) {
      const sha = params.get('head_sha');
      const v = verdicts[sha]?.[m[1]] ?? 'missing';
      if (v === 'missing') return { workflow_runs: [] };
      const id = (sha === SHA ? 100 : 200) + ids[m[1]];
      return {
        workflow_runs: [
          {
            id,
            head_sha: sha,
            head_branch: 'main',
            event: 'push',
            path: `.github/workflows/${m[1]}.yml`,
            status: v === 'pending' ? 'in_progress' : 'completed',
            conclusion: v === 'pending' ? null : v,
          },
        ],
      };
    }
    const j = /\/actions\/runs\/(\d+)\/jobs$/.exec(path);
    if (j) {
      const id = Number(j[1]);
      const sha = id >= 200 ? PARENT : SHA;
      const wf = id % 100 === 1 ? 'ci' : 'security';
      const v = verdicts[sha][wf];
      const name = wf === 'ci' ? 'ci-gate (push)' : 'security-gate';
      return {
        jobs: [
          v === 'pending'
            ? { name, status: 'in_progress', conclusion: null }
            : { name, status: 'completed', conclusion: v },
        ],
      };
    }
    throw new Error(`unexpected API path ${path}`);
  };
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const wait = (verdicts, extra = {}) => {
  const clock = fakeClock();
  return waitForGreen({
    api: fakeApi(verdicts),
    repo: REPO,
    sha: SHA,
    require: REQUIRE,
    timeoutMs: 60 * 60_000,
    intervalMs: 30_000,
    missingGraceMs: 10 * 60_000,
    now: clock.now,
    sleep: clock.sleep,
    log: () => {},
    ...extra,
  });
};

describe('waitForGreen with a version-only parent', () => {
  it('reuses the parent verdict when both of its gates are green, without the own CI', async () => {
    const r = await wait(
      {
        [PARENT]: { ci: 'success', security: 'success' },
        [SHA]: { ci: 'pending', security: 'pending' },
      },
      { reuseParent: PARENT },
    );
    expect(r).toMatchObject({ ok: true, reused: PARENT });
  });

  it('does not reuse without the option', async () => {
    const r = await wait({
      [PARENT]: { ci: 'success', security: 'success' },
      [SHA]: { ci: 'failure', security: 'success' },
    });
    expect(r.ok).toBe(false);
    expect(r.reused).toBeUndefined();
  });

  it('falls back to the own CI when the parent is red', async () => {
    const red = await wait(
      {
        [PARENT]: { ci: 'failure', security: 'success' },
        [SHA]: { ci: 'failure', security: 'success' },
      },
      { reuseParent: PARENT },
    );
    expect(red.ok).toBe(false);
    const green = await wait(
      {
        [PARENT]: { ci: 'success', security: 'failure' },
        [SHA]: { ci: 'success', security: 'success' },
      },
      { reuseParent: PARENT },
    );
    expect(green).toMatchObject({ ok: true });
    expect(green.reused).toBeUndefined();
  });

  it('falls back to the own CI when the parent has no push run', async () => {
    const r = await wait(
      {
        [PARENT]: { ci: 'missing', security: 'success' },
        [SHA]: { ci: 'failure', security: 'success' },
      },
      { reuseParent: PARENT },
    );
    expect(r.ok).toBe(false);
    expect(r.reused).toBeUndefined();
  });

  it('keeps waiting while the parent is pending and fails on the own red', async () => {
    const r = await wait(
      {
        [PARENT]: { ci: 'pending', security: 'success' },
        [SHA]: { ci: 'failure', security: 'success' },
      },
      { reuseParent: PARENT },
    );
    expect(r.ok).toBe(false);
  });
});

describe('wait-for-ci --reuse-version-only-parent', () => {
  const env = { GH_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA };
  const argv = [
    '--require',
    'ci.yml:ci-gate (push)',
    '--require',
    'security.yml:security-gate',
    '--reuse-version-only-parent',
  ];

  it('parses the flag', () => {
    expect(parseArgs(argv).reuseVersionOnlyParent).toBe(true);
    expect(parseArgs(argv.slice(0, 4)).reuseVersionOnlyParent).toBe(false);
  });

  it('writes result=green, the reused sha and the run summary line', async () => {
    const outputs = [];
    const summary = [];
    const clock = fakeClock();
    const code = await runCommand({
      argv,
      env,
      api: fakeApi({
        [PARENT]: { ci: 'success', security: 'success' },
        [SHA]: { ci: 'pending', security: 'pending' },
      }),
      classify: () => ({ versionOnly: true, parent: PARENT, reasons: [] }),
      writeOutput: (l) => outputs.push(l),
      writeSummary: (l) => summary.push(l),
      log: () => {},
      ...clock,
    });
    expect(code).toBe(0);
    expect(outputs).toContain('result=green');
    expect(outputs).toContain(`reused_from=${PARENT}`);
    expect(summary.join('\n')).toContain(`reused CI verdict of ${PARENT}: version-only`);
  });

  it('waits for the own CI when the commit is not version-only', async () => {
    const outputs = [];
    const clock = fakeClock();
    const code = await runCommand({
      argv,
      env,
      api: fakeApi({
        [PARENT]: { ci: 'success', security: 'success' },
        [SHA]: { ci: 'failure', security: 'success' },
      }),
      classify: () => ({ versionOnly: false, reasons: ['src/x.ts: not part of a version change'] }),
      writeOutput: (l) => outputs.push(l),
      writeSummary: () => {},
      log: () => {},
      ...clock,
    });
    expect(code).toBe(1);
    expect(outputs).not.toContain('result=green');
  });

  it('fails closed to the own CI when the classifier throws', async () => {
    const clock = fakeClock();
    const code = await runCommand({
      argv,
      env,
      api: fakeApi({
        [PARENT]: { ci: 'success', security: 'success' },
        [SHA]: { ci: 'failure', security: 'success' },
      }),
      classify: () => {
        throw new Error('git missing');
      },
      writeOutput: () => {},
      writeSummary: () => {},
      log: () => {},
      ...clock,
    });
    expect(code).toBe(1);
  });
});
