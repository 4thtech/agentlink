// M1-11s-b (D-118): collects the local UI's built files (apps/local-ui/dist) at build time, for
// bundle.config.mjs to embed in dist/agentlink.js. Only `index.html` and `assets/<one file name>`
// with a type the approval server serves are taken; source maps, the Vite manifest and anything
// else are left out. A missing directory (the app not built, or not in the repository yet) is an
// empty bundle: the CLI still builds and the server answers 404 for the app pages.
//
// Entries are `[name, base64url]`, sorted by name, so the bundle is deterministic. Base64url keeps the
// app's code opaque inside the CLI bundle (the bundle checks scan our own code, not the app's).
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The file types the approval server serves (packages/node approval-server.ts ASSET_TYPES). */
const EXTENSIONS = new Set(['js', 'css', 'woff2', 'woff', 'svg', 'png', 'webp', 'ico']);
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `[name, base64url]` for each file to embed from `dir` (apps/local-ui/dist), or [] without it. */
export function localUiAssetEntries(dir) {
  if (!existsSync(dir)) return [];
  const entries = [];
  const index = join(dir, 'index.html');
  if (existsSync(index) && lstatSync(index).isFile()) {
    entries.push(['index.html', readFileSync(index).toString('base64url')]);
  }
  const assets = join(dir, 'assets');
  if (existsSync(assets)) {
    for (const name of readdirSync(assets)) {
      const path = join(assets, name);
      const ext = name.slice(name.lastIndexOf('.') + 1);
      if (!ASSET_NAME.test(name) || !name.includes('.') || !EXTENSIONS.has(ext)) continue;
      if (!lstatSync(path).isFile()) continue; // no symbolic link, no directory
      entries.push([`assets/${name}`, readFileSync(path).toString('base64url')]);
    }
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
