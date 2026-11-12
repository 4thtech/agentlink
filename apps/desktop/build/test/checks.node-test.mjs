import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPreviewString, PREVIEW_VAR } from '../lib/preview-check.mjs';
import { EXTRA_CASES, FORBIDDEN_SWITCHES, runLockdown } from '../lib/switch-check.mjs';

test('preview check flags the variable name anywhere in the content', () => {
  assert.equal(PREVIEW_VAR, 'AGENTLINK_DESKTOP_PREVIEW');
  const hits = findPreviewString([
    { path: 'dist/main/a.js', content: Buffer.from('ok') },
    { path: 'dist/main/b.js', content: Buffer.from('x=process.env.AGENTLINK_DESKTOP_PREVIEW') },
  ]);
  assert.deepEqual(hits, ['dist/main/b.js']);
  assert.deepEqual(findPreviewString([{ path: 'c', content: Buffer.from('clean') }]), []);
});

test('the forbidden switch list covers the H1 set', () => {
  for (const s of [
    '--remote-debugging-port=9222',
    '--remote-debugging-pipe',
    '--inspect',
    '--inspect-brk',
    '--js-flags=--expose-gc',
    '--proxy-server=x:1',
    '--disable-web-security',
    '--host-rules=MAP * x',
    '--user-data-dir=/tmp/x',
    '--load-extension=/tmp/e',
    '--enable-logging',
    '--some-unknown-switch',
  ]) {
    const name = s.split('=')[0];
    assert.ok(
      FORBIDDEN_SWITCHES.some((f) => f.split('=')[0] === name),
      s,
    );
  }
});

test('single-dash, Windows-style and after-the-link forms are covered', async () => {
  for (const f of ['-inspect', '/inspect', '/remote-debugging-port=9222']) {
    assert.ok(
      FORBIDDEN_SWITCHES.some((x) => x.split('=')[0] === f.split('=')[0]),
      f,
    );
  }
  assert.ok(
    EXTRA_CASES.some(
      (c) => c[0] === '--' && c[1].startsWith('agentlink://') && c[2]?.startsWith('--'),
    ),
  );
  const seen = [];
  await runLockdown({
    exe: '/x',
    launch: async (_e, argv) => (seen.push(argv), { code: 1, windowSeen: false }),
  });
  assert.ok(seen.length >= FORBIDDEN_SWITCHES.length + EXTRA_CASES.length);
});

test('runLockdown passes only when every switch exits non-zero with no window', async () => {
  const good = async () => ({ code: 1, windowSeen: false });
  assert.equal((await runLockdown({ exe: '/x', launch: good })).failures.length, 0);
  const bad = async (_e, args) =>
    args[0].startsWith('--inspect')
      ? { code: 0, windowSeen: true }
      : { code: 1, windowSeen: false };
  assert.ok((await runLockdown({ exe: '/x', launch: bad })).failures.length >= 2);
  const timeout = async () => ({ code: null, windowSeen: false });
  assert.ok((await runLockdown({ exe: '/x', launch: timeout })).failures.length > 0);
});
