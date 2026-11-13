// ATT-APP-ATTACH (08 §1 "Attach a file"; 04 §4; D-121 D6; proposed, owner confirms at merge): a
// file the owner attaches in the app's conversation, checked and written into the open ID's allowed
// Send folder, from where the ordinary send takes it.
//
// - attachName: core's sanitizeFileName (one plain segment: no separator, no control, format or
//   bidi character, no leading dot, Windows device names prefixed, at most 255 UTF-8 bytes), then
//   the type allowlist on the sanitised name's last extension: .md, .markdown, .txt, .json. Light
//   text only, Markdown first; every other type is refused (also `notes.md.exe`).
// - attachProblem: at most ATTACH_MAX_FILE_BYTES (8 MiB); no NUL byte; valid UTF-8 (fatal decode).
// - writeSendFolderFile: the folder is a PINNED allowed folder (allowed-path `pinnedAllowedFolders`:
//   its realpath is where it was allowed, so a Send folder that became a link is not used), the
//   default `~/AgentLink/Send` first. The folder is held (inbox-folder `openInboxDir`: O_DIRECTORY |
//   O_NOFOLLOW, same device and inode) for the whole write. The file is created with O_CREAT |
//   O_EXCL | O_NOFOLLOW, mode 0600, so nothing existing is overwritten and a planted link is never
//   followed: a clash takes `name (2).md`, `name (3).md`, … Then the written path must pass the full
//   04 §4 check (`resolveAllowedFile`: realpath inside an allowed folder, not hidden, not protected,
//   a regular file) and the folder must still be the held one; otherwise the file is removed.
//
// Not exported from the package entry and never reached from MCP (I-4): only the local app's attach
// route (local-ui/api/attach.ts, behind the session, CSRF and Origin gate) calls it. Nothing here
// logs. Results and errors are fixed codes, never a path or a name (I-5, I-7).
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { sanitizeFileName } from '@4thtech-io/core';
import { pinnedAllowedFolders, pinnedLocation, resolveAllowedFile } from './allowed-path.js';
import { openInboxDir } from './inbox-folder.js';

/** The types the owner may attach in the app (lowercase extensions, no dot). */
export const ATTACH_EXTENSIONS: readonly string[] = Object.freeze([
  'md',
  'markdown',
  'txt',
  'json',
]);
/** The largest file the owner may attach in the app: text files are light. */
export const ATTACH_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The most files in one attached message. */
export const ATTACH_MAX_FILES = 5;
/** All files of one attached message together. */
export const ATTACH_MAX_TOTAL_BYTES = ATTACH_MAX_FILE_BYTES;

/** Why the bytes are refused. */
export type AttachProblem = 'too_large' | 'not_text';

/** Why a write did not happen (fixed codes only). */
export type SendFolderWriteRefusal = 'type' | 'no_folder' | 'folder_unavailable';

export type SendFolderWrite =
  | {
      readonly ok: true;
      /** The written file's real path (never shown or logged). */
      readonly realpath: string;
      /** The name it got (`name (2).md` after a clash). */
      readonly name: string;
      /** Removes the file this call wrote (best effort; only that name in that folder). */
      remove(): Promise<void>;
    }
  | { readonly ok: false; readonly reason: SendFolderWriteRefusal };

const DEFAULT_SEND = '~/AgentLink/Send';
const MAX_NAME_BYTES = 255;
const MAX_ATTEMPTS = 100;
const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const Utf8 = new TextDecoder('utf-8', { fatal: true });

/** The sanitised name when its type is allowed; otherwise undefined. */
export function attachName(untrusted: unknown): string | undefined {
  if (typeof untrusted !== 'string' || untrusted.length === 0) return undefined;
  const name = sanitizeFileName(untrusted);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return ATTACH_EXTENSIONS.includes(ext) ? name : undefined;
}

