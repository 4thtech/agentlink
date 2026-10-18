import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { findCycle, runChecks } from './check.mjs';
import {
  LIBRARIES,
  NODE_ZONES,
  RESTRICTED_ENTRY_POINTS,
  SUBTLE_ZONES,
  WORKSPACE_NAMES,
  ZONES,
  allowedWorkspaceNames,
  violationFor,
} from './policy.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('policy data', () => {
  it('has unique workspace names', () => {
    expect(new Set(WORKSPACE_NAMES).size).toBe(WORKSPACE_NAMES.length);
  });

  it('only lets a zone use packages that exist, and never an app', () => {
    for (const [zone, { uses }] of Object.entries(ZONES)) {
      for (const short of uses) {
        expect(ZONES[`packages/${short}`], `${zone} uses unknown packages/${short}`).toBeDefined();
      }
    }
  });

  it('keeps the layering acyclic', () => {
    const graph = Object.fromEntries(
      Object.values(ZONES).map(({ name, uses }) => [
        name,
        uses.map((short) => ZONES[`packages/${short}`].name),
      ]),
    );
    expect(findCycle(graph)).toBeNull();
  });

  it('requires a justification on every runtime-dependency entry', () => {
    for (const [zone, { external }] of Object.entries(ZONES)) {
      for (const { pattern, reason } of external) {
        expect(reason?.trim().length, `${zone}: ${pattern} needs a reason`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every library zone and Node zone in the layering table', () => {
    for (const zone of [...NODE_ZONES, ...SUBTLE_ZONES, ...LIBRARIES.flatMap((lib) => lib.zones)]) {
      expect(ZONES[zone], zone).toBeDefined();
    }
  });

  it('follows 04 §8.1 and the M0-10 card for the primitive libraries', () => {
    const zonesOf = (specifier) =>
      Object.keys(ZONES).filter((zone) => violationFor(zone, specifier) === null);
    expect(zonesOf('@noble/curves')).toEqual(['packages/crypto']);
    expect(zonesOf('@hpke/core')).toEqual(['packages/crypto']);
    expect(zonesOf('nostr-tools')).toEqual(['packages/crypto', 'packages/transport-nostr']);
    // viem in packages/crypto: test files only (IR-M1-1e-1 L-1).
    expect(zonesOf('viem')).toEqual(['packages/chain', 'apps/pay']);
    expect(violationFor('packages/crypto', 'viem', 'packages/crypto/src/x.test.ts')).toBeNull();
    expect(zonesOf('aws4fetch')).toEqual(['packages/storage']);
    expect(zonesOf('node:fs')).toEqual(NODE_ZONES);
    expect(zonesOf('node:crypto')).toEqual([]);
  });

  it('lets a package import itself and its layer, nothing above or beside it', () => {
    expect(allowedWorkspaceNames('packages/chain')).toEqual([
      '@agentlink/chain',
      '@agentlink/types',
      '@agentlink/log',
      '@agentlink/crypto',
    ]);
    // The logger (M0-8) imports no workspace package, and the trusted base does not import it.
    expect(violationFor('packages/log', '@agentlink/types')).toMatch(/layering/);
    expect(violationFor('packages/crypto', '@agentlink/log')).toMatch(/layering/);
    expect(violationFor('packages/crypto', '@agentlink/core')).toMatch(/layering/);
    expect(violationFor('packages/chain', '@agentlink/storage')).toMatch(/layering/);
    expect(violationFor('packages/core', '@agentlink/node')).toMatch(/layering/);
    expect(violationFor('apps/console', '@agentlink/node')).toMatch(/layering/);
    expect(violationFor('apps/submitter', '@agentlink/ui')).toMatch(/layering/);
    expect(violationFor('packages/core', '@4thtech-io/agentlink')).toMatch(/layering/);
    expect(violationFor('packages/core', '@agentlink/chain/sub')).toBeNull();
    expect(violationFor(null, '@agentlink/types')).toMatch(/no entry/);
  });
});

describe('the repository itself', () => {
  // The scan reads only packages/*, apps/* and test-vectors/ (434 source files) and never lists
  // docs/. Its cost is TypeScript parsing (CPU), not git: 0.46 s cold locally (git listing 20 ms;
  // PR #146 cut the spawns from 34 to 2, which was not the cause). On CI the "Unit tests" step runs
  // every package's tests at once (turbo, browser projects included), and the scan took 16.2 s there
  // (run 38769544356) and exceeded 30 s on a slower runner (run 38770433435). Same assertions, a
  // 120 s timeout for this one test, with headroom over the contended worst case.
  it('passes every boundary check', { timeout: 120_000 }, () => {
    const { problems, packages } = runChecks(REPO);
    expect(problems).toEqual([]);
    expect(packages).toBeGreaterThan(10);
  });
});

describe('M1-1g-b: no build can include the crypto test seam (IR-M1-1c-G2-1 L-1)', () => {
  const readJsonc = (path) => {
    const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
    if (error)
      throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`);
    return config;
  };
  const packageDirs = ['packages', 'apps'].flatMap((group) =>
    readdirSync(join(REPO, group), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(REPO, group, entry.name, 'tsconfig.json')),
      )
      .map((entry) => `${group}/${entry.name}`),
  );
  const seam = RESTRICTED_ENTRY_POINTS.find((entry) =>
    entry.group.includes('@agentlink/crypto/testing'),
  );
  // The packages of the seam's testDirs (IR-M1-9k-1 F01): `apps/cli/test` -> `apps/cli`.
  const testDirPackages = (seam?.testDirs ?? []).map((dir) => dir.split('/').slice(0, 2).join('/'));
  const seamPackages = [...(seam?.testZones ?? []), ...testDirPackages];

  it('finds the workspace packages', () => {
    expect(packageDirs.length).toBeGreaterThan(10);
  });

  it.each(packageDirs)('%s: the build excludes *.test.ts and has no path mapping', (dir) => {
    const build = readJsonc(join(REPO, dir, 'tsconfig.json'));
    expect(build.exclude).toContain('src/**/*.test.ts');
    expect(build.compilerOptions?.paths).toBeUndefined();
    expect(build.compilerOptions?.baseUrl).toBeUndefined();
  });

  it.each(packageDirs)(
    '%s: a seam path mapping exists only in a noEmit test config of a test zone',
    (dir) => {
      const path = join(REPO, dir, 'tsconfig.test.json');
      if (!existsSync(path)) return;
      const test = readJsonc(path);
      const paths = test.compilerOptions?.paths ?? {};
      if (Object.keys(paths).some((key) => key.startsWith('@agentlink/crypto/testing'))) {
        expect(seamPackages).toContain(dir);
        expect(test.compilerOptions.noEmit).toBe(true);
      }
    },
  );

  // IR-M1-1g-b-1 L-3: detect the alias however it is written (escaped regex, string key, a path to
  // the seam source, a helper called with 'testing.ts'), in any Vite or Vitest config.
  const SEAM_PATH = /crypto(?:\\?\/|\\\\)(?:src(?:\\?\/|\\\\))?testing/;
  const aliasesSeam = (text) =>
    SEAM_PATH.test(text) || (text.includes('crypto') && /['"`]testing(?:\.ts)?['"`]/.test(text));
  const VITE_CONFIG = /^vite(?:st)?\.config\.[cm]?[jt]s$/;

  it('the alias detector finds every spelling', () => {
    for (const text of [
      String.raw`{ find: /^@agentlink\/crypto\/testing$/, replacement: x }`,
      `alias: { '@agentlink/crypto/testing': y }`,
      `replacement: '../crypto/src/testing.ts'`,
      String.raw`replacement: '..\\crypto\\src\\testing.ts'`,
      `replacement: cryptoSource('testing.ts')`,
      `replacement: cryptoSource("testing")`,
    ]) {
      expect(aliasesSeam(text), text).toBe(true);
    }
    expect(aliasesSeam(String.raw`{ find: /^@agentlink\/crypto$/, replacement: x }`)).toBe(false);
  });

  it.each(packageDirs)('%s: only a test zone Vite or Vitest config aliases the seam', (dir) => {
    for (const name of readdirSync(join(REPO, dir)).filter((n) => VITE_CONFIG.test(n))) {
      if (!aliasesSeam(readFileSync(join(REPO, dir, name), 'utf8'))) continue;
      expect(seamPackages, `${dir}/${name}`).toContain(dir);
      expect(name, `${dir}/${name}`).toMatch(/^vitest\./);
    }
  });

  it('packages/crypto never exports or builds the seam', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'packages/crypto/package.json'), 'utf8'));
    expect(Object.keys(manifest.exports).some((key) => key.includes('testing'))).toBe(false);
    expect(readJsonc(join(REPO, 'packages/crypto/tsconfig.json')).exclude).toContain(
      'src/testing.ts',
    );
  });

  it('every testDirs package of the seam has the alias and the noEmit path it needs (IR-M1-9k-1 F01)', () => {
    // M1-27a: apps/drop/test signs drop requests with fixed test keys (signDropAuthorization).
    expect(seam?.testDirs).toEqual(['apps/cli/test', 'apps/drop/test']);
    for (const pkg of testDirPackages) {
      expect(readFileSync(join(REPO, pkg, 'vitest.config.ts'), 'utf8'), pkg).toMatch(
        /find: \/\^@agentlink\\\/crypto\\\/testing\$\//,
      );
      const test = readJsonc(join(REPO, pkg, 'tsconfig.test.json'));
      expect(test.compilerOptions.noEmit, pkg).toBe(true);
      expect(test.compilerOptions.paths['@agentlink/crypto/testing'], pkg).toEqual([
        '../../packages/crypto/src/testing.ts',
      ]);
    }
  });

  it('every test zone of the seam has the alias and the noEmit path it needs', () => {
    for (const zone of seam?.testZones ?? []) {
      expect(readFileSync(join(REPO, zone, 'vitest.config.ts'), 'utf8'), zone).toMatch(
        /find: \/\^@agentlink\\\/crypto\\\/testing\$\//,
      );
      const test = readJsonc(join(REPO, zone, 'tsconfig.test.json'));
      expect(test.compilerOptions.paths['@agentlink/crypto/testing'], zone).toEqual([
        '../crypto/src/testing.ts',
      ]);
    }
  });
});

