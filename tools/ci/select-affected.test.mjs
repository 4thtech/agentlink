// CHORE-CI-SPEED-2: the PR test selection. A wrong answer here skips tests on a pull request (the
// merge queue still runs everything), so every rule has a case, and the real workspace is checked too.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkspace, selectAffected, turboFilters } from './select-affected.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A small fake workspace: types <- chain <- app; log <- app; ui alone; tools; a docs consumer.
const fake = [
  { name: '@4thtech-io/types', dir: 'packages/types', deps: [], refs: [], playwright: true },
  { name: '@4thtech-io/crypto', dir: 'packages/crypto', deps: [], refs: [], playwright: false },
  { name: '@4thtech-io/core', dir: 'packages/core', deps: ['@4thtech-io/crypto'], refs: [], playwright: false },
  { name: '@4thtech-io/chain', dir: 'packages/chain', deps: ['@4thtech-io/types'], refs: [], playwright: false },
  { name: '@4thtech-io/log', dir: 'packages/log', deps: [], refs: [], playwright: false },
  {
    name: '@4thtech-io/ui',
    dir: 'packages/ui',
    deps: [],
    refs: ['docs/design/d1/'],
    playwright: false,
  },
  {
    name: '@4thtech-io/node',
    dir: 'packages/node',
    deps: ['@4thtech-io/log'],
    refs: [],
    playwright: true,
  },
  {
    name: '@4thtech-io/agentlink',
    dir: 'apps/cli',
    deps: ['@4thtech-io/chain', '@4thtech-io/node'],
    refs: ['docs/foundation/06-mcp-server.md', 'docs-site/guide/', 'packages/log/src/redact'],
    playwright: false,
  },
  { name: '@4thtech-io/tools', dir: 'tools', deps: [], refs: [], playwright: false },
];

const sel = (files) => selectAffected({ files, workspace: fake });

describe('selectAffected: global triggers run the full suite', () => {
  it.each([
    ['an unreadable diff', null],
    ['an empty diff', []],
    ['the lockfile', ['pnpm-lock.yaml']],
    ['a root config file', ['turbo.json']],
    ['a root dotfile', ['.npmrc']],
    ['a workflow', ['.github/workflows/ci.yml']],
    ['a tools script', ['tools/check-manifests.mjs']],
    ['the selector itself', ['tools/ci/select-affected.mjs']],
    ['a test vector', ['test-vectors/nip44/vectors.json']],
    ['shared package types', ['packages/types/src/policy.ts']],
    ['shared package crypto', ['packages/crypto/src/index.ts']],
    ['shared package core', ['packages/core/src/index.ts']],
    ['a path outside every known area', ['.claude/settings.json']],
    ['a non-md changeset file', ['.changeset/config.json']],
    ['a file of an unknown package directory', ['packages/new-thing/src/index.ts']],
    ['one global file among package files', ['packages/log/src/a.ts', 'packages/core/src/b.ts']],
  ])('%s', (_label, files) => {
    const r = sel(files);
    expect(r.scope).toBe('full');
    expect(r.reason).toBeTruthy();
  });
});

describe('selectAffected: package changes select the package and its dependents', () => {
  it('a leaf app selects itself and tools only', () => {
    expect(sel(['packages/ui/src/button.ts'])).toMatchObject({
      scope: 'filtered',
      packages: ['@4thtech-io/tools', '@4thtech-io/ui'],
      playwright: false,
    });
  });

  it('a library selects every transitive dependent', () => {
    const r = sel(['packages/log/src/index.ts']);
    expect(r.scope).toBe('filtered');
    expect(r.packages).toEqual([
      '@4thtech-io/agentlink',
      '@4thtech-io/log',
      '@4thtech-io/node',
      '@4thtech-io/tools',
    ]);
    expect(r.playwright).toBe(true);
  });

  it('chain selects the CLI but not unrelated packages', () => {
    expect(sel(['packages/chain/src/a.ts']).packages).toEqual([
      '@4thtech-io/agentlink',
      '@4thtech-io/chain',
      '@4thtech-io/tools',
    ]);
  });

  it('a package README counts as that package', () => {
    expect(sel(['apps/cli/README.md']).packages).toEqual(['@4thtech-io/agentlink', '@4thtech-io/tools']);
  });

  it('a package whose sources name a changed path is selected too', () => {
    expect(sel(['packages/log/src/redact.ts']).packages).toContain('@4thtech-io/agentlink');
  });
});

