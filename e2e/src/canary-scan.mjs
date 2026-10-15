// M1-13a canary scan (I-1, I-2; AGENTS.md "never log secrets"). The scenario plants canaries (the
// test owners' seeds and codes, a file under ~/.agentlink that the harness permission rules must
// keep out of the transcript, and the message plaintext), writes them to a canaries file OUTSIDE the
// artifact directory, and this scan reads every byte of every file under the given paths and fails
// when any canary appears. It also checks the values of environment variables named with
// `--env-secret` (the API keys of the LLM run), so a key that leaked into a log or artifact fails the
// run without ever being printed.
//
// Output: only the relative file name and the canary's NAME, never a value.
//
//   node canary-scan.mjs --canaries <file.json> [--env-secret NAME]... <path>...
//
// The canaries file is `[{ "name": string, "value": string, "where"?: "all" | "outside-transcripts" }]`.
// `outside-transcripts` canaries (the message plaintext, which the receiving agent legitimately
// reads) are allowed only in files whose name ends in `.transcript.jsonl`; every other canary is
// allowed nowhere.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TRANSCRIPT = /\.transcript\.jsonl$/;
const MIN_LENGTH = 8;

async function* files(path) {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return;
  if (info.isFile()) {
    yield path;
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(path)) yield* files(join(path, entry));
}

/**
 * Scans `paths` for `canaries` (`{ name, value, where }`). Returns `{ scanned, findings }`, where
 * each finding is `{ file, name }` (file relative to its scan root).
 */
export async function scanForCanaries(paths, canaries) {
  const needles = canaries
    .filter((c) => typeof c.value === 'string' && c.value.length >= MIN_LENGTH)
    .map((c) => ({ name: c.name, where: c.where ?? 'all', bytes: Buffer.from(c.value, 'utf8') }));
  const findings = [];
  let scanned = 0;
  for (const root of paths) {
    for await (const file of files(root)) {
      scanned += 1;
      const data = await readFile(file);
      const name = relative(root, file) || file;
      for (const needle of needles) {
        if (needle.where === 'outside-transcripts' && TRANSCRIPT.test(file)) continue;
        if (data.indexOf(needle.bytes) !== -1) findings.push({ file: name, name: needle.name });
      }
    }
  }
  return { scanned, findings };
}

/** Every spelling a byte string may take in a log: hex (both cases), base64 and base64url. */
export function spellings(name, bytes) {
  const buffer = Buffer.from(bytes);
  const hex = buffer.toString('hex');
  return [
    { name: `${name} (hex)`, value: hex },
    { name: `${name} (HEX)`, value: hex.toUpperCase() },
    { name: `${name} (base64)`, value: buffer.toString('base64').replace(/=+$/, '') },
    { name: `${name} (base64url)`, value: buffer.toString('base64url') },
  ];
}

async function main(argv) {
  let canariesFile;
  const envSecrets = [];
  const paths = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--canaries') canariesFile = argv[(i += 1)];
    else if (arg === '--env-secret') envSecrets.push(argv[(i += 1)]);
    else paths.push(arg);
  }
  if (canariesFile === undefined || paths.length === 0) {
    process.stderr.write(
      'usage: canary-scan.mjs --canaries <file> [--env-secret NAME]... <path>...\n',
    );
    return 2;
  }
  const canaries = JSON.parse(await readFile(canariesFile, 'utf8'));
  for (const name of envSecrets) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length >= MIN_LENGTH) {
      canaries.push({ name: `environment secret ${name}`, value });
    }
  }
  const { scanned, findings } = await scanForCanaries(paths, canaries);
  process.stdout.write(
    `canary scan: ${String(canaries.length)} canaries, ${String(scanned)} files, ${String(findings.length)} findings\n`,
  );
  for (const finding of findings) {
    process.stdout.write(`::error::canary "${finding.name}" found in ${finding.file}\n`);
  }
  return findings.length === 0 && scanned > 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
