// TRAY-ENGINE (0.5.9, plan risk #5): package the tray icon frames. The shell reads
// <resources>/assets/tray/manifest.json and the frames it names (src/main/tray-frames.ts). macOS gets
// the Template PNGs and also assets/trayTemplate.png(+@2x), the single static image main.ts names
// (never packaged before 0.5.9, so the built-in ring showed); Windows gets both taskbar sets (the .ico
// files from ico.mjs stay as the single-image fallback). The file list comes from the manifest only.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DESKTOP_DIR } from './stage.mjs';

export const TRAY_ASSETS_SOURCE = join(DESKTOP_DIR, 'assets', 'tray');

const SAFE_PATH = /^(macos|windows)\/[A-Za-z0-9][A-Za-z0-9_-]*(@2x)?\.png$/;
const MAC_STATIC = 'tray-connected';

function manifest() {
  return JSON.parse(readFileSync(join(TRAY_ASSETS_SOURCE, 'manifest.json'), 'utf8'));
}

/** The files (relative to assets/tray) a platform needs: manifest.json first, then its frames. */
export function trayAssetFiles(platform) {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`No tray assets for ${platform}.`);
  }
  const files = new Set(['manifest.json']);
  for (const sequence of Object.values(manifest().sequences ?? {})) {
    for (const frame of sequence.frames ?? []) {
      const list =
        platform === 'darwin'
          ? frame.macos
          : [...(frame.windows?.dark ?? []), ...(frame.windows?.light ?? [])];
      for (const file of list ?? []) {
        if (typeof file !== 'string' || !SAFE_PATH.test(file)) {
          throw new Error(`Unexpected tray frame path in manifest.json: ${String(file)}`);
        }
        if (!existsSync(join(TRAY_ASSETS_SOURCE, file))) {
          throw new Error(`The tray frame ${file} is missing: run build/tray-frames.mjs.`);
        }
        files.add(file);
      }
    }
  }
  return [...files];
}

/** Copies the tray frames into <assetsDir>/tray (and, on macOS, assetsDir/trayTemplate.png). */
export function copyTrayAssets(assetsDir, platform) {
  const files = trayAssetFiles(platform);
  const trayDir = join(assetsDir, 'tray');
  for (const file of files) {
    const dest = join(trayDir, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(TRAY_ASSETS_SOURCE, file), dest);
  }
  if (platform === 'darwin') {
    copyFileSync(
      join(TRAY_ASSETS_SOURCE, 'macos', `${MAC_STATIC}Template.png`),
      join(assetsDir, 'trayTemplate.png'),
    );
    copyFileSync(
      join(TRAY_ASSETS_SOURCE, 'macos', `${MAC_STATIC}Template@2x.png`),
      join(assetsDir, 'trayTemplate@2x.png'),
    );
  }
  return files.length;
}
