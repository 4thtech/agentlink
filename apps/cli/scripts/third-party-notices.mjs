// REPO-CLEAN-1 (P-2): THIRD-PARTY-NOTICES.md for the published package. The bundle embeds the built
// local app (scripts/local-ui-embed.mjs), and that carries third-party code and assets: React,
// react-dom and its scheduler, qrcode-generator (all MIT), the Geist fonts (SIL OFL 1.1) and the
// Lucide-derived icons (ISC). Their licences ask for the notice to travel with every copy, so
// `stagePackage` (bundle.config.mjs) writes this file into dist/package/ and `files` lists it.
//
// The licence texts are read at build time from the installed packages (their LICENSE file, or for
// a package that ships none the MIT text with the copyright line its source header states) and from
// packages/ui (THIRD-PARTY-NOTICES.md for fonts and icons, fonts/OFL.txt). A package whose declared
// licence is not the one listed here fails the build, so a licence change is never copied silently.
// test/third-party-notices.test.ts keeps BUNDLED in step with apps/local-ui's runtime dependencies.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Third-party packages inside the embedded local app. `from` is the package whose node_modules
 * resolve it; `copyright` is used only when the package ships no licence file.
 */
export const BUNDLED = [
  { name: 'react', from: 'apps/local-ui', license: 'MIT' },
  { name: 'react-dom', from: 'apps/local-ui', license: 'MIT' },
  { name: 'scheduler', from: 'react-dom', license: 'MIT' },
  {
    name: 'qrcode-generator',
    from: 'apps/local-ui',
    license: 'MIT',
    copyright: 'Copyright (c) 2009 Kazuhiko Arase',
  },
];

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The real directory of `name` as resolved from `fromDir` (walking up node_modules folders). */
function packageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(dir) === dir) throw new Error(`notices: ${name} is not installed`);
  }
}

function licenceText(dir, entry) {
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE']) {
    const path = join(dir, file);
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  }
  if (entry.license === 'MIT' && entry.copyright !== undefined) {
    return `MIT License\n\n${entry.copyright}\n\n${MIT_BODY}`;
  }
  throw new Error(`notices: ${entry.name} ships no licence file and has no copyright line here`);
}

/** The Markdown text of THIRD-PARTY-NOTICES.md. Throws on a missing package or a licence change. */
export function thirdPartyNotices(root = repoRoot) {
  const dirs = new Map();
  const sections = [];
  for (const entry of BUNDLED) {
    const base = dirs.get(entry.from) ?? join(root, entry.from);
    const dir = packageDir(entry.name, base);
    dirs.set(entry.name, dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (manifest.license !== entry.license) {
      throw new Error(
        `notices: ${entry.name} declares ${String(manifest.license)}, expected ${entry.license}`,
      );
    }
    sections.push(
      `## ${entry.name} ${manifest.version}\n\n- Licence: ${entry.license}\n\n\`\`\`text\n${licenceText(dir, entry)}\n\`\`\``,
    );
  }
  const ui = readFileSync(join(root, 'packages/ui/THIRD-PARTY-NOTICES.md'), 'utf8');
  // The fonts and icons part of packages/ui's notice, from its first section on.
  const uiSections = ui
    .slice(ui.indexOf('\n## ') + 1)
    .replace(
      'The full text is in `fonts/OFL.txt`, shipped next to the fonts.',
      'The full text is at the end of this file.',
    )
    .trim();
  const ofl = readFileSync(join(root, 'packages/ui/fonts/OFL.txt'), 'utf8').trim();
  return [
    '# Third-party notices: @4thtech-io/agentlink',
    '',
    'AgentLink itself is MIT-licensed (see LICENSE). The bundled local app (dist/agentlink.js and dist/desktop-host.js) includes the third-party material below. Runtime dependencies that npm installs next to the package carry their own licence files and are not repeated here.',
    '',
    ...sections.flatMap((s) => [s, '']),
    uiSections,
    '',
    '## SIL Open Font License 1.1 (Geist, Geist Mono)',
    '',
    '```text',
    ofl,
    '```',
    '',
  ].join('\n');
}
