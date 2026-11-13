// REL-LINKS-1 one-shot: give an existing GitHub Release the stable-named Mac files
// (AgentLink-mac-arm64.dmg, AgentLink-mac-x64.dmg) that release.yml now attaches by itself.
// Needed once, for the release that is Latest when the stable links first go live.
//
//   node tools/release/backfill-stable-dmg.mjs --tag v0.5.2            (dry run: downloads and checks, uploads nothing)
//   node tools/release/backfill-stable-dmg.mjs --tag v0.5.2 --apply    (uploads; run only with the owner's OK)
//
// It downloads the two versioned DMGs and SHA256SUMS-desktop-app.txt of the tag, verifies each DMG
// against that file, copies them under the stable names, adds the two stable lines to the sums and
// uploads the copies and the new sums with `gh release upload --clobber`. The versioned files are
// never touched. Needs `gh` with write access to the repository. Never prints URLs or tokens.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG_RE = /^v(\d+\.\d+\.\d+)$/;
const ARCHS = ['arm64', 'x64'];
const SUMS = 'SHA256SUMS-desktop-app.txt';

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Parses `<hash>  <name>` lines into a Map name -> hash. */
export function parseSums(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (m) map.set(m[2], m[1]);
  }
  return map;
}

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/**
 * Backfills one release. `gh(args)` runs the GitHub CLI (injectable for tests). Returns
 * { uploaded: boolean, files: string[] }.
 */
export function backfill({ tag, repo, apply = false, gh = defaultGh, dir, log = console.log }) {
  const m = TAG_RE.exec(tag ?? '');
  if (!m) throw new Error('--tag must look like v0.5.2');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('--repo must look like owner/name');
  const version = m[1];
  const work = dir ?? mkdtempSync(join(tmpdir(), 'backfill-stable-dmg-'));
  const versioned = ARCHS.map((a) => `AgentLink-${version}-mac-${a}.dmg`);
  const stable = ARCHS.map((a) => `AgentLink-mac-${a}.dmg`);

  const args = ['release', 'download', tag, '--repo', repo, '--dir', work, '--clobber'];
  for (const name of [...versioned, SUMS]) args.push('--pattern', name);
  gh(args);

  const sums = parseSums(readFileSync(join(work, SUMS), 'utf8'));
  for (const name of versioned) {
    const expected = sums.get(name);
    if (!expected) throw new Error(`${name} is not listed in ${SUMS} of ${tag}.`);
    if (sha256(join(work, name)) !== expected) {
      throw new Error(`${name} does not match ${SUMS} of ${tag}; nothing uploaded.`);
    }
    log(`${name}: SHA-256 matches the release sums.`);
  }

  // Keep the release's own lines, drop stale stable lines, add the stable ones.
  const lines = readFileSync(join(work, SUMS), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !stable.some((s) => l.trim().endsWith(` ${s}`)));
  ARCHS.forEach((a, i) => {
    copyFileSync(join(work, versioned[i]), join(work, stable[i]));
    lines.push(`${sha256(join(work, stable[i]))}  ${stable[i]}`);
  });
  writeFileSync(join(work, SUMS), `${lines.join('\n')}\n`);

  const files = [...stable, SUMS];
  if (!apply) {
    log(
      `Dry run: would upload ${files.join(', ')} to ${tag} with --clobber. Add --apply to do it.`,
    );
    return { uploaded: false, files };
  }
  gh([
    'release',
    'upload',
    tag,
    '--repo',
    repo,
    '--clobber',
    '--',
    ...files.map((f) => join(work, f)),
  ]);
  log(`Uploaded ${files.join(', ')} to ${tag}.`);
  return { uploaded: true, files };
}

function main(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    backfill({
      tag: get('--tag'),
      repo: get('--repo') ?? '4thtech/agentlink',
      apply: argv.includes('--apply'),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));