describe('selectAffected: docs-only changes run only the docs checks', () => {
  it('a process doc selects tools only (docs-status, links, vocabulary)', () => {
    expect(sel(['docs/process/ci-cd.md', 'changelog.d/X.md', 'README.md'])).toMatchObject({
      scope: 'filtered',
      packages: ['@4thtech-io/tools'],
      playwright: false,
    });
  });

  it('a doc that a package test reads selects that package as well', () => {
    expect(sel(['docs/design/d1/tokens/color.json']).packages).toEqual([
      '@4thtech-io/tools',
      '@4thtech-io/ui',
    ]);
    expect(sel(['docs/foundation/06-mcp-server.md']).packages).toEqual([
      '@4thtech-io/agentlink',
      '@4thtech-io/tools',
    ]);
    expect(sel(['docs-site/guide/get-started/codex.md']).packages).toEqual([
      '@4thtech-io/agentlink',
      '@4thtech-io/tools',
    ]);
  });

  it('a doc consumer does not pull in its dependents', () => {
    expect(sel(['docs/design/d1/x.md']).packages).not.toContain('@4thtech-io/agentlink');
  });

  it('changeset notes and knowledge files are docs', () => {
    expect(sel(['.changeset/brave-fox.md', 'knowledge/x.md']).packages).toEqual(['@4thtech-io/tools']);
  });
});

describe('turboFilters', () => {
  it('builds one --filter per package', () => {
    expect(turboFilters(['@4thtech-io/tools', '@4thtech-io/ui'])).toBe(
      '--filter=@4thtech-io/tools --filter=@4thtech-io/ui',
    );
  });

  it('refuses a name that is not a plain workspace package name', () => {
    expect(() => turboFilters(['@4thtech-io/ui; rm -rf /'])).toThrow();
    expect(() => turboFilters(['...@4thtech-io/ui'])).toThrow();
  });
});

describe('the real workspace', () => {
  const ws = loadWorkspace(root);
  const real = (files) => selectAffected({ files, workspace: ws });

  it('finds every workspace package with its internal dependencies', () => {
    const names = ws.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['@4thtech-io/tools', '@4thtech-io/core', '@4thtech-io/agentlink']));
    expect(ws.find((p) => p.name === '@4thtech-io/core').deps).toContain('@4thtech-io/storage');
  });

  it('a shared package change runs everything', () => {
    for (const f of ['packages/types/src/x.ts', 'packages/crypto/src/x.ts', 'packages/core/src/x.ts']) {
      expect(real([f]).scope).toBe('full');
    }
  });

  it('a storage change selects storage, core and everything above core', () => {
    const r = real(['packages/storage/src/s3.ts']);
    expect(r.scope).toBe('filtered');
    expect(r.packages).toEqual(
      expect.arrayContaining([
        '@4thtech-io/storage',
        '@4thtech-io/core',
        '@4thtech-io/node',
        '@4thtech-io/agentlink',
        '@4thtech-io/e2e',
        '@4thtech-io/tools',
      ]),
    );
    expect(r.packages).not.toContain('@4thtech-io/ui');
  });

  it('a ui change does not select the protocol packages', () => {
    const r = real(['packages/ui/src/x.ts']);
    expect(r.scope).toBe('filtered');
    expect(r.packages).not.toContain('@4thtech-io/core');
    expect(r.packages).not.toContain('@4thtech-io/node');
  });

  it('the design tokens and the MCP spec select their doc-drift tests', () => {
    expect(real(['docs/design/d1/tokens/colors.json']).packages).toContain('@4thtech-io/ui');
    expect(real(['docs/foundation/06-mcp-server.md']).packages).toContain('@4thtech-io/agentlink');
  });

  it('the node package needs the Playwright browsers', () => {
    expect(ws.find((p) => p.name === '@4thtech-io/node').playwright).toBe(true);
  });
});
