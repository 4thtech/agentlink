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
