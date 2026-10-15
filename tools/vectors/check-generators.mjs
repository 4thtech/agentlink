// CI provenance check (IR-M0-9-1 F02): re-runs the independent generator of every committed
// test-vectors/<suite>/vectors.json in `--check FILE` mode. Writes nothing to the repository.
// Needs python3. Usage (from anywhere): node tools/vectors/check-generators.mjs
// The generators need the pinned packages of tools/vectors/requirements.txt. Set VECTORS_PYTHON to
// the interpreter of a virtual environment that has them (test-vectors/README.md); default python3.
// A generator exits with MISMATCH_EXIT only when it compared and found a difference; any other
// failure (wrong interpreter, missing or unpinned package) is reported as a failure to compare
// (M1-1h-d). Both fail the check.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MISMATCH_EXIT, describeGeneratorRun, generatorCheck } from './generators.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vectorsDir = join(root, 'test-vectors');

const files = readdirSync(vectorsDir, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join(vectorsDir, entry.name, 'vectors.json')),
  )
  .map((entry) => `test-vectors/${entry.name}/vectors.json`);

const python = process.env.VECTORS_PYTHON || 'python3';
const problems = files.length === 0 ? ['no vector files found under test-vectors/'] : [];
for (const path of files) {
  let file;
  try {
    file = JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch {
    problems.push(`${path}: not valid JSON`);
    continue;
  }
  const check = generatorCheck(path, file, (script) => existsSync(join(root, script)), python);
  problems.push(...check.problems);
  if (check.argv === null) continue;
  const [command, ...args] = check.argv;
  const run = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  const problem = describeGeneratorRun(path, run);
  if (problem !== null) problems.push(problem);
}

// Negative control: the check must be able to fail, and must say so in the right words. A copy of
// the tagged-hash file (CPython hashlib only, no pinned package) with one expected value changed,
// written outside the repository, must be reported as a mismatch naming that case.
const CONTROL = 'test-vectors/tagged-hash/vectors.json';
{
  const control = JSON.parse(readFileSync(join(root, CONTROL), 'utf8'));
  const changed = control.cases[0];
  const field = Object.keys(changed.expected)[0];
  const value = changed.expected[field];
  changed.expected[field] = value.slice(0, -1) + (value.endsWith('0') ? '1' : '0');
  const dir = mkdtempSync(join(tmpdir(), 'vectors-control-'));
  try {
    const copy = join(dir, 'vectors.json');
    writeFileSync(copy, `${JSON.stringify(control, null, 2)}\n`);
    const check = generatorCheck(CONTROL, control, (script) => existsSync(join(root, script)), python);
    if (check.argv === null) {
      problems.push(`negative control: ${check.problems.join('; ')}`);
    } else {
      const [command, ...args] = check.argv;
      const run = spawnSync(command, [...args.slice(0, -1), copy], { cwd: root, encoding: 'utf8' });
      const stderr = typeof run.stderr === 'string' ? run.stderr : '';
      if (run.status !== MISMATCH_EXIT || !stderr.includes(changed.id)) {
        problems.push(
          `negative control: a changed ${CONTROL} case was not reported as a mismatch of case ` +
            `${changed.id} (status ${String(run.status)})`,
        );
      } else {
        console.log(`negative control: a changed ${changed.id} is reported as a mismatch`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (problems.length > 0) {
  console.error('\nvector provenance check FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `\nvector provenance check passed: ${String(files.length)} file(s) match their generators.`,
);
