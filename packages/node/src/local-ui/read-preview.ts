// REL051-A34 (D-149; 08 §1; 04 §4 realpath rules; I-7): the file read behind the in-app preview of
// a received text file. The same checks as Show in Finder (reveal-file.ts), then a bounded read.
//
// Input: the Inbox folder from the rules in force and the single saved name the store recorded for
// a received item (core `filesIo.previewSource`), plus the plaintext hash the message carried and
// the cap. Never a name or a path from the request: the route takes only the item ID.
//
// 1. The name must be one plain segment, as core's sanitizeFileName leaves it; else `refused` before
//    the disk is touched.
// 2. The Inbox folder is resolved to its realpath (existing, outside every protected root, not
//    hidden; nothing created): else `unavailable`.
// 3. The joined path must sit directly in that folder: else `refused`.
// 4. The file is opened once, read-only, with O_NOFOLLOW and O_NONBLOCK; no file is `not_found`, a
//    link or any other open failure `refused` (Windows: a dangling link is refused by the lstat).
// 5. That handle is checked: a regular file the path still names (realpath, device and inode).
// 6. Only through that handle: at most `maxBytes + 1` bytes are read (`too_large` past the cap), the
//    bytes must hash (SHA-256, @4thtech-io/crypto) to the stated plaintext hash (`changed`
//    otherwise: the file was edited or replaced since it arrived), and decode as UTF-8 without NUL
//    (`not_text` otherwise). A leading byte order mark is dropped.
//
// Unlike Show in Finder there is no path handed on: the bytes come from the checked handle, so a
// swap after step 5 cannot change what is read. A hard link to a file elsewhere is the same inode;
// its bytes must still match the hash the sender's message carried. Nothing here logs; outcomes are
// fixed words, never the name, the folder, the text or an error's text.
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { encodeHex, sha256 } from '@4thtech-io/crypto';
import { directlyInsideInbox, resolveInboxFolder, type ResolvedInbox } from '../allowed-path.js';
import { O_NOFOLLOW, O_NONBLOCK, openFailure, plainName, sameRegularFile } from './reveal-file.js';

export type PreviewReadOutcome =
  | { readonly status: 'ok'; readonly text: string }
  | {
      readonly status:
        'not_found' | 'refused' | 'unavailable' | 'too_large' | 'changed' | 'not_text';
    };

export interface PreviewReadLimits {
  /** The plaintext SHA-256 the message carried, 64 lowercase hex. */
  readonly sha256: string;
  /** The most bytes read. */
  readonly maxBytes: number;
}

export interface PreviewReadSeams {
  /** The home folder for `~/` (tests). Default: node:os homedir. */
  readonly home?: string;
  /** Tests: runs after the open, before the handle is checked. */
  readonly afterOpen?: () => Promise<void> | void;
  /** Tests: open as Windows does, without O_NOFOLLOW. Never set outside tests. */
  readonly openFollowsLinks?: true;
}

const HEX64 = /^[0-9a-f]{64}$/;
const fixed = <S extends PreviewReadOutcome['status']>(status: S) =>
  Object.freeze({ status }) as PreviewReadOutcome;

/** Reads at most `max + 1` bytes from the handle; undefined past `max`. */
async function readBounded(handle: FileHandle, max: number): Promise<Uint8Array | undefined> {
  const buffer = new Uint8Array(max + 1);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled > max ? undefined : buffer.subarray(0, filled);
}

/** The text of one saved received file, after the checks above. */
export async function readSavedText(
  inboxFolder: string,
  savedName: string,
  limits: PreviewReadLimits,
  seams: PreviewReadSeams = {},
): Promise<PreviewReadOutcome> {
  if (!plainName(savedName)) return fixed('refused');
  if (!HEX64.test(limits.sha256)) return fixed('refused');
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) return fixed('refused');
  if (typeof inboxFolder !== 'string') return fixed('unavailable');
  let inbox: ResolvedInbox;
  try {
    inbox = await resolveInboxFolder(
      inboxFolder,
      seams.home === undefined ? {} : { home: seams.home },
    );
  } catch {
    return fixed('unavailable');
  }
  const target = path.join(inbox.folder, savedName);
  if (path.basename(target) !== savedName || !directlyInsideInbox(target, inbox)) {
    return fixed('refused');
  }

  let handle: FileHandle;
  try {
    const noFollow = seams.openFollowsLinks === true ? 0 : O_NOFOLLOW;
    handle = await open(target, constants.O_RDONLY | noFollow | O_NONBLOCK);
  } catch (error) {
    return fixed(await openFailure(error, target));
  }
  let bytes: Uint8Array | undefined;
  try {
    if (seams.afterOpen !== undefined) await seams.afterOpen();
    if (!(await sameRegularFile(handle, target))) return fixed('refused');
    const stat = await handle.stat();
    if (stat.size > limits.maxBytes) return fixed('too_large');
    bytes = await readBounded(handle, limits.maxBytes);
  } catch {
    return fixed('unavailable');
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes === undefined) return fixed('too_large');
  if (encodeHex(sha256(bytes)) !== limits.sha256) return fixed('changed');
  if (bytes.includes(0)) return fixed('not_text');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return fixed('not_text');
  }
  return Object.freeze({ status: 'ok', text });
}
