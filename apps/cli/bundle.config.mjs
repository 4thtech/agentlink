// OPS-REL-1: the published `@4thtech/agentlink` is ONE bundled file, dist/agentlink.js (owner
// decision 2026-10-16: only the CLI publishes; the @agentlink/* workspace packages stay private and
// are bundled into it). `pnpm build` runs `tsc -b` first (types, project references, the per-file
// dist/ that e2e and the workspace use), then this Vite (Rolldown) SSR build.
//
// - Bundled: our own code only, i.e. apps/cli/src and the built @agentlink/* workspace packages.
// - External: every third-party package and every Node built-in. The third-party packages are the
//   CLI's real `dependencies`, pinned exactly (tools/deps-check: `bundles`), so npm installs, audits
//   and verifies them as usual. Native modules (@napi-rs/keyring, better-sqlite3) must stay external.
// - No minify, no source maps: the published file stays readable for review and carries no paths
//   from the build machine.
// - One file: dynamic imports are inlined, so `files` in package.json can name it exactly.
import { defineConfig } from 'vite';

/** True for an import that must stay an import in the bundle (not our own code). */
export function isExternal(id) {
  // Relative, absolute and virtual ids are our own modules (already resolved): bundle them.
  if (
    id.startsWith('.') ||
    id.startsWith('/') ||
    id.startsWith('\0') ||
    /^[A-Za-z]:[\\/]/.test(id)
  ) {
    return false;
  }
  // Bare specifiers (Node built-ins included): everything except our own workspace packages.
  return !id.startsWith('@agentlink/');
}

export default defineConfig({
  // No public dir, no .env loading: nothing outside the module graph may enter the bundle.
  publicDir: false,
  envDir: false,
  logLevel: 'warn',
  ssr: {
    target: 'node',
    noExternal: [/^@agentlink\//],
  },
  build: {
    ssr: 'src/cli.ts',
    outDir: 'dist',
    // tsc -b owns dist/; this build adds one file and never deletes the rest.
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'node22',
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rolldownOptions: {
      external: isExternal,
      output: {
        format: 'es',
        entryFileNames: 'agentlink.js',
        codeSplitting: false,
      },
    },
  },
});
