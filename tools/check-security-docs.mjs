#!/usr/bin/env node
// DOCS-UNDER-THE-HOOD: keeps the security explanation layer (docs/technical, knowledge) in step
// with the normative spec 04 and the decision log. Checks, all against the real repository:
//   1. threat mirror: every threat named in 04 §7 appears in threat-model.md (or tools/security-docs.json
//      `threats`, with a reason);
//   2. decision coverage: every decided entry in specs/decisions/ that cites 04 is referenced
//      (D-N) on a security page, or listed in tools/security-docs.json `decisions` with a reason; the
//      index specs/decisions/README.md has exactly one row per decision file;
//   3. stale wording: "Status: Design" and "next release" are refused on pages whose subject has shipped
//      (every docs/technical page, plus `shippedPages`), and a "Current for vX.Y" stamp older than the current minor version
//      (apps/cli/package.json) is refused on every docs and knowledge page;
//   4. section references: every "NN §x.y" on docs and knowledge pages names a numbered heading
//      that exists in spec NN.
// Exit 1 on any finding. `--pr <base>` additionally prints the PR-hygiene warning (never fails): a diff
// touching a security-sensitive path should touch a security page or carry "security-docs: none" in
// the PR body (`--body-file`).

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_DIR = 'specs';
const DECISIONS_DIR = 'specs/decisions';
const THREAT_PAGE = 'docs/technical/concepts/threat-model.md';

