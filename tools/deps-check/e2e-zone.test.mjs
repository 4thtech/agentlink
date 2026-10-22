// M1-1g-c (IR-M1-1g-b-1 C-1): the boundary guards scan e2e/. e2e is never built or published and
// may use the crypto test seam (04 §3.1.1), but its suites touch real crypto paths, so the primitive
// libraries, the /keystore entry, Node crypto and crypto.subtle stay refused there.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runChecks } from './check.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FORBIDDEN = [
  [
    'a primitive library',
    `import { secp256k1 } from '@noble/curves/secp256k1';\nvoid secp256k1;\n`,
  ],
  ['a hash library', `import { sha256 } from '@noble/hashes/sha2';\nvoid sha256;\n`],
  ['hpke', `import { CipherSuite } from '@hpke/core';\nvoid CipherSuite;\n`],
  ['the restricted keystore entry', `import { x } from '@4thtech-io/crypto/keystore';\nvoid x;\n`],
  ['node:crypto', `import { createHash } from 'node:crypto';\nvoid createHash;\n`],
  [
    'crypto.subtle',
    `export const k = () => globalThis.crypto.subtle.digest('SHA-256', new Uint8Array());\n`,
  ],
  ['a deep import', `import { x } from '@4thtech-io/crypto/src/testing';\nvoid x;\n`],
  ['a retired scope', `import { x } from '@agentlink/core';\nvoid x;\n`],
];

const ALLOWED = [
  [
    'the test seam',
    `import { MemoryKeyStore } from '@4thtech-io/crypto/testing';\nvoid MemoryKeyStore;\n`,
  ],
  ['a workspace package', `import { openAgent } from '@4thtech-io/node';\nvoid openAgent;\n`],
  ['a Node built-in', `import { readFile } from 'node:fs/promises';\nvoid readFile;\n`],
  [
    'the built CLI modules',
    `import { x } from '../../apps/cli/dist/runtime/index.js';\nvoid x;\n`,
  ],
];

describe('deps-check repository scan covers e2e/', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const repo = (code, name = 'e2e/test/a.test.ts') => {
    const root = mkdtempSync(join(tmpdir(), 'deps-check-e2e-'));
    dirs.push(root);
    const files = {
      '.gitignore': 'node_modules/\n',
      'packages/core/package.json': JSON.stringify({ name: '@4thtech-io/core' }),
      [name]: code,
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
  };

  it.each(FORBIDDEN)('reports %s planted in e2e/', (_label, code) => {
    const { problems } = runChecks(repo(code));
    expect(problems.some((problem) => problem.includes('e2e/test/a.test.ts'))).toBe(true);
  });

  it('scans every e2e/ directory and file kind (.mjs, nested)', () => {
    const { problems } = runChecks(
      repo(
        `import { secp256k1 } from '@noble/curves/secp256k1';\nvoid secp256k1;\n`,
        'e2e/src/deep/a.mjs',
      ),
    );
    expect(problems.join('\n')).toMatch(/e2e\/src\/deep\/a\.mjs/);
  });

  it.each(ALLOWED)('passes %s in e2e/', (_label, code) => {
    expect(runChecks(repo(code)).problems).toEqual([]);
  });

  it('refuses a relative import out of e2e/ other than the built CLI modules', () => {
    const { problems } = runChecks(
      repo(`import { x } from '../../packages/crypto/src/keystore.js';\nvoid x;\n`),
    );
    expect(problems.join('\n')).toMatch(/leaves e2e/);
  });

  it('reports the real repository clean', () => {
    expect(runChecks(REPO).problems).toEqual([]);
  });
});

describe('the ESLint config covers e2e/', () => {
  let eslint;
  beforeAll(async () => {
    eslint = new ESLint({ cwd: REPO, overrideConfigFile: join(REPO, 'eslint.config.mjs') });
    await eslint.lintText('export {};\n', { filePath: join(REPO, 'e2e/test/warmup.ts') });
  }, 60_000);
  const BOUNDARY = new Set(['no-restricted-imports', 'boundaries/no-bypass']);
  const lint = async (code) => {
    const [result] = await eslint.lintText(code, { filePath: join(REPO, 'e2e/test/a.test.ts') });
    return result.messages.filter((message) => BOUNDARY.has(message.ruleId));
  };

  it.each(FORBIDDEN)('rejects %s in e2e/', async (_label, code) => {
    expect((await lint(code)).length).toBeGreaterThan(0);
  });

  it.each(ALLOWED)('allows %s in e2e/', async (_label, code) => {
    expect(await lint(code)).toEqual([]);
  });
});
