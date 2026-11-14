// ATT-APP-ATTACH (08 §1 "Attach a file"; 04 §4; D-121 D6; proposed, owner confirms at merge): a
// file the owner attaches in the app's conversation, checked and written into the open ID's allowed
// Send folder, from where the ordinary send takes it.
//
// - attachName: core's sanitizeFileName (one plain segment: no separator, no control, format or
//   bidi character, no leading dot, Windows device names prefixed, at most 255 UTF-8 bytes), then
//   the type allowlist on the sanitised name's last extension: .md, .markdown, .txt, .json. Light
//   text only, Markdown first; every other type is refused (also `notes.md.exe`).
// - attachProblem: at most ATTACH_MAX_FILE_BYTES (8 MiB); no NUL byte; valid UTF-8 (fatal decode).
// - writeSendFolderFile: the folder is the ID's own Send folder (`~/AgentLink/Send`, or the
//   `Send-2` ... `Send-9` set-up made beside an unusable one), and only while it is allowed and
//   PINNED (allowed-path `pinnedAllowedFolders`: its realpath is where it was allowed, so a Send
//   folder that became a link is not used). Another allowed folder is never written to (IR-ATTACH-1
//   F-3): without the Send folder the answer is `no_folder`. The folder is held (inbox-folder `openInboxDir`: O_DIRECTORY |
//   O_NOFOLLOW, same device and inode) for the whole write. The file is created with O_CREAT |
//   O_EXCL | O_NOFOLLOW, mode 0600, so nothing existing is overwritten and a planted link is never
//   followed: a clash takes `name (2).md`, `name (3).md`, … Then the written path must pass the full
//   04 §4 check (`resolveAllowedFile`: realpath inside an allowed folder, not hidden, not protected,
//   a regular file) and the folder must still be the held one; otherwise the file is removed.
//
// Two callers (D-152 amends D-150 (2) for this writer only): the local app's attach route
// (local-ui/api/attach.ts, behind the session, CSRF and Origin gate), and, since FILES-AI-1, core's
// `sendMessage` with `contentFile` (agentlink_send `file: {name, content}`, 06 §2.3 "Send by content")
// through the runtime's files platform. MCP reaches it only that way: the folders are the verified
// policy's, the call names no folder, and the writer picks only the ID's own pinned Send folder
// (I-4). For that caller, `reserve` (the core's budget step) runs once the folder is held and before
// anything is created; the attempt limit is `name_taken`. Nothing here logs. Results and errors are
// fixed codes, never a path or a name (I-5, I-7).
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { sanitizeFileName } from '@4thtech-io/core';
import { pinnedAllowedFolders, pinnedLocation, resolveAllowedFile } from './allowed-path.js';
import { openInboxDir } from './inbox-folder.js';
import { SEND_FOLDER_FALLBACKS, SEND_FOLDER_SEGMENTS } from './owner-first-policy.js';

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
export type SendFolderWriteRefusal =
  | 'type'
  | 'no_folder'
  | 'folder_unavailable'
  /** FILES-AI-1: every name up to the attempt limit is taken. */
  | 'name_taken'
  /** FILES-AI-1: the budget reservation refused (over the daily budget). */
  | 'budget'
  /** FILES-AI-1: the budget ledger could not be read (fail closed). */
  | 'budget_unavailable';

export type SendFolderWrite =
  | {
      readonly ok: true;
      /** The written file's real path (never shown or logged). */
      readonly realpath: string;
      /** The name it got (`name (2).md` after a clash). */
      readonly name: string;
      /** The Send folder in its fixed home-relative form (`~/AgentLink/Send`, `Send-2` … `Send-9`). */
      readonly sendFolder: string;
      /** Removes the file this call wrote (best effort; only that name in that folder). */
      remove(): Promise<void>;
    }
  | { readonly ok: false; readonly reason: SendFolderWriteRefusal };

const [SEND_PARENT, SEND_NAME] = SEND_FOLDER_SEGMENTS as readonly [string, string];
/** The ID's own Send folder, in order: `~/AgentLink/Send`, then `~/AgentLink/Send-2` ... `Send-9`. */
const SEND_CANDIDATES: readonly string[] = [SEND_NAME, ...SEND_FOLDER_FALLBACKS].map(
  (name) => `~/${SEND_PARENT}/${name}`,
);
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

/** The ID's own pinned Send folder: its realpath and its fixed `~` form; never another folder. */
export async function ownSendFolder(
  allowedFolders: readonly string[],
  home: string,
): Promise<{ readonly where: string; readonly shown: string } | undefined> {
  const pinned = await pinnedAllowedFolders(allowedFolders, home);
  if (pinned.length === 0) return undefined;
  const realHome = await realpath(home).catch(() => home);
  // IR-ATTACH-1 F-3: only the ID's own Send folder (`~/AgentLink/Send`, or the `Send-2` ... `Send-9`
  // set-up made beside an unusable one), never another allowed folder the owner allowed for his AI.
  for (const candidate of SEND_CANDIDATES) {
    const where = pinnedLocation(candidate, realHome);
    if (where !== undefined && pinned.includes(where)) return { where, shown: candidate };
  }
  return undefined;
}

/**
 * FILES-AI-1: the package-entry form for the runtime's files platform (core's `contentFile` sends):
 * `reserve` is REQUIRED, so no caller outside this package writes without the budget step. Without
 * a function it writes nothing (`budget_unavailable`). The attach route keeps the optional form.
 */
export function writeSendFolderContentFile(input: {
  readonly allowedFolders: readonly string[];
  readonly name: unknown;
  readonly bytes: Uint8Array;
  readonly home?: string;
  readonly reserve: () => Promise<'ok' | 'over' | 'unavailable'>;
}): Promise<SendFolderWrite> {
  if (typeof input?.reserve !== 'function') {
    return Promise.resolve({ ok: false, reason: 'budget_unavailable' });
  }
  return writeSendFolderFile(input);
}

/** Writes `bytes` as a new file in the open ID's Send folder (see the header). */
export async function writeSendFolderFile(input: {
  readonly allowedFolders: readonly string[];
  readonly name: unknown;
  readonly bytes: Uint8Array;
  readonly home?: string;
  /**
   * FILES-AI-1: the core's budget step, called once after the folder is held and before anything is
   * created. Anything but 'ok' writes nothing.
   */
  readonly reserve?: () => Promise<'ok' | 'over' | 'unavailable'>;
}): Promise<SendFolderWrite> {
  const base = attachName(input.name);
  if (base === undefined) return { ok: false, reason: 'type' };
  const home = input.home ?? homedir();
  const allowed = Array.isArray(input.allowedFolders) ? input.allowedFolders : [];
  const send = await ownSendFolder(allowed, home);
  if (send === undefined) return { ok: false, reason: 'no_folder' };
  const folder = send.where;
  const info = await lstat(folder).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return { ok: false, reason: 'no_folder' };
  const held = await openInboxDir(folder, info);
  if (held === undefined) return { ok: false, reason: 'folder_unavailable' };
  try {
    if (input.reserve !== undefined) {
      let reserved: 'ok' | 'over' | 'unavailable';
      try {
        reserved = await input.reserve();
      } catch {
        reserved = 'unavailable';
      }
      if (reserved === 'over') return { ok: false, reason: 'budget' };
      if (reserved !== 'ok') return { ok: false, reason: 'budget_unavailable' };
    }
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
      return { ok: true, realpath: target, name, sendFolder: send.shown, remove };
    }
    return { ok: false, reason: 'name_taken' };
  } finally {
    await held.close();
  }
}
