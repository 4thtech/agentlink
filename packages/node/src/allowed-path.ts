// M1-15: the Node half of the allowed-folder and download rules (04 §4 "Allowed folders",
// "Downloads", §7; 06 §2.3). `realpath` runs on both sides (the requested path and every allowed
// folder, symlinks followed), then core's decidePath decides. Protected roots (`~/.ssh`,
// `~/.agentlink`, keychain directories) are checked in both their lexical and resolved forms, so a
// symlinked `~/.ssh` is covered too.
//
// Reading: resolveAllowedFile checks; openAllowedFile checks, opens, then checks again and requires
// the opened file to be the one the second check resolved (same device and inode, a regular file);
// its comment states the exact guarantee and the Windows residual.
// Writing: createInboxFile sanitises the untrusted name, resolves the inbox folder, refuses a
// protected or hidden inbox, and creates a new file exclusively (never overwrites, never follows a
// symlink), adding ` (1)`, ` (2)`, … on a clash.
//
// Pinned folders (M1-36b-2-d, IR-M1-36b-2-c-1 L3): owner commands store an allowed folder as its
// realpath (`policy allow-folder`, the Send folder), so the stored string pins the folder's real
// location. An allowed folder is used only while it still resolves to exactly that location (a
// leading `~/` stands for the real home folder): one that became a link, or sits below a folder that
// became a link, is not used, so a later link cannot widen what the owner allowed. pinFolder and
// stillPinned add the folder's identity on disk (device and inode) for owner flows that check a
// folder, ask the owner code and then apply: the folder must still be the same one at each step.
//
// Nothing here logs, and no error carries a path or a file name (a tool error is shown to the AI):
// callers branch on AllowedPathError.code.
import {
  MAX_FILE_NAME_BYTES,
  decidePath,
  expandHome,
  parseAbsolutePath,
  protectedRoots,
  sanitizeFileName,
  type PathFlavor,
} from '@4thtech-io/core';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type AllowedPathErrorCode =
  /** The path is empty, relative, has `.` or `..` segments, or does not exist. */
  | 'path_malformed'
  | 'not_found'
  /** No allowed folder is configured, or none of them exists (`needs_setup` in 06 §2.3). */
  | 'no_allowed_folder'
  | 'outside_allowed'
  | 'hidden'
  | 'protected'
  /** Not a regular file (a folder, device, FIFO or socket). */
  | 'not_a_file'
  /** The file changed between the check and the open. */
  | 'changed'
  /** The inbox folder is missing, not a folder, or no free name was found. */
  | 'inbox_unavailable';

const MESSAGES: Record<AllowedPathErrorCode, string> = {
  path_malformed: 'The file path is not a full path.',
  not_found: 'The file does not exist.',
  no_allowed_folder: 'No folder is allowed for sending files yet.',
  outside_allowed: 'The file is not inside a folder allowed for sending files.',
  hidden: 'Hidden files cannot be sent.',
  protected: 'Files in this folder can never be sent.',
  not_a_file: 'The path is not a regular file.',
  changed: 'The file changed while it was being opened.',
  inbox_unavailable: 'The inbox folder is not available.',
};

export class AllowedPathError extends Error {
  readonly code: AllowedPathErrorCode;

  constructor(code: AllowedPathErrorCode) {
    super(MESSAGES[code]); // fixed text: no path or file name
    this.name = 'AllowedPathError';
    this.code = code;
  }
}

export interface AllowedPathOptions {
  /** Policy `files.allowedFolders` (a leading `~/` means the home folder). */
  readonly allowedFolders: readonly string[];
  /** Default: os.homedir(). */
  readonly home?: string;
}

export interface AllowedFile {
  /** The resolved path that passed the check. */
  readonly realPath: string;
  /** The resolved allowed folder it is inside. */
  readonly folder: string;
  readonly size: number;
}

const FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await realpath(p);
  } catch {
    return undefined;
  }
}

/** Lexical and resolved forms of every protected root. */
async function resolvedProtectedRoots(home: string): Promise<string[]> {
  const lexical = [...protectedRoots(home, FLAVOR)];
  const homeReal = await realpathOrUndefined(home);
  if (homeReal !== undefined && homeReal !== home)
    lexical.push(...protectedRoots(homeReal, FLAVOR));
  const resolved = await Promise.all(lexical.map(realpathOrUndefined));
  return [...lexical, ...resolved.filter((r): r is string => r !== undefined)];
}

