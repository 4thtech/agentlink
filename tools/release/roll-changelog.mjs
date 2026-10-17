#!/usr/bin/env node
// OPS-REL-3 / D-43 (docs/process/versioning.md §5, §6): the release workflow's CHANGELOG roll (the Release-body size check is inline in release.yml, not here: that job holds the OIDC token).
//
//   roll   Run by the root script `version-packages` after `changeset version`. For a stable product
//          version it renames `## [Unreleased]` to `## [<version>] - <date>`, adds a fresh empty
//          `## [Unreleased]` and updates the compare links. It refuses an empty `[Unreleased]`
//          (nothing to release is a human decision, not a silent "maintenance release"), and does
//          nothing for a prerelease or when this version already has its section (the product
//          version was not bumped, e.g. only private packages were released).
//
//   OPS-REL-4: the entries come from changelog fragments (`changelog.d/*.md`, format in
//   changelog.d/README.md) and from any legacy lines already under `[Unreleased]`; both are folded into
//   the new section, grouped by Keep a Changelog section in a stable order, and the consumed fragments
//   are deleted. It refuses only when both are empty, and a fragment with an unknown section is an error.
//
//   node tools/release/roll-changelog.mjs roll [--file CHANGELOG.md] [--fragments changelog.d] [--version X.Y.Z] [--date YYYY-MM-DD]
//
// Without --version, `roll` reads the product version from apps/cli/package.json.
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isStableVersion = (v) => typeof v === 'string' && STABLE.test(v);

export const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const HEADING = /^#{2,4}\s+(.+?)\s*#*\s*$/;

// Parse one fragment into { Section: [lines] }. Front matter `section: X` and/or `### X` headings name
// the section; `none` records a reason and adds no entry (the CI check accepts it for a refactor).
export function parseFragment({ name, text }) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let current = null;
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (close === -1) throw new Error(`${name}: front matter is not closed with "---".`);
    for (const l of lines.slice(1, close)) {
      const m = /^section\s*:\s*(.+?)\s*$/i.exec(l);
      if (m) current = m[1];
    }
    i = close + 1;
  }
  const out = {};
  let noneReason = 0;
  const check = (sec) => {
    if (sec.toLowerCase() === 'none') return 'none';
    if (!SECTIONS.includes(sec))
      throw new Error(`${name}: unknown section "${sec}" (use ${SECTIONS.join(', ')}, or none).`);
    return sec;
  };
  if (current !== null) current = check(current);
  for (const l of lines.slice(i)) {
    const h = HEADING.exec(l);
    if (h) {
      if (/^\[?\d+\.\d+/.test(h[1]) || /^\[Unreleased\]/i.test(h[1]))
        throw new Error(`${name}: a version heading ("${l.trim()}") is not allowed in a fragment.`);
      current = check(h[1]);
    } else if (l.trim() !== '') {
      if (/^\s*\[[^\]]+\]:\s/.test(l))
        throw new Error(
          `${name}: a link-reference line ("[x]: url") is not allowed in a fragment.`,
        );
      if (current === 'none') noneReason += 1;
      if (current === null)
        throw new Error(
          `${name}: no section named (add "section: Added" front matter or a "### Added" heading).`,
        );
      if (current !== 'none') (out[current] ??= []).push(l.replace(/\s+$/, ''));
    }
  }
  if (current === null)
    throw new Error(
      `${name}: no section named (add "section: Added" front matter or a "### Added" heading).`,
    );
  if (current === 'none' && noneReason === 0)
    throw new Error(`${name}: "section: none" needs a one-line reason.`);
  for (const [sec, ls] of Object.entries(out)) {
    if (!ls.some((l) => /^[-*]\s/.test(l)))
      throw new Error(`${name}: section "${sec}" has no bullet line ("- ...").`);
  }
  if (current !== 'none' && Object.keys(out).length === 0)
    throw new Error(`${name}: no bullet line ("- ...") found.`);
  return out;
}

