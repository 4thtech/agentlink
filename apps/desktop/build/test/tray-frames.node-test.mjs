import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const dir = join(DESKTOP_DIR, 'assets', 'tray');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const dims = (file) => {
  const b = readFileSync(join(dir, file));
  assert.equal(b.toString('ascii', 1, 4), 'PNG', file);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

test('tray manifest: sequences, frame counts and duration', () => {
  const n = Object.fromEntries(
    Object.entries(manifest.sequences).map(([k, v]) => [k, v.frames.length]),
  );
  assert.deepEqual(n, { 'msg-in': 8, 'msg-out': 8, approval: 6, connecting: 8, static: 6 });
  assert.equal(manifest.frameMs, 40);
  assert.equal(manifest.sequences.connecting.loop, true);
});

test('tray manifest: every file exists with the right size', () => {
  for (const s of Object.values(manifest.sequences)) {
    for (const f of s.frames) {
      assert.ok(existsSync(join(dir, f.svg)), f.svg);
      assert.deepEqual(dims(f.macos[0]), [16, 16]);
      assert.deepEqual(dims(f.macos[1]), [32, 32]);
      assert.ok(f.macos[0].endsWith('Template.png') && f.macos[1].endsWith('Template@2x.png'));
      for (const taskbar of ['dark', 'light']) {
        assert.deepEqual(dims(f.windows[taskbar][0]), [16, 16]);
        assert.deepEqual(dims(f.windows[taskbar][1]), [32, 32]);
      }
    }
  }
});