function absolute(p: string, home: string): string | undefined {
  if (typeof p !== 'string') return undefined;
  const expanded = expandHome(p, home, FLAVOR);
  return parseAbsolutePath(expanded, FLAVOR) === undefined ? undefined : expanded;
}

/**
 * Where a stored allowed folder must really be: the folder with a leading `~/` expanded to the real
 * home folder (`realHome`, already resolved), normalised, without a trailing separator. Undefined
 * when it is not a full path. A folder is used only while its realpath equals this.
 */
export function pinnedLocation(folder: string, realHome: string): string | undefined {
  const abs = absolute(folder, realHome);
  if (abs === undefined) return undefined;
  const normal = path.normalize(abs);
  const { root } = path.parse(normal);
  return normal.length > root.length && normal.endsWith(path.sep) ? normal.slice(0, -1) : normal;
}

/**
 * The real path of every allowed folder that is still where it was allowed (see the header); the
 * others (missing, a link, below a link) are left out, fail closed.
 */
async function pinnedAllowedFolders(
  allowedFolders: readonly string[],
  home: string,
): Promise<string[]> {
  const realHome = (await realpathOrUndefined(home)) ?? home;
  const folders = await Promise.all(
    allowedFolders.map(async (folder) => {
      if (typeof folder !== 'string') return undefined;
      const pinned = pinnedLocation(folder, realHome);
      if (pinned === undefined) return undefined;
      const real = await realpathOrUndefined(pinned);
      return real !== undefined && real === pinned ? real : undefined;
    }),
  );
  return folders.filter((f): f is string => f !== undefined);
}

