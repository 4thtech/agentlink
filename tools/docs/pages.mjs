// DOCS-COMPACT-A: the public pages as the knowledge bundle and llms.txt see them: SUMMARY order,
// 4thTech Docs URLs and the `ai-knowledge` marker under each H1. No dependency on docs-status, so
// both the bundle builder and the docs-status generators can import it.

import fs from 'node:fs';
import path from 'node:path';
import { WIKI_URL } from './paths.mjs';
import {
  SKELETON_SUMMARY,
  destFor,
  navUrls,
  parseSummary,
  planNavigation,
  updateSummary,
} from './wiki-sync.mjs';

export const MODES = ['full', 'summary', 'skip'];

const MARKER_RE = /<!--\s*ai-knowledge:([\s\S]*?)-->/;

/**
 * Reads the page's marker. Returns null when there is none, { error } when it is malformed, else
 * { mode, summary }. The marker must sit right under the H1 (only blank lines between).
 */
export function parseMarker(text) {
  const m = MARKER_RE.exec(text);
  if (!m) return null;
  const before = text.slice(0, m.index).split('\n');
  const h1 = before.findIndex((l) => /^# /.test(l));
  if (h1 === -1 || before.slice(h1 + 1).some((l) => l.trim() !== ''))
    return { error: 'the ai-knowledge marker must sit right under the H1' };
  const [first, ...rest] = m[1].split('\n');
  const mode = first.trim();
  if (!MODES.includes(mode))
    return { error: `ai-knowledge mode "${mode}" is not one of ${MODES.join(', ')}` };
  const body = rest.join('\n').trim();
  const s = /^summary:\s*([\s\S]+)$/.exec(body);
  const summary = s ? s[1].replace(/\s+/g, ' ').trim() : '';
  if (body && !s) return { error: 'ai-knowledge: only a summary: line may follow the mode' };
  if (mode !== 'skip' && !summary) return { error: `ai-knowledge: ${mode} needs a summary: line` };
  return { mode, summary };
}

/** srcRel -> live 4thTech Docs URL, computed like the wiki sync computes its navigation. */
export function pageUrls(root, layout) {
  const guide = parseSummary(fs.readFileSync(path.join(root, layout.guide, 'SUMMARY.md'), 'utf8'));
  const tech = parseSummary(
    fs.readFileSync(path.join(root, layout.technical, 'SUMMARY.md'), 'utf8'),
  );
  const summary = updateSummary(SKELETON_SUMMARY, planNavigation(guide, tech));
  const byDest = new Map(navUrls(summary).map((n) => [n.file, n.url]));
  const out = new Map();
  for (const [base, entries] of [
    [layout.guide, guide],
    [layout.technical, tech],
  ]) {
    for (const e of entries) {
      const src = `${base}/${e.file}`;
      const url = byDest.get(destFor(src, layout));
      if (url !== undefined) out.set(src, url ? `${WIKI_URL}/${url}` : WIKI_URL);
    }
  }
  return out;
}

/** The pages in SUMMARY order: [{ rel, title }]. */
export function orderedPages(root, layout) {
  const out = [];
  const seen = new Set();
  for (const base of [layout.guide, layout.technical]) {
    for (const e of parseSummary(fs.readFileSync(path.join(root, base, 'SUMMARY.md'), 'utf8'))) {
      const rel = `${base}/${e.file}`;
      if (!seen.has(rel)) out.push({ rel, title: e.title });
      seen.add(rel);
    }
  }
  return out;
}
