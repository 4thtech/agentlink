// The Node files platform of the CLI (M1-9d-1; 04 §4, 06 §2.3, 07 §5.6, D-48, D-84). The core does
// no file-system or network I/O of its own (packages/core files/platform.ts); this module supplies:
//
// - nodeFileOpener: the `path` argument of `agentlink_send`, checked with @4thtech-io/node's M1-15
//   guard (`resolveAllowedFile`: realpath on both sides, inside an allowed folder, not hidden, outside
//   the protected roots, a regular file) WITHOUT opening it. The file is opened only when the core
//   reads it, through `openAllowedFile` (the full check again after the open, same device and
//   inode, no final symbolic link followed), and hashed while it is read.
// - nodeFilesPlatform: the allowed folders' realpaths; the encrypted drop (D-48) at its configured
//   origin; the SSRF-safe download of a received file's link (`nodeSafeFetch`, M1-15); and the
//   inbox folder with exclusive, never-following, never-overwriting file operations (D-84).
//
// Nothing here logs. No error carries a path, a file name or a link (I-5, I-7): refusals are fixed
// reasons, other failures fixed text.
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  expandHome,
  isInsideFolder,
  parseAbsolutePath,
  protectedRoots,
  type FilesPlatform,
  type InboxFolder,
  type PathFlavor,
} from '@4thtech-io/core';
import { createSha256, encodeHex } from '@4thtech-io/crypto';
import {
  AllowedPathError,
  freeBytes,
  inboxFolderProblem,
  nodeSafeFetch,
  openAllowedFile,
  openInboxDir,
  quarantineMark,
  resolveAllowedFile,
  type AllowedPathErrorCode,
  type InboxDir,
} from '@4thtech-io/node';
import { DROP_DEFAULT_ENDPOINT, type FetchLike, type TempFileOps } from '@4thtech-io/storage';
import type { AttachOutcome, AttachRefusal, FileOpener } from '@4thtech-io/mcp-tools/context.js';

const FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';
const CHUNK = 64 * 1024;

/** A fixed error: never a path, a name or a link. */
class FilesPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilesPlatformError';
  }
}

const REFUSALS: Record<AllowedPathErrorCode, AttachRefusal> = {
  path_malformed: 'not_allowed',
  not_found: 'not_found',
  no_allowed_folder: 'no_folder',
  outside_allowed: 'outside_folder',
  hidden: 'not_allowed',
  protected: 'not_allowed',
  not_a_file: 'not_allowed',
  changed: 'not_allowed',
  inbox_unavailable: 'not_allowed',
};

export interface NodeFileOpenerOptions {
  /** The home folder `~/` stands for. Default: the OS user's. */
  readonly home?: string;
  /** Test seam: called each time the file is actually opened. */
  readonly onOpen?: () => void;
}

/** Reads an opened file to the end in chunks, then closes it. */
function readStream(
  handle: Awaited<ReturnType<typeof open>>,
  onChunk: (chunk: Uint8Array) => void,
  onEnd: () => void,
): ReadableStream<Uint8Array> {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const buffer = new Uint8Array(CHUNK);
        const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
        if (bytesRead === 0) {
          await close();
          onEnd();
          controller.close();
          return;
        }
        const chunk = buffer.subarray(0, bytesRead);
        onChunk(chunk);
        controller.enqueue(chunk);
      } catch {
        await close();
        controller.error(new FilesPlatformError('The file could not be read.'));
      }
    },
    async cancel() {
      await close();
    },
  });
}

