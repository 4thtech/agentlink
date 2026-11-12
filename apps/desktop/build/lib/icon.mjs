// App icon. Uses apps/desktop/assets/AgentLink.icns when present (the real artwork lands with the
// design); otherwise builds a flat placeholder .icns on macOS (sips + iconutil), so a build never
// ships Electron's own icon by accident.
import { existsSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { run } from './run.mjs';
import { DESKTOP_DIR } from './stage.mjs';

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function solidPng(size, [r, g, b]) {
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Writes the icon to `dest` (a .icns path). Returns 'assets' or 'placeholder'. */
export function makeIcns(dest, workDir) {
  const given = join(DESKTOP_DIR, 'assets', 'AgentLink.icns');
  if (existsSync(given)) {
    copyFileSync(given, dest);
    return 'assets';
  }
  const set = join(workDir, 'AgentLink.iconset');
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  const base = join(workDir, 'icon-1024.png');
  writeFileSync(base, solidPng(1024, [0x1f, 0x3a, 0x5f]));
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [
      [1, ''],
      [2, '@2x'],
    ]) {
      const px = s * scale;
      run(
        'sips',
        ['-z', String(px), String(px), base, '--out', join(set, `icon_${s}x${s}${suffix}.png`)],
        { stdio: 'ignore' },
      );
    }
  }
  run('iconutil', ['-c', 'icns', set, '-o', dest]);
  return 'placeholder';
}
