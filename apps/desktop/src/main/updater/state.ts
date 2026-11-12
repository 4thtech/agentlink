// WP-D10: the accepted root statement, kept in the app's own data folder so a rotation sticks (the
// app accepts an update key only with a root statement newer than the one it has, Decision 5).
//
// The file holds only the signed statement (public data). On load it is parsed with the manifest
// rules and re-verified under the pinned root; anything else (missing, damaged, foreign, below the
// pinned floor) falls back to the initial state, which still trusts nothing but the root. Residual
// (04 §2.5): a same-user process can delete the file and so roll the state back to "nothing
// accepted"; the pinned `minimumStatementSequence` in root-key.json is the floor a later build
// raises after a revocation.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeUtf8, parseReceivedJson } from '@4thtech-io/crypto';
import {
  INITIAL_KEY_STATE,
  applyStatement,
  parseStatementValue,
  type KeyState,
  type PinnedRoot,
} from './manifest.js';

export const STATE_FILE = 'update-keys.json';
const MAX_STATE_BYTES = 4096;

export async function loadKeyState(dir: string, root: PinnedRoot, now: number): Promise<KeyState> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, STATE_FILE));
  } catch {
    return INITIAL_KEY_STATE;
  }
  if (bytes.length > MAX_STATE_BYTES) return INITIAL_KEY_STATE;
  try {
    const value = parseReceivedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return applyStatement(INITIAL_KEY_STATE, parseStatementValue(value), root, now);
  } catch {
    return INITIAL_KEY_STATE; // damaged, foreign, below the floor or not signed by the root
  }
}

/** Writes the statement atomically (temp file + rename), mode 0600 in a 0700 folder. */
export async function saveKeyState(dir: string, state: KeyState): Promise<void> {
  if (state.statement === null) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${STATE_FILE}.tmp`);
  await writeFile(tmp, encodeUtf8(JSON.stringify(state.statement) + '\n'), { mode: 0o600 });
  await rename(tmp, join(dir, STATE_FILE));
}