/** The allowed-folder check of `path` arguments (see the header). */
export function nodeFileOpener(options: NodeFileOpenerOptions = {}): FileOpener {
  const home = options.home ?? homedir();
  return Object.freeze<FileOpener>({
    async attach(requested, allowedFolders): Promise<AttachOutcome> {
      const guard = { allowedFolders, home };
      let checked;
      try {
        checked = await resolveAllowedFile(requested, guard);
      } catch (error) {
        if (error instanceof AllowedPathError) return { ok: false, reason: REFUSALS[error.code] };
        return { ok: false, reason: 'not_allowed' };
      }
      const { realPath, size } = checked;
      const name = path.basename(realPath);
      let digest: string | undefined;

      /** Opens through the full check again; the same file the attach checked, or a fixed error. */
      const openChecked = async () => {
        options.onOpen?.();
        const opened = await openAllowedFile(requested, guard).catch(() => {
          throw new FilesPlatformError('The file changed or is no longer allowed.');
        });
        if (opened.file.realPath !== realPath) {
          await opened.handle.close().catch(() => undefined);
          throw new FilesPlatformError('The file changed or is no longer allowed.');
        }
        return opened.handle;
      };

      return {
        ok: true,
        file: {
          name,
          size,
          file: {
            realpath: realPath,
            size,
            async open() {
              const handle = await openChecked();
              const hasher = createSha256();
              return readStream(
                handle,
                (chunk) => hasher.update(chunk),
                () => {
                  digest = encodeHex(hasher.digest());
                },
              );
            },
          },
          async plaintextSha256() {
            if (digest !== undefined) return digest;
            const handle = await openChecked();
            const hasher = createSha256();
            const reader = readStream(
              handle,
              (chunk) => hasher.update(chunk),
              () => undefined,
            ).getReader();
            for (;;) {
              const { done } = await reader.read();
              if (done) break;
            }
            digest = encodeHex(hasher.digest());
            return digest;
          },
        },
      };
    },
  });
}

/**
 * A fetch for the drop (D-48): only https requests to exactly the configured origin, no user info,
 * redirects never followed (07 §5.4). The drop adapter checks every URL the drop returns against the
 * same origin; this guard is the second line.
 */
export function guardedDropFetch(endpoint: string, inner: FetchLike): FetchLike {
  const origin = new URL(endpoint).origin;
  return (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return Promise.reject(new FilesPlatformError('The file service request was refused.'));
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== origin ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return Promise.reject(new FilesPlatformError('The file service request was refused.'));
    }
    return inner(
      new Request(request, { redirect: 'manual', duplex: 'half' } as RequestInit & {
        duplex: 'half';
      }),
    );
  };
}

/** The drop's https origin, as an inbox page shows a received file's `delivery` (06 §2.2). */
export const DROP_ORIGIN = new URL(DROP_DEFAULT_ENDPOINT).origin;

export interface NodeFilesPlatformOptions {
  /** The home folder `~/` stands for. Default: the OS user's. */
  readonly home?: string;
  /**
   * The encrypted drop: default the 4thTech drop with the guarded global fetch; `false` for none
   * (then files above the inline limit need own storage).
   */
  readonly drop?: false | { readonly endpoint: string; readonly fetch: FetchLike };
}

const hiddenSegment = (p: string): boolean =>
  p.split(/[\\/]/).some((segment) => segment.startsWith('.') && segment !== '');

/** Lexical and resolved forms of every protected root (04 §4). */
async function allProtectedRoots(home: string): Promise<string[]> {
  const roots = [...protectedRoots(home, FLAVOR)];
  const homeReal = await realpath(home).catch(() => undefined);
  if (homeReal !== undefined && homeReal !== home) roots.push(...protectedRoots(homeReal, FLAVOR));
  const resolved = await Promise.all(roots.map((r) => realpath(r).catch(() => undefined)));
  return [...roots, ...resolved.filter((r): r is string => r !== undefined)];
}

const isProtected = (p: string, roots: readonly string[]): boolean =>
  roots.some((root) => isInsideFolder(p, root, { flavor: FLAVOR, self: 'inside' }));

const inboxUnavailable = (): FilesPlatformError =>
  new FilesPlatformError('The inbox folder is not available.');

/** A single visible-or-quarantine name directly inside the folder; never a path. */
function entryName(folder: string, name: string): string {
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    /[\\/\0]/.test(name)
  ) {
    throw inboxUnavailable();
  }
  const target = path.join(folder, name);
  if (path.dirname(target) !== folder) throw inboxUnavailable();
  return target;
}

