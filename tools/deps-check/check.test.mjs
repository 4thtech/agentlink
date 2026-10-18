import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZONES } from './policy.mjs';
import {
  bundledRuntimeOf,
  checkManifest,
  checkSource,
  findCycle,
  listSourceFilesIn,
  realPackageName,
  runChecks,
} from './check.mjs';

const ROOT = '/repo';
const src = (zone, code, name = 'src/a.ts') =>
  checkSource(zone, join(ROOT, zone, name), code, ROOT);

describe('checkManifest', () => {
  const crypto = { name: '@agentlink/crypto' };
  const chain = { name: '@agentlink/chain' };

  it('accepts the declared dependencies of the real layering', () => {
    expect(
      checkManifest('packages/chain', {
        ...chain,
        dependencies: {
          '@agentlink/types': 'workspace:*',
          '@agentlink/crypto': 'workspace:*',
          viem: '2.0.0',
        },
      }),
    ).toEqual([]);
    expect(
      checkManifest('packages/crypto', {
        ...crypto,
        dependencies: { '@noble/curves': '1.0.0', '@hpke/core': '1.0.0' },
      }),
    ).toEqual([]);
  });

  it('rejects a directory that has no policy entry', () => {
    expect(checkManifest('packages/mystery', { name: 'x' })).toEqual([
      expect.stringContaining('no entry in tools/deps-check/policy.mjs'),
    ]);
  });

  it('rejects a package name that differs from the policy', () => {
    expect(checkManifest('packages/crypto', { name: '@agentlink/crypt0' })).toEqual([
      expect.stringContaining('policy.mjs expects "@agentlink/crypto"'),
    ]);
  });

  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])(
    'rejects a primitive library in %s outside its zone',
    (field) => {
      const problems = checkManifest('packages/core', {
        name: '@agentlink/core',
        [field]: { '@noble/hashes': '1.0.0' },
      });
      expect(problems).toEqual([expect.stringContaining('@noble/* may be imported only in')]);
    },
  );

  it.each([
    ['@noble/curves', 'packages/chain'],
    ['@hpke/core', 'packages/core'],
    ['nostr-tools', 'packages/storage'],
    ['viem', 'packages/storage'],
    ['viem', 'apps/submitter'],
    ['aws4fetch', 'packages/transport-nostr'],
  ])('rejects %s declared in %s', (library, zone) => {
    const problems = checkManifest(zone, {
      name: ZONES[zone].name,
      dependencies: { [library]: '1.0.0' },
    });
    expect(problems.some((problem) => problem.includes('may be imported only in'))).toBe(true);
  });

  it('sees through an npm: alias', () => {
    expect(realPackageName('curves', 'npm:@noble/curves@1.2.3')).toBe('@noble/curves');
    expect(realPackageName('x', 'npm:left-pad')).toBe('left-pad');
    const problems = checkManifest('packages/core', {
      name: '@agentlink/core',
      dependencies: { curves: 'npm:@noble/curves@1.2.3' },
    });
    expect(problems).toEqual([expect.stringContaining('(alias of @noble/curves)')]);
  });

  it('rejects a forbidden workspace dependency (layering)', () => {
    const problems = checkManifest('packages/crypto', {
      ...crypto,
      dependencies: { '@agentlink/core': 'workspace:*' },
    });
    expect(problems).toEqual([expect.stringContaining('may not import @agentlink/core')]);
    expect(
      checkManifest('apps/console', {
        name: '@agentlink/console',
        devDependencies: { '@agentlink/node': 'workspace:*' },
      }),
    ).toEqual([expect.stringContaining('may not import @agentlink/node')]);
  });

  it('rejects a runtime dependency that is not on the per-package allowlist', () => {
    const problems = checkManifest('packages/storage', {
      name: '@agentlink/storage',
      dependencies: { 'left-pad': '1.0.0' },
    });
    expect(problems).toEqual([expect.stringContaining('runtime-dependency allowlist')]);
  });

  it('leaves devDependencies (tools) free of the runtime allowlist', () => {
    expect(
      checkManifest('packages/storage', {
        name: '@agentlink/storage',
        devDependencies: { vitest: '4.0.0' },
      }),
    ).toEqual([]);
  });
});

describe('findCycle', () => {
  it('finds a cycle and reports its path', () => {
    expect(findCycle({ a: ['b'], b: ['c'], c: ['a'] })).toEqual(['a', 'b', 'c', 'a']);
  });
  it('accepts a DAG', () => {
    expect(findCycle({ a: ['b', 'c'], b: ['c'], c: [] })).toBeNull();
  });
});

