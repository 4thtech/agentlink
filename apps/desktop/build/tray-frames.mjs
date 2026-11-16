// Regenerates apps/desktop/assets/tray (SVG sources, macOS template PNGs, Windows PNGs, manifest).
// Usage: node apps/desktop/build/tray-frames.mjs [--sheet <path.png>]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { FRAME_MS, allFrames, contactSheet, framePng, toSvg } from './lib/tray-frames.mjs';

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..'); // not stage.mjs: it needs the workspace installed
const out = join(DESKTOP_DIR, 'assets', 'tray');
rmSync(out, { recursive: true, force: true });
for (const d of ['svg', 'macos', 'windows']) mkdirSync(join(out, d), { recursive: true });

const frames = allFrames();
const manifest = {
  frameMs: FRAME_MS,
  sizes: { macos: [16, 32], windows: [16, 32] },
  sequences: {},
};
for (const f of frames) {
  writeFileSync(join(out, 'svg', `${f.id}.svg`), toSvg(f));
  const files = { svg: `svg/${f.id}.svg` };
  // macOS: pure black with alpha; the system tints a name ending in Template.
  files.macos = [`macos/${f.id}Template.png`, `macos/${f.id}Template@2x.png`];
  writeFileSync(join(out, files.macos[0]), framePng(f, 16));
  writeFileSync(join(out, files.macos[1]), framePng(f, 32));
  // Windows: white for the dark taskbar, black for the light one (as the brand windows set).
  files.windows = {};
  for (const [taskbar, ink] of [
    ['dark', 255],
    ['light', 0],
  ]) {
    files.windows[taskbar] = [16, 32].map((size) => {
      const rel = `windows/${f.id}-${taskbar}-taskbar-${size}.png`;
      writeFileSync(join(out, rel), framePng(f, size, ink));
      return rel;
    });
  }
  const s = (manifest.sequences[f.sequence] ??= { loop: f.loop, frameMs: FRAME_MS, frames: [] });
  s.frames.push({ id: f.id, ...files });
}
// Written in the repository's Prettier format, so regenerating leaves the committed file unchanged.
const manifestPath = join(out, 'manifest.json');
const prettierConfig = (await resolveConfig(manifestPath)) ?? {};
writeFileSync(
  manifestPath,
  await format(JSON.stringify(manifest, null, 2), { ...prettierConfig, filepath: manifestPath }),
);

const i = process.argv.indexOf('--sheet');
if (i > 0) writeFileSync(process.argv[i + 1], contactSheet(frames, 8));
console.log(`tray frames: ${frames.length} frames -> ${out}`);