/** A write that ran out of space: the fixed code core reads (04 §4.1 "Disk full"), never a path. */
function spaceError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return Object.assign(new FilesPlatformError('The disk is full.'), { saveError: 'disk_full' });
  }
  return inboxUnavailable();
}

/**
 * File operations on names directly inside `folder` (packages/storage TempFileOps; D-84), each
 * bracketed by the held directory's check (W4-AUTO-SAVE, 04 §4.1): the folder path must still be the
 * directory that passed the rules, and a created file must be the entry at its name.
 */
function inboxOps(folder: string, dir?: InboxDir): TempFileOps {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const same = async (): Promise<void> => {
    if (dir !== undefined && !(await dir.stillSame())) throw inboxUnavailable();
  };
  return Object.freeze<TempFileOps>({
    async create(name) {
      const target = entryName(folder, name);
      await same();
      let handle;
      try {
        // Exclusive (never overwrites, and O_EXCL with O_CREAT never follows a final link), 0600,
        // never executable.
        handle = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
          0o600,
        );
      } catch (error) {
        throw spaceError(error);
      }
      // The file just created must be the entry at its name inside the held folder.
      const created = await handle.stat().catch(() => undefined);
      const entry = await lstat(target).catch(() => undefined);
      if (
        created === undefined ||
        entry === undefined ||
        !entry.isFile() ||
        created.dev !== entry.dev ||
        created.ino !== entry.ino ||
        (dir !== undefined && !(await dir.stillSame()))
      ) {
        await handle.close().catch(() => undefined);
        throw inboxUnavailable();
      }
      return {
        async write(chunk) {
          let offset = 0;
          try {
            while (offset < chunk.length) {
              const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
              offset += bytesWritten;
            }
          } catch (error) {
            throw spaceError(error);
          }
        },
        async close() {
          try {
            await handle.close();
          } catch (error) {
            throw spaceError(error);
          }
        },
      };
    },
    async rename(from, to) {
      const source = entryName(folder, from);
      const target = entryName(folder, to);
      await same();
      // link() fails with EEXIST when the target exists (a file, folder or link): a rename that
      // never overwrites (04 §4.1, the hard-link fallback).
      try {
        await link(source, target);
      } catch {
        throw inboxUnavailable();
      }
      await unlink(source).catch(() => undefined);
      await same();
    },
    async remove(name) {
      const target = entryName(folder, name);
      try {
        await unlink(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw inboxUnavailable();
      }
    },
    async list() {
      try {
        return await readdir(folder);
      } catch {
        throw inboxUnavailable();
      }
    },
  });
}

/** The default Inbox folder: the only one the core creates when it is missing (04 §4.1). */
const DEFAULT_INBOX_FOLDER = '~/AgentLink/Inbox';

/** The realpaths of the policy's allowed send folders that exist. */
async function sendFolderRealpaths(folders: readonly string[], home: string): Promise<string[]> {
  const out: string[] = [];
  for (const folder of folders) {
    const abs = expandHome(folder, home, FLAVOR);
    if (parseAbsolutePath(abs, FLAVOR) === undefined) continue;
    const real = await realpath(abs).catch(() => undefined);
    if (real !== undefined) out.push(real);
    out.push(abs);
  }
  return out;
}

/**
 * Resolves `files.inboxFolder` for one save (see the header) under the folder rules of 04 §4.1
 * (W4-AUTO-SAVE): only the default is created (0700) when missing; the folder is held open as a
 * directory handle for the save, and the core closes it when the save ends.
 */