// Merge legacy [Unreleased] body lines and parsed fragments into one body in canonical order.
function mergeBody(body, fragments) {
  const parsed = [...fragments]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(parseFragment);
  if (!parsed.some((f) => Object.keys(f).length > 0)) return { lines: body, hasFragments: false };
  const pre = [];
  const sections = new Map();
  let cur = null;
  for (const l of body) {
    const h = /^###\s+(.+?)\s*$/.exec(l);
    if (h) {
      cur = h[1];
      if (!sections.has(cur)) sections.set(cur, []);
    } else if (cur === null) pre.push(l);
    else sections.get(cur).push(l);
  }
  const trim = (ls) => {
    const r = [...ls];
    while (r.length && r[r.length - 1].trim() === '') r.pop();
    while (r.length && r[0].trim() === '') r.shift();
    return r;
  };
  for (const f of parsed)
    for (const [sec, ls] of Object.entries(f)) {
      const base = trim(sections.get(sec) ?? []);
      sections.set(sec, [...base, ...ls]);
    }
  const order = [
    ...SECTIONS.filter((s) => sections.has(s)),
    ...[...sections.keys()].filter((s) => !SECTIONS.includes(s)),
  ];
  const lines = [];
  const p = trim(pre);
  if (p.length) lines.push(...p, '');
  for (const sec of order) {
    const ls = trim(sections.get(sec));
    if (!ls.length) continue;
    lines.push(`### ${sec}`, '', ...ls, '');
  }
  return { lines, hasFragments: true };
}

export function rollChangelog(text, version, date, fragments = []) {
  if (!isStableVersion(version))
    throw new Error(`Only a stable version can be rolled, got "${version}".`);
  if (!DATE.test(date)) throw new Error(`Invalid date "${date}" (want YYYY-MM-DD).`);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'));
  if (start === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.');
  if (lines.some((l) => l.startsWith(`## [${version}]`))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  }
  let end = lines.findIndex((l, i) => i > start && (/^## \[/.test(l) || /^\[[^\]]+\]:/.test(l)));
  if (end === -1) end = lines.length;
  const merged = mergeBody(lines.slice(start + 1, end), fragments);
  const body = merged.lines;
  const hasContent = body.some((l) => l.trim() !== '' && !/^#{1,6}\s/.test(l));
  if (!hasContent)
    throw new Error(
      '"## [Unreleased]" is empty: add an entry under [Unreleased] in CHANGELOG.md or a fragment in changelog.d/ before releasing.',
    );

  const prevLine = lines.find((l, i) => i >= end && /^## \[\d+\.\d+\.\d+\]/.test(l));
  const prev = prevLine ? /^## \[([^\]]+)\]/.exec(prevLine)[1] : null;

  const trimmed = [...body];
  while (trimmed.length && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
  while (trimmed.length && trimmed[0].trim() === '') trimmed.shift();
  const out = [
    ...lines.slice(0, start + 1),
    '',
    `## [${version}] - ${date}`,
    '',
    ...trimmed,
    '',
    ...lines.slice(end),
  ];

  const linkIdx = out.findIndex((l) => l.startsWith('[Unreleased]:'));
  if (linkIdx !== -1) {
    const m = /^\[Unreleased\]:\s*(https:\/\/github\.com\/[^/\s]+\/[^/\s]+)\//.exec(out[linkIdx]);
    if (m) {
      const repo = m[1];
      out[linkIdx] = `[Unreleased]: ${repo}/compare/v${version}...HEAD`;
      out.splice(
        linkIdx + 1,
        0,
        prev
          ? `[${version}]: ${repo}/compare/v${prev}...v${version}`
          : `[${version}]: ${repo}/releases/tag/v${version}`,
      );
    }
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i];
    if (!k?.startsWith('--') || rest[i + 1] === undefined) throw new Error(`Bad argument "${k}".`);
    opts[k.slice(2)] = rest[i + 1];
  }
  return { command, opts };
}

export function runCli(argv) {
  const { command, opts } = parseArgs(argv);
  if (command === 'roll') {
    const file = opts.file ?? 'CHANGELOG.md';
    const version =
      opts.version ?? JSON.parse(readFileSync('apps/cli/package.json', 'utf8')).version;
    if (!isStableVersion(version)) {
      console.log(`Version ${version} is not stable; CHANGELOG.md left alone.`);
      return;
    }
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const text = readFileSync(file, 'utf8');
    if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(text)) {
      console.log(
        `::notice::CHANGELOG.md already has [${version}]; the product version was not bumped, nothing rolled.`,
      );
      return;
    }
    const dir = opts.fragments ?? 'changelog.d';
    const names = existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
          .map((e) => e.name)
          .sort()
      : [];
    const fragments = names.map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
    writeFileSync(file, rollChangelog(text, version, date, fragments));
    for (const name of names) unlinkSync(join(dir, name));
    console.log(`Rolled [Unreleased] into [${version}] - ${date}.`);
    return;
  }
  throw new Error('Usage: roll-changelog.mjs roll ...');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.log(`::error::${error?.message ?? String(error)}`);
    process.exit(1);
  }
}
