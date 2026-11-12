// WP-D10: release builds refuse to package the placeholder root key (lib/root-key-check.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OWNER_LOCAL_VAR,
  ROOT_KEY_PLACEHOLDER_MARK,
  assertRootKeyPinned,
  findRootKeyPlaceholder,
  rootKeyProblems,
} from '../lib/root-key-check.mjs';

const DESKTOP = fileURLToPath(new URL('../..', import.meta.url));
const REPO_JSON = readFileSync(`${DESKTOP}/src/main/updater/root-key.json`, 'utf8');
const REAL = JSON.stringify({
  rootPublicKey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  minimumStatementSequence: 0,
});
const cleanAsar = [{ path: 'dist/main/entry.js', content: Buffer.from('console.log(1)') }];

test('the committed root-key.json is the placeholder, and a release build refuses it', () => {
  assert.ok(REPO_JSON.includes(ROOT_KEY_PLACEHOLDER_MARK));
  assert.notDeepEqual(rootKeyProblems(REPO_JSON), []);
  assert.throws(
    () => assertRootKeyPinned({ rootKeyJson: REPO_JSON, files: cleanAsar, env: {} }),
    /release build refused/,
  );
});

test('a real key passes; the placeholder anywhere in the ASAR still refuses', () => {
  assert.equal(assertRootKeyPinned({ rootKeyJson: REAL, files: cleanAsar, env: {} }), 'pinned');
  const stale = [
    { path: 'dist/main/entry.js', content: Buffer.from(`x="${ROOT_KEY_PLACEHOLDER_MARK}-y"`) },
  ];
  assert.deepEqual(findRootKeyPlaceholder(stale), ['dist/main/entry.js']);
  assert.throws(
    () => assertRootKeyPinned({ rootKeyJson: REAL, files: stale, env: {} }),
    /in the release ASAR/,
  );
});

test('malformed keys and floors are refused', () => {
  for (const json of [
    '{',
    JSON.stringify({ rootPublicKey: 'AB'.repeat(32), minimumStatementSequence: 0 }),
    JSON.stringify({ rootPublicKey: 'ab'.repeat(32), minimumStatementSequence: -1 }),
    JSON.stringify({ rootPublicKey: 'ab'.repeat(32) }),
    // Not a point on the curve (x >= p).
    JSON.stringify({ rootPublicKey: 'ff'.repeat(32), minimumStatementSequence: 0 }),
    JSON.stringify({
      rootPublicKey: '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      minimumStatementSequence: 2 ** 31,
    }),
  ]) {
    assert.notDeepEqual(rootKeyProblems(json), [], json);
  }
});

test('the owner-local exception never applies in CI', () => {
  const local = { [OWNER_LOCAL_VAR]: '1' };
  assert.equal(
    assertRootKeyPinned({ rootKeyJson: REPO_JSON, files: cleanAsar, env: local }),
    'owner-local',
  );
  for (const ci of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }]) {
    assert.throws(() =>
      assertRootKeyPinned({ rootKeyJson: REPO_JSON, files: cleanAsar, env: { ...local, ...ci } }),
    );
  }
  assert.throws(() =>
    assertRootKeyPinned({
      rootKeyJson: REPO_JSON,
      files: cleanAsar,
      env: { [OWNER_LOCAL_VAR]: 'yes' },
    }),
  );
});
