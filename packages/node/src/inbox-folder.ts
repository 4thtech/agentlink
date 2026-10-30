// W4-AUTO-SAVE: the Node side of the Inbox folder writing rules (D-142; 04 §4.1; proposed, owner
// confirms at merge). Used by the CLI's files platform (apps/cli runtime/files.ts) for every save,
// automatic or not.
//
// - inboxFolderProblem: the folder rules of 04 §4.1 checked on the folder's realpath (hidden and
//   protected roots are checked by the caller's resolve): an existing directory owned by the current
//   OS user, on macOS and Linux not writable by group or others; not the home folder itself or a
//   filesystem root; not equal to, inside or containing an allowed send folder.
// - openInboxDir: the folder opened once as a directory handle without following a final link
//   (`O_DIRECTORY | O_NOFOLLOW`), checked with fstat to be the directory that passed the rules (same
//   device and inode, owner and mode). Node has no `openat`/`renameat`, so every later step names the
//   entry by path and is bracketed by `stillSame`: the path's lstat must still be the held directory
//   (same device and inode) before and after it, and a created file's inode must be the entry's. A
//   folder swapped for a link or another directory is detected and the save stops (residual: the
//   window between the check and the syscall, documented in the PR threat note).
// - quarantineMark: the OS "downloaded from the internet" mark, set and read back. macOS
//   `com.apple.quarantine` = `0081;<hex unix time>;AgentLink;<random UUID>` through /usr/bin/xattr
//   (no shell, `-s`: never through a link); Windows the `Zone.Identifier` stream with `[ZoneTransfer]`
//   and `ZoneId=3` only; Linux has none (`unsupported`, an accepted residual). The mark never carries
//   a link, a host or a referrer (I-7).
// - freeBytes: free bytes on the folder's volume (statfs), for the 1 GiB reserve.
//
// Nothing here logs. Errors are fixed text: never a path or a name (I-5, I-7).
import { execFile } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readFile, statfs, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';

/** Why a folder is refused (fixed codes, never a path). */
export type InboxFolderProblem =
  'not_a_folder' | 'not_owned' | 'shared_writable' | 'home_or_root' | 'send_folder';

export interface InboxFolderRulesInput {
  /** The folder's realpath. */
  readonly realpath: string;
  /** The home folder's realpath. */
  readonly home: string;
  /** The realpaths of the policy's allowed send folders. */
  readonly sendFolders: readonly string[];
  /** Test seam: the stat of the folder. Default lstat. */
  readonly stat?: Stats;
  /** Test seam: the current OS user's uid. Default process.getuid(). */
  readonly uid?: number;
  /** Test seam: the platform. Default process.platform. */
  readonly platform?: NodeJS.Platform;
}

const pathApi = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

function sameOrInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const p = pathApi(platform);
  const fold = (s: string) => (platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s);
  const rel = p.relative(fold(parent), fold(child));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
}

/** The folder rules of 04 §4.1 on a resolved folder; undefined when it passes. */
export async function inboxFolderProblem(
  input: InboxFolderRulesInput,
): Promise<InboxFolderProblem | undefined> {
  const platform = input.platform ?? process.platform;
  const p = pathApi(platform);
  const info = input.stat ?? (await lstat(input.realpath).catch(() => undefined));
  if (info === undefined || !info.isDirectory()) return 'not_a_folder';
  if (platform !== 'win32') {
    const uid = input.uid ?? process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return 'not_owned';
    if ((info.mode & 0o022) !== 0) return 'shared_writable';
  }
  const real = input.realpath;
  if (p.parse(real).root === real || p.dirname(real) === real) return 'home_or_root';
  if (sameOrInside(input.home, real, platform)) return 'home_or_root'; // the home itself or above it
  for (const send of input.sendFolders) {
    if (sameOrInside(real, send, platform) || sameOrInside(send, real, platform)) {
      return 'send_folder';
    }
  }
  return undefined;
}

