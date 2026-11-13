// UPD-1: the updater's persisted state, in the app's own data folder. Since the owner decision of
// 2026-11-13 (one pinned update key, no root statements) there is no key state to keep: the only
// record is `failedVersion`, the version that failed to start after an update, which is never offered
// again (manifest.ts `failed_version`). The in-app installer (UPD-4) writes it on a rollback.
//
// The file holds only a version string (public data). It is read strictly: anything else (missing,
// damaged, oversize, extra fields, not a version) reads as "none". Residual (04 §2.5): a same-user
// process can delete it, so a failed version could be offered once more; the rollback catches it
// again.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeUtf8, parseReceivedJson } from '@4thtech-io/crypto';
import { parseVersion } from './manifest.js';

export const FAILED_FILE = 'update-failed.json';
const MAX_STATE_BYTES = 1024;

const isVersion = (v: unknown): v is string => {
  try {
    parseVersion(v);
    return true;
  } catch {
    return false;
  }
};

/** The version recorded as failed, or null. */
export async function loadFailedVersion(dir: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, FAILED_FILE));
  } catch {
    return null;
  }
  if (bytes.length > MAX_STATE_BYTES) return null;
  try {
    const value = parseReceivedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    const version = (value as Record<string, unknown>)['failedVersion'];
    return keys.length === 1 && keys[0] === 'failedVersion' && isVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/** Records `version` as failed, atomically (temp file + rename), mode 0600 in a 0700 folder. */
export async function saveFailedVersion(dir: string, version: string): Promise<void> {
  if (!isVersion(version)) throw new Error('update state: not a version');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${FAILED_FILE}.tmp`);
  await writeFile(tmp, encodeUtf8(JSON.stringify({ failedVersion: version }) + '\n'), {
    mode: 0o600,
  });
  await rename(tmp, join(dir, FAILED_FILE));
}
