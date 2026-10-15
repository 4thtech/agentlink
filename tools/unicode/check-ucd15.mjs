// UCD 15.0.0 drift check (D-74, M1-21-b; 04 §3.4 "Table provenance"), run by `pnpm lint` through
// the tools package `check` script. Fails unless:
// - the vendored DerivedGeneralCategory.txt has the SHA-256 recorded in SHA256SUMS next to it, and
//   that is the value pinned in the generator;
// - re-running the generator on that file gives exactly the committed packages/types/src/ucd15.ts.
// Needs any python3 (the generator uses no `unicodedata`); set UCD_PYTHON to choose one.
// Usage: node tools/unicode/check-ucd15.mjs [--table FILE] [--source FILE] [--sums FILE]
// (the overrides exist for tools/unicode/check-ucd15.test.mjs; CI runs it without arguments).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATOR = 'tools/unicode/generate_ucd15_table.py';
const VENDORED = 'tools/unicode/ucd-15.0.0';
const FILE = 'DerivedGeneralCategory.txt';

const { values } = parseArgs({
  options: {
    table: { type: 'string' },
    source: { type: 'string' },
    sums: { type: 'string' },
  },
});
const source = values.source ?? join(root, VENDORED, FILE);
const sums = values.sums ?? join(root, VENDORED, 'SHA256SUMS');

const problems = [];
const pinned = /^SOURCE_SHA256 = "([0-9a-f]{64})"$/m.exec(
  readFileSync(join(root, GENERATOR), 'utf8'),
)?.[1];
if (pinned === undefined) problems.push(`${GENERATOR}: no pinned SOURCE_SHA256`);

const recorded = /^([0-9a-f]{64}) {2}DerivedGeneralCategory\.txt\n$/.exec(
  readFileSync(sums, 'utf8'),
);
if (recorded === null) problems.push(`${VENDORED}/SHA256SUMS: not one line "<sha256>  ${FILE}"`);
else if (recorded[1] !== pinned)
  problems.push(`${VENDORED}/SHA256SUMS: ${recorded[1]} is not the generator's pinned ${pinned}`);

const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
if (actual !== pinned) problems.push(`${FILE}: SHA-256 ${actual}, pinned ${pinned}`);

const args = ['-I', GENERATOR, '--check'];
if (values.table !== undefined) args.push('--table', values.table);
if (values.source !== undefined) args.push('--source', values.source);
const run = spawnSync(process.env.UCD_PYTHON || 'python3', args, { cwd: root, encoding: 'utf8' });
if (run.error) problems.push(`could not run ${GENERATOR}: ${run.error.message}`);
else if (run.status !== 0)
  problems.push(
    `packages/types/src/ucd15.ts: drift check failed (exit ${String(run.status)}): ` +
      `${run.stderr.trim()}; regenerate with python3 -I ${GENERATOR} --write`,
  );

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-ucd15: ${problem}`);
  process.exit(1);
}
