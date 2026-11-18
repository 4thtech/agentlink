#!/usr/bin/env node
// DOCS-COMPACT-A: builds the Lumina knowledge bundle (`agentlink-knowledge.md`) from the public docs.
// One source: the guide and technical pages. Each page says under its H1 how it goes into the bundle:
//
//   <!-- ai-knowledge: full | summary | skip
//   summary: One to three plain sentences: what this page answers, for whom. -->
//
// `full` = the summary and the whole body; `summary` = the summary and the page link; `skip` = left
// out. The bundle starts with what AgentLink is and the version and status block from
// docs/status.yaml, then every page in SUMMARY order (guide, then technical): `## <H1>`, its 4thTech
// Docs URL, the summary and (for `full`) the body with headings demoted and images, screenshot
// captions, diagrams, "Also on 4thTech Docs" lines, version stamps and HTML comments removed;
// relative links point at the wiki (or, outside the public docs, at the repository at the tag).
// The output is deterministic (no dates except the source tag), so a diff of two builds is meaningful.
//
//   node tools/docs/build-knowledge.mjs --check                   # CI: markers present, under the cap
//   node tools/docs/build-knowledge.mjs --out <file> [--tag vX.Y.Z]   # release: write the bundle
//   node tools/docs/build-knowledge.mjs --assume full|summary     # estimate before pages are marked
//
// Size: tokens are estimated as bytes / 4 (as the old knowledge/ check did). Above TARGET_TOKENS a
// warning; above MAX_TOKENS a failure (release blocking); a page above PAGE_WARN_TOKENS a warning.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS, REPO_ROOT, REPO_URL, WIKI_URL, detectLayout } from './paths.mjs';
import { MODES, orderedPages, pageUrls, parseMarker } from './pages.mjs';
import { parseYaml } from '../docs-status/yaml.mjs';
import { renderKnowledgeIntro, renderKnowledgeSummary } from '../docs-status/status.mjs';

export const TARGET_TOKENS = 19_000;
export const MAX_TOKENS = 22_000;
export const PAGE_WARN_TOKENS = 3_000;

export { MODES, orderedPages, pageUrls, parseMarker };

export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

