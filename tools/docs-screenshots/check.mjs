// Checks that the screenshot manifest and the docs agree (docs model section 5):
//   node tools/docs-screenshots/check.mjs [--check]
// Fails when a Markdown page in docs-site/ (or the README) shows an image the manifest does not
// produce, when the manifest lists an image no page shows, or when a listed image is missing on disk.
// Runs offline in a second; it does not start a browser. `pnpm docs:screenshots` writes the images.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const IMAGE = /\.(png|webp|jpe?g|gif|svg)$/i;

/** Every Markdown file under a folder (no node_modules). */
function markdown(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? markdown(path) : name.endsWith('.md') ? [path] : [];
  });
}

/** Images a page shows: <img src>, <source srcset> and ![](...). Templates and their <...> placeholders are skipped. */
function imagesOf(file) {
  const text = readFileSync(file, 'utf8');
  const refs = [];
  for (const m of text.matchAll(/(?:src|srcset)="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)/g)) {
    const ref = (m[1] ?? m[2]).split('#')[0];
    if (/^https?:|^data:/.test(ref) || ref.includes('<') || !IMAGE.test(ref)) continue;
    refs.push(ref);
  }
  return refs;
}

const wanted = new Map(); // image path (from the repo root) -> the pages that show it
const pages = [...markdown(join(ROOT, 'docs-site')), join(ROOT, 'README.md')].filter(
  (f) => !relative(ROOT, f).startsWith('docs-site/_templates'),
);
for (const page of pages) {
  for (const ref of imagesOf(page)) {
    const image = relative(ROOT, resolve(dirname(page), ref));
    // Brand art and other images the pipeline does not draw are not screenshots.
    if (!image.startsWith('docs-site/')) continue;
    wanted.set(image, [...(wanted.get(image) ?? []), relative(ROOT, page)]);
  }
}

const listed = new Set(manifest.shots.map((s) => s.image));
const problems = [];
for (const [image, shownOn] of wanted) {
  if (!listed.has(image)) {
    problems.push(`${image} is shown on ${shownOn[0]} but the manifest does not produce it`);
  }
}
for (const image of listed) {
  if (!wanted.has(image)) problems.push(`${image} is in the manifest but no page shows it`);
  else if (!existsSync(join(ROOT, image))) {
    problems.push(`${image} is in the manifest but missing on disk (run pnpm docs:screenshots)`);
  }
}
const names = manifest.shots.map((s) => s.name);
for (const name of names) {
  if (names.indexOf(name) !== names.lastIndexOf(name)) problems.push(`${name} is listed twice`);
}

if (problems.length > 0) {
  console.error(`docs screenshots: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`docs screenshots: ${listed.size} images, every page and the manifest agree`);
