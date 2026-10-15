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
  if (run.signal) return `${vectorsPath}: the generator was stopped by ${run.signal} before comparing`;
  return (
    `${vectorsPath}: the generator failed (exit ${String(run.status)}) before comparing; its message ` +
    'is above (VECTORS_PYTHON must be a virtual environment with the pinned packages, test-vectors/README.md)'
  );
}