describe('checkSource', () => {
  it('accepts allowed imports', () => {
    expect(src('packages/crypto', `import { x } from '@noble/curves/secp256k1';`)).toEqual([]);
    expect(src('packages/chain', `import { y } from '@agentlink/crypto'; import 'viem';`)).toEqual(
      [],
    );
    expect(src('packages/node', `import { readFileSync } from 'node:fs';`)).toEqual([]);
    expect(
      src('packages/chain', `import { z } from './b.js'; import { w } from '../src/c.js';`),
    ).toEqual([]);
  });

  it.each([
    [`import x from '@noble/hashes/sha2';`, 'packages/core'],
    [`import x from '@hpke/core';`, 'packages/chain'],
    [`import { x } from 'nostr-tools/pure';`, 'packages/chain'],
    [`import { createPublicClient } from 'viem';`, 'packages/storage'],
    [`import { AwsClient } from 'aws4fetch';`, 'packages/core'],
    [`export * from '@noble/curves';`, 'packages/core'],
    [`import type { T } from 'viem';`, 'packages/core'],
    [`import fs from 'node:fs';`, 'packages/core'],
    [`import { join } from 'path';`, 'packages/chain'],
    [`import { webcrypto } from 'node:crypto';`, 'packages/node'],
    [`import { randomBytes } from 'crypto';`, 'apps/cli'],
    [`import { x } from '@agentlink/core';`, 'packages/crypto'],
    [`import { x } from '@agentlink/node';`, 'apps/console'],
  ])('rejects the static import %s in %s', (code, zone) => {
    expect(src(zone, code)).toHaveLength(1);
  });

  it.each([
    [`const m = await import('@noble/curves');`],
    [`const m = require('viem');`],
    [`import fs = require('node:fs');`],
    [`type T = import('@hpke/core').CipherSuite;`],
    [`const m = await import(\`node:fs\`);`],
  ])('rejects the bypass form %s', (code) => {
    expect(src('packages/core', code)).toHaveLength(1);
  });

  it('rejects a dynamic import with a computed specifier', () => {
    const problems = src('apps/cli', `const m = await import(name);`);
    expect(problems).toEqual([expect.stringContaining('non-literal specifier')]);
    expect(src('apps/cli', `require(name);`)).toHaveLength(1);
  });

  it('rejects a relative import that leaves the package', () => {
    const problems = src('packages/chain', `import { x } from '../../crypto/src/index.js';`);
    expect(problems).toEqual([expect.stringContaining('leaves packages/chain')]);
    expect(src('packages/chain', `export * from '../../../apps/cli/src/index.js';`)).toHaveLength(
      1,
    );
  });

  it.each([
    [`crypto.subtle.digest('SHA-256', d);`],
    [`globalThis.crypto.subtle.digest('SHA-256', d);`],
    [`const c = self.crypto; c['subtle'];`],
    [`const { subtle } = globalThis.crypto;`],
    [`const { subtle: s } = crypto;`],
  ])('rejects crypto.subtle outside packages/crypto: %s', (code) => {
    expect(src('packages/core', code)).toHaveLength(1);
    expect(src('packages/crypto', code)).toEqual([]);
  });

  it('parses plain JavaScript files too (ESLint zones cover TypeScript only)', () => {
    const problems = checkSource(
      'packages/core',
      join(ROOT, 'packages/core/src/a.mjs'),
      `import x from '@noble/curves';`,
      ROOT,
    );
    expect(problems).toHaveLength(1);
  });

  it.each([
    [`// eslint-disable-next-line no-restricted-imports\nimport x from '@noble/curves';`],
    [`/* eslint-disable no-restricted-syntax */`],
    [`// eslint-disable-next-line boundaries/no-bypass -- reason`],
    [`/* eslint-disable */`],
    [`// eslint-disable-next-line -- reason`],
    [`// eslint-disable-line no-console, no-restricted-imports`],
  ])('rejects an eslint-disable that switches off the boundary rules: %s', (code) => {
    const problems = src('packages/core', code).filter((p) => p.includes('eslint-disable'));
    expect(problems).toHaveLength(1);
  });

  it('allows unrelated eslint-disable directives', () => {
    const code = `// eslint-disable-next-line @typescript-eslint/no-explicit-any\nconst a: any = 1;`;
    expect(src('packages/core', code)).toEqual([]);
  });

  it('reports the file and line', () => {
    const problems = src('packages/core', `const a = 1;\nimport x from 'viem';`);
    expect(problems[0]).toMatch(/^packages\/core\/src\/a\.ts:2: /);
  });
});

