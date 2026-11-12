// WP-D10 (Decision 5, Fable H3): a release build must carry the owner's real offline root public key.
// The repository holds a placeholder in src/main/updater/root-key.json until the key ceremony
// (docs/runbooks/desktop-update-keys.md). Packaging refuses the placeholder, both in the source file
// and anywhere in the built app.asar. The only exception is an owner build on his own machine
// (AGENTLINK_DESKTOP_OWNER_LOCAL_BUILD=1), which is refused whenever CI or GITHUB_ACTIONS is set.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT_KEY_PLACEHOLDER_MARK = 'PLACEHOLDER-AGENTLINK-DESKTOP-ROOT-KEY';
export const OWNER_LOCAL_VAR = 'AGENTLINK_DESKTOP_OWNER_LOCAL_BUILD';
const HEX32 = /^[0-9a-f]{64}$/;

export const rootKeyJsonPath = (desktopDir) =>
  join(desktopDir, 'src', 'main', 'updater', 'root-key.json');

/** Problems with the pinned root in root-key.json (text); [] when a real key is pinned. */
export function rootKeyProblems(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return ['root-key.json is not JSON'];
  }
  const problems = [];
  if (typeof value?.rootPublicKey !== 'string' || !HEX32.test(value.rootPublicKey)) {
    problems.push(
      'root-key.json has no real root public key (still the placeholder?): run the offline key ceremony first',
    );
  }
  const floor = value?.minimumStatementSequence;
  if (!Number.isSafeInteger(floor) || floor < 0) {
    problems.push('root-key.json minimumStatementSequence must be a whole number >= 0');
  }
  return problems;
}

/** files: [{path, content}]. The paths whose content still carries the placeholder. */
export function findRootKeyPlaceholder(files) {
  const needle = Buffer.from(ROOT_KEY_PLACEHOLDER_MARK);
  return files.filter((f) => Buffer.from(f.content).includes(needle)).map((f) => f.path);
}

const ownerLocal = (env) =>
  env[OWNER_LOCAL_VAR] === '1' && (env.CI ?? '') === '' && (env.GITHUB_ACTIONS ?? '') === '';

/**
 * Throws unless a real root key is pinned and none of `files` (the ASAR contents) holds the
 * placeholder. Returns 'pinned', or 'owner-local' for the owner's own unpinned build.
 */
export function assertRootKeyPinned({ rootKeyJson, files, env = process.env }) {
  const problems = [...rootKeyProblems(rootKeyJson)];
  const hits = findRootKeyPlaceholder(files);
  if (hits.length)
    problems.push(`the root key placeholder is in the release ASAR: ${hits.join(', ')}`);
  if (problems.length === 0) return 'pinned';
  if (ownerLocal(env)) return 'owner-local';
  throw new Error(`release build refused: ${problems.join('; ')}`);
}

export const readRootKeyJson = (desktopDir) => readFileSync(rootKeyJsonPath(desktopDir), 'utf8');
