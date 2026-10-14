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
    expect(violationFor('packages/core', '@4thtech/agentlink')).toMatch(/layering/);
    expect(violationFor('packages/core', '@agentlink/chain/sub')).toBeNull();
    expect(violationFor(null, '@agentlink/types')).toMatch(/no entry/);
  });
});

describe('the repository itself', () => {
  // The scan reads only packages/*, apps/* and test-vectors/ (git ls-files per zone, 167 source
  // files; it never lists docs/), about 0.4 s alone: ~0.2 s in 34 git ls-files calls, ~0.1 s parsing.
  // On the CI runner it shares the CPU with every package's tests (turbo) and took 4.0 to 5.1 s,
  // past the 5 s default. Same assertions, a timeout with headroom over the worst seen.
  it('passes every boundary check', { timeout: 30_000 }, () => {
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
        expect(seam?.testZones).toContain(dir);
        expect(test.compilerOptions.noEmit).toBe(true);
      }
    },
  );

  it.each(packageDirs)('%s: only a test zone vitest config aliases the seam', (dir) => {
    const path = join(REPO, dir, 'vitest.config.ts');
    if (!existsSync(path) || !readFileSync(path, 'utf8').includes('crypto\\/testing')) return;
    expect(seam?.testZones).toContain(dir);
  });

  it('packages/crypto never exports or builds the seam', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'packages/crypto/package.json'), 'utf8'));
    expect(Object.keys(manifest.exports).some((key) => key.includes('testing'))).toBe(false);
    expect(readJsonc(join(REPO, 'packages/crypto/tsconfig.json')).exclude).toContain(
      'src/testing.ts',
    );
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
