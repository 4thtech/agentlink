// CHORE-CI-SPEED-2: the PR test selection. A wrong answer here skips tests on a pull request (the
// heavy lane on `main` still runs everything), so every rule has a case, and the real workspace is
// checked too.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HEAVY_LANE,
  INSTALL_FILES,
  PACKAGE_JOBS,
  heavyLane,
  jobOutputs,
  fastLane,
  docsOnly,
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

// CHORE-CI-SPEED-3: the short Linux jobs follow the affected packages in the fast lane. A wrong answer
// skips a job on the PR only; the heavy lane on `main` runs every job and ci-gate requires them there.
// Before the selector exports the map, every case below must fail on its own (not the whole file).
const PKG = PACKAGE_JOBS ?? { 'package-jobs-missing': ['@4thtech-io/package-jobs-missing'] };
const HEAVY = HEAVY_LANE ?? { 'heavy-lane-missing': ['heavy-lane-missing/'] };

describe('package jobs: which ones a pull request runs', () => {
  const ws = loadWorkspace(root);
  const jobsFor = (files) => selectAffected({ files, workspace: ws }).jobs ?? {};
  const running = (files) =>
    Object.entries(jobsFor(files))
      .filter(([, run]) => run)
      .map(([job]) => job)
      .sort();
  const ALL = Object.keys(PKG).sort();

  it('maps each package job of ci.yml to the packages it tests', () => {
    expect(ALL).toEqual(['bundle-check', 'keychain', 'relays-docker', 'storage-minio', 'vectors']);
  });

  it('names only packages that exist in the workspace (a renamed package must not silence a job)', () => {
    const names = new Set(ws.map((p) => p.name));
    for (const [job, pkgs] of Object.entries(PKG)) {
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

  it('a docs-only change runs no package job', () => {
    expect(running(['docs/process/ci-cd.md', 'changelog.d/x.md', 'README.md'])).toEqual([]);
  });

  it('a CLI-only change runs keychain and bundle-check', () => {
    expect(running(['apps/cli/src/server.ts'])).toEqual(['bundle-check', 'keychain']);
  });

  it('a node change runs keychain, relays-docker and bundle-check (node is under the CLI)', () => {
    expect(running(['packages/node/src/keystore.ts'])).toEqual([
      'bundle-check',
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

  it('a chain change runs the vectors (the harness imports chain)', () => {
    expect(running(['packages/chain/src/index.ts'])).toContain('vectors');
  });

  it('an e2e change runs no package job', () => {
    expect(running(['e2e/test/world.ts'])).toEqual([]);
  });

  it('a change to an app no package job tests (console, verify) runs none', () => {
    expect(running(['apps/console/src/x.ts', 'apps/verify/src/x.ts'])).toEqual([]);
  });

  it('a ui change runs the jobs of the CLI, which serves the approval pages', () => {
    expect(running(['packages/ui/src/x.ts'])).toEqual(['bundle-check', 'keychain']);
  });
});

// OPS-FAST-LANE-1 (owner decision 54): the heavy-lane jobs run on a pull request only for a change in
// their own area. A wrong answer delays a failure to the heavy lane on `main`; it never skips a job
// there. The path lists are pinned here so a change to them is a reviewed, visible change.
describe('heavy lane: which heavy jobs a pull request runs (by area)', () => {
  const running = (files) =>
    Object.entries(heavyLane(files))
      .filter(([, run]) => run)
      .map(([job]) => job)
      .sort();
  const ALL = Object.keys(HEAVY).sort();

  it('maps each heavy-lane job of ci.yml', () => {
    expect(ALL).toEqual([
      'e2e-deterministic',
      'keychain-os',
      'node-os',
      'path-guard',
      'windows-smoke',
    ]);
  });

  it('every area prefix points at a path that exists (a moved file must not silence a job)', () => {
    for (const [job, prefixes] of Object.entries(HEAVY)) {
      expect(prefixes.length, job).toBeGreaterThan(0);
      for (const prefix of prefixes) {
        const full = join(root, prefix);
        const dir = prefix.endsWith('/') ? full : dirname(full);
        const base = prefix.endsWith('/') ? '' : prefix.slice(prefix.lastIndexOf('/') + 1);
        const hit = existsSync(dir) && readdirSync(dir).some((n) => n.startsWith(base));
        expect(hit, `${job}: ${prefix}`).toBe(true);
      }
    }
  });

  it.each([
    ['an unreadable diff', null],
    ['an empty diff', []],
    ...INSTALL_FILES.map((f) => [`the install file ${f}`, [f]]),
  ])('runs every heavy job: %s', (_label, files) => {
    expect(running(files)).toEqual(ALL);
  });

  it('a UI-only change runs no heavy job', () => {
    expect(
      running([
        'apps/local-ui/src/pages/home/start-here.tsx',
        'packages/ui/src/components/surface.tsx',
        'e2e/test/local-ui-sheet-close.test.ts',
        'changelog.d/X.md',
        'docs/process/backlog.md',
      ]),
    ).toEqual([]);
  });

  it('a docs-only change runs no heavy job, even a Windows guide', () => {
    expect(
      running(['docs-site/guide/get-started/windows.md', 'changelog.d/W5-WINDOWS.md']),
    ).toEqual([]);
  });

  it('a harness change runs windows-smoke', () => {
    expect(running(['apps/cli/src/harness/entry.ts'])).toEqual(['windows-smoke']);
  });

  it('a CLI init or runtime change runs windows-smoke', () => {
    expect(running(['apps/cli/src/commands/init.ts'])).toEqual(['windows-smoke']);
    expect(running(['apps/cli/src/runtime/cli-prefix.ts'])).toEqual(['windows-smoke']);
  });

  it('a file with a Windows name runs windows-smoke and node-os', () => {
    expect(running(['apps/cli/src/harness/windows-entry.test.ts'])).toEqual([
      'node-os',
      'windows-smoke',
    ]);
    expect(running(['packages/node/src/win32-paths.ts'])).toEqual(['node-os', 'windows-smoke']);
  });

  it('an Inbox folder change runs node-os', () => {
    expect(running(['packages/node/src/inbox-folder.ts'])).toEqual(['node-os']);
  });

  it('a path-guard change runs path-guard and node-os', () => {
    expect(running(['packages/node/src/allowed-path.ts'])).toEqual(['node-os', 'path-guard']);
    expect(running(['packages/core/src/path-guard.ts'])).toEqual(['node-os', 'path-guard']);
  });

  it('a keychain change runs the macOS and Windows keychain legs and node-os', () => {
    expect(running(['packages/node/src/keychain.ts'])).toEqual(['keychain-os', 'node-os']);
    expect(running(['apps/cli/test/two-process.keychain.test.ts'])).toEqual(['keychain-os']);
  });

  it('a crypto or KeyStore file change runs the macOS and Windows keychain legs and node-os', () => {
    expect(running(['packages/crypto/src/index.ts'])).toEqual(['keychain-os', 'node-os']);
    expect(running(['packages/node/src/file-keystore.ts'])).toEqual(['keychain-os', 'node-os']);
    expect(running(['packages/node/src/file-keystore-fs.ts'])).toEqual(['keychain-os', 'node-os']);
    expect(running(['packages/node/src/inter-process-lock.ts'])).toEqual(['node-os']);
  });

  it('an e2e scenario change runs the full e2e; an affected-area e2e test does not', () => {
    expect(running(['e2e/src/relays.mjs'])).toEqual(['e2e-deterministic']);
    expect(running(['e2e/test/pair-and-message.test.ts'])).toEqual(['e2e-deterministic']);
    expect(running(['e2e/test/journey/x.test.ts'])).toEqual([]);
  });

  it('an ordinary CLI or node change runs no heavy job', () => {
    expect(running(['apps/cli/src/commands/status.ts', 'packages/node/src/keystore.ts'])).toEqual(
      [],
    );
  });

  it('selectAffected carries the area answer even when the package scope is full', () => {
    expect(
      selectAffected({ files: ['packages/core/src/index.ts'], workspace: fake }).heavy,
    ).toEqual(heavyLane(['packages/core/src/index.ts']));
  });
});

describe('jobOutputs', () => {
  it('writes one run_<job> line per job, true on a full run with no file list', () => {
    const lines = jobOutputs(selectAffected({ files: null, workspace: fake }));
    expect(lines).toEqual(
      [...Object.keys(PKG), ...Object.keys(HEAVY)].map((j) => `run_${j.replaceAll('-', '_')}=true`),
    );
  });

  it('writes false for a job the change does not reach', () => {
    const r = selectAffected({ files: ['packages/ui/src/x.ts'], workspace: fake });
    expect(jobOutputs(r)).toContain('run_storage_minio=false');
    expect(jobOutputs(r)).toContain('run_windows_smoke=false');
    expect(jobOutputs(r)).toContain('run_e2e_deterministic=false');
  });

  it('a missing area answer runs the heavy job (fail towards running)', () => {
    expect(jobOutputs({ scope: 'full', reason: 'x', jobs: {} })).toContain('run_node_os=true');
  });
});

describe('ci.yml wires the job selection', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = (name) => {
    const start = yml.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(-1);
    const rest = yml.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };
  const ALL = [...Object.keys(PKG), ...Object.keys(HEAVY)];
  const jobName = (name) => (name === 'keychain-os' ? 'keychain' : name);

  it.each(ALL)('%s runs only when detect selects it', (name) => {
    const key = `run_${name.replaceAll('-', '_')}`;
    expect(job(jobName(name))).toContain(`needs.detect.outputs.${key} == 'true'`);
  });

  it.each(ALL)(
    'detect defaults %s to true when the selector did not run (heavy lane, crash)',
    (name) => {
      const key = `run_${name.replaceAll('-', '_')}`;
      expect(job('detect')).toContain(`${key}: \${{ steps.affected.outputs.${key} || 'true' }}`);
    },
  );

  it.each(['windows-smoke', 'node-os', 'path-guard', 'e2e-deterministic'])(
    '%s always runs on main and wave-4 and never on a feature-branch push',
    (name) => {
      expect(job(name)).toContain(
        "(github.event_name != 'push' || github.ref == 'refs/heads/main' || github.ref == 'refs/heads/wave-4')",
      );
    },
  );

  it('keychain runs macOS and Windows only for its area or on main and wave-4', () => {
    expect(job('keychain')).toContain(
      "os: ${{ fromJSON((needs.detect.outputs.run_keychain_os == 'true' && (github.event_name != 'push' || github.ref == 'refs/heads/main' || github.ref == 'refs/heads/wave-4'))",
    );
  });

  it('ci-gate requires every heavy job and checks to succeed in the heavy lane', () => {
    const gate = job('ci-gate');
    expect(gate).toContain('[ "$REF" = refs/heads/main ] || [ "$REF" = refs/heads/wave-4 ]');
    expect(gate).not.toContain('QUEUE_REQUIRED');
    for (const name of ['checks', ...Object.keys(PKG), ...Object.keys(HEAVY).map(jobName)]) {
      expect(gate, name).toMatch(new RegExp(`HEAVY_REQUIRED:.*\\b${name}(\\s|$)`, 'm'));
    }
  });

  it('every push publishes ci-gate (push); only the pull request run is ci-gate', () => {
    expect(job('ci-gate')).toContain(
      "name: ${{ github.event_name == 'push' && 'ci-gate (push)' || 'ci-gate' }}",
    );
  });
});

// CHORE-CI-DOCS-FASTLANE and OPS-FAST-LANE-1: which events take the fast lane. Anything unknown fails
// towards running everything.
describe('fastLane: the fast lane and the heavy lane', () => {
  const DOC = ['docs/process/ci-cd.md', 'changelog.d/X.md', 'README.md', '.changeset/a-b.md'];
  const CODE = ['apps/cli/src/index.ts'];
  const FULL = { codeChanged: true, selector: false };
  const FEATURE = 'refs/heads/feat/x';
  const FAST_DOCS = { codeChanged: false, selector: true };
  const FAST_CODE = { codeChanged: true, selector: true };

  it('a pull request uses the selector, docs-only or not', () => {
    expect(fastLane({ event: 'pull_request', files: DOC })).toEqual(FAST_DOCS);
    expect(fastLane({ event: 'pull_request', files: CODE })).toEqual(FAST_CODE);
  });

  it('a merge group (while the queue exists) is a fast lane like the pull request', () => {
    expect(fastLane({ event: 'merge_group', files: DOC })).toEqual(FAST_DOCS);
    expect(fastLane({ event: 'merge_group', files: [...DOC, ...CODE] })).toEqual(FAST_CODE);
  });

  it('a push to a feature branch is a fast lane', () => {
    expect(fastLane({ event: 'push', ref: FEATURE, files: DOC })).toEqual(FAST_DOCS);
    expect(fastLane({ event: 'push', ref: FEATURE, files: CODE })).toEqual(FAST_CODE);
  });

  it('a push to main or wave-4 is the heavy lane, even for docs', () => {
    for (const ref of ['refs/heads/main', 'refs/heads/wave-4']) {
      expect(fastLane({ event: 'push', ref, files: DOC })).toEqual(FULL);
      expect(fastLane({ event: 'push', ref, files: CODE })).toEqual(FULL);
    }
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
});

describe('ci.yml wires the fast lane', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('the selector step runs when the scope step says so (fast lane)', () => {
    const at = yml.indexOf('id: affected');
    const head = yml.slice(at, yml.indexOf('run: |', at));
    expect(head).toContain("steps.e2e_scope.outputs.use_selector == 'true'");
  });

  it('a push to a feature branch diffs against its merge base with main', () => {
    expect(yml).toContain('git merge-base HEAD origin/main');
    expect(yml).toContain("fetch-depth: ${{ github.event_name == 'push' && '0' || '1' }}");
  });

  it('a .github/ or tools/ change runs everything before the selector is read', () => {
    expect(yml).toContain('grep -Eq \'^(\\.github|tools)/\' "$list"');
  });

  it('the full suite still runs when the scope is not decided (outputs default to full)', () => {
    expect(yml).toContain("test_scope: ${{ steps.affected.outputs.test_scope || 'full' }}");
  });
});

// OPS-DOCS-FASTLANE: a docs-only pull request runs the quick docs-checks job and skips install,
// build and the package suites. When unsure it is not docs-only.
describe('docsOnly: the docs fast lane', () => {
  const pr = (files, coupledRefs = []) => docsOnly({ event: 'pull_request', files, coupledRefs });

  it('is true when every path is prose or an image in a doc tree', () => {
    expect(pr(['docs/process/ci-cd.md'])).toBe(true);
    expect(pr(['docs/foundation/00-README.md', 'docs/lessons/new.md'])).toBe(true);
    expect(pr(['docs-site/technical/project/x.md', 'docs-site/guide/.gitbook/assets/a.png'])).toBe(
      true,
    );
    expect(pr(['knowledge/agentlink-overview.md'])).toBe(true);
    expect(pr(['changelog.d/ops-docs-fastlane.md'])).toBe(true);
    expect(pr(['README.md', 'CHANGELOG.md', 'llms.txt', 'brand/logo/mark.svg'])).toBe(true);
  });

  it('is false for anything that can change behaviour or generated checks', () => {
    for (const f of [
      'packages/core/src/a.ts',
      'apps/cli/src/main.ts',
      'tools/ci/select-affected.mjs',
      '.github/workflows/ci.yml',
      'e2e/test/a.test.ts',
      'test-vectors/a.json',
      'package.json',
      'pnpm-lock.yaml',
      'AGENTS.md',
      'CLAUDE.md',
      '.claude/settings.json',
      '.changeset/brave-owls.md',
    ]) {
      expect(pr([f]), f).toBe(false);
    }
  });

  it('tricky cases: status.yaml, .github markdown, package READMEs, non-doc files in doc trees', () => {
    expect(pr(['docs/status.yaml'])).toBe(false);
    expect(pr(['.github/pull_request_template.md'])).toBe(false);
    expect(pr(['.github/CODEOWNERS'])).toBe(false);
    expect(pr(['packages/core/README.md'])).toBe(false); // a package publishes its README
    expect(pr(['apps/cli/README.md'])).toBe(false);
    expect(pr(['docs/design/d1/tokens/tokens.css'])).toBe(false);
    expect(pr(['docs/design/d1/components/reference/bundle.js'])).toBe(false);
    expect(pr(['docs/x/../../packages/core/src/a.md'])).toBe(false);
    expect(pr(['docs/runbook.sh'])).toBe(false);
    expect(pr(['docs/a.sol'])).toBe(false);
    expect(pr(['AGENTS.md.bak'])).toBe(false);
    expect(pr(['README.md.sh'])).toBe(false);
  });

  it('one non-doc file makes the whole diff not docs-only', () => {
    expect(pr(['docs/process/ci-cd.md', 'packages/core/src/a.ts'])).toBe(false);
    expect(pr(['docs/process/ci-cd.md', 'docs/status.yaml'])).toBe(false);
  });

  it('a doc that a package source names is not docs-only', () => {
    const refs = ['docs-site/guide/get-started/codex.md', 'docs/design/d1/'];
    expect(pr(['docs-site/guide/get-started/codex.md'], refs)).toBe(false);
    expect(pr(['docs/design/d1/copy/notes.md'], refs)).toBe(false);
    expect(pr(['docs/process/ci-cd.md'], refs)).toBe(true);
  });

  it('is false when the diff is unknown or empty, and in the heavy lane', () => {
    expect(docsOnly({ event: 'pull_request', files: null })).toBe(false);
    expect(docsOnly({ event: 'pull_request', files: [] })).toBe(false);
    expect(docsOnly({ event: 'pull_request', files: ['', '  '] })).toBe(false);
    expect(docsOnly({ event: 'unknown', files: ['docs/a.md'] })).toBe(false);
    expect(docsOnly({ event: 'push', ref: 'refs/heads/main', files: ['docs/a.md'] })).toBe(false);
    expect(docsOnly({ event: 'push', ref: 'refs/heads/wave-4', files: ['docs/a.md'] })).toBe(false);
    expect(docsOnly({ event: 'push', ref: 'refs/heads/feat', files: ['docs/a.md'] })).toBe(true);
  });

  it('docs-only is always a subset of the existing docs rule (no heavy job for it)', () => {
    for (const f of ['docs/a.md', 'knowledge/a.md', 'README.md', 'llms.txt', 'brand/a.png']) {
      if (docsOnly({ event: 'pull_request', files: [f] })) {
        expect(fastLane({ event: 'pull_request', files: [f] }).codeChanged, f).toBe(false);
      }
    }
  });
});

describe('ci.yml wires the docs fast lane', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = (name) => {
    const at = yml.indexOf(`\n  ${name}:\n`);
    expect(at, name).toBeGreaterThan(-1);
    const next = yml.slice(at + 1).search(/\n  [a-z0-9-]+:\n/);
    return yml.slice(at, next < 0 ? undefined : at + 1 + next);
  };

  it('checks is skipped only when detect says docs-only; docs-checks runs only then', () => {
    expect(job('checks')).toContain("needs.detect.outputs.docs_only != 'true'");
    expect(job('docs-checks')).toContain("needs.detect.outputs.docs_only == 'true'");
  });

  it('docs_only defaults to false and the scope output is validated as three lines', () => {
    expect(yml).toContain("docs_only: ${{ steps.e2e_scope.outputs.docs_only || 'false' }}");
    expect(yml).toContain("use_selector=(true|false)$'\\n'docs_only=(true|false)$");
  });

  it('docs-checks runs the existing docs validations, no build', () => {
    const j = job('docs-checks');
    for (const cmd of [
      'check-knowledge-size.mjs',
      'check-knowledge-links.mjs',
      'docs-status/index.mjs --check',
      'vocabulary.test.mjs',
      'retired-scope.test.mjs',
      'prettier --check .',
    ]) {
      expect(j, cmd).toContain(cmd);
    }
    expect(j).not.toMatch(/pnpm (build|test|typecheck)|turbo run/);
  });

  it('ci-gate needs docs-checks and demands it exactly when docs-only', () => {
    const gate = job('ci-gate');
    expect(gate).toMatch(/needs: \[[^\]]*docs-checks/);
    expect(gate).toContain('DOCS_ONLY: ${{ needs.detect.outputs.docs_only }}');
    expect(gate).toContain('docs-checks');
  });
});

describe('docsOnly: odd diff lists and events', () => {
  const ev = (event, files, ref = '') => docsOnly({ event, ref, files });

  it('upper-case extensions are not docs', () => {
    expect(ev('pull_request', ['docs/A.MD'])).toBe(false);
    expect(ev('pull_request', ['docs/a.PNG'])).toBe(false);
    expect(ev('pull_request', ['README.MD'])).toBe(false);
  });

  it('a rename out of code lists both paths (CI diffs with --no-renames), so it is not docs-only', () => {
    expect(ev('pull_request', ['packages/x/notes.md', 'docs/x.md'])).toBe(false);
    expect(ev('pull_request', ['docs/x.md', 'packages/x/src/a.ts'])).toBe(false);
  });

  it('CRLF and trailing whitespace in the list do not change the answer', () => {
    expect(ev('pull_request', ['docs/a.md\r', ' knowledge/b.md  ', ''])).toBe(true);
    expect(ev('pull_request', ['docs/a.md\r', 'packages/core/src/a.ts\r'])).toBe(false);
  });

  it('merge_group and feature-branch pushes follow the same rules; main does not', () => {
    expect(ev('merge_group', ['docs/a.md'])).toBe(true);
    expect(ev('merge_group', ['docs/a.md', 'tools/x.mjs'])).toBe(false);
    expect(ev('push', ['docs/a.md'], 'refs/heads/feat')).toBe(true);
    expect(ev('push', ['docs/a.md'], 'refs/heads/main')).toBe(false);
    expect(ev('workflow_dispatch', ['docs/a.md'])).toBe(false);
  });

  it('ci.yml refuses docs-only for a symlink or submodule (modes 120000 and 160000)', () => {
    const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(yml).toContain('git diff --no-renames --raw "$base" HEAD');
    const re = /^:(1[26]0000 [0-9]+|[0-9]+ 1[26]0000) /;
    expect(re.test(':120000 000000 abc def D\tdocs/link.md')).toBe(true);
    expect(re.test(':000000 120000 abc def A\tdocs/link.md')).toBe(true);
    expect(re.test(':000000 160000 abc def A\tdocs/sub')).toBe(true);
    expect(re.test(':100644 100644 abc def M\tdocs/a.md')).toBe(false);
  });
});
