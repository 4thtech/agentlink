// MSG-FILES-IO-h: the file check behind Show in Finder (08 §1; 04 §2.5, §4 realpath rules; D-134;
// I-4, I-7).
//
// Input: the Inbox folder from the rules in force and the single saved name the store recorded for a
// received item (core `filesIo.savedName`). Never a name or a path from the request: the route takes
// only the item ID.
//
// 1. The name must be one plain segment, exactly as core's sanitizeFileName would leave it (no
//    separator, no `.` or `..`, no control or bidi character, at most 255 bytes); else `refused`
//    before the disk is touched.
// 2. The Inbox folder is resolved to its realpath (an existing folder, outside every protected root,
//    not hidden; nothing is created): else `unavailable`.
// 3. The joined path must sit directly in that folder and pass decidePath: else `refused`.
// 4. The file is opened once, read-only, with O_NOFOLLOW (a final link is not followed) and
//    O_NONBLOCK (a FIFO cannot block): no file is `not_found`; a link or any other open failure is
//    `refused` (or `unavailable` for an I/O error). There is no lstat-then-open step.
// 5. That handle is checked: a regular file, and the path still names it (realpath equals the joined
//    path, and its device and inode equal the handle's). Any doubt is `refused`. The handle is closed.
// 6. Only then the checked path (and the folder, for Linux) goes to the OS revealer, which runs a
//    fixed program by absolute path with the path as one argument, never through a shell.
//
// Residuals (threat note in the PR): the revealer gets a path, not the handle, so a same-user process
// could swap the file between step 5 and the reveal; the OS file manager then only selects whatever
// is at that path inside the Inbox, and nothing is opened, run or read (04 §2.5: such a process can
// already open Finder itself). A hard link to a file elsewhere is the same inode and is not detected.
// Windows has no O_NOFOLLOW; there the realpath and inode re-check of step 5 refuses a link.
// Nothing here logs; outcomes are fixed words, never the name, the folder or an error's text.
import { constants, type Stats } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeFileName } from '@4thtech-io/core';
import { directlyInsideInbox, resolveInboxFolder, type ResolvedInbox } from '../allowed-path.js';
import type { FileRevealer } from '../approval-os.js';

/** What Show in Finder came to. */
export type RevealOutcome = 'shown' | 'not_found' | 'refused' | 'unavailable' | 'not_opened';

export interface RevealSeams {
  /** The OS revealer (approval-os.ts fileRevealerWith). */
  readonly opener: FileRevealer;
  /** The home folder for `~/` (tests). Default: node:os homedir. */
  readonly home?: string;
  /** Tests: runs after the open, before the handle is checked. */
  readonly afterOpen?: () => Promise<void> | void;
}

const MAX_NAME_BYTES = 255;

/** One plain segment, exactly as core's sanitizeFileName leaves a name. */
function plainName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) return false;
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return false;
  try {
    return sanitizeFileName(name) === name;
  } catch {
    return false;
  }
}

const OPEN_FLAGS =
  constants.O_RDONLY |
  ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) |
  ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0);

/** The open's failure as an outcome: no file is `not_found`; anything else fails closed. */
function openFailure(error: unknown): RevealOutcome {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'not_found';
  if (code === 'EIO' || code === 'EMFILE' || code === 'ENFILE') return 'unavailable';
  // ELOOP / EMLINK / EFTYPE (a final link), ENOTDIR, EACCES, ENXIO (a socket), anything else.
  return 'refused';
}

/** Step 5: the opened handle is a regular file that `target` still names. */
async function sameRegularFile(handle: FileHandle, target: string): Promise<boolean> {
  let opened: Stats;
  let current: Stats;
  let real: string;
  try {
    opened = await handle.stat();
    if (!opened.isFile()) return false;
    real = await realpath(target);
    current = await stat(target);
  } catch {
    return false;
  }
  return (
    real === target && current.isFile() && current.dev === opened.dev && current.ino === opened.ino
  );
}

/** Shows one saved received file in the OS file manager, after the checks above. */
export async function revealSavedFile(
  inboxFolder: string,
  savedName: string,
  seams: RevealSeams,
): Promise<RevealOutcome> {
  if (!plainName(savedName)) return 'refused';
  if (typeof inboxFolder !== 'string') return 'unavailable';
  let inbox: ResolvedInbox;
  try {
    inbox = await resolveInboxFolder(
      inboxFolder,
      seams.home === undefined ? {} : { home: seams.home },
    );
  } catch {
    return 'unavailable';
  }
  const target = path.join(inbox.folder, savedName);
  if (path.basename(target) !== savedName || !directlyInsideInbox(target, inbox)) return 'refused';

  let handle: FileHandle;
  try {
    handle = await open(target, OPEN_FLAGS);
  } catch (error) {
    return openFailure(error);
  }
  let checked: boolean;
  try {
    if (seams.afterOpen !== undefined) await seams.afterOpen();
    checked = await sameRegularFile(handle, target);
  } catch {
    checked = false;
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!checked) return 'refused';

  try {
    return (await seams.opener(target, inbox.folder)) ? 'shown' : 'not_opened';
  } catch {
    return 'not_opened';
  }
}