async function resolveInbox(
  folder: string,
  home: string,
  allowedFolders: readonly string[] = [],
): Promise<InboxFolder> {
  const real = await resolveOwnFolder(folder, home, { create: folder === DEFAULT_INBOX_FOLDER });
  const info = await lstat(real).catch(() => undefined);
  if (info === undefined) throw inboxUnavailable();
  const homeReal = await realpath(home).catch(() => home);
  const problem = await inboxFolderProblem({
    realpath: real,
    home: homeReal,
    sendFolders: await sendFolderRealpaths(allowedFolders, home),
    stat: info,
  });
  if (problem !== undefined) throw inboxUnavailable();
  const dir = await openInboxDir(real, info);
  if (dir === undefined) throw inboxUnavailable();
  return {
    realpath: real,
    ops: inboxOps(real, dir),
    freeBytes: () => freeBytes(real),
    async mark(name) {
      const target = entryName(real, name);
      if (!(await dir.stillSame())) return 'failed';
      const entry = await lstat(target).catch(() => undefined);
      if (entry === undefined || !entry.isFile()) return 'failed';
      return quarantineMark(target);
    },
    async isSavedFile(name) {
      if (!(await dir.stillSame())) return false;
      const entry = await lstat(entryName(real, name)).catch(() => undefined);
      return entry !== undefined && entry.isFile();
    },
    close: () => dir.close(),
  };
}

/**
 * Resolves a folder the user's rules name for AgentLink to write into (`files.inboxFolder`,
 * `proofs.exportFolder`, M1-9d-2): a full path (`~/` expands), not hidden, outside the protected
 * roots before and after realpath, a directory; created (0700) when missing. Returns its realpath;
 * throws a fixed error otherwise.
 */
export async function resolveOwnFolder(
  folder: string,
  home: string,
  options: { readonly create?: boolean } = {},
): Promise<string> {
  if (typeof folder !== 'string') throw inboxUnavailable();
  const abs = expandHome(folder, home, FLAVOR);
  if (parseAbsolutePath(abs, FLAVOR) === undefined || hiddenSegment(abs)) throw inboxUnavailable();
  const roots = await allProtectedRoots(home);
  if (isProtected(abs, roots)) throw inboxUnavailable();
  const existing = await lstat(abs).catch(() => undefined);
  if (existing === undefined) {
    // W4-AUTO-SAVE (04 §4.1): for the Inbox folder only the default is created; any other missing
    // folder is unavailable.
    if (options.create === false) throw inboxUnavailable();
    await mkdir(abs, { recursive: true, mode: 0o700 }).catch(() => {
      throw inboxUnavailable();
    });
  }
  const real = await realpath(abs).catch(() => undefined);
  if (real === undefined || hiddenSegment(real) || isProtected(real, roots)) {
    throw inboxUnavailable();
  }
  const info = await stat(real).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw inboxUnavailable();
  return real;
}

/** The core's FilesPlatform in Node (see the header). */
export function nodeFilesPlatform(options: NodeFilesPlatformOptions = {}): FilesPlatform {
  const home = options.home ?? homedir();
  const download = nodeSafeFetch();
  const drop =
    options.drop === false
      ? undefined
      : (options.drop ?? {
          endpoint: DROP_DEFAULT_ENDPOINT,
          fetch: guardedDropFetch(DROP_DEFAULT_ENDPOINT, (request) => globalThis.fetch(request)),
        });
  return Object.freeze<FilesPlatform>({
    flavor: FLAVOR,
    async allowedFolderRealpaths(folders) {
      const resolved = await Promise.all(
        folders.map(async (folder) => {
          const abs = expandHome(folder, home, FLAVOR);
          if (parseAbsolutePath(abs, FLAVOR) === undefined) return undefined;
          const real = await realpath(abs).catch(() => undefined);
          if (real === undefined) return undefined;
          const info = await stat(real).catch(() => undefined);
          return info?.isDirectory() === true ? real : undefined;
        }),
      );
      return resolved.filter((r): r is string => r !== undefined);
    },
    ...(drop === undefined ? {} : { drop: { endpoint: drop.endpoint, fetch: drop.fetch } }),
    download: (url) => async (maxBytes, onChunk) => {
      await download(url, { maxBytes, onChunk });
    },
    inbox: (folder, allowedFolders) => resolveInbox(folder, home, allowedFolders),
  });
}
