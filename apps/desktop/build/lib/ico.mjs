// WIN-DESK-2 (R-WIN §6 item 6): the Windows tray icons. A .ico file can hold PNG images directly
// (Windows Vista and later); this writes one from the brand PNGs in
// docs/design/brand/icons/tray/windows, one file per taskbar colour, 16, 20, 24 and 32 px. The app
// picks one at start (src/main/main.ts resourcePaths). Pure Node, so it runs on any build host.
import { join } from 'node:path';
import { DESKTOP_DIR } from './stage.mjs';

/** The file names under resources\assets (the shell reads the same names). */
export const TRAY_ICO_NAMES = Object.freeze({
  dark: 'tray-dark-taskbar.ico',
  light: 'tray-light-taskbar.ico',
});

const SIZES = [16, 20, 24, 32];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The brand PNGs for each taskbar colour (the "connected" state), smallest first. */
export function trayIcoSources() {
  const dir = join(DESKTOP_DIR, '..', '..', 'docs', 'design', 'brand', 'icons', 'tray', 'windows');
  const files = (taskbar) =>
    SIZES.map((size) =>
      join(dir, `agentlink-tray-windows-connected-${taskbar}-taskbar-${size}.png`),
    );
  return { dark: files('dark'), light: files('light') };
}

/** Width and height of a PNG from its IHDR chunk; throws when it is not a PNG. */
function pngSize(png) {
  if (
    png.length < 24 ||
    !png.subarray(0, 8).equals(PNG_MAGIC) ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('Not a PNG image.');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** An .ico holding the PNG images as they are (ICONDIR, one ICONDIRENTRY each, then the PNGs). */
export function icoFromPngs(pngs) {
  if (!Array.isArray(pngs) || pngs.length === 0) throw new Error('No images for the icon.');
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const { width, height } = pngSize(png);
    for (const side of [width, height]) {
      if (side < 1 || side > 256) throw new Error('Icon images must be 1 to 256 pixels.');
    }
    const e = 6 + 16 * i;
    header[e] = width === 256 ? 0 : width;
    header[e + 1] = height === 256 ? 0 : height;
    header[e + 2] = 0; // no palette
    header[e + 3] = 0;
    header.writeUInt16LE(1, e + 4); // colour planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}
