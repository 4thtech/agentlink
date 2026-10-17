#!/usr/bin/env node
// OPS-REL-3 / D-43 (docs/process/versioning.md §5, §6): the release workflow's two CHANGELOG jobs.
//
//   roll   Run by the root script `version-packages` after `changeset version`. For a stable product
//          version it renames `## [Unreleased]` to `## [<version>] - <date>`, adds a fresh empty
//          `## [Unreleased]` and updates the compare links. It refuses an empty `[Unreleased]`
//          (nothing to release is a human decision, not a silent "maintenance release"), and does
//          nothing for a prerelease.
//   body   Run by the `notes` step of `publish-latest`. GitHub rejects a Release body over 125,000
//          characters (HTTP 422), so an over-long section is replaced by a short note that links
//          `docs/releases/v<version>.md` if it exists, else the CHANGELOG section.
//
//   node tools/release/roll-changelog.mjs roll [--file CHANGELOG.md] [--version X.Y.Z] [--date YYYY-MM-DD]
//   node tools/release/roll-changelog.mjs body --notes FILE --version X.Y.Z --repo owner/name [--date D]
//
// Without --version, `roll` reads the product version from apps/cli/package.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const GITHUB_BODY_LIMIT = 125_000;
const STABLE = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isStableVersion = (v) => typeof v === 'string' && STABLE.test(v);

// GitHub heading anchor of `## [<version>] - <date>`.
export const anchorFor = (version, date) =>
  `${version} - ${date}`
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-');

export function rollChangelog(text, version, date) {
  if (!isStableVersion(version))
    throw new Error(`Only a stable version can be rolled, got "${version}".`);
  if (!DATE.test(date)) throw new Error(`Invalid date "${date}" (want YYYY-MM-DD).`);
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'));
  if (start === -1) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.');
  if (lines.some((l) => l.startsWith(`## [${version}]`))) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  }
  let end = lines.findIndex((l, i) => i > start && (/^## \[/.test(l) || /^\[[^\]]+\]:/.test(l)));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  const hasContent = body.some((l) => l.trim() !== '' && !/^#{1,6}\s/.test(l));
  if (!hasContent) throw new Error('"## [Unreleased]" is empty: nothing to release.');

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

export function releaseBody(section, { version, date, repository, hasReleaseNote = false }) {
  if (section.length <= GITHUB_BODY_LIMIT) return { body: section, fallback: false };
  const base = `https://github.com/${repository}/blob/v${version}`;
  const link = hasReleaseNote
    ? `${base}/docs/releases/v${version}.md`
    : `${base}/CHANGELOG.md#${anchorFor(version, date ?? '')}`;
  const what = hasReleaseNote ? 'the release note' : 'the changelog section';
  const body = `The full notes for v${version} are too long for a GitHub Release body. Read ${what}: ${link}\n`;
  return { body, fallback: true };
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

// The date of `## [<version>] - <date>` in CHANGELOG.md (the anchor of the fallback link needs it).
function headingDate(version) {
  if (!existsSync('CHANGELOG.md')) return '';
  const m = new RegExp(
    `^## \\[${version.replace(/\./g, '\\.')}\\] - (\\d{4}-\\d{2}-\\d{2})`,
    'm',
  ).exec(readFileSync('CHANGELOG.md', 'utf8'));
  return m ? m[1] : '';
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
    writeFileSync(file, rollChangelog(readFileSync(file, 'utf8'), version, date));
    console.log(`Rolled [Unreleased] into [${version}] - ${date}.`);
    return;
  }
  if (command === 'body') {
    const { notes, version, repo } = opts;
    if (!notes || !version || !repo) throw new Error('body needs --notes, --version and --repo.');
    if (!isStableVersion(version) || !/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error('Bad --version or --repo.');
    const section = readFileSync(notes, 'utf8');
    const { body, fallback } = releaseBody(section, {
      version,
      date: opts.date ?? headingDate(version),
      repository: repo,
      hasReleaseNote: existsSync(`docs/releases/v${version}.md`),
    });
    if (fallback) {
      writeFileSync(notes, body);
      console.log(
        `::warning::Release notes for v${version} are over ${GITHUB_BODY_LIMIT} characters; using a short note with a link.`,
      );
    }
    return;
  }
  throw new Error('Usage: roll-changelog.mjs roll|body ...');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.log(`::error::${error?.message ?? String(error)}`);
    process.exit(1);
  }
}
