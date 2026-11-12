import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkTgzDeps, lockRegistryProblems } from '../lib/core-lock.mjs';
import { buildCoreLock, readPnpmLock } from '../lib/pnpm-core-lock.mjs';
import { tamperAsarHeader } from '../lib/tamper.mjs';

const dir = new URL('../core-lock/', import.meta.url);

test('the packed CLI dependencies must be a subset of the committed lock, same version', () => {
  assert.deepEqual(checkTgzDeps({ zod: '4.6.7' }, { zod: '4.6.7', ws: '8.22.0' }), []);
  assert.equal(checkTgzDeps({ zod: '4.6.8' }, { zod: '4.6.7' }).length, 1);
  assert.equal(checkTgzDeps({ evil: '1.0.0' }, { zod: '4.6.7' }).length, 1);
});

test('core-lock matches apps/cli dependencies exactly and uses the public registry only', () => {
  const lockPkg = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
  const cli = JSON.parse(
    readFileSync(new URL('../../../cli/package.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(lockPkg.dependencies, cli.dependencies);
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', dir), 'utf8'));
  assert.deepEqual(lockRegistryProblems(lock), []);
  assert.ok(Object.keys(lock.packages).length > 20);
});

test('core-lock has no drift from pnpm-lock.yaml (same name@version and integrity)', async () => {
  const pnpm = await readPnpmLock(new URL('../../../../pnpm-lock.yaml', import.meta.url));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', dir), 'utf8'));
  const names = new Set();
  for (const [path, p] of Object.entries(lock.packages)) {
    if (!path) continue;
    const name = path.split('node_modules/').pop();
    names.add(name);
    const meta = pnpm.packages[`${name}@${p.version}`];
    assert.ok(meta, `${name}@${p.version} is not in pnpm-lock.yaml`);
    assert.equal(p.integrity, meta.resolution.integrity, `${name}@${p.version} integrity`);
  }
  assert.ok(names.size > 20);
  const cli = JSON.parse(
    readFileSync(new URL('../../../cli/package.json', import.meta.url), 'utf8'),
  );
  const regenerated = buildCoreLock(pnpm, 'apps/cli', cli.dependencies);
  assert.deepEqual(lock, regenerated, 'core-lock is stale: run node update-core-lock.mjs');
});

test('lockRegistryProblems flags a foreign registry and a missing integrity', () => {
  const lock = {
    packages: {
      '': {},
      'node_modules/a': { resolved: 'https://evil.example/a.tgz', integrity: 'sha512-x' },
      'node_modules/b': { resolved: 'https://registry.npmjs.org/b/-/b-1.tgz' },
    },
  };
  assert.equal(lockRegistryProblems(lock).length, 2);
});

test('tamperAsarHeader changes exactly one byte inside the header', () => {
  const src = Buffer.from('xxxx{"files":{"a":{"size":1,"offset":"0"}}}');
  const out = tamperAsarHeader(src);
  let diff = 0;
  for (let i = 0; i < src.length; i++) if (src[i] !== out[i]) diff++;
  assert.equal(diff, 1);
});
