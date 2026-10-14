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
 * @returns {{ problems: string[], argv: string[] | null }} The command to run, or the reasons not to.
 */
export function generatorCheck(vectorsPath, file, exists) {
  // RED (expected): implemented in the next commit.
  void SCRIPT;
  void file;
  void exists;
  throw new Error(`generatorCheck: not implemented yet (${vectorsPath})`);
}
