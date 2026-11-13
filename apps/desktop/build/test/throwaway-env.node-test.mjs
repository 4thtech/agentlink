// WIN-DESK-1c: the launch checks run the built app on a throw-away profile that has both AppData
// folders (without Roaming, Electron has no user-data path on Windows and the lock fails).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwAwayEnv } from '../lib/throwaway-env.mjs';

test('the throw-away env points every profile variable at home and creates both AppData folders', () => {
  const home = mkdtempSync(join(tmpdir(), 'win-desk-1c-'));
  try {
    const env = throwAwayEnv(home, { PATH: '/bin', SystemRoot: 'C:\\Windows', OTHER: 'x' });
    assert.equal(env.USERPROFILE, home);
    assert.equal(env.HOME, home);
    assert.equal(env.TEMP, home);
    assert.equal(env.PATH, '/bin');
    assert.equal(env.APPDATA, join(home, 'AppData', 'Roaming'));
    assert.equal(env.LOCALAPPDATA, join(home, 'AppData', 'Local'));
    assert.equal(env.OTHER, undefined);
    assert.ok(statSync(env.APPDATA).isDirectory());
    assert.ok(statSync(env.LOCALAPPDATA).isDirectory());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the tamper and lockdown checks start the app with the throw-away env', () => {
  for (const f of ['check-tampered-asar.mjs', 'check-switch-lockdown.mjs']) {
    const s = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(s, /const env = throwAwayEnv\(home\);/, f);
  }
});
