// Reading and writing a harness config file safely (04 §4 realpath and symlink rules, 06 §7).
//
// - The path is `<home>/<parts…>` built by AgentLink from a fixed table, never from input.
// - Every folder below the home folder must be a real directory (never a link) owned by this user and
//   not writable by group or others; its realpath must be exactly where it is expected (home itself
//   may be a link: both sides are resolved). The file must be a regular file with one name (never a
//   link, FIFO or folder), owned by this user, and at most MAX_CONFIG_BYTES.
// - A write happens only to the file that was shown: it is read again right before, and must be the
//   same bytes. The new content goes to a fresh temporary file in the same folder (O_EXCL, no links
//   followed), a backup of the old file is made first (never replacing an older backup), and the
//   temporary file is renamed over the config, so a failure leaves the original untouched. A file that
//   did not exist is created without ever replacing one that appears meanwhile.
//
// Same-user processes can change all of this (G-1, D-67): these checks keep mistakes and other users
// out; they are not a boundary against the agent. Windows has no POSIX modes, so the mode and owner
// checks do not apply there (link, type and containment checks do).
import { constants, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { encodeHex, randomBytes } from '@agentlink/crypto';
import { HarnessError } from './errors.js';

/** `~/.claude.json` can hold a long project history; anything above this is refused unread. */
export const MAX_CONFIG_BYTES = 8 * 1024 * 1024;

const POSIX = process.platform !== 'win32';

export interface FileOptions {
  /** Who must own the folders and the file. Default: this process's user (POSIX). Tests pass another. */
  readonly uid?: number;
}

/** A config file as it was read: its exact bytes, or `undefined` when it does not exist. */
export interface ConfigFile {
  readonly bytes: Buffer | undefined;
  readonly text: string | undefined;
  /** The mode of the existing file. */
  readonly mode: number | undefined;
}

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
const isMissing = (error: unknown): boolean => {
  const code = codeOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};
const unsafe = (): HarnessError => new HarnessError('unsafe_path');

function expectedUid(options: FileOptions): number | undefined {
  return (
    options.uid ?? (POSIX && typeof process.getuid === 'function' ? process.getuid() : undefined)
  );
}

async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw unsafe();
  }
}

interface Resolved {
  /** The real folder that holds (or will hold) the file. */
  readonly dir: string;
  /** The folders that do not exist yet, outermost first (absolute, under the real home). */
  readonly missing: string[];
}

