// The RELEASE bundle of the shell's main process (plan Decision 3, Fable H1; review L8): one ESM file
// dist-release/main/entry.js with `__AGENTLINK_DESKTOP_PREVIEW__` defined `false`, so the bundler drops
// the branch that reads the preview environment variables. build/lib/stage.mjs packs only this into
// app.asar (never plain tsc output) and fails the build if the preview name is still in the ASAR.
// A preview (owner-feedback) build sets AGENTLINK_DESKTOP_PREVIEW_BUILD=1 when bundling.
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

// UPD-S1 SPIKE ONLY (branch upd-s1-spike, never merged): AGENTLINK_SPIKE_SWAP=1 adds the tray item
// that downloads AGENTLINK_SPIKE_ZIP_URL and swaps it into /Applications (src/main/spike-swap.ts).
// Unset in every release and PR build (desktop.yml passes it only on a manual run that asks for it).
const spikeSwap = process.env['AGENTLINK_SPIKE_SWAP'] === '1';
const spikeZipUrl = spikeSwap ? (process.env['AGENTLINK_SPIKE_ZIP_URL'] ?? '') : '';
if (spikeSwap && !/^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(spikeZipUrl)) {
  throw new Error(
    'AGENTLINK_SPIKE_ZIP_URL must be https:// or http://127.0.0.1 with AGENTLINK_SPIKE_SWAP=1.',
  );
}

export default defineConfig({
  configFile: false,
  publicDir: false,
  envDir: false,
  logLevel: 'warn',
  define: {
    __AGENTLINK_DESKTOP_PREVIEW__: JSON.stringify(preview),
    __AGENTLINK_SPIKE_SWAP__: JSON.stringify(spikeSwap),
    __AGENTLINK_SPIKE_ZIP_URL__: JSON.stringify(spikeZipUrl),
  },
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
