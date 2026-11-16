// The RELEASE bundle of the shell's main process (plan Decision 3, Fable H1; review L8): one ESM file
// dist-release/main/entry.js with `__AGENTLINK_DESKTOP_PREVIEW__` defined `false`, so the bundler drops
// the branch that reads the preview environment variables. build/lib/stage.mjs packs only this into
// app.asar (never plain tsc output) and fails the build if the preview name is still in the ASAR.
// A preview (owner-feedback) build sets AGENTLINK_DESKTOP_PREVIEW_BUILD=1 when bundling.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const preview = process.env['AGENTLINK_DESKTOP_PREVIEW_BUILD'] === '1';

// DESK051-C4: AGENTLINK_DESKTOP_UPDATES=off bundles root-key.updates-off.json (no key, the updates-off
// mark) in place of root-key.json, so the app's updater is not configured and never fetches. A
// release built this way passes build-*.mjs `--updates off` (build/lib/root-key-check.mjs). After the
// offline key ceremony, release builds go back to the pinned root-key.json (unset or `on`).
const updates = process.env['AGENTLINK_DESKTOP_UPDATES'] ?? 'on';
if (updates !== 'on' && updates !== 'off') {
  throw new Error('AGENTLINK_DESKTOP_UPDATES must be on or off.');
}
const updatesOffFile = fileURLToPath(
  new URL('./src/main/updater/root-key.updates-off.json', import.meta.url),
);

// FILES-FOLDER-PICKER (D-154): the window's one preload goes next to entry.js unchanged as preload.cjs (a sandboxed
// preload is a plain CommonJS script; folder-picker.ts preloadPath finds it there).
const preloadFile = fileURLToPath(new URL('./src/main/preload.js', import.meta.url));
// TRAY-POPOVER (D-155): the popover's own preload, next to it as widget-preload.cjs (widget-ipc.ts
// widgetPreloadPath finds it there). Each window loads only its own one.
const widgetPreloadFile = fileURLToPath(new URL('./src/main/widget-preload.js', import.meta.url));
const preloadAsset = {
  name: 'agentlink-preload',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'preload.cjs',
      source: readFileSync(preloadFile, 'utf8'),
    });
    this.emitFile({
      type: 'asset',
      fileName: 'widget-preload.cjs',
      source: readFileSync(widgetPreloadFile, 'utf8'),
    });
  },
};

export default defineConfig({
  configFile: false,
  plugins: [preloadAsset],
  publicDir: false,
  envDir: false,
  logLevel: 'warn',
  define: { __AGENTLINK_DESKTOP_PREVIEW__: JSON.stringify(preview) },
  resolve: {
    alias: updates === 'off' ? [{ find: /^\.\/root-key\.json$/, replacement: updatesOffFile }] : [],
  },
  build: {
    ssr: fileURLToPath(new URL('./src/main/entry.ts', import.meta.url)),
    outDir: fileURLToPath(new URL('./dist-release/main', import.meta.url)),
    emptyOutDir: true,
    minify: true,
    target: 'node22',
    rollupOptions: {
      // Electron's built-in module and Node's own; everything else is ours and inlined.
      external: (id) => id === 'electron' || id.startsWith('node:'),
      output: { format: 'es', entryFileNames: 'entry.js', codeSplitting: false },
    },
  },
});
