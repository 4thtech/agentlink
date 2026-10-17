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
//   node tools/release/roll-changelog.mjs roll [--file CHANGELOG.md] [--version X.Y.Z] [--date YYYY-MM-DD]
//
// Without --version, `roll` reads the product version from apps/cli/package.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const STABLE = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isStableVersion = (v) => typeof v === 'string' && STABLE.test(v);

export function rollChangelog(text, version, date) {
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
  const body = lines.slice(start + 1, end);
  const hasContent = body.some((l) => l.trim() !== '' && !/^#{1,6}\s/.test(l));
  if (!hasContent)
    throw new Error(
      '"## [Unreleased]" is empty: add an entry under [Unreleased] in CHANGELOG.md before releasing.',
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
    writeFileSync(file, rollChangelog(text, version, date));
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