/** Lower case, no Markdown emphasis or code marks, typographic quotes folded, whitespace collapsed. */
export function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[*`_]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The threat names (first bold run of the first cell) of the table under "## 7. Threat model". */
export function parseThreats(spec04) {
  const start = spec04.search(/^## 7\. Threat model\s*$/m);
  if (start === -1) throw new Error('04: no "## 7. Threat model" heading');
  const rest = spec04.slice(start);
  const end = rest.slice(1).search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end + 1);
  const names = [];
  for (const line of section.split('\n')) {
    const m = /^\|\s*\*\*(.+?)\*\*/.exec(line);
    if (m) names.push(m[1].trim());
  }
  return names;
}

export function checkThreatMirror(spec04, threatPage, allowed = {}) {
  const page = normalise(threatPage);
  const names = parseThreats(spec04);
  return {
    count: names.length,
    missing: names.filter((n) => !(n in allowed) && !page.includes(normalise(n))),
  };
}

/** A status text that records an owner decision (in whole or in part). */
export const isDecided = (status) => /\b(decided|accepted)\b/i.test(status);
/** A decision text that cites spec 04 (`04 §x`, `04 section`, `04-security…`). */
export const citesSpec04 = (text) => /(^|[^\w.-])04(\s?§|\s+section\b|-security)/.test(text);

/** Parses one decision file: { id (number), label ("D-07"), status, text }. */
export function parseDecision(text, file = '') {
  const head = /^# (D-(\d+)): .+$/m.exec(text);
  const status = /^- \*\*Status:\*\* (.+)$/m.exec(text);
  if (!head || !status) throw new Error(`${file}: needs "# D-N: title" and "- **Status:** …"`);
  return { id: Number(head[2]), label: head[1], status: status[1], text };
}

export function readDecisions(dir = join(root, DECISIONS_DIR)) {
  return readdirSync(dir)
    .filter((f) => /^D-\d{3}\.md$/.test(f))
    .sort()
    .map((f) => ({ file: f, ...parseDecision(readFileSync(join(dir, f), 'utf8'), f) }));
}

/** IDs referenced as D-N (any zero padding) in a text. */
export function referencedDecisions(text) {
  return new Set([...text.matchAll(/\bD-0*(\d{1,4})\b/g)].map((m) => Number(m[1])));
}

export function checkDecisionCoverage(decisions, pagesText, allowed = {}) {
  const refs = referencedDecisions(pagesText);
  const allowedIds = new Set(Object.keys(allowed).map((k) => Number(k.replace(/^D-0*/, ''))));
  const required = decisions.filter((d) => isDecided(d.status) && citesSpec04(d.text));
  return {
    required: required.length,
    missing: required.filter((d) => !refs.has(d.id) && !allowedIds.has(d.id)).map((d) => d.label),
    staleAllow: [...allowedIds].filter((id) => refs.has(id)).map((id) => `D-${id}`),
  };
}

/** Index rows "| [D-N](D-NNN.md) | …" against the decision files. */
export function checkDecisionIndex(indexText, files) {
  const rows = [...indexText.matchAll(/^\| \[D-(\d+)\]\((D-\d{3}\.md)\) \|/gm)].map((m) => ({
    id: Number(m[1]),
    file: m[2],
  }));
  const problems = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.file)) problems.push(`${r.file}: more than one index row`);
    seen.add(r.file);
    if (r.file !== `D-${String(r.id).padStart(3, '0')}.md`)
      problems.push(`${r.file}: row ID D-${r.id}`);
    if (!files.includes(r.file)) problems.push(`${r.file}: index row without a file`);
  }
  for (const f of files) if (!seen.has(f)) problems.push(`${f}: no row in decisions/README.md`);
  return problems;
}

const minorOf = (v) => {
  const m = /^v?(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/** Stale wording on one page. `shipped`: the page's subject has shipped. */
export function checkWording(text, { shipped, currentVersion }) {
  const problems = [];
  if (shipped) {
    if (/status:\s*design/i.test(text)) problems.push('"Status: Design" on a shipped subject');
    if (/\bnext release\b/i.test(text)) problems.push('"next release" on a shipped subject');
  }
  const cur = minorOf(currentVersion);
  for (const m of text.matchAll(/Current for v(\d+\.\d+(?:\.\d+)?)/g)) {
    const v = minorOf(m[1]);
    if (cur && v && (v[0] < cur[0] || (v[0] === cur[0] && v[1] < cur[1])))
      problems.push(`stamp "Current for v${m[1]}" is older than ${cur.join('.')}`);
  }
  return problems;
}

/** Numbered section headings of a spec: "2.5.4", "7", "10" … */
export function sectionNumbers(specText) {
  const out = new Set();
  for (const m of specText.matchAll(/^#{1,6}\s+(\d+(?:\.\d+)*)\.?\s/gm)) out.add(m[1]);
  return out;
}

/** Every "NN §x.y" reference in a text: [{ spec, section, index }]. */
export function sectionRefs(text) {
  return [...text.matchAll(/(?<![\w.§-])(0\d|1[0-2]) ?§ ?(\d+(?:\.\d+)*)/g)].map((m) => ({
    spec: m[1],
    section: m[2],
    index: m.index,
  }));
}

export function specFiles(dir = join(root, SPEC_DIR)) {
  const map = {};
  for (const f of readdirSync(dir)) {
    const m = /^(\d\d)-.+\.md$/.exec(f);
    if (m) map[m[1]] = readFileSync(join(dir, f), 'utf8');
  }
  return map;
}

export function checkSectionRefs(text, specs) {
  const problems = [];
  const cache = {};
  for (const r of sectionRefs(text)) {
    if (!(r.spec in specs)) {
      if (r.spec !== '01' && r.spec !== '09')
        problems.push(`${r.spec} §${r.section}: no spec ${r.spec}`);
      continue;
    }
    cache[r.spec] ??= sectionNumbers(specs[r.spec]);
    if (!cache[r.spec].has(r.section)) problems.push(`${r.spec} §${r.section}: no such section`);
  }
  return problems;
}

/** PR hygiene: a warning (or null) for a change that touches security-sensitive paths. */
export function securityDocsWarning(paths, body = '', config = loadConfig()) {
  const sensitive = config.sensitivePaths.map((s) => new RegExp(s));
  const hits = paths.filter((p) => sensitive.some((re) => re.test(p)));
  if (hits.length === 0) return null;
  const pages = new Set([...config.securityPages, 'docs/technical/reference/policies.md']);
  if (paths.some((p) => pages.has(p))) return null;
  if (/^\s*security-docs:\s*none\b/im.test(body)) return null;
  return (
    `Security-relevant paths changed (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ', …' : ''}) ` +
    'but no security page (security model, threat model, policies, MCP tools, privacy, knowledge) was ' +
    'updated. Update one, or add "security-docs: none (<reason>)" to the PR body.'
  );
}

export function loadConfig() {
  return JSON.parse(readFileSync(join(root, 'tools/security-docs.json'), 'utf8'));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Runs every check on the repository. Returns { problems: string[], notes: string[] }. */
export function runChecks(base = root) {
  const config = loadConfig();
  const read = (p) => readFileSync(join(base, p), 'utf8');
  const problems = [];
  const notes = [];
  const specs = specFiles(join(base, SPEC_DIR));

  const mirror = checkThreatMirror(specs['04'], read(THREAT_PAGE), config.threats);
  for (const n of mirror.missing)
    problems.push(`${THREAT_PAGE}: threat "${n}" from 04 §7 is missing`);
  notes.push(
    `threats: ${mirror.count - mirror.missing.length}/${mirror.count} on the threat model`,
  );

  const decisions = readDecisions(join(base, DECISIONS_DIR));
  const files = decisions.map((d) => d.file);
  for (const p of checkDecisionIndex(read(`${DECISIONS_DIR}/README.md`), files))
    problems.push(`${DECISIONS_DIR}/${p}`);
  const pagesText = config.securityPages.map(read).join('\n');
  const cov = checkDecisionCoverage(decisions, pagesText, config.decisions);
  for (const id of cov.missing)
    problems.push(
      `${id} is decided and cites 04 but no security page references it (or allowlist it in tools/security-docs.json with a reason)`,
    );
  for (const id of cov.staleAllow)
    problems.push(`tools/security-docs.json: ${id} is referenced now; drop it from "decisions"`);
  notes.push(
    `decisions: ${decisions.length} files; ${cov.required - cov.missing.length}/${cov.required} decided 04 entries covered (${Object.keys(config.decisions).length} by allowlist)`,
  );

  const version = JSON.parse(read('apps/cli/package.json')).version;
  const shipped = new Set(config.shippedPages);
  // Every technical page counts as shipped: an unbuilt subject says "Planned for vX" instead.
  const isShipped = (p) => shipped.has(p) || p.startsWith('docs/technical/');
  const pages = [...walk(join(base, 'docs')), ...walk(join(base, 'knowledge'))]
    .map((f) => relative(base, f).split('\\').join('/'))
    .filter((p) => !p.startsWith('docs/_templates/') && p !== 'docs/MAINTAINING.md');
  let refs = 0;
  for (const p of pages) {
    const text = read(p);
    for (const w of checkWording(text, { shipped: isShipped(p), currentVersion: version }))
      problems.push(`${p}: ${w}`);
    refs += sectionRefs(text).length;
    for (const s of checkSectionRefs(text, specs)) problems.push(`${p}: ${s}`);
  }
  for (const p of shipped)
    if (!pages.includes(p)) problems.push(`tools/security-docs.json: ${p} does not exist`);
  notes.push(
    `pages: ${pages.length} checked for stamps, ${refs} "NN §x.y" references resolved (current ${version})`,
  );
  return { problems, notes };
}

function main(argv) {
  const { problems, notes } = runChecks();
  const pr = argv.indexOf('--pr');
  if (pr !== -1) {
    const base = argv[pr + 1] ?? 'origin/main';
    if (!/^[A-Za-z0-9._/-]+$/.test(base)) throw new Error('--pr: not a ref');
    const bf = argv.indexOf('--body-file');
    const body = bf !== -1 ? readFileSync(argv[bf + 1], 'utf8') : '';
    const paths = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    const warning = securityDocsWarning(paths, body);
    if (warning) console.warn(`warning: ${warning}`);
  }
  for (const n of notes) console.log(`check-security-docs: ${n}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-security-docs: ${p}`);
    console.error(`check-security-docs: ${problems.length} problem(s).`);
    process.exit(1);
  }
  console.log('check-security-docs: OK');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`check-security-docs: ${error?.message ?? String(error)}`);
    process.exit(1);
  }
}
