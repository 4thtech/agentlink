// RET-3 (S2; D-148; 04 §4.2 "Deleting a saved file"; 04 §4 realpath rules; proposed, owner confirms
// at merge): moves a saved Inbox file to the OS Trash. Never a hard delete.
//
// `trashSavedFile` touches only the file the app saved and only while it is unchanged: the entry at
// the single name inside the held Inbox folder must be a regular file (opened with O_NOFOLLOW and
// checked by lstat, so a link is never followed or moved) with the recorded device, inode and size,
// and its bytes must hash to the recorded sha256. The checks run just before the move, and the
// entry is checked once more (same device, inode, size and modification time) after the hash.
//
// `moveToTrash` then moves it:
// - macOS: a rename into `~/.Trash` on the same volume, never over an existing item (a hard link
//   under a free name, then the old name removed); another volume answers `no_trash`.
// - Linux and other freedesktop systems: the freedesktop.org Trash specification, home trash
//   (`$XDG_DATA_HOME/Trash`, default `~/.local/share/Trash`): `info/<name>.trashinfo` is created
//   exclusively first, then the file goes to `files/<name>`; another volume answers `no_trash`.
// - Windows: the Recycle Bin through `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(...,
//   SendToRecycleBin)` in Windows PowerShell, started by its absolute path with fixed arguments, no
//   shell, no profile. The path reaches it only through an environment variable, never as part of
//   the command, so nothing in a file name can become code.
// - Anything else: `no_trash` (the caller asks before a permanent delete; the retention pass skips).
//
// Nothing here logs. Outcomes are fixed codes; no error carries a path or a name (I-7).
import { spawn as nodeSpawn } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createSha256, encodeHex } from '@4thtech-io/crypto';

/** What the index row says the saved file is (core SavedFileExpectation). */
export interface SavedFileExpectation {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  /** lowercase hex */
  readonly sha256: string;
}

/** Fixed outcome codes (core TrashSavedOutcome). */
export type TrashOutcome = 'trashed' | 'changed' | 'missing' | 'no_trash' | 'failed';

/** Starts a process with fixed arguments and no shell; resolves with its exit code. */
export type TrashSpawn = (
  file: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly shell: false;
    readonly windowsHide: true;
    readonly timeout: number;
  },
) => Promise<{ readonly code: number | null }>;

export interface TrashOptions {
  /** Default: process.platform. */
  readonly platform?: NodeJS.Platform;
  /** The home folder; default the OS user's. */
  readonly home?: string;
  /** `$XDG_DATA_HOME` (Linux); default from the environment. Used only when absolute. */
  readonly xdgDataHome?: string;
  /** Windows: `%SystemRoot%`; default from the environment, else `C:\Windows`. */
  readonly systemRoot?: string;
  /** Windows: the process launcher (a stub in tests). */
  readonly spawn?: TrashSpawn;
  /** Windows: true once the file is gone from its place (default: lstat says ENOENT). */
  readonly gone?: (target: string) => Promise<boolean>;
}

export interface TrashSavedFileInput extends TrashOptions {
  /** The Inbox folder's realpath (absolute). */
  readonly folder: string;
  /** The single name inside it, from the index row; never a path. */
  readonly name: string;
  readonly expected: SavedFileExpectation;
  /** The held folder handle's check (inbox-folder.ts InboxDir.stillSame). */
  readonly stillSame?: () => Promise<boolean>;
}

const CHUNK = 256 * 1024;
const MAX_NAME_ATTEMPTS = 1_000;
const WINDOWS_TIMEOUT_MS = 30_000;
const ENV_TARGET = 'AGENTLINK_TRASH_TARGET';

/**
 * The fixed PowerShell command (Windows). It reads the path only from the environment; the Recycle
 * Bin option is fixed; only error dialogs can show (VisualBasic has no "no dialog" option here).
 */
const WINDOWS_SCRIPT =
  "$ErrorActionPreference = 'Stop'; " +
  'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
  `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:${ENV_TARGET}, ` +
  '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, ' +
  '[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)';

const WINDOWS_ARGS: readonly string[] = Object.freeze([
  '-NoProfile',
  '-NonInteractive',
  '-NoLogo',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  WINDOWS_SCRIPT,
]);

const codeOf = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/** A single visible name: not empty, no separator or NUL, not `.`/`..`, not hidden. */
function isOneVisibleSegment(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 1024 &&
    !name.startsWith('.') &&
    !/[\\/\0]/.test(name)
  );
}

const isDecimal = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{1,24}$/.test(v);

/**
 * Moves the saved file `name` inside `folder` to the OS Trash when it is still exactly the file the
 * app saved (see the header). Never throws.
 */
export async function trashSavedFile(input: TrashSavedFileInput): Promise<TrashOutcome> {
  try {
    return await trashSavedFileUnsafe(input);
  } catch {
    return 'failed';
  }
}

