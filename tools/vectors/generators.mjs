// Provenance rule (IR-M0-9-1 F02, M0-9 "vectors are produced by an independent generator"): every
// committed vector file names its generator, and CI re-runs that generator in `--check FILE` mode,
// which writes nothing and fails unless the committed file equals the generator's output. Pure
// function, tested in generators.test.mjs; tools/vectors/check-generators.mjs runs it.

/** Generators are repository scripts under tools/vectors/, outside the TypeScript code under test. */
const SCRIPT = /^tools\/vectors\/[A-Za-z0-9_-]+\.py$/;

/**
 * @param {string} vectorsPath Repository-relative path of the vectors.json file.
 * @param {unknown} file Its parsed content.
 * @param {(path: string) => boolean} exists
 * @param {string} [python] The interpreter: `python3`, or the virtual environment that holds the
 *   pinned generator dependencies (tools/vectors/requirements.txt, `VECTORS_PYTHON` in CI).
 * @returns {{ problems: string[], argv: string[] | null }} The command to run, or the reasons not to.
 */
export function generatorCheck(vectorsPath, file, exists, python = 'python3') {
  const script = /** @type {{ generator?: { script?: unknown } } | null} */ (file)?.generator
    ?.script;
  if (typeof script !== 'string' || script === '') {
    return { problems: [`${vectorsPath}: generator.script is missing`], argv: null };
  }
  if (!SCRIPT.test(script)) {
    return {
      problems: [
        `${vectorsPath}: generator.script must be a Python script directly under tools/vectors/`,
      ],
      argv: null,
    };
  }
  if (!exists(script)) {
    return { problems: [`${vectorsPath}: generator.script does not exist`], argv: null };
  }
  // -I: isolated mode, so nothing from the working directory or the environment is imported.
  return { problems: [], argv: [python, '-I', script, '--check', vectorsPath] };
}

/**
 * The exit status of a generator's `--check` when it compared and found a difference
 * (tools/vectors/vectorlib.py `MISMATCH`). Distinct from 1 (any other `sys.exit` message: a
 * missing or unpinned package, a published-vector cross-check) and 2 (argparse).
 */
export const MISMATCH_EXIT = 3;

/**
 * What one `--check` run says (M1-1h-d): nothing when it matched, a mismatch only for
 * MISMATCH_EXIT, and a failure to compare for anything else, so a broken environment never reads
 * as drifted vectors. Every non-null result fails the check.
 * @param {string} vectorsPath
 * @param {{ status: number | null, signal: string | null, error?: Error }} run spawnSync's result.
 * @returns {string | null}
 */
export function describeGeneratorRun(vectorsPath, run) {
  if (run.error) return `${vectorsPath}: could not run the generator: ${run.error.message}`;
  if (run.status === 0) return null;
  if (run.status === MISMATCH_EXIT) return `${vectorsPath}: does not match its generator's output`;
  if (run.signal)
    return `${vectorsPath}: the generator was stopped by ${run.signal} before comparing`;
  return (
    `${vectorsPath}: the generator failed (exit ${String(run.status)}) before comparing; its message ` +
    'is above (VECTORS_PYTHON must be a virtual environment with the pinned packages, test-vectors/README.md)'
  );
}

const README = 'test-vectors/README.md';
const STATUSES = ['committed', 'pending', 'planned'];

/**
 * The Suites table of test-vectors/README.md agrees with the vector files and the pending list
 * (M1-1h-d, IR-M1-2a-1 F01): one row per suite; a suite with a vectors.json is `committed` or, when
 * pending-suites.json lists it, `pending`; a suite without one is `planned`.
 * @param {string} readme The README text.
 * @param {string[]} pending The suites of pending-suites.json.
 * @param {string[]} committed The suites that have a vectors.json.
 * @returns {string[]} The problems, empty when the table agrees.
 */
export function suitesTableProblems(readme, pending, committed) {
  const lines = readme.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Suites');
  if (start === -1) return [`${README}: no Suites table`];
  /** @type {Map<string, string>} */
  const rows = new Map();
  const problems = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const match = /^\| `([a-z0-9-]+)` \| ([^|]*) \|/.exec(line);
    if (match === null) continue;
    const [, suite, cell] = match;
    if (rows.has(suite)) {
      problems.push(`${README}: suite ${suite} has more than one row`);
      continue;
    }
    rows.set(suite, cell.trim());
  }
  if (rows.size === 0) return [`${README}: no Suites table`];
  for (const [suite, cell] of rows) {
    const status = STATUSES.find((word) => cell === word || cell.startsWith(`${word} `));
    const hasVectors = committed.includes(suite);
    const isPending = pending.includes(suite);
    if (status === undefined) {
      problems.push(
        `${README}: suite ${suite} has an unknown status "${cell}" (committed, pending or planned)`,
      );
    } else if (status === 'planned') {
      if (hasVectors) {
        problems.push(`${README}: suite ${suite} has vectors.json but is planned in the table`);
      }
    } else if (!hasVectors) {
      problems.push(`${README}: suite ${suite} is ${status} in the table but has no vectors.json`);
    } else if (status === 'pending' && !isPending) {
      problems.push(
        `${README}: suite ${suite} is pending in the table but not in pending-suites.json`,
      );
    } else if (status === 'committed' && isPending) {
      problems.push(
        `${README}: suite ${suite} is in pending-suites.json but committed in the table`,
      );
    }
  }
  for (const suite of committed) {
    if (!rows.has(suite)) {
      problems.push(`${README}: suite ${suite} has vectors but no row in the Suites table`);
    }
  }
  return problems;
}
