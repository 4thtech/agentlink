// Build of the local web app (D-118). The CLI embeds `dist/` and the approval server serves it with
// CSP `script-src 'self'; style-src 'self'` (08 §4): no inline script, no inline style, no data:
// URIs (fonts and icons stay files), hashed asset names so they can be cached for good.
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
