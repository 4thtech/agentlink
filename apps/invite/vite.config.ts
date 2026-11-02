// Builds the invite host's static site (M1-19, 08 §4): `site/` is copied as it is (the pages and the
// `_headers` file) and the one first-party script, `invite.js`, is bundled from src/main.ts. No source
// map, no second chunk, no inline code: the CSP allows one script file from this origin and nothing else.
//
// INSTALLER-1 (owner Decision 58): the one-line installers, installer/install.sh and install.ps1 at
// the repository root, are copied byte for byte to /install.sh and /install.ps1 (plain text; the
// `_headers` file sets their type). The deploy checks that the served bytes equal the built files.
// No Node built-in here (deps-check: built-ins only in node, cli and e2e): the files are read with
// the bundler's own file access, from the folder Vite resolves as this package's root.
import { defineConfig, type Plugin } from 'vite';

const INSTALLERS = ['install.sh', 'install.ps1'];

function installers(): Plugin {
  let root = '';
  return {
    name: 'agentlink-installers',
    configResolved(config) {
      root = config.root;
    },
    async generateBundle() {
      for (const fileName of INSTALLERS) {
        const path = `${root}/../../installer/${fileName}`;
        this.addWatchFile(path);
        this.emitFile({ type: 'asset', fileName, source: await this.fs.readFile(path) });
      }
    },
  };
}

export default defineConfig({
  publicDir: 'site',
  plugins: [installers()],
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