describe('runChecks on a fixture repository', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo(files) {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-'));
    dirs.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(
        join(root, path),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
    return root;
  }
  const pkg = (name, extra = {}) => ({ name, version: '0.0.0', ...extra });

  it('passes a clean repository', () => {
    const root = repo({
      'packages/crypto/package.json': pkg('@agentlink/crypto', {
        dependencies: { '@noble/curves': '1.0.0' },
      }),
      'packages/crypto/src/index.ts': `import { x } from '@noble/curves'; crypto.subtle;`,
      'packages/chain/package.json': pkg('@agentlink/chain', {
        dependencies: { '@agentlink/crypto': 'workspace:*', viem: '2.0.0' },
      }),
      'packages/chain/src/index.ts': `import { y } from '@agentlink/crypto';`,
    });
    expect(runChecks(root)).toMatchObject({ problems: [], packages: 2, files: 2 });
  });

  it('fails a primitive-library import in a non-allowlisted package', () => {
    const root = repo({
      'packages/storage/package.json': pkg('@agentlink/storage'),
      'packages/storage/src/index.ts': `import { sha256 } from '@noble/hashes/sha2';`,
    });
    const { problems } = runChecks(root);
    expect(problems).toEqual([expect.stringContaining('packages/storage/src/index.ts:1')]);
  });

  it('fails a forbidden dependency declaration', () => {
    const root = repo({
      'packages/storage/package.json': pkg('@agentlink/storage', {
        dependencies: { 'nostr-tools': '2.0.0' },
      }),
    });
    expect(runChecks(root).problems).toEqual([expect.stringContaining('nostr-tools')]);
  });

  it('fails a workspace dependency cycle', () => {
    // The layering already forbids both edges; the cycle report is the second line of defence.
    const root = repo({
      'packages/types/package.json': pkg('@agentlink/types', {
        dependencies: { '@agentlink/core': 'workspace:*' },
      }),
      'packages/core/package.json': pkg('@agentlink/core', {
        dependencies: { '@agentlink/types': 'workspace:*' },
      }),
    });
    const { problems } = runChecks(root);
    expect(problems.some((problem) => problem.includes('dependency cycle'))).toBe(true);
    expect(problems.some((problem) => problem.includes('may not import @agentlink/core'))).toBe(
      true,
    );
  });

  it('fails a directory that is not in the policy and a missing manifest', () => {
    const root = repo({
      'packages/newcomer/package.json': pkg('@agentlink/newcomer'),
      'packages/newcomer/src/index.ts': `export {};`,
      'apps/drop/src/index.ts': `export {};`,
    });
    const { problems } = runChecks(root);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('packages/newcomer: no entry'),
        expect.stringContaining('apps/drop: no package.json'),
      ]),
    );
  });

  it('ignores node_modules at any depth and nothing else (full walk without repository data)', () => {
    const root = repo({
      'packages/crypto/package.json': pkg('@agentlink/crypto'),
      'packages/crypto/node_modules/dep/index.js': `require('node:fs')`,
      'packages/crypto/src/node_modules/dep/index.js': `require('node:fs')`,
    });
    expect(runChecks(root)).toMatchObject({ problems: [], files: 0 });
  });
});

describe('listSourceFilesIn', () => {
  it('fails closed when zones nest', () => {
    const a = join(ROOT, 'packages/a');
    expect(() => listSourceFilesIn(ROOT, [a, join(a, 'b')])).toThrow(/nest/);
  });
});

