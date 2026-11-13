// UPD-4: the two small files the update watchdog (swap-mac.ts) waits on, in the app's own data folder.
// - `update-starting.json`: written by the shell as soon as it starts ({version, pid}); the watchdog
//   uses the pid to stop a new copy that never got healthy before it puts the old one back.
// - `update-health.json`: written once the core says `ready` ({version, pid}); the watchdog treats
//   the update as good only when this file names the version it installed.
// Both hold public data only (a version and a process id), mode 0600, written atomically. Residual
// (04 §2.5): a same-user process can write them; it could equally replace the whole app.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeUtf8 } from '@4thtech-io/crypto';
import { parseVersion } from './manifest.js';

export const HEALTH_FILE = 'update-health.json';
export const STARTING_FILE = 'update-starting.json';
const MAX_BYTES = 256;

export interface HealthRecord {
  readonly version: string;
  readonly pid: number;
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

async function write(dir: string, name: string, version: string, pid: number): Promise<void> {
  if (!validVersion(version) || !validPid(pid)) throw new Error('update health: bad record');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `${name}.tmp`);
  await writeFile(tmp, encodeUtf8(JSON.stringify({ version, pid })), { mode: 0o600 });
  await rename(tmp, join(dir, name));
}

/** The shell has started (before the core). */
export function writeStarting(dir: string, version: string, pid: number): Promise<void> {
  return write(dir, STARTING_FILE, version, pid);
}

/** The core said `ready`: this version is healthy. */
export function writeHealth(dir: string, version: string, pid: number): Promise<void> {
  return write(dir, HEALTH_FILE, version, pid);
}

/** The health record, read strictly (exactly `version` and `pid`), or null. */
export async function readHealth(dir: string): Promise<HealthRecord | null> {
  let text: string;
  try {
    const bytes = await readFile(join(dir, HEALTH_FILE));
    if (bytes.length > MAX_BYTES) return null;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort();
    if (keys.length !== 2 || keys[0] !== 'pid' || keys[1] !== 'version') return null;
    const { version, pid } = value as Record<string, unknown>;
    return validVersion(version) && validPid(pid) ? { version, pid } : null;
  } catch {
    return null;
  }
}
