// `pnpm vectors:check` (M0-9): runs the vector harness in Node, Chromium, Firefox, WebKit and
// workerd, then enforces what an exit code alone cannot show:
//   1. every required runtime reported its own identity and passed every committed case;
//   2. the run created, changed or deleted nothing under test-vectors/.
// Extra command-line arguments are not forwarded on purpose: a filtered run is not a vectors check.
// The root script calls this file directly, not through a package script and turbo, so no package
// manifest can turn the check into a no-op (IR-M0-9-1 F01).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCoverage, diffSnapshots, pendingSuites, REQUIRED_RUNTIMES } from './rules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vectorsDir = join(root, 'test-vectors');

/** relative path -> SHA-256 of every file under test-vectors/, node_modules excluded. */
function snapshot(dir) {
  const hashes = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        hashes.set(
          relative(dir, path),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        );
    }
  };
  walk(dir);
  return hashes;
}

/** The committed suites: every test-vectors/<dir>/vectors.json. */
function readSuites(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'vectors.json')))
    .map((entry) => {
      const file = JSON.parse(readFileSync(join(dir, entry.name, 'vectors.json'), 'utf8'));
      // A missing or non-array `cases` yields caseIds = null, which checkCoverage rejects.
      return {
        suite: entry.name,
        caseIds: Array.isArray(file.cases) ? file.cases.map((c) => c?.id) : null,
      };
    });
}

const before = snapshot(vectorsDir);
const suites = readSuites(vectorsDir);

const vitestPackage = createRequire(import.meta.url).resolve('vitest/package.json');
const vitestBin = join(dirname(vitestPackage), 'vitest.mjs');
const outDir = mkdtempSync(join(tmpdir(), 'agentlink-vectors-'));
const reportPath = join(outDir, 'report.json');

const run = spawnSync(
  process.execPath,
  [
    vitestBin,
    'run',
    '--config',
    'vitest.config.ts',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
  ],
  { cwd: vectorsDir, stdio: 'inherit' },
);

const problems = [];
if (run.error) problems.push(`could not start Vitest: ${run.error.message}`);
else if (run.status !== 0) problems.push(`Vitest exited with ${String(run.status ?? run.signal)}`);

let report;
if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, 'utf8'));
rmSync(outDir, { recursive: true, force: true });

problems.push(...checkCoverage(report, suites));
problems.push(...diffSnapshots(before, snapshot(vectorsDir)));

const identities = new Map();
for (const file of report?.testResults ?? []) {
  for (const assertion of file.assertionResults ?? []) {
    const meta = assertion.meta?.vectors;
    if (meta?.kind === 'identity')
      identities.set(meta.runtime, `${assertion.status}: ${meta.detail}`);
  }
}
console.log('\nvectors:check runtime identities');
for (const runtime of REQUIRED_RUNTIMES) {
  console.log(`  ${runtime.padEnd(9)} ${identities.get(runtime) ?? 'MISSING'}`);
}
const total = suites.reduce((n, s) => n + (s.caseIds?.length ?? 0), 0);
console.log(`  ${String(suites.length)} suite(s), ${String(total)} case(s) per runtime`);

// Suites whose vectors are committed before their code (M1-1h). Reported, never counted as passed.
const pending = pendingSuites(report);
if (pending.size > 0) {
  console.log('\nvectors:check pending suites (vectors committed, code not yet implemented)');
  for (const [suite, card] of pending) {
    const count = suites.find((s) => s.suite === suite)?.caseIds?.length ?? 0;
    console.log(`  ${suite.padEnd(16)} ${String(count)} case(s), not run: ${card}`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(
        `::notice title=vectors pending::${suite} (${String(count)} cases) waits for ${card}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('\nvectors:check FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  pending.size > 0
    ? `\nvectors:check passed in every runtime (${String(pending.size)} suite(s) pending); test-vectors/ unchanged.`
    : '\nvectors:check passed in every runtime; test-vectors/ unchanged.',
);
