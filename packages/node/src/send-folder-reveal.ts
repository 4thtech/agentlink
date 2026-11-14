// FILES-REVEAL (S2; D-152; 08 §1 "Show in Finder for the folders"; 04 §4 "Pinned at allow time";
// I-4, I-5, I-7): which folder Show in Finder opens for the Send folder. It takes no path from
// anywhere: the folder is the open ID's own Send folder from the verified policy (`ownSendFolder`:
// allowed AND still pinned, so a folder that became a link is not used), and it is checked again
// here right before it is shown: its path is its own realpath, a real directory (lstat), not a link.
// Anything else is the fixed `not_found`; nothing is opened. Only the app host's server holds this
// (no MCP tool reaches it). Fixed answers, nothing is logged, no path leaves this function.
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ownSendFolder } from './send-folder-file.js';

export type SendFolderRevealOutcome =
  'shown' | 'not_found' | 'refused' | 'unavailable' | 'not_opened';

/** What the server hands over: the verified policy reader and the OS revealer (argv, no shell). */
export interface SendFolderRevealSeams {
  readonly loadPolicy: () => Promise<
    | { readonly mode: 'fail_closed' }
    | {
        readonly mode: string;
        readonly policy: { readonly files?: { readonly allowedFolders?: unknown } };
      }
  >;
  readonly revealer: (file: string, folder: string) => Promise<boolean>;
  readonly home?: string;
}

export async function revealOwnSendFolder(
  seams: SendFolderRevealSeams,
): Promise<SendFolderRevealOutcome> {
  let allowed: unknown;
  try {
    const effective = await seams.loadPolicy();
    if (effective.mode === 'fail_closed' || !('policy' in effective)) return 'unavailable';
    allowed = effective.policy.files?.allowedFolders;
  } catch {
    return 'unavailable';
  }
  if (!Array.isArray(allowed) || allowed.length === 0) return 'not_found';
  let folder: string;
  try {
    const own = await ownSendFolder(allowed as string[], seams.home ?? homedir());
    if (own === undefined) return 'not_found';
    folder = own.where;
    const info = await lstat(folder);
    if (info.isSymbolicLink() || !info.isDirectory()) return 'not_found';
    if ((await realpath(folder)) !== folder) return 'not_found';
  } catch {
    return 'not_found';
  }
  try {
    return (await seams.revealer(folder, path.dirname(folder))) ? 'shown' : 'not_opened';
  } catch {
    return 'not_opened';
  }
}