/** Undefined when the bytes are light, valid UTF-8 text without NUL. */
export function attachProblem(bytes: Uint8Array): AttachProblem | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.length > ATTACH_MAX_FILE_BYTES) return 'too_large';
  if (bytes.includes(0)) return 'not_text';
  try {
    Utf8.decode(bytes);
  } catch {
    return 'not_text';
  }
  return undefined;
}

function truncateUtf8(text: string, bytes: number): string {
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out + ch, 'utf8') > bytes) break;
    out += ch;
  }
  return out;
}

/** `name`, or `stem (n).ext` for n ≥ 2, within 255 bytes. */
function numbered(name: string, n: number): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const tail = ` (${String(n)})${ext}`;
  const room = MAX_NAME_BYTES - Buffer.byteLength(tail, 'utf8');
  return `${truncateUtf8(stem, room).replace(/\s+$/u, '')}${tail}`;
}

/** The folder to write into: the pinned default Send folder, else the first pinned allowed one. */
async function sendFolder(
  allowedFolders: readonly string[],
  home: string,
): Promise<string | undefined> {
  const pinned = await pinnedAllowedFolders(allowedFolders, home);
  if (pinned.length === 0) return undefined;
  const realHome = await realpath(home).catch(() => home);
  const preferred = pinnedLocation(DEFAULT_SEND, realHome);
  return pinned.find((f) => f === preferred) ?? pinned[0];
}

/** Writes `bytes` as a new file in the open ID's Send folder (see the header). */
export async function writeSendFolderFile(input: {
  readonly allowedFolders: readonly string[];
  readonly name: unknown;
  readonly bytes: Uint8Array;
  readonly home?: string;
}): Promise<SendFolderWrite> {
  const base = attachName(input.name);
  if (base === undefined) return { ok: false, reason: 'type' };
  const home = input.home ?? homedir();
  const allowed = Array.isArray(input.allowedFolders) ? input.allowedFolders : [];
  const folder = await sendFolder(allowed, home);
  if (folder === undefined) return { ok: false, reason: 'no_folder' };
  const info = await lstat(folder).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return { ok: false, reason: 'no_folder' };
  const held = await openInboxDir(folder, info);
  if (held === undefined) return { ok: false, reason: 'folder_unavailable' };
  try {
    for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
      const name = numbered(base, n);
      const target = path.join(folder, name);
      if (path.dirname(target) !== folder || path.basename(target) !== name) {
        return { ok: false, reason: 'folder_unavailable' };
      }
      if (!(await held.stillSame())) return { ok: false, reason: 'folder_unavailable' };
      let handle;
      try {
        handle = await open(
          target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        return { ok: false, reason: 'folder_unavailable' };
      }
      const created = await handle.stat().catch(() => undefined);
      const remove = async (): Promise<void> => {
        // Only the entry this call created: same device and inode, never through a link.
        const now = await lstat(target).catch(() => undefined);
        if (
          created !== undefined &&
          now !== undefined &&
          now.isFile() &&
          now.dev === created.dev &&
          now.ino === created.ino
        ) {
          await unlink(target).catch(() => undefined);
        }
      };
      try {
        await handle.writeFile(input.bytes);
      } catch {
        await handle.close().catch(() => undefined);
        await remove();
        return { ok: false, reason: 'folder_unavailable' };
      }
      await handle.close().catch(() => undefined);
      // The full 04 §4 check on the written path, and the folder still the one held.
      let checked;
      try {
        checked = await resolveAllowedFile(target, { allowedFolders: allowed, home });
      } catch {
        checked = undefined;
      }
      if (
        checked === undefined ||
        checked.realPath !== target ||
        checked.size !== input.bytes.length ||
        !(await held.stillSame())
      ) {
        await remove();
        return { ok: false, reason: 'folder_unavailable' };
      }
      return { ok: true, realpath: target, name, remove };
    }
    return { ok: false, reason: 'folder_unavailable' };
  } finally {
    await held.close();
  }
}
