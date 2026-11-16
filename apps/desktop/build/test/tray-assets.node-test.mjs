// TRAY-ENGINE (plan risk #5): the packaged apps carry the tray frames (build/lib/tray-assets.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_DIR } from '../lib/stage.mjs';
import {
  MAX_TRAY_SEQUENCES,
  TRAY_ASSETS_SOURCE,
  copyTrayAssets,
  trayAssetFiles,
} from '../lib/tray-assets.mjs';

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

test('L6: refuses a symlinked frame or manifest, and caps the sequence count', () => {
  const dir = tmp();
  try {
    const src = join(dir, 'src');
    mkdirSync(join(src, 'macos'), { recursive: true });
    const frame = { id: 'a', macos: ['macos/aTemplate.png'], windows: { dark: [], light: [] } };
    const outside = join(dir, 'outside.png');
    writeFileSync(outside, 'x');
    symlinkSync(outside, join(src, 'macos', 'aTemplate.png'));
    const write = (sequences) =>
      writeFileSync(join(src, 'manifest.json'), JSON.stringify({ frameMs: 40, sequences }));
    write({ s: { loop: false, frames: [frame] } });
    assert.throws(() => trayAssetFiles('darwin', src), /not a regular file/);
    assert.throws(() => copyTrayAssets(join(dir, 'out'), 'darwin', src), /not a regular file/);

    rmSync(join(src, 'macos', 'aTemplate.png'));
    writeFileSync(join(src, 'macos', 'aTemplate.png'), 'png');
    assert.deepEqual(trayAssetFiles('darwin', src), ['manifest.json', 'macos/aTemplate.png']);
    write(
      Object.fromEntries(
        Array.from({ length: MAX_TRAY_SEQUENCES + 1 }, (_, i) => [
          `s${i}`,
          { loop: false, frames: [] },
        ]),
      ),
    );
    assert.throws(() => trayAssetFiles('darwin', src), /Too many tray sequences/);

    rmSync(join(src, 'manifest.json'));
    symlinkSync(join(TRAY_ASSETS_SOURCE, 'manifest.json'), join(src, 'manifest.json'));
    assert.throws(() => trayAssetFiles('darwin', src), /not a regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
