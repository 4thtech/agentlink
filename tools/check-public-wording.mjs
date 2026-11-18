#!/usr/bin/env node
// DOCS-COMPACT-A: the public docs (guide, technical docs, their index) carry no internal annotations.
// Run by `pnpm lint` (tools `check`). The specs mark open points as "proposed, owner confirms at
// merge" or "DECISION NEEDED", reviews have IDs like IR-UPD-8-1, and CI has internal variables and
// secret names; none of these belong on a public page. Fails on any of INTERNAL_PATTERNS outside code.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS } from './docs/paths.mjs';

export const INTERNAL_PATTERNS = [
  [/DECISION NEEDED/, 'an open-decision marker'],
  [/owner confirms at merge/i, 'a spec review marker'],
  [/\(proposed[),;:]/i, 'a "proposed" marker'],
  [/\bproposed, owner\b/i, 'a "proposed" marker'],
  [/\bIR-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/, 'an internal review ID'],
  [
    /\b(?:DEPLOY_FREEZE|NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|DESKTOP_EXT_SIGNING_KEY|DOCS_RATCHET_BASE)\b/,
    'an internal CI variable or secret name',
  ],
  [/\b(?:secrets|vars)\.[A-Z_]{3,}\b/, 'a workflow secret or variable reference'],
];

/** Problems in one page: [`line: what (match)`]. Fenced and inline code are not checked. */
export function findInternal(text) {
  const out = [];
  let fence = null;
  text.split('\n').forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      fence = fence === null ? f[1] : fence === f[1] ? null : fence;
      return;
    }
    if (fence !== null) return;
    const prose = line.replace(/`[^`\n]*`/g, '');
    for (const [re, what] of INTERNAL_PATTERNS) {
      const m = re.exec(prose);
      if (m) out.push(`${i + 1}: ${what} ("${m[0]}")`);
    }
  });
  return out;
}

export function publicPages(root) {
  const out = [];
  for (const dir of [DOCS.guide, DOCS.technical]) {
    for (const f of readdirSync(join(root, dir), { recursive: true }).map(String).sort())
      if (f.endsWith('.md')) out.push(`${dir}/${f.split('\\').join('/')}`);
  }
  out.push(DOCS.publicReadme);
  return out;
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = [];
  for (const rel of publicPages(root))
    for (const p of findInternal(readFileSync(join(root, rel), 'utf8')))
      problems.push(`${rel}:${p}`);
  if (problems.length) {
    console.error(
      `check-public-wording: ${problems.length} internal annotation(s) on public pages; reword them:\n- ${problems.join('\n- ')}`,
    );
    process.exit(1);
  }
  console.log('check-public-wording: no internal annotations on the public pages.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
