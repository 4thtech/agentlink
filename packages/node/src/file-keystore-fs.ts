// M1-8f: file handling of the file KeyStore (04 §2.8 "File handling"): the `~/.agentlink/keystore/`
// directory (0700) and its `.alks` / `.alko` files (0600), the passphrase file of 07 §9.2, and the
// atomic write of the write protocol. Every check runs on the open descriptor (`fstat`), never on the
// path; files are opened with O_NOFOLLOW, and `realpath(file)` must sit directly inside
// `realpath(dir)`. Bytes only: no primitive is called here, and nothing read is logged or quoted in an
// error (I-7). Errors are fixed sentences.
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { NodeKeyStoreError } from './errors.js';
import { CLI_COMMAND } from './cli-command.js';

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_DIRECTORY } = constants;

/** The largest `ALKS` file: 107-byte header, 64 KiB plaintext, 16-byte tag (04 §2.8). */
export const MAX_KEYSTORE_FILE_BYTES = 107 + 65536 + 16;
/** 04 §2.8: a passphrase file is at most 1 KiB. */
export const MAX_PASSPHRASE_FILE_BYTES = 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const TEMP_SUFFIX = /^[0-9a-f]{16}$/;

/** Test seams only; production passes none. */
export interface KeystoreFsOptions {
  /** The owner every file and the directory must have. Default: the process user. */
  readonly uid?: number;
  /** Replaces the `fchmod` of a new file (to simulate a filesystem where modes do not stick). */
  readonly chmod?: (handle: FileHandle, mode: number) => Promise<void>;
  /** Replaces the mode bits `fstat` reports for a new file. */
  readonly mode?: (reported: number) => number;
  /** Runs after the temporary file is synced and before it is renamed (a simulated crash). */
  readonly beforeRename?: () => void | Promise<void>;
}

export const keystoreUnsafe = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_file_unsafe',
    `The agent's key file or its folder is not protected. It must be a regular file you own, not a link, with no access for other users (folder mode 0700, file mode 0600), on a disk that keeps file permissions. Fix it, then try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
  );

const passphraseFileUnsafe = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_file_unsafe',
    'The passphrase file named in AGENTLINK_KEYSTORE_PASSPHRASE_FILE cannot be used. It must be a regular file of at most 1 KiB that no other user can write. Fix it, then restart.',
  );

export const keystoreFailed = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keystore_failed',
    `The agent's key file could not be read or written. Check the disk and try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
  );

const errno = (error: unknown): unknown => (error as { code?: unknown }).code;

function assertPosix(): void {
  // 04 §2.8: the keystore needs a filesystem with POSIX modes; Windows has none (WSL is Linux).
  if (process.platform === 'win32') throw keystoreUnsafe();
}

function processUid(options: KeystoreFsOptions): number {
  return options.uid ?? (process.getuid?.() as number);
}

/** Every failure that is not already a fixed-sentence error becomes `keystore_failed`. */
async function fixed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof NodeKeyStoreError) throw error;
    throw keystoreFailed();
  }
}

/**
 * Opens `dir` with O_DIRECTORY | O_NOFOLLOW and checks the descriptor: a directory owned by the
 * process user with no group or other bits. Returns its realpath, or null when it does not exist.
 */