/** Replaces fenced and inline code with placeholders so transforms leave code alone. */
function maskCode(text) {
  const saved = [];
  const keep = (m) => {
    saved.push(m);
    return `${saved.length - 1}`;
  };
  const masked = text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (m) =>
      /^(```|~~~)\s*mermaid/.test(m) ? '' : keep(m),
    )
    .replace(/`[^`\n]*`/g, keep);
  return { masked, restore: (s) => s.replace(/(\d+)/g, (_, i) => saved[Number(i)]) };
}

/**
 * The page body for the bundle: H1 removed, headings demoted by one level (so the page's `##`
 * becomes `###` under the bundle's `## <title>`), noise removed, links made absolute.
 * `link(href)` returns the absolute target for a relative href.
 */
export function cleanBody(text, link) {
  const { masked, restore } = maskCode(text);
  let stripped = masked;
  for (let prev = null; prev !== stripped; ) {
    prev = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');
  }
  let out = stripped
    .replace(/<figure>[\s\S]*?<\/figure>/g, '')
    .replace(/<img\b[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^Also on 4thTech Docs:.*$/gm, '')
    .replace(/^\*?Applies to AgentLink \d[^\n]*$/gm, '')
    .replace(/^# .*$/m, '')
    .replace(/^(#{2,5}) /gm, '#$1 ')
    .replace(/(\[[^\]]*\]\()([^)\s]+)(\))/g, (_, a, h, b) => a + link(h) + b)
    .replace(/(\bhref=")([^"]+)(")/g, (_, a, h, b) => a + link(h) + b);
  out = restore(out)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out;
}

function makeLinker(root, rel, urls, ref) {
  const posix = path.posix;
  return (href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
    if (href.startsWith('#')) return `${urls.get(rel) ?? ''}${href}`;
    if (href.startsWith('/')) return href;
    const [p, ...restParts] = href.split(/(?=[#?])/);
    const rest = restParts.join('');
    let target;
    try {
      target = posix.normalize(posix.join(posix.dirname(rel), decodeURI(p))).replace(/\/$/, '');
    } catch {
      return href;
    }
    if (urls.has(target)) return urls.get(target) + rest;
    if (fs.existsSync(path.join(root, target))) {
      const kind = fs.statSync(path.join(root, target)).isDirectory() ? 'tree' : 'blob';
      return `${REPO_URL}/${kind}/${ref}/${target}${rest}`;
    }
    return href;
  };
}

/** What AgentLink is: the guide README's marker summary, else its first bold paragraph. */
function aboutLine(root, layout) {
  const text = fs.readFileSync(path.join(root, layout.guide, 'README.md'), 'utf8');
  const marker = parseMarker(text);
  if (marker?.summary) return marker.summary;
  const bold = /^\*\*([^*\n]+)\*\*\s*$/m.exec(text.replace(/^\*Applies to[^\n]*$/gm, ''));
  return bold ? bold[1] : 'AgentLink, by 4thTech: encrypted, provable exchange between AI agents.';
}

/**
 * Builds the bundle. `assume` (full|summary) stands in for a missing marker, for estimates only.
 * Returns { text, tokens, pages: [{ rel, title, mode, tokens }], problems, warnings }.
 */
export function buildBundle({ root = REPO_ROOT, tag, assume = null } = {}) {
  const layout = detectLayout(root);
  const problems = [];
  const warnings = [];
  const status = parseYaml(fs.readFileSync(path.join(root, DOCS.status), 'utf8'));
  const ref = tag ?? status.version;
  const urls = pageUrls(root, layout);
  const head = [
    '# AgentLink knowledge base',
    '',
    `> Generated from 4thtech/agentlink ${ref} by tools/docs/build-knowledge.mjs. Do not edit: edit the documentation pages. Latest: ${REPO_URL}/releases/latest/download/agentlink-knowledge.md`,
    '',
    aboutLine(root, layout),
    '',
    `Documentation: ${WIKI_URL}/products/agentlink. Source: ${REPO_URL}.`,
    '',
    '## Version and status',
    '',
    renderKnowledgeIntro(status),
    '',
    renderKnowledgeSummary(status).replace(/^## .*\n\n/, '').replace(/^### /gm, '#### '),
  ].join('\n');
  const parts = [head];
  const pages = [];
  for (const { rel, title: navTitle } of orderedPages(root, layout)) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    let marker = parseMarker(text);
    if (marker?.error) {
      problems.push(`${rel}: ${marker.error}`);
      continue;
    }
    if (!marker) {
      if (!assume) {
        problems.push(`${rel}: no ai-knowledge marker under the H1 (full, summary or skip)`);
        continue;
      }
      marker = { mode: assume, summary: '' };
    }
    if (marker.mode === 'skip') {
      pages.push({ rel, title: navTitle, mode: 'skip', tokens: 0 });
      continue;
    }
    const title = /^# (.+)$/m.exec(text)?.[1].trim() ?? navTitle;
    const url = urls.get(rel) ?? `${REPO_URL}/blob/${ref}/${rel}`;
    // A summary-only page is one short paragraph: the summary and its link.
    const block =
      marker.mode === 'full'
        ? [`## ${title}`, '', `Page: ${url}`, ...(marker.summary ? ['', marker.summary] : [])]
        : [`## ${title}`, '', `${marker.summary ? `${marker.summary} ` : ''}Page: ${url}`];
    if (marker.mode === 'full') {
      const body = cleanBody(text, makeLinker(root, rel, urls, ref));
      if (body) block.push('', body);
    }
    const chunk = block.join('\n');
    const tokens = estimateTokens(chunk);
    if (tokens > PAGE_WARN_TOKENS)
      warnings.push(`${rel}: ${tokens} tokens in the bundle (above ${PAGE_WARN_TOKENS})`);
    pages.push({ rel, title, mode: marker.mode, tokens });
    parts.push(chunk);
  }
  const text = `${parts.join('\n\n')}\n`;
  const tokens = estimateTokens(text);
  if (tokens > MAX_TOKENS)
    problems.push(`the bundle is ${tokens} tokens, above the hard max ${MAX_TOKENS}`);
  else if (tokens > TARGET_TOKENS)
    warnings.push(`the bundle is ${tokens} tokens, above the target ${TARGET_TOKENS}`);
  return { text, tokens, pages, problems, warnings };
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--check' || k === '--list') a[k.slice(2)] = true;
    else if (['--out', '--tag', '--assume', '--root'].includes(k)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${k} needs a value`);
      a[k.slice(2)] = v;
      i += 1;
    } else throw new Error(`unknown argument ${k}`);
  }
  if (a.assume && !['full', 'summary'].includes(a.assume))
    throw new Error('--assume takes full or summary');
  if (a.assume && a.check) throw new Error('--assume is for estimates; --check needs real markers');
  if (a.tag && !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(a.tag))
    throw new Error(`"${a.tag}" is not a release tag like v0.5.11`);
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? path.resolve(args.root) : REPO_ROOT;
  const r = buildBundle({ root, tag: args.tag, assume: args.assume ?? null });
  if (args.list)
    for (const p of r.pages) console.log(`  ${String(p.tokens).padStart(6)}  ${p.mode.padEnd(7)} ${p.rel}`);
  for (const w of r.warnings) console.warn(`build-knowledge: warning: ${w}`);
  if (r.problems.length) {
    console.error(
      `build-knowledge: ${r.problems.length} problem(s)\n- ${r.problems.slice(0, 40).join('\n- ')}${r.problems.length > 40 ? `\n- … and ${r.problems.length - 40} more` : ''}`,
    );
    process.exit(1);
  }
  if (args.out) fs.writeFileSync(path.resolve(args.out), r.text);
  const counts = MODES.map((m) => `${r.pages.filter((p) => p.mode === m).length} ${m}`).join(', ');
  console.log(
    `build-knowledge: ${r.tokens} tokens (bytes/4; target ${TARGET_TOKENS}, hard max ${MAX_TOKENS}); pages: ${counts}${args.out ? `; wrote ${args.out}` : ''}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`build-knowledge: ${e.message}`);
    process.exit(1);
  }
}
