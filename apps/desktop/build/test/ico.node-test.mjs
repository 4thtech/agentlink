// WIN-DESK-2 (R-WIN §6 item 6): the Windows tray icons are .ico files built from the brand PNGs in
// docs/design/brand/icons/tray/windows (one per taskbar colour, 16/20/24/32 px).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { icoFromPngs, trayIcoSources, TRAY_ICO_NAMES } from '../lib/ico.mjs';

const png = (size) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(size, 16);
  b.writeUInt32BE(size, 20);
  return b;
};

test('icoFromPngs writes an ICONDIR with one PNG entry per size', () => {
  const images = [png(16), png(32)];
  const ico = icoFromPngs(images);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1); // icon
  assert.equal(ico.readUInt16LE(4), 2);
  let offset = 6 + 16 * 2;
  for (let i = 0; i < 2; i += 1) {
    const e = 6 + 16 * i;
    const size = i === 0 ? 16 : 32;
    assert.equal(ico[e], size);
    assert.equal(ico[e + 1], size);
    assert.equal(ico.readUInt16LE(e + 4), 1);
    assert.equal(ico.readUInt16LE(e + 6), 32);
    assert.equal(ico.readUInt32LE(e + 8), images[i].length);
    assert.equal(ico.readUInt32LE(e + 12), offset);
    assert.deepEqual(ico.subarray(offset, offset + images[i].length), images[i]);
    offset += images[i].length;
  }
  assert.equal(ico.length, offset);
});

test('icoFromPngs refuses anything but a PNG of 1..256 px', () => {
  assert.throws(() => icoFromPngs([]));
  assert.throws(() => icoFromPngs([Buffer.from('not a png at all, really not')]));
  assert.throws(() => icoFromPngs([png(0)]));
  assert.throws(() => icoFromPngs([png(512)]));
});

test('the tray icons come from the brand PNGs, one .ico per taskbar colour', () => {
  assert.deepEqual(TRAY_ICO_NAMES, {
    dark: 'tray-dark-taskbar.ico',
    light: 'tray-light-taskbar.ico',
  });
  const sources = trayIcoSources();
  for (const taskbar of ['dark', 'light']) {
    assert.equal(sources[taskbar].length, 4);
    for (const [i, size] of [16, 20, 24, 32].entries()) {
      const file = sources[taskbar][i];
      assert.ok(file.endsWith(`agentlink-tray-windows-connected-${taskbar}-taskbar-${size}.png`));
      const ico = icoFromPngs([readFileSync(file)]);
      assert.equal(ico[6], size);
    }
  }
});