const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const directory = (constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;

/** The held Inbox folder (see the header). */
export interface InboxDir {
  /** True while the folder path still names the held directory (lstat, no link followed). */
  stillSame(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Opens the resolved folder once as a directory handle and checks it is `expected` (the stat that
 * passed the rules). Undefined when it is not (swapped, a link, gone). Windows: no directory handle
 * from Node; the lstat comparison alone.
 */
export async function openInboxDir(
  realpath: string,
  expected: Stats,
): Promise<InboxDir | undefined> {
  let handle: FileHandle | undefined;
  if (process.platform !== 'win32') {
    try {
      handle = await open(realpath, constants.O_RDONLY | directory | noFollow);
    } catch {
      return undefined;
    }
  }
  const held = handle === undefined ? expected : await handle.stat().catch(() => undefined);
  const same = (s: Stats | undefined) =>
    s !== undefined &&
    s.isDirectory() &&
    s.dev === expected.dev &&
    s.ino === expected.ino &&
    s.uid === expected.uid &&
    s.mode === expected.mode;
  if (!same(held)) {
    await handle?.close().catch(() => undefined);
    return undefined;
  }
  return {
    async stillSame() {
      const now = await lstat(realpath).catch(() => undefined);
      return (
        now !== undefined && now.isDirectory() && now.dev === held?.dev && now.ino === held.ino
      );
    },
    async close() {
      await handle?.close().catch(() => undefined);
    },
  };
}

/** The quarantine attribute's name on macOS. */
export const MACOS_QUARANTINE_ATTR = 'com.apple.quarantine';
const XATTR = '/usr/bin/xattr';
/** The Windows Mark-of-the-Web content: Internet zone only, no link, no referrer (I-7). */
export const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n';

/** A random (version 4) UUID, upper case, from the CSPRNG of @4thtech-io/crypto. */
function randomUuid(): string {
  const b = randomBytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = encodeHex(b).toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** `0081;<hex unix time>;AgentLink;<random UUID>` (04 §4.1); the event UUID is never shared. */
export function quarantineValue(now: number = Math.floor(Date.now() / 1000)): string {
  return `0081;${now.toString(16)};AgentLink;${randomUuid()}`;
}

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error('mark failed'));
      else resolve(String(stdout));
    });
  });
}

export interface QuarantineMarkSeams {
  readonly platform?: NodeJS.Platform;
  /** Runs /usr/bin/xattr with these arguments (no shell). */
  readonly xattr?: (args: readonly string[]) => Promise<string>;
}

/**
 * Sets the quarantine mark on the file at `target` and reads it back: `marked`, `unsupported`
 * (Linux) or `failed` (any error, or a value that does not read back).
 */
export async function quarantineMark(
  target: string,
  seams: QuarantineMarkSeams = {},
): Promise<'marked' | 'unsupported' | 'failed'> {
  const platform = seams.platform ?? process.platform;
  try {
    if (platform === 'darwin') {
      const xattr = seams.xattr ?? ((args: readonly string[]) => run(XATTR, args));
      const value = quarantineValue();
      await xattr(['-s', '-w', MACOS_QUARANTINE_ATTR, value, target]);
      const back = (await xattr(['-s', '-p', MACOS_QUARANTINE_ATTR, target])).trim();
      return back === value ? 'marked' : 'failed';
    }
    if (platform === 'win32') {
      const stream = `${target}:Zone.Identifier`;
      await writeFile(stream, ZONE_IDENTIFIER, { flag: 'w' });
      const back = await readFile(stream, 'utf8');
      return back === ZONE_IDENTIFIER ? 'marked' : 'failed';
    }
    return 'unsupported';
  } catch {
    return 'failed';
  }
}

/** Free bytes for this user on the volume of `folder`. */
export async function freeBytes(folder: string): Promise<number> {
  const s = await statfs(folder);
  return Number(s.bavail) * Number(s.bsize);
}