async function trashSavedFileUnsafe(input: TrashSavedFileInput): Promise<TrashOutcome> {
  const { folder, name, expected } = input;
  if (!isOneVisibleSegment(name) || typeof folder !== 'string' || !path.isAbsolute(folder)) {
    return 'failed';
  }
  if (
    !isDecimal(expected?.dev) ||
    !isDecimal(expected.ino) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    typeof expected.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(expected.sha256)
  ) {
    return 'failed';
  }
  const target = path.join(folder, name);
  if (path.dirname(target) !== folder) return 'failed';
  const held = input.stillSame ?? (() => Promise.resolve(true));
  if (!(await held())) return 'failed';

  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const noBlock = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | noFollow | noBlock);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return 'missing';
    // ELOOP: a link at the name (never followed); EISDIR and the like: not a regular file.
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'EMLINK' || code === 'ENOTDIR') {
      return 'changed';
    }
    return 'failed';
  }
  let before;
  try {
    const opened = await handle.stat({ bigint: true });
    const entry = await lstat(target, { bigint: true }).catch(() => undefined);
    if (
      !opened.isFile() ||
      entry === undefined ||
      !entry.isFile() ||
      entry.dev !== opened.dev ||
      entry.ino !== opened.ino
    ) {
      return 'changed';
    }
    if (
      opened.dev.toString() !== expected.dev ||
      opened.ino.toString() !== expected.ino ||
      opened.size !== BigInt(expected.size)
    ) {
      return 'changed';
    }
    // The bytes, read only from the opened file (never by path again), must hash as recorded.
    const hasher = createSha256();
    const buffer = new Uint8Array(CHUNK);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.size) return 'changed';
      hasher.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expected.size) return 'changed';
    if (encodeHex(hasher.digest()) !== expected.sha256.toLowerCase()) return 'changed';
    before = opened;
  } finally {
    await handle.close().catch(() => undefined);
  }
  // Just before the move: still the same entry, not written to since the hash.
  const again = await lstat(target, { bigint: true }).catch(() => undefined);
  if (
    again === undefined ||
    !again.isFile() ||
    again.dev !== before.dev ||
    again.ino !== before.ino ||
    again.size !== before.size ||
    again.mtimeNs !== before.mtimeNs
  ) {
    return 'changed';
  }
  if (!(await held())) return 'failed';
  return moveToTrash(target, input, { dev: before.dev, ino: before.ino });
}

/**
 * Moves `target` (an absolute path the caller checked) to the OS Trash (see the header). Never
 * throws; never deletes outright. With `identity`, the moved entry must still be that file
 * (POSIX), otherwise the answer is `changed` (it is in the Trash, recoverable).
 */
export async function moveToTrash(
  target: string,
  options: TrashOptions = {},
  identity?: { readonly dev: bigint; readonly ino: bigint },
): Promise<TrashOutcome> {
  try {
    const platform = options.platform ?? process.platform;
    if (platform === 'darwin') return await toMacTrash(target, options, identity);
    if (platform === 'win32') return await toRecycleBin(target, options);
    if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
      return await toXdgTrash(target, options, identity);
    }
    return 'no_trash';
  } catch {
    return 'failed';
  }
}

/** A directory that is ours: created 0700 when missing, never a link, owned by this user. */
async function ownDirectory(dir: string): Promise<boolean> {
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if (codeOf(error) !== 'EEXIST') throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) return false;
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid === undefined || info.uid === uid;
}

/** `name`, then `stem 2.ext`, `stem 3.ext`, ... (Finder's pattern). */
function* candidates(name: string): Generator<string> {
  yield name;
  const ext = path.extname(name);
  const stem = ext.length > 0 && ext.length < name.length ? name.slice(0, -ext.length) : name;
  const e = stem === name ? '' : ext;
  for (let n = 2; n <= MAX_NAME_ATTEMPTS; n += 1) yield `${stem} ${String(n)}${e}`;
}

type Placed = 'placed' | 'exists' | 'other_volume' | 'failed';

/**
 * Moves `from` to `to` without ever replacing an entry at `to`: a hard link (fails when `to`
 * exists), then the old name removed. Where the volume has no hard links, a rename after checking
 * that `to` is free (a same-user race is the accepted residual, G-1).
 */
async function placeNoReplace(from: string, to: string): Promise<Placed> {
  try {
    await link(from, to);
  } catch (error) {
    const code = codeOf(error);
    if (code === 'EEXIST') return 'exists';
    if (code === 'EXDEV') return 'other_volume';
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EMLINK' && code !== 'ENOSYS') {
      return 'failed';
    }
    const free = await lstat(to).then(
      () => false,
      (e: unknown) => codeOf(e) === 'ENOENT',
    );
    if (!free) return 'exists';
    try {
      await rename(from, to);
      return 'placed';
    } catch (e) {
      return codeOf(e) === 'EXDEV' ? 'other_volume' : 'failed';
    }
  }
  try {
    await unlink(from);
  } catch {
    // Roll back: the file keeps its place, the extra name goes (it is the same file).
    await unlink(to).catch(() => undefined);
    return 'failed';
  }
  return 'placed';
}