// OPS-REL-2: the @agentlink npm scope belongs to a third party. The workspace packages moved to
// @4thtech-io/*, and any import from the old scope is refused in every zone, in any letter case.
// The old scope is spelled without its slash here so the repository scan (retired-scope.test.mjs)
// finds no `<scope>/<name>` text outside history.
const OLD = '@agentlink';
const OLD_MIXED = '@AgentLink';
describe('retired @agentlink scope (OPS-REL-2)', () => {
  const RETIRED = /@agentlink npm scope.*third party/;

  it('names no workspace package in the @agentlink scope', () => {
    for (const name of WORKSPACE_NAMES) {
      expect(name.toLowerCase().startsWith(`${OLD}/`)).toBe(false);
      expect(name.startsWith('@4thtech-io/')).toBe(true);
    }
  });

  it.each([
    ['packages/core', `${OLD}/types`, 'packages/core/src/a.ts'],
    ['packages/core', `${OLD}/crypto/testing`, 'packages/core/src/a.test.ts'],
    ['apps/cli', `${OLD}/node`, 'apps/cli/src/a.ts'],
    ['apps/drop', `${OLD_MIXED}/crypto`, 'apps/drop/src/a.ts'],
    ['packages/types', `${OLD}/anything-else`, 'packages/types/src/a.ts'],
    [null, `${OLD}/core`, 'somewhere/a.ts'],
  ])('refuses %s importing %s', (zone, specifier, file) => {
    expect(violationFor(zone, specifier, file)).toMatch(RETIRED);
  });

  it('still allows the renamed workspace packages along the layering', () => {
    expect(violationFor('packages/core', '@4thtech-io/types', 'packages/core/src/a.ts')).toBeNull();
    expect(violationFor('apps/cli', '@4thtech-io/node', 'apps/cli/src/a.ts')).toBeNull();
  });
});
