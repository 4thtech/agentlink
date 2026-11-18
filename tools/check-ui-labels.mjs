#!/usr/bin/env node
// DOCS-COMPACT-A: the guide names only buttons and labels that exist. Run by `pnpm lint` (tools
// `check`). Every `**Label**` in the user guide must appear inside a string literal of the shipped
// UI strings: the local app (apps/local-ui/src/**/strings.ts), the desktop app (apps/desktop/src,
// menus and tray), the invite page (apps/invite/src) and the MCP tool strings
// (packages/mcp-tools/src/strings). Bold text that is not a UI label (emphasis, terms, OS labels)
// and today's misses sit in tools/docs/ui-labels-allow.json, a ratchet: new misses fail, fixed ones
// must be removed, and the list may not grow (compared with origin/main when available).
//
//   node tools/check-ui-labels.mjs           # check
//   node tools/check-ui-labels.mjs --seed    # (once / to shrink) write today's misses as the allowlist

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS } from './docs/paths.mjs';
import { baseAllowlist, ratchet, readAllowlist, writeAllowlist } from './docs/ratchet.mjs';

export const ALLOWLIST = 'tools/docs/ui-labels-allow.json';
const NOTE =
  'DOCS-COMPACT-A ratchet: bold phrases in the guide that are not found in the UI strings (emphasis, terms, OS labels, or a renamed button). Fix or reword one and remove its line; never add lines.';

/** Where UI strings live: [dir, file filter]. Test files never count. */
export const UI_SOURCES = [
  ['apps/local-ui/src', (f) => /(^|\/)strings\.ts$/.test(f)],
  ['apps/desktop/src', (f) => /\.(ts|mts|js|mjs)$/.test(f)],
  ['apps/invite/src', (f) => /\.(ts|mts|js|mjs)$/.test(f)],
  ['packages/mcp-tools/src/strings', (f) => /\.(ts|mts|js|mjs)$/.test(f)],
];

const isTest = (f) => /(\.test\.|\.spec\.|(^|\/)(testing|__tests__|fixtures)\/)/.test(f);

function list(root, dir) {
  try {
    return readdirSync(join(root, dir), { recursive: true })
      .map(String)
      .map((f) => f.split('\\').join('/'))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** The contents of every string literal ('…', "…", `…` with ${…} parts as breaks) in a source. */
export function stringLiterals(source) {
  const out = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of source.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    for (const part of raw.split(/\$\{[^}]*\}/))
      out.push(part.replace(/\\(['"`\\])/g, '$1').replace(/\\u2019/g, '\u2019'));
  }
  return out;
}

/** One searchable text of every UI string literal (NUL-separated, so a match never spans two). */
export function uiCorpus(root) {
  const parts = [];
  for (const [dir, keep] of UI_SOURCES)
    for (const f of list(root, dir))
      if (keep(f) && !isTest(f))
        parts.push(...stringLiterals(readFileSync(join(root, dir, f), 'utf8')));
  return `\0${parts.join('\0')}\0`;
}

const fold = (s) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');

/** Bold phrases in a Markdown page, outside code: the text between ** and **. */
export function boldLabels(markdown) {
  const text = markdown.replace(/^(```|~~~)[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
  const out = [];
  for (const m of text.matchAll(/\*\*([^*\n]+?)\*\*/g)) {
    const label = m[1].trim().replace(/[.:,;]$/, '');
    if (label) out.push(label);
  }
  return out;
}

/** Each guide label not found in the UI strings, as `label` (deduplicated). */
export function findMisses(root) {
  const corpus = fold(uiCorpus(root));
  const out = new Set();
  for (const f of list(root, DOCS.guide)) {
    if (!f.endsWith('.md') || f.endsWith('SUMMARY.md')) continue;
    for (const label of boldLabels(readFileSync(join(root, DOCS.guide, f), 'utf8')))
      if (!corpus.includes(fold(label))) out.add(label);
  }
  return [...out].sort();
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const misses = findMisses(root);
  if (process.argv.includes('--seed')) {
    const allowed = readAllowlist(root, ALLOWLIST);
    const next = allowed.length ? misses.filter((m) => allowed.includes(m)) : misses;
    writeAllowlist(root, ALLOWLIST, NOTE, next);
    console.log(`check-ui-labels: wrote ${next.length} entries to ${ALLOWLIST}.`);
    return;
  }
  const base = baseAllowlist(root, ALLOWLIST);
  const { fresh, stale, grown } = ratchet(misses, readAllowlist(root, ALLOWLIST), base);
  const fail = [
    ...fresh.map(
      (m) =>
        `"**${m}**" in ${DOCS.guide} is not a label in the UI strings: use the on-screen words, or plain text for emphasis`,
    ),
    ...stale.map((m) => `${ALLOWLIST}: "${m}" no longer misses; remove it`),
    ...grown.map((m) => `${ALLOWLIST}: "${m}" is new; the allowlist may only shrink`),
  ];
  if (fail.length) {
    console.error(`check-ui-labels: ${fail.length} problem(s)\n- ${fail.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    `check-ui-labels: every guide label exists in the UI (${misses.length} allowlisted${base === null ? '; growth check skipped: no base allowlist' : ''}).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
