#!/usr/bin/env node
// DOCS-COMPACT-A: every reference into the specs resolves. Run by `pnpm lint` (tools `check`).
//   1. textual refs "NN §x.y" (also "specs/NN §x") in docs, internal docs, research, code comments,
//      workflows and the specs themselves name an existing spec and a numbered heading in it
//      (01 and 09 are private and skipped);
//   2. Markdown links into the specs folder (relative, or github.com/4thtech/agentlink/blob/main/…)
//      name an existing file and, when they carry one, an existing heading anchor.
// History is not checked (CHANGELOG.md, changelog.d/, .changeset/). Today's misses sit in
// tools/docs/spec-refs-allow.json, a ratchet: new misses fail, fixed ones must be removed, and the
// list may not grow (compared with origin/main when available).
//
//   node tools/check-spec-refs.mjs           # check
//   node tools/check-spec-refs.mjs --seed    # (once / to shrink) write today's misses as the allowlist

import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS, PRIVATE_SPEC_NAMES } from './docs/paths.mjs';
import { baseAllowlist, ratchet, readAllowlist, writeAllowlist } from './docs/ratchet.mjs';
import { sectionNumbers, sectionRefs } from './check-security-docs.mjs';
import { listRepoFiles } from './check-no-solidity.mjs';

export const ALLOWLIST = 'tools/docs/spec-refs-allow.json';
const NOTE =
  'DOCS-COMPACT-A ratchet: spec references that did not resolve when the check was added. Fix one and remove its line; never add lines.';

const SCANNED_EXT = /\.(md|mdx|ts|tsx|mts|cts|mjs|cjs|js|ya?ml|sh|txt)$/i;
const HISTORY = /^(CHANGELOG\.md|changelog\.d\/|\.changeset\/)|\/CHANGELOG\.md$/;
const MAX_BYTES = 2 * 1024 * 1024;

/** GitHub heading anchors of a Markdown text (with -1, -2 … for duplicates). */
export function headingAnchors(text) {
  const out = new Set();
  const seen = new Map();
  let fence = null;
  for (const line of text.split('\n')) {
    const f = /^(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1] : fence === f[1] ? null : fence;
    if (fence !== null || f) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    let heading = h[1];
    for (let prev = null; prev !== heading;) {
      prev = heading;
      heading = heading.replace(/<[^>]+>/g, '');
    }
    const base = heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Spec number -> text, for the specs root. */
export function loadSpecs(root, files) {
  const specs = {};
  for (const f of files) {
    const m = new RegExp(`^${DOCS.specs}/(\\d\\d)-[^/]+\\.md$`).exec(f);
    if (m) specs[m[1]] = readFileSync(join(root, f), 'utf8');
  }
  return specs;
}

const LINK_RE = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BLOB_RE =
  /^https:\/\/github\.com\/4thtech\/agentlink\/(?:blob|tree)\/main\/([^#?]*)(#[^?]*)?/;

/** Problems in one file's text: [`NN §x: …` | `link …`]. */
export function checkText(file, text, { specs, exists, anchorsOf }) {
  const problems = [];
  const sections = {};
  for (const r of sectionRefs(text)) {
    if (!(r.spec in specs)) {
      if (!PRIVATE_SPEC_NAMES.some((n) => n.startsWith(`${r.spec}-`)))
        problems.push(`${r.spec} §${r.section}: no spec ${r.spec}`);
      continue;
    }
    sections[r.spec] ??= sectionNumbers(specs[r.spec]);
    if (!sections[r.spec].has(r.section)) problems.push(`${r.spec} §${r.section}: no such section`);
  }
  if (/\.mdx?$/i.test(file)) {
    for (const m of text.matchAll(LINK_RE)) {
      const href = m[1];
      let target;
      let anchor;
      const blob = BLOB_RE.exec(href);
      if (blob) {
        target = blob[1].replace(/\/$/, '');
        anchor = blob[2] ?? '';
      } else if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) continue;
      else {
        const [p, ...rest] = href.split('#');
        try {
          target = posix.normalize(posix.join(posix.dirname(file), decodeURI(p)));
        } catch {
          continue;
        }
        anchor = rest.length ? `#${rest.join('#')}` : '';
      }
      if (target !== DOCS.specs && !target.startsWith(`${DOCS.specs}/`)) continue;
      if (PRIVATE_SPEC_NAMES.some((n) => target === `${DOCS.specs}/${n}`)) continue;
      if (!exists(target)) {
        problems.push(`link ${target}: no such file`);
        continue;
      }
      if (anchor.length > 1 && target.endsWith('.md')) {
        let a;
        try {
          a = decodeURIComponent(anchor.slice(1)).toLowerCase();
        } catch {
          a = anchor.slice(1).toLowerCase();
        }
        if (!anchorsOf(target).has(a)) problems.push(`link ${target}${anchor}: no such heading`);
      }
    }
  }
  return problems;
}

/** Every miss in the repository, as `file: problem` (deduplicated). */
export function findMisses(root) {
  const files = listRepoFiles(root);
  const tracked = new Set(files);
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  const specs = loadSpecs(root, files);
  const anchorCache = new Map();
  const ctx = {
    specs,
    exists: (p) => tracked.has(p) || dirs.has(p),
    anchorsOf: (p) => {
      if (!anchorCache.has(p))
        anchorCache.set(p, headingAnchors(readFileSync(join(root, p), 'utf8')));
      return anchorCache.get(p);
    },
  };
  const out = new Set();
  for (const file of files) {
    if (!SCANNED_EXT.test(file) || HISTORY.test(file) || file.includes('node_modules/')) continue;
    if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/.test(file)) continue;
    let buf;
    try {
      buf = readFileSync(join(root, file));
    } catch {
      continue;
    }
    if (buf.length > MAX_BYTES || buf.includes(0)) continue;
    for (const p of checkText(file, buf.toString('utf8'), ctx)) out.add(`${file}: ${p}`);
  }
  return [...out].sort();
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const misses = findMisses(root);
  if (process.argv.includes('--seed')) {
    const allowed = readAllowlist(root, ALLOWLIST);
    // Seeding never adds to an existing list: it keeps only entries that still occur.
    const next = allowed.length ? misses.filter((m) => allowed.includes(m)) : misses;
    writeAllowlist(root, ALLOWLIST, NOTE, next);
    console.log(`check-spec-refs: wrote ${next.length} entries to ${ALLOWLIST}.`);
    return;
  }
  const base = baseAllowlist(root, ALLOWLIST);
  const { fresh, stale, grown } = ratchet(misses, readAllowlist(root, ALLOWLIST), base);
  const fail = [
    ...fresh.map((m) => `${m} (fix the reference; the allowlist only shrinks)`),
    ...stale.map((m) => `${ALLOWLIST}: "${m}" no longer occurs; remove it`),
    ...grown.map((m) => `${ALLOWLIST}: "${m}" is new; fix the reference instead of allowing it`),
  ];
  if (fail.length) {
    console.error(`check-spec-refs: ${fail.length} problem(s)\n- ${fail.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    `check-spec-refs: every spec reference resolves (${misses.length} allowlisted${base === null ? '; growth check skipped: no base allowlist' : ''}).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
