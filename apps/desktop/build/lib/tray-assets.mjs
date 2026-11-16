// TRAY-ENGINE (0.5.9, plan risk #5): package the tray icon frames. The shell reads
// <resources>/assets/tray/manifest.json and the frames it names (src/main/tray-frames.ts). macOS gets
// the Template PNGs and also assets/trayTemplate.png(+@2x), the single static image main.ts names
// (never packaged before 0.5.9, so the built-in ring showed); Windows gets both taskbar sets (the .ico
// files from ico.mjs stay as the single-image fallback). The file list comes from the manifest only.
import { copyFileSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DESKTOP_DIR } from './stage.mjs';

export const TRAY_ASSETS_SOURCE = join(DESKTOP_DIR, 'assets', 'tray');

const SAFE_PATH = /^(macos|windows)\/[A-Za-z0-9][A-Za-z0-9_-]*(@2x)?\.png$/;
const MAC_STATIC = 'tray-connected';
/** Caps (the runtime parser in src/main/tray-frames.ts has the same sequence cap). */
export const MAX_TRAY_SEQUENCES = 64;
export const MAX_TRAY_FILES = 2048;

/** A regular file: lstat, so a symlink (or anything else) is refused. */
export function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function manifest(source) {
  const path = join(source, 'manifest.json');
  if (!isRegularFile(path)) throw new Error('The tray manifest.json is not a regular file.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The files (relative to assets/tray) a platform needs: manifest.json first, then its frames. */
export function trayAssetFiles(platform, source = TRAY_ASSETS_SOURCE) {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`No tray assets for ${platform}.`);
  }
  const files = new Set(['manifest.json']);
  const sequences = Object.values(manifest(source).sequences ?? {});
  if (sequences.length > MAX_TRAY_SEQUENCES) throw new Error('Too many tray sequences.');
  for (const sequence of sequences) {
    for (const frame of sequence.frames ?? []) {
      const list =
        platform === 'darwin'
          ? frame.macos
          : [...(frame.windows?.dark ?? []), ...(frame.windows?.light ?? [])];
      for (const file of list ?? []) {
        if (typeof file !== 'string' || !SAFE_PATH.test(file)) {
          throw new Error(`Unexpected tray frame path in manifest.json: ${String(file)}`);
        }
        if (!isRegularFile(join(source, file))) {
          throw new Error(
            `The tray frame ${file} is missing or not a regular file: run build/tray-frames.mjs.`,
          );
        }
        files.add(file);
        if (files.size > MAX_TRAY_FILES) throw new Error('Too many tray files.');
      }
    }
  }
  return [...files];
}

/** Copies the tray frames into <assetsDir>/tray (and, on macOS, assetsDir/trayTemplate.png). */
export function copyTrayAssets(assetsDir, platform, src = TRAY_ASSETS_SOURCE) {
  const files = trayAssetFiles(platform, src);
  const trayDir = join(assetsDir, 'tray');
  for (const file of files) {
    const dest = join(trayDir, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(src, file), dest);
  }
  if (platform === 'darwin') {
    for (const suffix of ['', '@2x']) {
      const from = join(src, 'macos', `${MAC_STATIC}Template${suffix}.png`);
      if (!isRegularFile(from))
        throw new Error(`The static tray image ${from} is not a regular file.`);
      copyFileSync(from, join(assetsDir, `trayTemplate${suffix}.png`));
    }
  }
  return files.length;
}
