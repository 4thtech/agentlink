// M1-15: the pure half of the allowed-folder rule (04 §4 "Allowed folders", §7 "Malicious files /
// symlink tricks"; 06 §2.3, §3 `files.allowedFolders`). A path from a tool argument may only be read
// when, after `realpath` on both sides (symlinks followed), it stays inside an owner-allowed folder.
// Hidden files, and anything under `~/.ssh`, `~/.agentlink` or a keychain directory, are always
// refused, even when the owner allowed a folder that contains them.
//
// This module compares paths that the platform has already resolved (`@agentlink/node`'s
// `resolveAllowedFile` runs realpath and passes the results here). It does no I/O and imports no
// Node built-in, so it parses both path flavours itself: `posix` and `win32` (drive letters, UNC
// shares, `\\?\` prefixes, either separator, case-insensitive). Every function fails closed: a
// relative path, a `.` or `..` segment or anything unparseable is never inside anything.

export type PathFlavor = 'posix' | 'win32';

/** Why a path was refused. Fixed codes: the path itself never appears in an error. */
export type PathRefusal =
  /** The path is empty, not absolute after `~` expansion, or has a `.`, `..` or empty segment. */
  | 'path_malformed'
  /** No allowed folder is configured (or none of them exists). */
  | 'no_allowed_folder'
  /** The resolved path is not inside any allowed folder. */
  | 'outside_allowed'
  /** A hidden file or folder (a segment starting with `.`) below the allowed folder. */
  | 'hidden'
  /** Under `~/.ssh`, `~/.agentlink` or a keychain directory. */
  | 'protected';

export type PathCheck =
  | { readonly ok: true; readonly folder: string }
  | { readonly ok: false; readonly reason: PathRefusal };

interface ParsedPath {
  /** `/` for posix; the lower-cased drive (`c:`) or `\\server\share` for win32. */
  readonly root: string;
  readonly segments: readonly string[];
}