async function checkedDir(dir: string, options: KeystoreFsOptions): Promise<string | null> {
  assertPosix();
  let handle: FileHandle;
  try {
    handle = await open(dir, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (error) {
    if (errno(error) === 'ENOENT') return null;
    throw keystoreUnsafe();
  }
  try {
    const st = await handle.stat();
    if (!st.isDirectory() || st.uid !== processUid(options) || (st.mode & 0o077) !== 0) {
      throw keystoreUnsafe();
    }
  } finally {
    await handle.close();
  }
  return realpath(dir);
}

/**
 * Creates `dir` (and `~/.agentlink` above it) with mode 0700, set explicitly so the umask does not
 * matter, then checks it like every open does and that the mode stuck. An existing directory is
 * checked, never silently re-moded.
 */
export function ensureKeystoreDir(dir: string, options: KeystoreFsOptions = {}): Promise<string> {
  return fixed(async () => {
    assertPosix();
    const parent = dirname(dir);
    try {
      await mkdir(parent, { mode: DIR_MODE });
      await chmod(parent, DIR_MODE);
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
    }
    try {
      await mkdir(dir, { mode: DIR_MODE });
      await chmod(dir, DIR_MODE);
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error;
    }
    const real = await checkedDir(dir, options);
    if (real === null) throw keystoreFailed();
    return real;
  });
}

/** Reads all of `handle` (whose size `fstat` reported) into a fresh Uint8Array. */
async function readAll(handle: FileHandle, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  // A file that changed size under us is refused, not read short or long.
  const extra = new Uint8Array(1);
  if (offset !== size || (await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
    bytes.fill(0);
    throw keystoreFailed();
  }
  return bytes;
}

/**
 * 04 §2.8 "Checks on every open": reads `dir/name`, or returns null when the directory or the file
 * does not exist. Refuses (`keystore_file_unsafe`) a symlinked directory or file, a file that is not
 * regular, has another owner, any group or other bit, a second hard link or more than the size limit,
 * and a realpath outside `realpath(dir)`. The caller wipes the bytes.
 */
export function readKeystoreFile(
  dir: string,
  name: string,
  options: KeystoreFsOptions = {},
): Promise<Uint8Array | null> {
  return fixed(async () => {
    const realDir = await checkedDir(dir, options);
    if (realDir === null) return null;
    const path = join(realDir, name);
    let handle: FileHandle;
    try {
      handle = await open(path, O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw keystoreUnsafe();
    }
    try {
      const st = await handle.stat();
      if (
        !st.isFile() ||
        st.uid !== processUid(options) ||
        (st.mode & 0o077) !== 0 ||
        st.nlink !== 1 ||
        st.size > MAX_KEYSTORE_FILE_BYTES
      ) {
        throw keystoreUnsafe();
      }
      if (dirname(await realpath(path)) !== realDir) throw keystoreUnsafe();
      return await readAll(handle, st.size);
    } finally {
      await handle.close();
    }
  });
}

/** The prefix of `name`'s temporary files: `.<name>.tmp-` and 16 hex characters. */
const tempPrefix = (name: string): string => `.${name}.tmp-`;

/**
 * 04 §2.8 write step 5: writes `bytes` as `dir/name` through a temporary file in the same directory
 * (O_CREAT | O_EXCL | O_NOFOLLOW, mode 0600, checked to have stuck), fsyncs it, renames it over the
 * target and fsyncs the directory. A crash leaves the old file or the new one. The caller holds the
 * agent's inter-process lock.
 */
export function writeKeystoreFile(
  dir: string,
  name: string,
  bytes: Uint8Array,
  options: KeystoreFsOptions = {},
): Promise<void> {
  return fixed(async () => {
    const realDir = await checkedDir(dir, options);
    if (realDir === null) throw keystoreFailed();
    const temp = join(realDir, `${tempPrefix(name)}${encodeHex(randomBytes(8))}`);
    const handle = await open(temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, FILE_MODE);
    let closed = false;
    let renamed = false;
    try {
      await (options.chmod ?? ((h, mode) => h.chmod(mode)))(handle, FILE_MODE);
      const st = await handle.stat();
      const mode = options.mode ? options.mode(st.mode & 0o777) : st.mode & 0o777;
      if (mode !== FILE_MODE || st.uid !== processUid(options)) throw keystoreUnsafe();
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        offset += bytesWritten;
      }
      await handle.sync();
      await handle.close();
      closed = true;
      await options.beforeRename?.();
      await rename(temp, join(realDir, name));
      renamed = true;
      const dirHandle = await open(realDir, O_RDONLY | O_DIRECTORY);
      try {
        await dirHandle.sync();
      } catch (error) {
        // Some filesystems refuse fsync on a directory; the rename itself already happened.
        if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(errno(error) as string)) throw error;
      } finally {
        await dirHandle.close();
      }
    } finally {
      if (!closed) await handle.close().catch(() => undefined);
      if (!renamed) await unlink(temp).catch(() => undefined);
    }
  });
}

/** 04 §2.8: removes temporary files of `name` left by a crash. The caller holds the lock. */
export function removeStaleTemps(
  dir: string,
  name: string,
  options: KeystoreFsOptions = {},
): Promise<void> {
  return fixed(async () => {
    const realDir = await checkedDir(dir, options);
    if (realDir === null) return;
    const prefix = tempPrefix(name);
    for (const entry of await readdir(realDir)) {
      if (entry.startsWith(prefix) && TEMP_SUFFIX.test(entry.slice(prefix.length))) {
        await unlink(join(realDir, entry));
      }
    }
  });
}

/**
 * U3-e (04 §2.5 "Removing an agent" step 6): deletes `dir/name` and its temporary files, after the
 * folder check, as a plain unlink (never through a link: `name` is a single path segment and a link
 * or anything that is not a regular file of the process user refuses with `keystore_file_unsafe`).
 * A file that is already gone is not an error. The directory entry is synced. The caller holds the
 * lock and has checked `name`.
 */
export function removeKeystoreFile(
  dir: string,
  name: string,
  options: KeystoreFsOptions = {},
): Promise<void> {
  return fixed(async () => {
    if (name.length === 0 || name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      throw keystoreUnsafe();
    }
    const realDir = await checkedDir(dir, options);
    if (realDir === null) return;
    const path = join(realDir, name);
    let st: Stats | undefined;
    try {
      st = await lstat(path);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    if (st !== undefined) {
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== processUid(options)) {
        throw keystoreUnsafe();
      }
      try {
        await unlink(path);
      } catch (error) {
        if (errno(error) !== 'ENOENT') throw error;
      }
    }
    const prefix = tempPrefix(name);
    for (const entry of await readdir(realDir)) {
      if (entry.startsWith(prefix) && TEMP_SUFFIX.test(entry.slice(prefix.length))) {
        await unlink(join(realDir, entry)).catch((error: unknown) => {
          if (errno(error) !== 'ENOENT') throw error;
        });
      }
    }
    const dirHandle = await open(realDir, O_RDONLY | O_DIRECTORY);
    try {
      await dirHandle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(errno(error) as string)) throw error;
    } finally {
      await dirHandle.close();
    }
  });
}

/** The agent files in `dir` (`<agentId>.alks`), by agent ID. */
export function listAgentFiles(dir: string, options: KeystoreFsOptions = {}): Promise<string[]> {
  return fixed(async () => {
    const realDir = await checkedDir(dir, options);
    if (realDir === null) return [];
    return (await readdir(realDir))
      .filter((entry) => /^0x[0-9a-f]{40}\.alks$/.test(entry))
      .map((entry) => entry.slice(0, -'.alks'.length));
  });
}

/**
 * 07 §9.2 source 1: the passphrase file, after `realpath` (secret mounts are often symlinks), opened
 * with O_RDONLY | O_NOFOLLOW and checked on the descriptor: a regular file of at most 1 KiB that
 * group and others cannot write. Readable by them is accepted (secret mounts are often 0444) and
 * reported for `doctor`. The caller wipes the bytes.
 */
export function readPassphraseFile(
  path: string,
): Promise<{ readonly secret: Uint8Array; readonly readableByOthers: boolean }> {
  return (async () => {
    try {
      assertPosix();
      const real = await realpath(path);
      const handle = await open(real, O_RDONLY | O_NOFOLLOW);
      try {
        const st = await handle.stat();
        if (!st.isFile() || st.size > MAX_PASSPHRASE_FILE_BYTES || (st.mode & 0o022) !== 0) {
          throw passphraseFileUnsafe();
        }
        return {
          secret: await readAll(handle, st.size),
          readableByOthers: (st.mode & 0o044) !== 0,
        };
      } finally {
        await handle.close();
      }
    } catch {
      throw passphraseFileUnsafe();
    }
  })();
}
