// WP-D10: release builds refuse to package the placeholder root key (lib/root-key-check.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OWNER_LOCAL_VAR,
  ROOT_KEY_PLACEHOLDER_MARK,
  UPDATES_OFF_MARK,
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

// DESK051-C4: until the key ceremony, a public release is built with updates OFF: the bundle carries
// root-key.updates-off.json (no key, the updates-off mark) instead of the placeholder, so the app's
// updater is not configured and never fetches. Allowed in CI; no owner-local flag involved.
const OFF_JSON = readFileSync(`${DESKTOP}/src/main/updater/root-key.updates-off.json`, 'utf8');
const offAsar = [{ path: 'dist/main/entry.js', content: Buffer.from(`var r=${OFF_JSON.trim()};`) }];

test('the updates-off root holds the mark, no key and no placeholder', () => {
  assert.ok(OFF_JSON.includes(UPDATES_OFF_MARK));
  assert.ok(!OFF_JSON.includes(ROOT_KEY_PLACEHOLDER_MARK));
  assert.notDeepEqual(rootKeyProblems(OFF_JSON), []);
});

test('an updates-off release build passes in CI when the ASAR has the mark and no placeholder', () => {
  for (const env of [{}, { CI: 'true', GITHUB_ACTIONS: 'true' }]) {
    assert.equal(
      assertRootKeyPinned({ rootKeyJson: REPO_JSON, files: offAsar, env, updates: 'off' }),
      'updates-off',
    );
  }
});

test('an updates-off build is refused when the placeholder or no mark is in the ASAR', () => {
  const stale = [
    ...offAsar,
    { path: 'dist/main/x.js', content: Buffer.from(ROOT_KEY_PLACEHOLDER_MARK) },
  ];
  assert.throws(
    () => assertRootKeyPinned({ rootKeyJson: REPO_JSON, files: stale, env: {}, updates: 'off' }),
    /in the release ASAR/,
  );
  assert.throws(
    () =>
      assertRootKeyPinned({ rootKeyJson: REPO_JSON, files: cleanAsar, env: {}, updates: 'off' }),
    /updates-off/,
  );
  assert.throws(() =>
    assertRootKeyPinned({ rootKeyJson: REPO_JSON, files: offAsar, env: {}, updates: 'maybe' }),
  );
});

test('the updates-off mark never satisfies an updates-on build', () => {
  assert.throws(
    () => assertRootKeyPinned({ rootKeyJson: REPO_JSON, files: offAsar, env: {} }),
    /release build refused/,
  );
});

test('the release bundle swaps in the updates-off root only when asked', async () => {
  const { execFileSync } = await import('node:child_process');
  const probe = (env) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "const c=(await import('./bundle.config.mjs')).default;console.log(JSON.stringify(c.resolve?.alias??[]))",
        ],
        {
          cwd: DESKTOP,
          env: { PATH: process.env.PATH, ...env },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ),
    );
  assert.match(
    JSON.stringify(probe({ AGENTLINK_DESKTOP_UPDATES: 'off' })),
    /root-key\.updates-off\.json/,
  );
  assert.doesNotMatch(JSON.stringify(probe({})), /updates-off/);
  assert.throws(() => probe({ AGENTLINK_DESKTOP_UPDATES: 'maybe' }));
});
