// CHORE-CI-SPEED-2: the PR test selection. A wrong answer here skips tests on a pull request (the
// merge queue still runs everything), so every rule has a case, and the real workspace is checked too.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HEAVY_JOBS,
  jobOutputs,
  fastLane,
  loadWorkspace,
  selectAffected,
  turboFilters,
} from './select-affected.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A small fake workspace: types <- chain <- app; log <- app; ui alone; tools; a docs consumer.
const fake = [
  { name: '@4thtech-io/types', dir: 'packages/types', deps: [], refs: [], playwright: true },
  { name: '@4thtech-io/crypto', dir: 'packages/crypto', deps: [], refs: [], playwright: false },
  {
    name: '@4thtech-io/core',
    dir: 'packages/core',
    deps: ['@4thtech-io/crypto'],
    refs: [],
    playwright: false,
  },
  {
    name: '@4thtech-io/chain',
    dir: 'packages/chain',
    deps: ['@4thtech-io/types'],
    refs: [],
    playwright: false,
  },
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
    expect(sel(['apps/cli/README.md']).packages).toEqual([
      '@4thtech-io/agentlink',
      '@4thtech-io/tools',
    ]);
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
    expect(sel(['.changeset/brave-fox.md', 'knowledge/x.md']).packages).toEqual([
      '@4thtech-io/tools',
    ]);
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
    expect(names).toEqual(
      expect.arrayContaining(['@4thtech-io/tools', '@4thtech-io/core', '@4thtech-io/agentlink']),
    );
    expect(ws.find((p) => p.name === '@4thtech-io/core').deps).toContain('@4thtech-io/storage');
  });

  it('a shared package change runs everything', () => {
    for (const f of [
      'packages/types/src/x.ts',
      'packages/crypto/src/x.ts',
      'packages/core/src/x.ts',
    ]) {
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

// CHORE-CI-SPEED-3: the heavy jobs follow the affected packages on a pull request. A wrong answer
// skips a job on the PR only; the merge queue runs every job and ci-gate requires them there.
// Before the selector exports the map, every case below must fail on its own (not the whole file).
const HEAVY = HEAVY_JOBS ?? { 'heavy-jobs-missing': ['@4thtech-io/heavy-jobs-missing'] };

describe('heavy jobs: which ones a pull request runs', () => {
  const ws = loadWorkspace(root);
  const jobsFor = (files) => selectAffected({ files, workspace: ws }).jobs ?? {};
  const running = (files) =>
    Object.entries(jobsFor(files))
      .filter(([, run]) => run)
      .map(([job]) => job)
      .sort();
  const ALL = Object.keys(HEAVY).sort();

  it('maps each heavy job of ci.yml to the packages it tests', () => {
    expect(ALL).toEqual([
      'bundle-check',
      'e2e-deterministic',
      'keychain',
      'relays-docker',
      'storage-minio',
      'vectors',
    ]);
  });

  it('names only packages that exist in the workspace (a renamed package must not silence a job)', () => {
    const names = new Set(ws.map((p) => p.name));
    for (const [job, pkgs] of Object.entries(HEAVY)) {
      expect(pkgs.length, job).toBeGreaterThan(0);
      for (const name of pkgs) expect(names.has(name), `${job}: ${name}`).toBe(true);
    }
  });

  it.each([
    ['an unreadable diff', null],
    ['an empty diff', []],
    ['a workflow change', ['.github/workflows/ci.yml']],
    ['a tools change', ['tools/ci/select-affected.mjs']],
    ['the lockfile', ['pnpm-lock.yaml']],
    ['a root config file', ['turbo.json']],
    ['an unknown path', ['scripts/new.sh']],
    ['an unknown package directory', ['packages/new-thing/src/index.ts']],
    ['a test vector', ['test-vectors/nip44/vectors.json']],
    ['core', ['packages/core/src/index.ts']],
    ['crypto', ['packages/crypto/src/index.ts']],
    ['types', ['packages/types/src/index.ts']],
  ])('fails open to every job: %s', (_label, files) => {
    expect(running(files)).toEqual(ALL);
  });

  it('a docs-only change runs no heavy job', () => {
    expect(running(['docs/process/ci-cd.md', 'changelog.d/x.md', 'README.md'])).toEqual([]);
  });

  it('a CLI-only change runs keychain, bundle-check and the e2e', () => {
    expect(running(['apps/cli/src/server.ts'])).toEqual([
      'bundle-check',
      'e2e-deterministic',
      'keychain',
    ]);
  });

  it('a node change runs keychain, relays-docker, bundle-check and the e2e (node is under the CLI)', () => {
    expect(running(['packages/node/src/keystore.ts'])).toEqual([
      'bundle-check',
      'e2e-deterministic',
      'keychain',
      'relays-docker',
    ]);
  });

  it('a transport-nostr change runs relays-docker', () => {
    expect(running(['packages/transport-nostr/src/index.ts'])).toContain('relays-docker');
  });

  it('a storage change runs storage-minio', () => {
    expect(running(['packages/storage/src/s3.ts'])).toContain('storage-minio');
  });

  it('a tool-handler change (packages/mcp-tools, M2-3t) runs bundle-check through the CLI', () => {
    expect(running(['packages/mcp-tools/src/send.ts'])).toContain('bundle-check');
  });

  it('a chain change runs the vectors (the harness imports chain) and the e2e', () => {
    const jobs = running(['packages/chain/src/index.ts']);
    expect(jobs).toContain('vectors');
    expect(jobs).toContain('e2e-deterministic');
  });

  it('an e2e change runs the e2e only', () => {
    expect(running(['e2e/test/world.ts'])).toEqual(['e2e-deterministic']);
  });

  it('an invite page change runs the e2e (it builds the invite site)', () => {
    expect(running(['apps/invite/site/index.html'])).toContain('e2e-deterministic');
  });

  it('a change to an app no heavy job tests (console, verify) runs none', () => {
    expect(running(['apps/console/src/x.ts', 'apps/verify/src/x.ts'])).toEqual([]);
  });

  it('a ui change runs the jobs of the CLI, which serves the approval pages', () => {
    expect(running(['packages/ui/src/x.ts'])).toEqual([
      'bundle-check',
      'e2e-deterministic',
      'keychain',
    ]);
  });
});

describe('jobOutputs', () => {
  it('writes one run_<job> line per heavy job, true on a full run', () => {
    const lines = jobOutputs({
      scope: 'full',
      reason: 'x',
      jobs: selectAffected({ files: null, workspace: fake }).jobs,
    });
    expect(lines).toEqual(Object.keys(HEAVY).map((j) => `run_${j.replaceAll('-', '_')}=true`));
  });

  it('writes false for a job the change does not reach', () => {
    const r = selectAffected({ files: ['packages/ui/src/x.ts'], workspace: fake });
    expect(jobOutputs(r)).toContain('run_storage_minio=false');
  });
});

describe('ci.yml wires the heavy-job selection', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = (name) => {
    const start = yml.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = yml.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  it.each(Object.keys(HEAVY))('%s runs only when detect selects it', (name) => {
    const key = `run_${name.replaceAll('-', '_')}`;
    expect(job(name)).toMatch(
      new RegExp(`\\n    if: .*needs\\.detect\\.outputs\\.${key} == 'true'`),
    );
  });

  it.each(Object.keys(HEAVY))(
    'detect defaults %s to true when the selector did not run (queue, push, crash)',
    (name) => {
      const key = `run_${name.replaceAll('-', '_')}`;
      expect(job('detect')).toContain(`${key}: \${{ steps.affected.outputs.${key} || 'true' }}`);
    },
  );

  it('ci-gate requires every heavy job and checks to succeed in the merge queue', () => {
    const gate = job('ci-gate');
    expect(gate).toContain('merge_group');
    for (const name of ['checks', ...Object.keys(HEAVY)]) {
      expect(gate, name).toMatch(new RegExp(`QUEUE_REQUIRED:.*\\b${name}\\b`));
    }
  });
});

// CHORE-CI-DOCS-FASTLANE (owner decisions 2026-10-25, D1 and plan item B): which events narrow the work
// for a docs-only change. Anything unknown fails towards running everything.
describe('fastLane: the docs-only fast lane', () => {
  const DOC = ['docs/process/ci-cd.md', 'changelog.d/X.md', 'README.md', '.changeset/a-b.md'];
  const CODE = ['apps/cli/src/index.ts'];
  const FULL = { codeChanged: true, selector: false };
  const FEATURE = 'refs/heads/feat/x';

  it('a merge group of docs-only PRs uses the selector and skips the heavy jobs', () => {
    expect(fastLane({ event: 'merge_group', files: DOC })).toEqual({
      codeChanged: false,
      selector: true,
    });
  });

  it('a merge group with any code PR runs the full suite', () => {
    expect(fastLane({ event: 'merge_group', files: [...DOC, ...CODE] })).toEqual(FULL);
  });

  it('a merge group touching .github or tools runs the full suite', () => {
    for (const f of ['.github/workflows/ci.yml', 'tools/ci/select-affected.mjs']) {
      expect(fastLane({ event: 'merge_group', files: [...DOC, f] })).toEqual(FULL);
    }
  });

  it('a docs-only push to a feature branch skips the heavy jobs and uses the selector', () => {
    expect(fastLane({ event: 'push', ref: FEATURE, files: DOC })).toEqual({
      codeChanged: false,
      selector: true,
    });
  });

  it('a code push to a feature branch runs everything', () => {
    expect(fastLane({ event: 'push', ref: FEATURE, files: CODE })).toEqual(FULL);
  });

  it('a push to main always runs the full suite, even for docs', () => {
    expect(fastLane({ event: 'push', ref: 'refs/heads/main', files: DOC })).toEqual(FULL);
  });

  it('an unknown base (no file list) or an empty diff runs everything', () => {
    for (const event of ['merge_group', 'push', 'pull_request']) {
      expect(fastLane({ event, ref: FEATURE, files: null })).toEqual(FULL);
      expect(fastLane({ event, ref: FEATURE, files: [] })).toEqual(FULL);
    }
  });

  it('an unknown event runs everything', () => {
    expect(fastLane({ event: 'workflow_dispatch', files: DOC })).toEqual(FULL);
  });

  it('a pull request keeps using the selector, docs-only or not', () => {
    expect(fastLane({ event: 'pull_request', files: DOC })).toEqual({
      codeChanged: false,
      selector: true,
    });
    expect(fastLane({ event: 'pull_request', files: CODE })).toEqual({
      codeChanged: true,
      selector: true,
    });
  });
});

describe('ci.yml wires the docs-only fast lane', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('the selector step runs when the scope step says so (pull request, docs-only queue group or push)', () => {
    const at = yml.indexOf('id: affected');
    const head = yml.slice(at, yml.indexOf('run: |', at));
    expect(head).toContain("steps.e2e_scope.outputs.use_selector == 'true'");
  });

  it('a push to a feature branch diffs against its merge base with main', () => {
    expect(yml).toContain('git merge-base HEAD origin/main');
    expect(yml).toContain("fetch-depth: ${{ github.event_name == 'push' && '0' || '1' }}");
  });

  it('the full suite still runs when the scope is not decided (outputs default to full)', () => {
    expect(yml).toContain("test_scope: ${{ steps.affected.outputs.test_scope || 'full' }}");
  });
});
