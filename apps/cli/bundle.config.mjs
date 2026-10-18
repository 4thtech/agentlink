// OPS-REL-1: the published `@4thtech-io/agentlink` is ONE bundled file, dist/agentlink.js (owner
// decision 2026-10-16: only the CLI publishes; the @4thtech-io/* workspace packages stay private and
// are bundled into it). `pnpm build` runs `tsc -b` first (types, project references, the per-file
// dist/ that e2e and the workspace use), then this Vite (Rolldown) SSR build.
//
// - Bundled: our own code only, i.e. apps/cli/src and the built @4thtech-io/* workspace packages.
// - External: every third-party package and every Node built-in. The third-party packages are the
//   CLI's real `dependencies`, pinned exactly (tools/deps-check: `bundles`), so npm installs, audits
//   and verifies them as usual. Native modules (@napi-rs/keyring, better-sqlite3) must stay external.
// - No minify, no source maps: the published file stays readable for review and carries no paths
//   from the build machine.
// - One file: dynamic imports are inlined, so `files` in package.json can name it exactly.
// - The publish directory (IR-OPS-REL-1-1 M-1): after the bundle is written, `stagePackage` writes
//   dist/package/ with dist/agentlink.js, README.md, LICENSE and a GENERATED package.json that
//   holds only the allowlisted publish fields: no devDependencies, no scripts, no workspace
//   (`@4thtech-io/*`) name. `publishConfig.directory` in apps/cli/package.json makes `pnpm pack`
//   (Changesets in release.yml) and `npm publish` pack that directory, never apps/cli itself.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const packageDir = fileURLToPath(new URL('.', import.meta.url));

/** The package.json fields that reach npm, in this order. Everything else is dropped. */
export const PUBLISHED_FIELDS = [
  'name',
  'version',
  'description',
  'license',
  'type',
  'homepage',
  'bugs',
  'repository',
  'keywords',
  'engines',
  'publishConfig',
  'bin',
  'files',
  'dependencies',
];

/** The published manifest generated from apps/cli/package.json. Pure. */
export function publishedManifest(manifest) {
  const out = {};
  for (const field of PUBLISHED_FIELDS) {
    if (manifest[field] !== undefined) out[field] = manifest[field];
  }
  // `directory` and `linkDirectory` describe the workspace layout; npm needs neither.
  const { access, provenance } = manifest.publishConfig ?? {};
  out.publishConfig = { access, provenance };
  for (const name of Object.keys(out.dependencies ?? {})) {
    if (name.startsWith('@4thtech-io/')) {
      throw new Error(`bundle: ${name} is a bundled workspace package, not a runtime dependency`);
    }
  }
  return out;
}

/** Writes the publish directory dist/package/ (see the header). */
export function stagePackage(dir = packageDir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const stage = join(dir, manifest.publishConfig.directory);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'dist'), { recursive: true });
  copyFileSync(join(dir, 'dist', 'agentlink.js'), join(stage, 'dist', 'agentlink.js'));
  copyFileSync(join(dir, 'README.md'), join(stage, 'README.md'));
  copyFileSync(join(dir, 'LICENSE'), join(stage, 'LICENSE'));
  writeFileSync(
    join(stage, 'package.json'),
    `${JSON.stringify(publishedManifest(manifest), null, 2)}\n`,
  );
}

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
  return !id.startsWith('@4thtech-io/');
}

export default defineConfig({
  plugins: [{ name: 'agentlink-stage-package', writeBundle: () => stagePackage() }],
  // No public dir, no .env loading: nothing outside the module graph may enter the bundle.
  publicDir: false,
  envDir: false,
  logLevel: 'warn',
  ssr: {
    target: 'node',
    noExternal: [/^@4thtech-io\//],
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
