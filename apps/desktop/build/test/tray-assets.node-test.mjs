// TRAY-ENGINE (plan risk #5): the packaged apps carry the tray frames (build/lib/tray-assets.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_DIR } from '../lib/stage.mjs';
import { TRAY_ASSETS_SOURCE, copyTrayAssets, trayAssetFiles } from '../lib/tray-assets.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'tray-assets-'));

test('macOS: manifest, every Template PNG and the static trayTemplate.png for the shell', () => {
  const dir = tmp();
  try {
    const assets = join(dir, 'assets');
    const copied = copyTrayAssets(assets, 'darwin');
    assert.ok(copied > 10);
    assert.ok(existsSync(join(assets, 'tray', 'manifest.json')));
    assert.ok(existsSync(join(assets, 'tray', 'macos', 'tray-connectedTemplate.png')));
    assert.ok(existsSync(join(assets, 'tray', 'macos', 'msg-in-0Template@2x.png')));
    assert.equal(existsSync(join(assets, 'tray', 'windows')), false);
    assert.equal(existsSync(join(assets, 'tray', 'svg')), false);
    // main.ts resourcePaths() names assets/trayTemplate.png on macOS (never packaged before).
    assert.deepEqual(
      readFileSync(join(assets, 'trayTemplate.png')),
      readFileSync(join(TRAY_ASSETS_SOURCE, 'macos', 'tray-connectedTemplate.png')),
    );
    assert.ok(existsSync(join(assets, 'trayTemplate@2x.png')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows: manifest and both taskbar sets, no macOS files', () => {
  const dir = tmp();
  try {
    const assets = join(dir, 'assets');
    copyTrayAssets(assets, 'win32');
    const files = readdirSync(join(assets, 'tray', 'windows'));
    assert.ok(files.some((f) => f.includes('-dark-taskbar-')));
    assert.ok(files.some((f) => f.includes('-light-taskbar-')));
    assert.equal(existsSync(join(assets, 'tray', 'macos')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file list comes from the manifest and stays inside the tray folder', () => {
  for (const platform of ['darwin', 'win32']) {
    const files = trayAssetFiles(platform);
    assert.equal(files[0], 'manifest.json');
    for (const f of files) {
      assert.ok(!f.includes('..') && !f.startsWith('/'), f);
      assert.ok(existsSync(join(TRAY_ASSETS_SOURCE, f)), f);
    }
  }
  assert.throws(() => trayAssetFiles('linux'));
});

test('build-mac and build-win package the tray frames', () => {
  for (const [script, platform] of [
    ['build-mac.mjs', 'darwin'],
    ['build-win.mjs', 'win32'],
  ]) {
    const src = readFileSync(join(DESKTOP_DIR, 'build', script), 'utf8');
    assert.match(src, /from '\.\/lib\/tray-assets\.mjs'/, script);
    assert.match(src, new RegExp(`copyTrayAssets\\(.*'${platform}'\\)`), script);
  }
});
