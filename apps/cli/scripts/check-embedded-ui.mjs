#!/usr/bin/env node
// CHORE-LOCALUI-EMBED-NONEMPTY: the release-time check that the built CLI really embeds the local UI
// (D-118). An empty embed would publish a CLI whose approval server answers the fixed 503 page, so
// no approval would work in the browser. The release workflow runs this in the `pack` job right
// after `pnpm build`; dev and test runs, where the bundle may be absent or empty, never call it.
//
// It reads the `[name, base64url]` entries bundle.config.mjs inlined for `__AGENTLINK_LOCAL_UI__`
// out of dist/agentlink.js (from the AST, nothing is executed) and fails unless `index.html`, at
// least one `.js` and at least one `.css` under `assets/` are present, each with content.
//
// Usage: node scripts/check-embedded-ui.mjs [--bundle <file>]
// Exit code 0 when the embed is complete, 1 on a finding (stderr), 2 on an error.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseAst } from 'vite';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

const isString = (n) => n?.type === 'Literal' && typeof n.value === 'string';
const isPair = (n) =>
  n?.type === 'ArrayExpression' && n.elements.length === 2 && n.elements.every(isString);

/** The embedded `[name, base64url]` entries of a bundle's source: its largest array of such pairs. */
export function entriesFromBundle(source) {
  let best = [];
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (
      node.type === 'ArrayExpression' &&
      node.elements.length > best.length &&
      node.elements.every(isPair) &&
      node.elements.every((p) => /^(index\.html|assets\/.+)$/.test(p.elements[0].value))
    ) {
      best = node.elements.map((p) => [p.elements[0].value, p.elements[1].value]);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') visit(child);
    }
  };
  visit(parseAst(source));
  return best;
}

/** Findings (strings) for a list of embedded entries; [] when the embed is complete. */
export function embeddedUiProblems(entries) {
  const problems = [];
  const need = (label, match) => {
    const found = entries.filter(([name]) => match(name));
    if (found.length === 0) problems.push(`the embedded local UI has no ${label}`);
    else if (!found.some(([, data]) => data.length > 0)) {
      problems.push(`the embedded local UI's ${label} is empty`);
    }
  };
  need('index.html', (n) => n === 'index.html');
  need('JavaScript file (assets/*.js)', (n) => /^assets\/[^/]+\.js$/.test(n));
  need('CSS file (assets/*.css)', (n) => /^assets\/[^/]+\.css$/.test(n));
  return problems;
}

function main() {
  const { values } = parseArgs({ options: { bundle: { type: 'string' } } });
  const bundle = values.bundle ?? join(packageDir, 'dist', 'agentlink.js');
  const problems = embeddedUiProblems(entriesFromBundle(readFileSync(bundle, 'utf8')));
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error('Build apps/local-ui before the CLI (pnpm build does) and release again.');
    process.exit(1);
  }
  console.log('embedded local UI: index.html, JavaScript and CSS present');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`check-embedded-ui: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