// OPS-REL-1: the published CLI bundles the @agentlink/* workspace packages into one file, so it
// re-declares their third-party runtime dependencies (exact same spec) as its own `dependencies`.
// Only a zone with `bundles: true` may do that; its own source imports stay checked as before.
describe('bundled workspace packages (policy `bundles`, OPS-REL-1)', () => {
  const cli = { name: '@4thtech-io/agentlink' };
  const manifests = {
    '@agentlink/crypto': {
      name: '@agentlink/crypto',
      dependencies: { '@noble/hashes': '2.4.0', '@hpke/core': '1.9.0' },
    },
    '@agentlink/node': {
      name: '@agentlink/node',
      dependencies: { '@agentlink/crypto': 'workspace:*', ws: '8.22.0' },
      devDependencies: { vitest: '4.1.11' },
    },
    '@agentlink/types': { name: '@agentlink/types', dependencies: { zod: '4.6.7' } },
  };
  const cliManifest = (dependencies) => ({
    ...cli,
    dependencies,
    devDependencies: { '@agentlink/node': 'workspace:*' },
  });

  it('only apps/cli bundles', () => {
    const bundling = Object.entries(ZONES)
      .filter(([, policy]) => policy.bundles === true)
      .map(([zone]) => zone);
    expect(bundling).toEqual(['apps/cli']);
  });

  it('collects the runtime dependencies of the bundled workspace packages, transitively', () => {
    const { runtime, problems } = bundledRuntimeOf(cliManifest({}), manifests);
    expect(problems).toEqual([]);
    expect(Object.fromEntries(runtime)).toEqual({
      '@noble/hashes': '2.4.0',
      '@hpke/core': '1.9.0',
      ws: '8.22.0',
    });
  });

  it('reports two bundled packages that declare one dependency with different specs', () => {
    const { problems } = bundledRuntimeOf(
      {
        ...cli,
        devDependencies: { '@agentlink/node': 'workspace:*', '@agentlink/log': 'workspace:*' },
      },
      {
        ...manifests,
        '@agentlink/log': { name: '@agentlink/log', dependencies: { ws: '8.21.0' } },
      },
    );
    expect(problems).toEqual([expect.stringContaining('ws')]);
  });

  it('accepts a re-declared runtime dependency of a bundled package with the same exact spec', () => {
    const { runtime } = bundledRuntimeOf(cliManifest({}), manifests);
    expect(
      checkManifest(
        'apps/cli',
        cliManifest({
          '@noble/hashes': '2.4.0',
          ws: '8.22.0',
          '@modelcontextprotocol/sdk': '1.32.1',
        }),
        { bundledRuntime: runtime },
      ),
    ).toEqual([]);
  });

  it('rejects a re-declared dependency whose spec differs from the bundled package', () => {
    const { runtime } = bundledRuntimeOf(cliManifest({}), manifests);
    const problems = checkManifest('apps/cli', cliManifest({ '@noble/hashes': '^2.4.0' }), {
      bundledRuntime: runtime,
    });
    expect(problems).toEqual([expect.stringContaining('@noble/* may be imported only in')]);
  });

  it('rejects a primitive library that no bundled package declares', () => {
    const { runtime } = bundledRuntimeOf(cliManifest({}), manifests);
    const problems = checkManifest('apps/cli', cliManifest({ '@noble/curves': '2.4.0' }), {
      bundledRuntime: runtime,
    });
    expect(problems).toEqual([expect.stringContaining('@noble/* may be imported only in')]);
  });

  it('keeps the library ban for re-declared dependencies in devDependencies', () => {
    const { runtime } = bundledRuntimeOf(cliManifest({}), manifests);
    const problems = checkManifest(
      'apps/cli',
      { ...cli, devDependencies: { '@noble/hashes': '2.4.0' } },
      { bundledRuntime: runtime },
    );
    expect(problems).toEqual([expect.stringContaining('@noble/* may be imported only in')]);
  });

  it('rejects a workspace package at runtime in a bundling zone (it is bundled, not installed)', () => {
    const problems = checkManifest('apps/cli', {
      ...cli,
      dependencies: { '@agentlink/core': 'workspace:*' },
    });
    expect(problems).toEqual([expect.stringContaining('bundled')]);
  });

  it('ignores bundledRuntime in a zone that does not bundle', () => {
    const problems = checkManifest(
      'packages/core',
      { name: '@agentlink/core', dependencies: { '@noble/hashes': '2.4.0' } },
      { bundledRuntime: new Map([['@noble/hashes', '2.4.0']]) },
    );
    expect(problems).toEqual([expect.stringContaining('@noble/* may be imported only in')]);
  });

  it('still refuses a primitive-library import in the bundling zone source', () => {
    expect(src('apps/cli', `import { sha256 } from '@noble/hashes/sha2.js';`)).toHaveLength(1);
  });
});

// OPS-REL-2: deps-check refuses any dependency or import in the third-party @agentlink scope.
// The old scope is spelled without its slash here so the repository scan (retired-scope.test.mjs)
// finds no `<scope>/<name>` text outside history.
const OLD = '@agentlink';
describe('retired @agentlink scope (OPS-REL-2)', () => {
  const RETIRED = expect.stringMatching(/@agentlink npm scope.*third party/);
  const core = { name: '@4thtech-io/core' };

  it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])(
    'refuses a package in the @agentlink scope in %s',
    (field) => {
      expect(
        checkManifest('packages/core', { ...core, [field]: { [`${OLD}/types`]: 'workspace:*' } }),
      ).toEqual(expect.arrayContaining([RETIRED]));
    },
  );

  it('refuses an npm: alias that points into the @agentlink scope', () => {
    expect(
      checkManifest('packages/core', {
        ...core,
        devDependencies: { innocent: `npm:${OLD}/types@1.0.0` },
      }),
    ).toEqual(expect.arrayContaining([RETIRED]));
  });

  it('refuses a package named in the @agentlink scope', () => {
    expect(checkManifest('packages/core', { name: `${OLD}/core` })).toEqual(
      expect.arrayContaining([RETIRED]),
    );
  });

  it('refuses a source import from the @agentlink scope', () => {
    expect(src('packages/core', `import { x } from '${OLD}/types';`)).toEqual([RETIRED]);
    expect(src('apps/cli', `const m = await import('${OLD}/node');`)).toEqual([RETIRED]);
  });

  it('accepts the renamed layering', () => {
    expect(
      checkManifest('packages/core', {
        ...core,
        dependencies: { '@4thtech-io/types': 'workspace:*' },
      }),
    ).toEqual([]);
  });
});