/** Walks the folders below home; every one that exists must pass the checks. */
async function resolveDir(
  home: string,
  dirs: readonly string[],
  uid: number | undefined,
): Promise<Resolved> {
  let homeReal: string;
  try {
    homeReal = await realpath(home);
  } catch {
    throw unsafe();
  }
  let current = homeReal;
  const missing: string[] = [];
  for (const part of dirs) {
    current = join(current, part);
    if (missing.length > 0) {
      missing.push(current);
      continue;
    }
    const info = await lstatOrMissing(current);
    if (info === undefined) {
      missing.push(current);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe();
    if (POSIX && ((info.mode & 0o022) !== 0 || (uid !== undefined && info.uid !== uid))) {
      throw unsafe();
    }
    let real: string;
    try {
      real = await realpath(current);
    } catch {
      throw unsafe();
    }
    if (real !== current) throw unsafe();
  }
  return { dir: current, missing };
}

function checkFile(info: Stats, uid: number | undefined): void {
  // nlink 1: a rename over the file would break another name for it.
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw unsafe();
  if (POSIX && uid !== undefined && info.uid !== uid) throw unsafe();
  if (info.size > MAX_CONFIG_BYTES) throw new HarnessError('malformed');
}

/** Reads `<home>/<parts…>`; a missing file (or folder) reads as `bytes: undefined`. */
export async function readConfigFile(
  home: string,
  parts: readonly string[],
  options: FileOptions = {},
): Promise<ConfigFile> {
  const name = parts[parts.length - 1];
  if (name === undefined) throw unsafe();
  const uid = expectedUid(options);
  const { dir, missing } = await resolveDir(home, parts.slice(0, -1), uid);
  if (missing.length > 0) return { bytes: undefined, text: undefined, mode: undefined };
  const path = join(dir, name);

  const before = await lstatOrMissing(path);
  if (before === undefined) return { bytes: undefined, text: undefined, mode: undefined };
  checkFile(before, uid);

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isMissing(error)) return { bytes: undefined, text: undefined, mode: undefined };
    throw unsafe();
  }
  try {
    const info = await handle.stat();
    // The file opened is the one checked (not swapped in between).
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) throw unsafe();
    const bytes = await handle.readFile();
    if (bytes.length > MAX_CONFIG_BYTES) throw new HarnessError('malformed');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HarnessError('malformed');
    }
    return { bytes, text, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

export interface WriteOptions extends FileOptions {
  /** Unix seconds, for the backup's name. */
  readonly now: number;
}

async function ensureDirs(missing: readonly string[], uid: number | undefined): Promise<void> {
  for (const path of missing) {
    try {
      await mkdir(path, { mode: 0o700 });
      if (POSIX) await chmod(path, 0o700);
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw new HarnessError('write_failed');
    }
    const info = await lstatOrMissing(path);
    if (info === undefined || info.isSymbolicLink() || !info.isDirectory()) throw unsafe();
    if (POSIX && ((info.mode & 0o022) !== 0 || (uid !== undefined && info.uid !== uid))) {
      throw unsafe();
    }
  }
}

async function writeNew(path: string, bytes: Buffer | string, mode: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    if (POSIX) await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes `text` as the new content of `<home>/<parts…>`, which was read as `before`. Returns the
 * backup's file name (inside the same folder) when there was an old file. Throws `changed` when the
 * file is no longer what was shown.
 */
export async function writeConfigFile(
  home: string,
  parts: readonly string[],
  before: ConfigFile,
  text: string,
  options: WriteOptions,
): Promise<{ backup: string | undefined }> {
  const name = parts[parts.length - 1];
  if (name === undefined) throw unsafe();
  const uid = expectedUid(options);
  const { dir, missing } = await resolveDir(home, parts.slice(0, -1), uid);

  // The file must still be the one that was shown.
  const now = await readConfigFile(home, parts, options);
  const unchanged =
    before.bytes === undefined || now.bytes === undefined
      ? before.bytes === now.bytes
      : before.bytes.equals(now.bytes);
  if (!unchanged) throw new HarnessError('changed');
  await ensureDirs(missing, uid);

  const target = join(dir, name);
  const temp = join(dir, `.${name}.agentlink-${encodeHex(randomBytes(8))}.tmp`);
  const mode = before.mode ?? 0o600;
  let backup: string | undefined;
  try {
    try {
      await writeNew(temp, text, mode);
    } catch {
      throw new HarnessError('write_failed');
    }
    if (before.bytes === undefined) {
      // Never replaces a file that appeared in the meantime.
      try {
        await link(temp, target);
      } catch (error) {
        throw new HarnessError(codeOf(error) === 'EEXIST' ? 'changed' : 'write_failed');
      }
      return { backup };
    }
    for (let attempt = 0; attempt < 10 && backup === undefined; attempt += 1) {
      const candidate = `${name}.agentlink-backup-${options.now}${attempt === 0 ? '' : `-${attempt}`}`;
      try {
        await writeNew(join(dir, candidate), before.bytes, 0o600);
        backup = candidate;
      } catch (error) {
        if (codeOf(error) !== 'EEXIST') throw new HarnessError('write_failed');
      }
    }
    if (backup === undefined) throw new HarnessError('write_failed');
    try {
      await rename(temp, target);
    } catch {
      throw new HarnessError('write_failed');
    }
    return { backup };
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
