// UPD-4: the small files between the update watchdog (swap-mac.ts) and the new copy, in the app's own
// data folder.
// - `update-pending.json` ({version, nonce}): written by the watchdog after the swap, before it
//   launches the new copy. The nonce is new for every swap (IR-UPD-4-1 #4).
// - `update-starting.json` ({version, pid}): written by the shell first thing at start, before the
//   single-instance lock (IR-UPD-4-1 #2). The watchdog uses the pid only after `ps` shows that it
//   runs the new bundle's executable (#3).
// - `update-health.json` ({version, pid, nonce}): written once the core says `ready`, only while an
//   update of this version is pending, echoing its nonce. A leftover file never matches a new nonce.
// All hold public data only (a version, a process id, a non-secret nonce), mode 0600, written
// atomically. Residual (04 §2.5): a same-user process can write them; it could equally replace the
// whole app.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeUtf8 } from '@4thtech-io/crypto';
import { parseVersion } from './manifest.js';

export const HEALTH_FILE = 'update-health.json';
export const STARTING_FILE = 'update-starting.json';
export const PENDING_FILE = 'update-pending.json';
const NONCE = /^[0-9a-z-]{8,64}$/;
const MAX_BYTES = 256;

export interface HealthRecord {
  readonly version: string;
  readonly pid: number;
  readonly nonce: string;
}

const validVersion = (v: unknown): v is string => {
  try {
    parseVersion(v);
    return true;
  } catch {
    return false;
  }
};

const validPid = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 1 && v < 2 ** 31;

async function write(
  dir: string,
  name: string,
  record: { version: string; pid: number; nonce?: string },
): Promise<void> {
  if (!validVersion(record.version) || !validPid(record.pid))
    throw new Error('update health: bad record');
  if (record.nonce !== undefined && !NONCE.test(record.nonce))
    throw new Error('update health: bad record');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${name}.tmp`);
  await writeFile(tmp, encodeUtf8(JSON.stringify(record)), { mode: 0o600 });
  await rename(tmp, join(dir, name));
}

/** The shell has started (before the core). */
export function writeStarting(dir: string, version: string, pid: number): Promise<void> {
  return write(dir, STARTING_FILE, { version, pid });
}

/**
 * The core said `ready`: when an update of exactly this version is pending, answer its nonce in the
 * health file. Otherwise nothing is written (a normal start needs no health record).
 */
export async function writeHealthIfPending(
  dir: string,
  version: string,
  pid: number,
): Promise<void> {
  const pending = await readStrict(dir, PENDING_FILE, ['nonce', 'version']);
  if (pending === null || pending['version'] !== version) return;
  const nonce = pending['nonce'];
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return;
  await write(dir, HEALTH_FILE, { version, pid, nonce });
}

/** The health record, read strictly (exactly `nonce`, `pid`, `version`), or null. */
export async function readHealth(dir: string): Promise<HealthRecord | null> {
  const value = await readStrict(dir, HEALTH_FILE, ['nonce', 'pid', 'version']);
  if (value === null) return null;
  const { version, pid, nonce } = value;
  return validVersion(version) && validPid(pid) && typeof nonce === 'string' && NONCE.test(nonce)
    ? { version, pid, nonce }
    : null;
}

/** A small JSON object with exactly `keys` (sorted), or null. */
async function readStrict(
  dir: string,
  name: string,
  keys: readonly string[],
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    const bytes = await readFile(join(dir, name));
    if (bytes.length > MAX_BYTES) return null;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join(',') !== keys.join(',')) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