async function movedIsSame(
  to: string,
  identity: { readonly dev: bigint; readonly ino: bigint } | undefined,
): Promise<TrashOutcome> {
  if (identity === undefined) return 'trashed';
  const moved = await lstat(to, { bigint: true }).catch(() => undefined);
  return moved !== undefined && moved.dev === identity.dev && moved.ino === identity.ino
    ? 'trashed'
    : 'changed';
}

async function toMacTrash(
  target: string,
  options: TrashOptions,
  identity: { readonly dev: bigint; readonly ino: bigint } | undefined,
): Promise<TrashOutcome> {
  const home = options.home ?? os.homedir();
  const trash = path.join(home, '.Trash');
  if (!(await ownDirectory(trash).catch(() => false))) return 'no_trash';
  const source = await lstat(target, { bigint: true });
  const into = await lstat(trash, { bigint: true });
  if (source.dev !== into.dev) return 'no_trash';
  for (const candidate of candidates(path.basename(target))) {
    const to = path.join(trash, candidate);
    const placed = await placeNoReplace(target, to);
    if (placed === 'exists') continue;
    if (placed === 'other_volume') return 'no_trash';
    if (placed === 'failed') return 'failed';
    return movedIsSame(to, identity);
  }
  return 'failed';
}

/** The trashinfo `Path=` value: the absolute path, each segment percent-encoded (RFC 2396). */
const trashInfoPath = (absolute: string): string =>
  absolute.split('/').map(encodeURIComponent).join('/');

const two = (n: number): string => String(n).padStart(2, '0');

/** `DeletionDate`: local time, `YYYY-MM-DDThh:mm:ss` (the specification's format). */
function deletionDate(d = new Date()): string {
  return (
    `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}` +
    `T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  );
}

async function toXdgTrash(
  target: string,
  options: TrashOptions,
  identity: { readonly dev: bigint; readonly ino: bigint } | undefined,
): Promise<TrashOutcome> {
  const home = options.home ?? os.homedir();
  const xdg = options.xdgDataHome ?? process.env.XDG_DATA_HOME;
  const base =
    typeof xdg === 'string' && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
  await mkdir(base, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const trash = path.join(base, 'Trash');
  const files = path.join(trash, 'files');
  const info = path.join(trash, 'info');
  for (const dir of [trash, files, info]) {
    if (!(await ownDirectory(dir).catch(() => false))) return 'no_trash';
  }
  const source = await lstat(target, { bigint: true });
  const into = await lstat(files, { bigint: true });
  if (source.dev !== into.dev) return 'no_trash';
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const body = `[Trash Info]\nPath=${trashInfoPath(target)}\nDeletionDate=${deletionDate()}\n`;
  for (const candidate of candidates(path.basename(target))) {
    const infoFile = path.join(info, `${candidate}.trashinfo`);
    let handle: FileHandle;
    try {
      // Created exclusively first: it reserves the name (the specification's atomic step).
      handle = await open(
        infoFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
    } catch (error) {
      if (codeOf(error) === 'EEXIST') continue;
      return 'failed';
    }
    try {
      await handle.writeFile(body, 'utf8');
    } catch {
      await handle.close().catch(() => undefined);
      await unlink(infoFile).catch(() => undefined);
      return 'failed';
    }
    await handle.close();
    const to = path.join(files, candidate);
    const placed = await placeNoReplace(target, to);
    if (placed === 'placed') return movedIsSame(to, identity);
    await unlink(infoFile).catch(() => undefined);
    if (placed === 'exists') continue;
    return placed === 'other_volume' ? 'no_trash' : 'failed';
  }
  return 'failed';
}

/** The real launcher: no shell, hidden window, a time bound; output is ignored, never logged. */
const defaultSpawn: TrashSpawn = (file, args, options) =>
  new Promise((resolve) => {
    let child;
    try {
      child = nodeSpawn(file, [...args], {
        env: { ...options.env },
        shell: false,
        windowsHide: true,
        timeout: options.timeout,
        stdio: 'ignore',
      });
    } catch {
      resolve({ code: null });
      return;
    }
    child.once('error', () => resolve({ code: null }));
    child.once('exit', (code) => resolve({ code }));
  });

async function toRecycleBin(target: string, options: TrashOptions): Promise<TrashOutcome> {
  const systemRoot =
    options.systemRoot ?? process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  // The absolute path of Windows PowerShell: never looked up on PATH.
  const exe = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  env[ENV_TARGET] = target;
  env.SystemRoot = systemRoot;
  const run = options.spawn ?? defaultSpawn;
  let code: number | null;
  try {
    ({ code } = await run(exe, WINDOWS_ARGS, {
      env,
      shell: false,
      windowsHide: true,
      timeout: WINDOWS_TIMEOUT_MS,
    }));
  } catch {
    return 'failed';
  }
  if (code !== 0) return 'failed';
  const gone =
    options.gone ??
    ((p: string) =>
      lstat(p).then(
        () => false,
        (e: unknown) => codeOf(e) === 'ENOENT',
      ));
  return (await gone(target).catch(() => false)) ? 'trashed' : 'failed';
}
