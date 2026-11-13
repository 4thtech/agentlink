// WP-D10 (Decision 5, Fable H3): a release build must carry the owner's real offline root public key.
// The repository holds a placeholder in src/main/updater/root-key.json until the key ceremony
// (docs/runbooks/desktop-update-keys.md). Packaging refuses the placeholder, both in the source file
// and anywhere in the built app.asar. The only exception is an owner build on his own machine
// (AGENTLINK_DESKTOP_OWNER_LOCAL_BUILD=1), which is refused whenever CI or GITHUB_ACTIONS is set.
//
// DESK051-C4: a release built with updates OFF (`--updates off`, bundled with
// AGENTLINK_DESKTOP_UPDATES=off) carries src/main/updater/root-key.updates-off.json instead: no key,
// so the app's updater is not configured and never fetches. Allowed in CI, because nothing in it can
// be updated; it must carry the updates-off mark and no placeholder. Switch to `--updates on` after
// the key ceremony (then the real key is required, as before).
//
// UPD-3 (Fable L3, D-151): an updates-on build must also carry EXACTLY the key of root-key.json in its
// ASAR (the bundled main process holds it as text), and the build records the pin it shipped in
// inputs-<target>.json (`updatePinRecord`), so the release checks it once more against root-key.json
// and against the signing key before anything is signed (tools/release/desktop-update-manifest.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeHex, isBip340PublicKey } from '@4thtech-io/crypto';

export const ROOT_KEY_PLACEHOLDER_MARK = 'PLACEHOLDER-AGENTLINK-DESKTOP-ROOT-KEY';
export const OWNER_LOCAL_VAR = 'AGENTLINK_DESKTOP_OWNER_LOCAL_BUILD';
export const UPDATES_OFF_MARK = 'AGENTLINK-DESKTOP-UPDATES-OFF';
const HEX32 = /^[0-9a-f]{64}$/;
/** The same limits as the app's pinnedRoot (src/main/updater/manifest.ts). */
const MAX_SEQUENCE = 2 ** 31 - 1;

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
  const key = value?.rootPublicKey;
  if (typeof key !== 'string' || !HEX32.test(key) || !isBip340PublicKey(decodeHex(key))) {
    problems.push(
      'root-key.json has no valid root public key (still the placeholder?): run the offline key ceremony first',
    );
  }
  const floor = value?.minimumStatementSequence;
  if (!Number.isSafeInteger(floor) || floor < 0 || floor > MAX_SEQUENCE) {
    problems.push('root-key.json minimumStatementSequence must be a whole number from 0 to 2^31-1');
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
 * placeholder. Returns 'pinned', or 'owner-local' for the owner's own unpinned build. With
 * updates 'off': returns 'updates-off' when the ASAR has the updates-off mark and no placeholder.
 */
export function assertRootKeyPinned({ rootKeyJson, files, env = process.env, updates = 'on' }) {
  if (updates !== 'on' && updates !== 'off') throw new Error('updates must be on or off');
  const hits = findRootKeyPlaceholder(files);
  const placeholder = hits.length
    ? [`the root key placeholder is in the release ASAR: ${hits.join(', ')}`]
    : [];
  if (updates === 'off') {
    const mark = Buffer.from(UPDATES_OFF_MARK);
    const problems = [...placeholder];
    if (!files.some((f) => Buffer.from(f.content).includes(mark))) {
      problems.push('the ASAR has no updates-off root: bundle with AGENTLINK_DESKTOP_UPDATES=off');
    }
    if (problems.length === 0) return 'updates-off';
    throw new Error(`release build refused: ${problems.join('; ')}`);
  }
  const problems = [...rootKeyProblems(rootKeyJson), ...placeholder];
  if (problems.length === 0) {
    const pin = Buffer.from(JSON.parse(rootKeyJson).rootPublicKey);
    if (files.some((f) => Buffer.from(f.content).includes(pin))) return 'pinned';
    problems.push('the release ASAR does not carry the pinned update key of root-key.json');
  }
  if (ownerLocal(env)) return 'owner-local';
  throw new Error(`release build refused: ${problems.join('; ')}`);
}

export const readRootKeyJson = (desktopDir) => readFileSync(rootKeyJsonPath(desktopDir), 'utf8');

/**
 * What inputs-<target>.json records about updates: `{updates: 'on'|'off', updatePin}`. `updatePin` is
 * the pinned key only for a 'pinned' build; an owner-local build records `on` with no pin, which the
 * release refuses.
 */
export function updatePinRecord({ mode, rootKeyJson }) {
  if (mode === 'updates-off') return { updates: 'off', updatePin: null };
  if (mode === 'pinned') return { updates: 'on', updatePin: JSON.parse(rootKeyJson).rootPublicKey };
  return { updates: 'on', updatePin: null };
}
