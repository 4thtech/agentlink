import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { constants, assetFor } from '../lib/constants.mjs';

const root = new URL('../../../../', import.meta.url);

test('every pinned asset has a 64-hex SHA-256 and an https url on an allowed host', () => {
  for (const kind of ['node', 'electron']) {
    for (const [platform, a] of Object.entries(constants[kind].assets)) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/, `${kind} ${platform}`);
      const u = new URL(a.url);
      assert.equal(u.protocol, 'https:');
      assert.ok(
        constants.allowedHosts.includes(u.hostname),
        `${kind} ${platform} host ${u.hostname}`,
      );
    }
  }
});

test('covers darwin arm64, darwin x64 and win32 x64 for both runtimes', () => {
  for (const kind of ['node', 'electron']) {
    assert.deepEqual(Object.keys(constants[kind].assets).sort(), [
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
    ]);
  }
  assert.equal(
    assetFor('node', 'darwin-arm64').sha256,
    constants.node.assets['darwin-arm64'].sha256,
  );
  assert.throws(() => assetFor('node', 'linux-x64'));
});

test('Node pin is shared with installer/install.sh and installer/install.ps1', () => {
  const sh = readFileSync(new URL('installer/install.sh', root), 'utf8');
  const ps = readFileSync(new URL('installer/install.ps1', root), 'utf8');
  assert.ok(sh.includes(`NODE_VERSION=${constants.node.version}`));
  assert.ok(sh.includes(constants.node.assets['darwin-arm64'].sha256));
  assert.ok(sh.includes(constants.node.assets['darwin-x64'].sha256));
  assert.ok(ps.includes(constants.node.assets['win32-x64'].sha256));
});

test('Electron is an exact version', () => {
  assert.match(constants.electron.version, /^\d+\.\d+\.\d+$/);
});