/** Splits an absolute path into root and segments, or undefined (fail closed). */
export function parseAbsolutePath(path: unknown, flavor: PathFlavor): ParsedPath | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.length > 32_767) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return undefined;
  let root: string;
  let rest: string;
  if (flavor === 'posix') {
    if (!path.startsWith('/')) return undefined;
    root = '/';
    rest = path.slice(1);
  } else {
    let p = path.replace(/\//g, '\\');
    if (p.startsWith('\\\\?\\UNC\\')) p = `\\\\${p.slice('\\\\?\\UNC\\'.length)}`;
    else if (p.startsWith('\\\\?\\') || p.startsWith('\\\\.\\')) {
      p = p.slice(4);
      if (!/^[A-Za-z]:\\/.test(p)) return undefined; // a device or volume GUID path
    }
    const drive = /^([A-Za-z]):\\/.exec(p);
    if (drive !== null) {
      root = `${(drive[1] as string).toLowerCase()}:`;
      rest = p.slice(3);
    } else {
      const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/.exec(p);
      if (unc === null) return undefined;
      root = `\\\\${(unc[1] as string).toLowerCase()}\\${(unc[2] as string).toLowerCase()}`;
      rest = p.slice(unc[0].length);
    }
  }
  const sep = flavor === 'posix' ? '/' : '\\';
  const trimmed = rest.endsWith(sep) ? rest.slice(0, -1) : rest;
  const segments = trimmed === '' ? [] : trimmed.split(sep);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return undefined;
    // An NTFS stream (`file:stream`) or a trailing dot or space would name another object.
    if (flavor === 'win32' && (/[:*?"<>|]/.test(segment) || /[. ]$/.test(segment))) {
      return undefined;
    }
  }
  return {
    root,
    segments: flavor === 'win32' ? segments.map((s) => s.toLowerCase()) : segments,
  };
}

/** Segments of `path` below `folder`, or undefined when `path` is not `folder` or inside it. */
export function segmentsBelow(
  path: string,
  folder: string,
  flavor: PathFlavor,
  options: { readonly caseInsensitive?: boolean } = {},
): readonly string[] | undefined {
  const p = parseAbsolutePath(path, flavor);
  const f = parseAbsolutePath(folder, flavor);
  if (p === undefined || f === undefined) return undefined;
  const fold = (s: string): string => (options.caseInsensitive === true ? s.toLowerCase() : s);
  if (p.root !== f.root || p.segments.length < f.segments.length) return undefined;
  for (let i = 0; i < f.segments.length; i += 1) {
    if (fold(p.segments[i] as string) !== fold(f.segments[i] as string)) return undefined;
  }
  return p.segments.slice(f.segments.length);
}

/** True when `path` is `folder` or inside it (segment-wise: `/a/bc` is not inside `/a/b`). */
export function isInsideFolder(path: string, folder: string, flavor: PathFlavor): boolean {
  return segmentsBelow(path, folder, flavor) !== undefined;
}

/**
 * Expands a leading `~` (`~` alone, `~/…` or, on win32, `~\…`) to `home`. Any other `~user` form is
 * returned unchanged, so it then fails the absolute-path check.
 */
export function expandHome(path: string, home: string, flavor: PathFlavor): string {
  if (path === '~') return home;
  const sep = flavor === 'posix' ? '/' : '\\';
  const prefixed = path.startsWith('~/') || (flavor === 'win32' && path.startsWith('~\\'));
  if (!prefixed) return path;
  const base = home.endsWith(sep) || home.endsWith('/') ? home.slice(0, -1) : home;
  const tail = path.slice(2);
  return `${base}${sep}${flavor === 'win32' ? tail.replace(/\//g, '\\') : tail}`;
}

/** Joins `segments` below `base` with the flavour's separator. */
function joinBelow(base: string, flavor: PathFlavor, ...segments: string[]): string {
  const sep = flavor === 'posix' ? '/' : '\\';
  const trimmed = base.endsWith(sep) ? base.slice(0, -1) : base;
  return [trimmed, ...segments].join(sep);
}

/**
 * The directories no file is ever read from (04 §4): `~/.ssh`, `~/.agentlink` and the keychain
 * directories of macOS (`~/Library/Keychains`, `/Library/Keychains`), Linux (`~/.local/share/
 * keyrings`) and Windows (DPAPI master keys, Credential Manager and Vault under `AppData`). The
 * platform resolves each one with realpath as well and checks both forms.
 */
export function protectedRoots(home: string, flavor: PathFlavor): readonly string[] {
  if (flavor === 'posix') {
    return [
      joinBelow(home, flavor, '.ssh'),
      joinBelow(home, flavor, '.agentlink'),
      joinBelow(home, flavor, 'Library', 'Keychains'),
      '/Library/Keychains',
      '/System/Library/Keychains',
      '/private/var/db/SystemKeychain',
      joinBelow(home, flavor, '.local', 'share', 'keyrings'),
    ];
  }
  return [
    joinBelow(home, flavor, '.ssh'),
    joinBelow(home, flavor, '.agentlink'),
    joinBelow(home, flavor, 'AppData', 'Roaming', 'Microsoft', 'Protect'),
    joinBelow(home, flavor, 'AppData', 'Roaming', 'Microsoft', 'Credentials'),
    joinBelow(home, flavor, 'AppData', 'Roaming', 'Microsoft', 'Crypto'),
    joinBelow(home, flavor, 'AppData', 'Local', 'Microsoft', 'Credentials'),
    joinBelow(home, flavor, 'AppData', 'Local', 'Microsoft', 'Vault'),
  ];
}

export interface PathDecisionInput {
  /** The path as requested (after `~` expansion), for the hidden-name check on its last segment. */
  readonly requested: string;
  /** `realpath(requested)`. */
  readonly resolved: string;
  /** `realpath` of each allowed folder that exists. */
  readonly allowedFolders: readonly string[];
  /** Protected roots, in lexical and resolved form (see protectedRoots). */
  readonly protectedRoots: readonly string[];
  readonly flavor: PathFlavor;
}

/**
 * Decides whether a resolved path may be read (04 §4): it must be inside an allowed folder (both
 * sides already resolved), must not be or lie below a hidden segment under that folder, the
 * requested name must not be hidden, and it must not be under a protected root. Protected roots are
 * compared case-insensitively on every platform (macOS volumes usually are), which can only refuse
 * more.
 */
export function decidePath(input: PathDecisionInput): PathCheck {
  const { flavor } = input;
  const requested = parseAbsolutePath(input.requested, flavor);
  const resolved = parseAbsolutePath(input.resolved, flavor);
  if (requested === undefined || resolved === undefined) {
    return { ok: false, reason: 'path_malformed' };
  }
  for (const root of input.protectedRoots) {
    if (segmentsBelow(input.resolved, root, flavor, { caseInsensitive: true }) !== undefined) {
      return { ok: false, reason: 'protected' };
    }
    if (segmentsBelow(input.requested, root, flavor, { caseInsensitive: true }) !== undefined) {
      return { ok: false, reason: 'protected' };
    }
  }
  const folders = input.allowedFolders.filter(
    (folder) => parseAbsolutePath(folder, flavor) !== undefined,
  );
  if (folders.length === 0) return { ok: false, reason: 'no_allowed_folder' };
  const lastRequested = requested.segments[requested.segments.length - 1];
  if (lastRequested !== undefined && lastRequested.startsWith('.')) {
    return { ok: false, reason: 'hidden' };
  }
  let sawInside = false;
  for (const folder of folders) {
    const below = segmentsBelow(input.resolved, folder, flavor);
    if (below === undefined) continue;
    sawInside = true;
    if (below.some((segment) => segment.startsWith('.'))) continue;
    return { ok: true, folder };
  }
  return { ok: false, reason: sawInside ? 'hidden' : 'outside_allowed' };
}
