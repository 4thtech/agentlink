// Builds the invite host's static site (M1-19, 08 §4): `site/` is copied as it is (the pages and the
// `_headers` file) and the one first-party script, `invite.js`, is bundled from src/main.ts. No source
// map, no second chunk, no inline code: the CSP allows one script file from this origin and nothing else.
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'site',
  build: {
    outDir: 'dist/site',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    minify: false,
    modulePreload: false,
    cssCodeSplit: false,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => 'invite.js',
    },
  },
});
