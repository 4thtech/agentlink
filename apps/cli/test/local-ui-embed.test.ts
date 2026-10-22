// M1-11s-b: the local UI's built files are embedded in dist/agentlink.js (D-118) and handed to the
// approval server as an in-memory bundle; nothing reads apps/local-ui at run time.
//
// - scripts/local-ui-embed.mjs `localUiAssetEntries` (used by bundle.config.mjs) collects `index.html` and `assets/<name>` from the
//   local UI's dist directory at build time; a missing directory (apps/local-ui not built, or not
//   there yet) gives an empty bundle, and the build still works.
// - `localUiAssets` turns the embedded entries into the server's map; with nothing embedded (tsc
//   output, tests) it is empty, and the server then answers 404 for the app pages.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { localUiAssetEntries } from '../scripts/local-ui-embed.mjs';
import { embeddedLocalUiAssets, localUiAssets } from '../src/mcp/local-ui-assets.js';

const work = mkdtempSync(join(tmpdir(), 'agentlink-local-ui-embed-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('embedding the local UI build (M1-11s-b, D-118)', () => {
  it('gives an empty bundle when the local UI has not been built', () => {
    expect(localUiAssetEntries(join(work, 'missing'))).toEqual([]);
    expect(localUiAssets([]).files.size).toBe(0);
    // Unbundled (tsc output and tests): nothing is embedded, which is an empty bundle.
    expect(embeddedLocalUiAssets().files.size).toBe(0);
  });

  it('collects index.html and the hashed assets, and nothing else', () => {
    const dist = join(work, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    mkdirSync(join(dist, '.vite'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head></head></html>');
    writeFileSync(join(dist, 'assets', 'index-Ab12.js'), 'console.log(1)');
    writeFileSync(join(dist, 'assets', 'index-Ab12.js.map'), '{}');
    writeFileSync(join(dist, 'assets', 'font-Cd34.woff2'), new Uint8Array([1, 2, 3]));
    writeFileSync(join(dist, '.vite', 'manifest.json'), '{}');
    writeFileSync(join(dist, 'robots.txt'), 'x');
    const entries = localUiAssetEntries(dist);
    expect(entries.map(([name]) => name)).toEqual([
      'assets/font-Cd34.woff2',
      'assets/index-Ab12.js',
      'index.html',
    ]);
    const files = localUiAssets(entries).files;
    expect([...(files.get('assets/font-Cd34.woff2') ?? [])]).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(files.get('assets/index-Ab12.js'))).toBe('console.log(1)');
  });

  it('refuses malformed embedded entries', () => {
    expect(() => localUiAssets([['index.html', '%%%']])).toThrow();
    expect(() => localUiAssets('nope' as never)).toThrow();
  });
});
