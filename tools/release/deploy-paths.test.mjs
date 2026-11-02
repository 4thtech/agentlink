import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitRunner, headCheck, pathspecs, pushPaths, run } from './deploy-paths.mjs';

// OPS-UNSTICK-A: a production deploy is skipped only when a NEWER commit on main changes this
// service's own paths (the workflow's `on.push.paths`). A newer docs-only commit no longer skips
// it: this run's bundle is what main's head would build for this service, so it deploys.

const root = resolve(import.meta.dirname, '../..');
const DEPLOY_WORKFLOWS = ['deploy-drop.yml', 'deploy-submitter.yml', 'deploy-invite.yml'];

describe('pushPaths', () => {
  it('reads on.push.paths of every deploy workflow', () => {
    for (const file of DEPLOY_WORKFLOWS) {
      const paths = pushPaths(readFileSync(join(root, '.github/workflows', file), 'utf8'));
      expect(paths.length, file).toBeGreaterThan(3);
      expect(paths).toContain(`.github/workflows/${file}`);
      expect(paths).toContain('tools/release/deploy-paths.mjs');
    }
  });

  it('returns null without a push paths filter', () => {
    expect(pushPaths('name: x\non:\n  push:\n    branches: [main]\n')).toBeNull();
  });
});

describe('pathspecs', () => {
  it('turns GitHub filter patterns into git glob pathspecs', () => {
    expect(pathspecs(['apps/drop/**', 'pnpm-lock.yaml'])).toEqual([
      ':(glob)apps/drop/**',
      ':(glob)pnpm-lock.yaml',
    ]);
  });

  it('refuses negated or empty pattern lists (fail closed)', () => {
    expect(() => pathspecs(['!apps/x/**'])).toThrow();
    expect(() => pathspecs([])).toThrow();
    expect(() => pathspecs(null)).toThrow();
  });
});

// A real repository: main = A (service) -> B (docs) -> C (service) -> D (docs).
function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-paths-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.test',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.test',
      },
    }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('init', '-q', '-b', 'main');
  const commit = (path, text) => {
    write(path, text);
    git('add', '-A');
    git('commit', '-q', '-m', path);
    return git('rev-parse', 'HEAD');
  };
  const A = commit('apps/drop/src/a.ts', 'a');
  const B = commit('docs/readme.md', 'b');
  const C = commit('apps/drop/src/c.ts', 'c');
  const D = commit('docs/other.md', 'd');
  git('update-ref', 'refs/remotes/origin/main', D);
  return { dir, A, B, C, D };
}

describe('gitRunner and headCheck on a real repository', () => {
  const repo = fixtureRepo();
  const git = gitRunner({ cwd: repo.dir });
  const specs = pathspecs(['apps/drop/**']);

  it("reads main's head from origin/main", () => {
    expect(git.head()).toBe(repo.D);
  });

  it('is current at the head, and when only unrelated commits follow', () => {
    expect(headCheck({ git, sha: repo.D, specs })).toMatchObject({ current: true, head: repo.D });
    expect(headCheck({ git, sha: repo.C, specs })).toMatchObject({
      current: true,
      head: repo.D,
      newer: [],
    });
  });

  it('is not current when a newer commit changes the service', () => {
    expect(headCheck({ git, sha: repo.A, specs })).toMatchObject({
      current: false,
      head: repo.D,
      newer: [repo.C],
    });
    expect(headCheck({ git, sha: repo.B, specs }).current).toBe(false);
  });

  it('finds the newest commit that changes the service, and ancestry', () => {
    expect(git.lastTouch(repo.D, specs)).toBe(repo.C);
    expect(git.contains(repo.D, repo.C)).toBe(true);
    expect(git.contains(repo.A, repo.C)).toBe(false);
    expect(git.contains('e'.repeat(40), repo.C)).toBeNull();
  });

  it('fails closed for a commit that is not on main', () => {
    expect(() => headCheck({ git, sha: 'e'.repeat(40), specs })).toThrow();
  });
});

describe('headCheck with a fake git', () => {
  const SHA = 'a'.repeat(40);
  it('fails when the head of main cannot be read', () => {
    for (const head of ['', 'not-a-sha', null]) {
      expect(() =>
        headCheck({ git: { head: () => head }, sha: SHA, specs: [':(glob)x/**'] }),
      ).toThrow(/head of main/);
    }
  });
});

describe('head-check command line', () => {
  const repo = fixtureRepo();
  mkdirSync(join(repo.dir, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(repo.dir, '.github/workflows/deploy-drop.yml'),
    'name: x\non:\n  push:\n    branches: [main]\n    paths:\n      - "apps/drop/**"\n',
  );
  const go = (sha) => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-paths-out-'));
    const output = join(dir, 'output');
    const summary = join(dir, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const lines = [];
    const code = run({
      argv: ['head-check', '--workflow', 'deploy-drop.yml'],
      env: { GITHUB_SHA: sha, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
      cwd: repo.dir,
      log: (l) => lines.push(l),
    });
    return {
      code,
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
      log: lines.join('\n'),
    };
  };

  it('writes current=true and a notice when only unrelated commits followed', () => {
    const r = go(repo.C);
    expect(r.code).toBe(0);
    expect(r.output).toContain('current=true');
    expect(r.log).toMatch(/::notice::/);
    expect(r.summary).toContain(repo.D);
  });

  it('writes nothing to the summary at the head', () => {
    const r = go(repo.D);
    expect(r.output).toContain('current=true');
    expect(r.summary).toBe('');
  });

  it('writes current=false, a warning and a "Superseded by" summary naming the newer commit', () => {
    const r = go(repo.A);
    expect(r.code).toBe(0);
    expect(r.output).toContain('current=false');
    expect(r.log).toMatch(/::warning::/);
    expect(r.summary).toMatch(/Superseded by/);
    expect(r.summary).toContain(repo.C);
    expect(r.summary).toMatch(/did not change production/);
    expect(r.summary).toMatch(/catch-up/);
  });

  it('fails for bad arguments, a malformed SHA or a commit off main', () => {
    expect(
      run({ argv: ['head-check'], env: { GITHUB_SHA: repo.D }, cwd: repo.dir, log: () => {} }),
    ).toBe(1);
    expect(
      run({
        argv: ['head-check', '--workflow', '../x.yml'],
        env: { GITHUB_SHA: repo.D },
        cwd: repo.dir,
        log: () => {},
      }),
    ).toBe(1);
    expect(go('not-a-sha').code).toBe(1);
    expect(go('e'.repeat(40)).code).toBe(1);
  });
});
