// CI provenance check (IR-M0-9-1 F02): re-runs the independent generator of every committed
// test-vectors/<suite>/vectors.json in `--check FILE` mode. Writes nothing. Needs python3.
// Usage (from anywhere): node tools/vectors/check-generators.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatorCheck } from './generators.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vectorsDir = join(root, 'test-vectors');

const files = readdirSync(vectorsDir, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && existsSync(join(vectorsDir, entry.name, 'vectors.json')),
  )
  .map((entry) => `test-vectors/${entry.name}/vectors.json`);

const problems = files.length === 0 ? ['no vector files found under test-vectors/'] : [];
for (const path of files) {
  let file;
  try {
    file = JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch {
    problems.push(`${path}: not valid JSON`);
    continue;
  }
  const check = generatorCheck(path, file, (script) => existsSync(join(root, script)));
  problems.push(...check.problems);
  if (check.argv === null) continue;
  const [command, ...args] = check.argv;
  const run = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (run.error) problems.push(`${path}: could not run the generator: ${run.error.message}`);
  else if (run.status !== 0) problems.push(`${path}: does not match its generator's output`);
}

if (problems.length > 0) {
  console.error('\nvector provenance check FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `\nvector provenance check passed: ${String(files.length)} file(s) match their generators.`,
);
