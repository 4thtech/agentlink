// M1-15: the Node half of the allowed-folder and download rules (04 §4 "Allowed folders",
// "Downloads", §7; 06 §2.3). `realpath` runs on both sides (the requested path and every allowed
// folder, symlinks followed), then core's decidePath decides. Protected roots (`~/.ssh`,
// `~/.agentlink`, keychain directories) are checked in both their lexical and resolved forms, so a
// symlinked `~/.ssh` is covered too.
//
// Reading: resolveAllowedFile checks; openAllowedFile checks, opens the resolved path without
// following a final symlink and verifies that the opened file is the checked one (same device and
// inode, a regular file), so a swap between check and open is refused.
// Writing: createInboxFile sanitises the untrusted name, resolves the inbox folder, refuses a
// protected or hidden inbox, and creates a new file exclusively (never overwrites, never follows a
// symlink), adding ` (1)`, ` (2)`, … on a clash.
//
// Nothing here logs, and no error carries a path or a file name (a tool error is shown to the AI):
// callers branch on AllowedPathError.code.
import {
  decidePath,
  expandHome,
  parseAbsolutePath,
  protectedRoots,
  sanitizeFileName,
  type PathFlavor,
} from '@agentlink/core';
import { constants, type Stats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
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
 * Checks that `requested` (a tool argument) may be read under 04 §4: realpath on both sides, inside
 * an allowed folder, not hidden, not under a protected root, a regular file. Never opens the file.
 */
export async function resolveAllowedFile(
  requested: string,
  options: AllowedPathOptions,
): Promise<AllowedFile> {
  const home = options.home ?? homedir();
  const requestedAbs = absolute(requested, home);
  if (requestedAbs === undefined) throw new AllowedPathError('path_malformed');
  const folders = (
    await Promise.all(
      options.allowedFolders.map(async (folder) => {
        const abs = absolute(folder, home);
        return abs === undefined ? undefined : realpathOrUndefined(abs);
      }),
    )
  ).filter((f): f is string => f !== undefined);
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

/**
 * resolveAllowedFile, then opens the resolved path read-only without following a final symlink and
 * checks that the opened file is the checked one (device, inode, regular file). The caller closes
 * the handle.
 */
export async function openAllowedFile(
  requested: string,
  options: AllowedPathOptions,
): Promise<{ readonly file: AllowedFile; readonly handle: FileHandle }> {
  const file = await resolveAllowedFile(requested, options);
  const before = await stat(file.realPath).catch(() => undefined);
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let handle: FileHandle;
  try {
    handle = await open(file.realPath, constants.O_RDONLY | noFollow);
  } catch {
    throw new AllowedPathError('changed');
  }
  try {
    const after = await handle.stat();
    if (
      before === undefined ||
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new AllowedPathError('changed');
    }
    return { file: { ...file, size: after.size }, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error instanceof AllowedPathError ? error : new AllowedPathError('changed');
  }
}

/** Most ` (n)` suffixes tried before giving up. */
const MAX_NAME_ATTEMPTS = 100;

function withSuffix(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * Creates a new file for a download inside the inbox folder (policy `files.inboxFolder`; 04 §4
 * "Downloads"): the untrusted name is sanitised (core's sanitizeFileName), the inbox folder is
 * resolved and must be an existing folder outside every protected root, and the file is created
 * exclusively (never overwriting) with mode 0600 without following a symlink. The caller writes,
 * closes, and removes the file on an integrity failure.
 */
export async function createInboxFile(
  inboxFolder: string,
  untrustedName: unknown,
  options: { readonly home?: string } = {},
): Promise<{ readonly path: string; readonly name: string; readonly handle: FileHandle }> {
  const home = options.home ?? homedir();
  const abs = absolute(inboxFolder, home);
  if (abs === undefined) throw new AllowedPathError('inbox_unavailable');
  const folder = await realpathOrUndefined(abs);
  if (folder === undefined) throw new AllowedPathError('inbox_unavailable');
  const info = await stat(folder).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new AllowedPathError('inbox_unavailable');
  const roots = await resolvedProtectedRoots(home);
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
