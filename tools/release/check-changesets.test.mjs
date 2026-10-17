import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkChangesets, isVersionPackagesPr } from './check-changesets.mjs';

// OPS-CI-2 / D-43: a pull request that changes a published package fails unless
// `changeset status` passes. The fixture tests run the real Changesets CLI of this repository
// against a throwaway git repository with one public and one private package.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const changesetBin = join(repoRoot, 'node_modules', '@changesets', 'cli', 'bin.js');

describe('isVersionPackagesPr', () => {
  const bot = { headRef: 'changeset-release/main', author: 'github-actions[bot]', sameRepo: true };

  it('recognises the Changesets "Version packages" pull request', () => {
    expect(isVersionPackagesPr(bot)).toBe(true);
  });

  it('does not exempt a branch with that name from anyone else', () => {
    expect(isVersionPackagesPr({ ...bot, author: 'talirezun' })).toBe(false);
    expect(isVersionPackagesPr({ ...bot, author: 'renovate[bot]' })).toBe(false);
  });

  it('does not exempt a fork or another branch', () => {
    expect(isVersionPackagesPr({ ...bot, sameRepo: false })).toBe(false);
    expect(isVersionPackagesPr({ ...bot, headRef: 'feature/changeset-release/main' })).toBe(false);
    expect(isVersionPackagesPr({ ...bot, headRef: '' })).toBe(false);
  });
});

describe('checkChangesets on a fixture repository', () => {
  let dir;
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  const check = () =>
    checkChangesets({ cwd: dir, base: 'main', changesetBin, log: () => {}, pr: {} });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ops-ci-2-changesets-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'fixture');
    git('config', 'commit.gpgsign', 'false');
    write(
      'package.json',
      JSON.stringify({ name: 'fixture-root', private: true, workspaces: ['packages/*'] }),
    );
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    write('packages/pub/package.json', JSON.stringify({ name: '@fixture/pub', version: '0.0.0' }));
    write(
      'packages/priv/package.json',
      JSON.stringify({ name: '@fixture/priv', version: '0.0.0', private: true }),
    );
    write(
      '.changeset/config.json',
      JSON.stringify({
        changelog: false,
        commit: false,
        fixed: [],
        linked: [],
        access: 'public',
        baseBranch: 'main',
        updateInternalDependencies: 'patch',
        ignore: [],
      }),
    );
    write('docs/a.md', '# a\n');
    commit('base');
    git('switch', '-q', '-c', 'feature');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is red when a published package changes without a changeset', async () => {
    write('packages/pub/index.js', 'export const x = 1;\n');
    commit('change pub');
    expect((await check()).ok).toBe(false);
  });

  it('is green when the same change carries a changeset', async () => {
    write('packages/pub/index.js', 'export const x = 1;\n');
    write('.changeset/pub-x.md', '---\n"@fixture/pub": patch\n---\n\nAdd x.\n');
    commit('change pub with changeset');
    expect((await check()).ok).toBe(true);
  });

  it('is green for a docs-only change', async () => {
    write('docs/a.md', '# a, edited\n');
    commit('docs');
    expect((await check()).ok).toBe(true);
  });

  it('is green when only a private (unpublished) package changes', async () => {
    write('packages/priv/index.js', 'export const y = 2;\n');
    commit('change priv');
    expect((await check()).ok).toBe(true);
  });

  it('skips the bot "Version packages" pull request, and only that one', async () => {
    write('packages/pub/package.json', JSON.stringify({ name: '@fixture/pub', version: '0.0.1' }));
    commit('version packages');
    const versionPr = {
      headRef: 'changeset-release/main',
      author: 'github-actions[bot]',
      sameRepo: true,
    };
    const skipped = await checkChangesets({
      cwd: dir,
      base: 'main',
      changesetBin,
      log: () => {},
      pr: versionPr,
    });
    expect(skipped).toEqual({ ok: true, skipped: true });
    const human = await checkChangesets({
      cwd: dir,
      base: 'main',
      changesetBin,
      log: () => {},
      pr: { ...versionPr, author: 'someone' },
    });
    expect(human.ok).toBe(false);
  });

  // OPS-CI-3: with privatePackages.version the private tooling packages count as versioned, but a
  // tooling-only change needs no changeset. Library packages still do.
  describe('with privatePackages.version (OPS-CI-3)', () => {
    beforeEach(() => {
      git('switch', '-q', 'main');
      write(
        '.changeset/config.json',
        JSON.stringify({
          changelog: false,
          commit: false,
          fixed: [],
          linked: [],
          access: 'public',
          baseBranch: 'main',
          updateInternalDependencies: 'patch',
          ignore: [],
          privatePackages: { version: true, tag: false },
        }),
      );
      write(
        'package.json',
        JSON.stringify({
          name: 'fixture-root',
          private: true,
          workspaces: ['packages/*', 'tools', 'e2e'],
        }),
      );
      write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - tools\n  - e2e\n');
      write(
        'tools/package.json',
        JSON.stringify({ name: '@fixture/tools', version: '0.0.0', private: true }),
      );
      write(
        'e2e/package.json',
        JSON.stringify({ name: '@fixture/e2e', version: '0.0.0', private: true }),
      );
      commit('private versioning');
      git('switch', '-q', '-c', 'feature2');
    });

    it('is green when only tools/ changes', async () => {
      write('tools/x.mjs', 'export const t = 1;\n');
      commit('tools');
      expect((await check()).ok).toBe(true);
    });

    it('is green when tools/, e2e/ and docs change', async () => {
      write('tools/x.mjs', 'export const t = 1;\n');
      write('e2e/y.mjs', 'export const e = 1;\n');
      write('docs/a.md', '# edited\n');
      commit('tooling and docs');
      expect((await check()).ok).toBe(true);
    });

    it('is red when a published package changes alongside tools/', async () => {
      write('tools/x.mjs', 'export const t = 1;\n');
      write('packages/pub/index.js', 'export const x = 1;\n');
      commit('mixed');
      expect((await check()).ok).toBe(false);
    });

    it('is red when a published package changes alone', async () => {
      write('packages/pub/index.js', 'export const x = 1;\n');
      commit('pub');
      expect((await check()).ok).toBe(false);
    });

    it('is red when a private library package (not tooling) changes', async () => {
      write('packages/priv/index.js', 'export const y = 2;\n');
      commit('priv lib');
      expect((await check()).ok).toBe(false);
    });
  });
});