/** A folder as checked: its real path and its identity on disk (M1-36b-2-d). */
export interface FolderPin {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Pins `folder` when it is a real folder (not a link) whose realpath is exactly `folder`; undefined
 * otherwise. The identity is read before and after the realpath and must match, so a swap during
 * the pin is not pinned.
 */
export async function pinFolder(folder: string): Promise<FolderPin | undefined> {
  if (typeof folder !== 'string' || parseAbsolutePath(folder, FLAVOR) === undefined) {
    return undefined;
  }
  try {
    const first = await lstat(folder, { bigint: true });
    if (first.isSymbolicLink() || !first.isDirectory()) return undefined;
    if ((await realpath(folder)) !== folder) return undefined;
    const second = await lstat(folder, { bigint: true });
    if (second.isSymbolicLink() || !second.isDirectory()) return undefined;
    if (second.dev !== first.dev || second.ino !== first.ino) return undefined;
    return Object.freeze({ path: folder, dev: first.dev, ino: first.ino });
  } catch {
    return undefined;
  }
}

/** True while the pinned folder is still that same real folder: same path, device and inode. */
export async function stillPinned(pin: FolderPin): Promise<boolean> {
  const now = await pinFolder(pin.path);
  return now !== undefined && now.dev === pin.dev && now.ino === pin.ino;
}

/**
 * Checks that `requested` (a tool argument) may be read under 04 §4: realpath on both sides, inside
 * an allowed folder that is still where it was allowed (pinned, see the header), not hidden, not
 * under a protected root, a regular file. Never opens the file.
 */
export async function resolveAllowedFile(
  requested: string,
  options: AllowedPathOptions,
): Promise<AllowedFile> {
  const home = options.home ?? homedir();
  const requestedAbs = absolute(requested, home);
  if (requestedAbs === undefined) throw new AllowedPathError('path_malformed');
  const folders = await pinnedAllowedFolders(options.allowedFolders, home);
  const roots = await resolvedProtectedRoots(home);
  // Refuse a protected or hidden request before touching the file system for it.
  const early = decidePath({
    requested: requestedAbs,
    resolved: requestedAbs,
    allowedFolders: [requestedAbs],
    protectedRoots: roots,
    flavor: FLAVOR,
  });
  if (!early.ok && (early.reason === 'protected' || early.reason === 'hidden')) {
    throw new AllowedPathError(early.reason);
  }
  if (folders.length === 0) throw new AllowedPathError('no_allowed_folder');
  const resolved = await realpathOrUndefined(requestedAbs);
  if (resolved === undefined) throw new AllowedPathError('not_found');
  const decision = decidePath({
    requested: requestedAbs,
    resolved,
    allowedFolders: folders,
    protectedRoots: roots,
    flavor: FLAVOR,
  });
  if (!decision.ok) throw new AllowedPathError(decision.reason);
  let info: Stats;
  try {
    info = await stat(resolved);
  } catch {
    throw new AllowedPathError('not_found');
  }
  if (!info.isFile()) throw new AllowedPathError('not_a_file');
  return { realPath: resolved, folder: decision.folder, size: info.size };
}

/** Test seams, never exported from the package entry. */
export interface OpenAllowedFileSeams {
  /** Runs between the first check and the open (a swap there is caught by the re-check). */
  readonly afterCheck?: () => Promise<void> | void;
  /** Runs between the open and the re-check. */
  readonly afterOpen?: () => Promise<void> | void;
}

/**
 * Opens a file that passes resolveAllowedFile, read-only. Guarantee: the returned handle is a
 * regular file whose device and inode equal those of the path that `requested` resolves to in a
 * second, full check (realpath on both sides and decidePath again) made AFTER the open. A swap of
 * the file, or of any directory or link on its path, before or during the open therefore either
 * fails that re-check (with its own code) or changes the device and inode (`changed`). The open
 * uses O_NOFOLLOW (a final symlink is not followed) and O_NONBLOCK (a FIFO or device swapped in
 * cannot block the open). Residual: Windows has neither flag, so there only the re-check and the
 * device and inode match apply (Windows also refuses to rename a folder that holds an open file,
 * so a folder swap can only happen before the open, which the re-check catches); realpath is the
 * native one, so 8.3 short names (`RUNNER~1`) resolve to their long form on both sides; a hard link to a protected file placed inside an allowed folder is
 * the same inode and is not detected (it needs write access to that folder as the same OS user,
 * 04 §2.5). The caller closes the handle.
 */
export async function openAllowedFile(
  requested: string,
  options: AllowedPathOptions,
): Promise<{ readonly file: AllowedFile; readonly handle: FileHandle }> {
  return openAllowedFileWith(requested, options, {});
}

/** openAllowedFile with the test seam. */
export async function openAllowedFileWith(
  requested: string,
  options: AllowedPathOptions,
  seams: OpenAllowedFileSeams,
): Promise<{ readonly file: AllowedFile; readonly handle: FileHandle }> {
  const first = await resolveAllowedFile(requested, options);
  if (seams.afterCheck !== undefined) await seams.afterCheck();
  const flags = constants as { O_NOFOLLOW?: number; O_NONBLOCK?: number };
  let handle: FileHandle;
  try {
    handle = await open(
      first.realPath,
      constants.O_RDONLY | (flags.O_NOFOLLOW ?? 0) | (flags.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new AllowedPathError('changed');
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new AllowedPathError('changed');
    if (seams.afterOpen !== undefined) await seams.afterOpen();
    // The second full check, after the open.
    const second = await resolveAllowedFile(requested, options);
    let current: Stats;
    try {
      current = await stat(second.realPath);
    } catch {
      throw new AllowedPathError('changed');
    }
    if (
      second.realPath !== first.realPath ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    ) {
      throw new AllowedPathError('changed');
    }
    return { file: { ...second, size: opened.size }, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error instanceof AllowedPathError ? error : new AllowedPathError('changed');
  }
}

/** Most ` (n)` suffixes tried before giving up. */
const MAX_NAME_ATTEMPTS = 100;

/** Cuts `text` to at most `bytes` UTF-8 bytes on a code-point boundary. */
function truncateUtf8(text: string, bytes: number): string {
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, 'utf8') > bytes) break;
    out += ch;
  }
  return out;
}

/**
 * `name` with ` (n)` before a short extension, the stem shortened so the result stays within
 * MAX_FILE_NAME_BYTES.
 */
function withSuffix(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && name.length - dot <= 16;
  const stem = hasExt ? name.slice(0, dot) : name;
  const tail = ` (${n})${hasExt ? name.slice(dot) : ''}`;
  const room = MAX_FILE_NAME_BYTES - Buffer.byteLength(tail, 'utf8');
  return `${truncateUtf8(stem, room).replace(/\s+$/u, '')}${tail}`;
}

/** The inbox folder's realpath and the protected roots it was checked against. */
export interface ResolvedInbox {
  readonly folder: string;
  readonly roots: readonly string[];
}

/**
 * Resolves the inbox folder (policy `files.inboxFolder`, `~/` expanded): its realpath, which must be
 * an existing folder outside every protected root whose own name (as given or resolved) is not
 * hidden. Creates nothing. Throws AllowedPathError otherwise (`inbox_unavailable`, or the decision's
 * reason). Used by createInboxFile and by Show in Finder (MSG-FILES-IO-h).
 */
export async function resolveInboxFolder(
  inboxFolder: string,
  options: { readonly home?: string } = {},
): Promise<ResolvedInbox> {
  const home = options.home ?? homedir();
  const abs = absolute(inboxFolder, home);
  if (abs === undefined) throw new AllowedPathError('inbox_unavailable');
  const folder = await realpathOrUndefined(abs);
  if (folder === undefined) throw new AllowedPathError('inbox_unavailable');
  const info = await stat(folder).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new AllowedPathError('inbox_unavailable');
  const roots = await resolvedProtectedRoots(home);
  // The inbox itself: outside every protected root, and its own name (given or resolved) not
  // hidden. decidePath checks protected roots first, then the last segment of `requested`.
  for (const own of [abs, folder]) {
    const inbox = decidePath({
      requested: own,
      resolved: folder,
      allowedFolders: [folder],
      protectedRoots: roots,
      flavor: FLAVOR,
    });
    if (!inbox.ok) throw new AllowedPathError(inbox.reason);
  }
  return { folder, roots };
}

/**
 * Whether `target` (already joined, not resolved) may name a file directly inside the resolved
 * inbox `folder`: its parent is exactly the folder, and decidePath allows it (not hidden, outside
 * every protected root). MSG-FILES-IO-h.
 */
export function directlyInsideInbox(target: string, inbox: ResolvedInbox): boolean {
  if (path.dirname(target) !== inbox.folder) return false;
  return decidePath({
    requested: target,
    resolved: target,
    allowedFolders: [inbox.folder],
    protectedRoots: inbox.roots,
    flavor: FLAVOR,
  }).ok;
}

/**
 * Creates a new file for a download inside the inbox folder (policy `files.inboxFolder`; 04 §4
 * "Downloads"): the untrusted name is sanitised (core's sanitizeFileName), the inbox folder is
 * resolved and must be an existing folder outside every protected root whose own name (as given
 * or resolved) is not hidden, and the file is created exclusively (never overwriting) with mode
 * 0600 without following a symlink. A clash adds ` (1)`, ` (2)`, … within the 255-byte name limit.
 * The caller writes, closes, and removes the file on an integrity failure.
 */
export async function createInboxFile(
  inboxFolder: string,
  untrustedName: unknown,
  options: { readonly home?: string } = {},
): Promise<{ readonly path: string; readonly name: string; readonly handle: FileHandle }> {
  const { folder, roots } = await resolveInboxFolder(inboxFolder, options);
  const base = sanitizeFileName(untrustedName);
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  for (let n = 0; n < MAX_NAME_ATTEMPTS; n += 1) {
    const name = withSuffix(base, n);
    const target = path.join(folder, name);
    // The joined path must still be directly inside the inbox and outside every protected root.
    const decision = decidePath({
      requested: target,
      resolved: target,
      allowedFolders: [folder],
      protectedRoots: roots,
      flavor: FLAVOR,
    });
    if (!decision.ok || path.dirname(target) !== folder) {
      throw new AllowedPathError(decision.ok ? 'inbox_unavailable' : decision.reason);
    }
    try {
      const handle = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      return { path: target, name, handle };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new AllowedPathError('inbox_unavailable');
    }
  }
  throw new AllowedPathError('inbox_unavailable');
}
