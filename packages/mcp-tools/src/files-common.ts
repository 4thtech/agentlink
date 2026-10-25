// Fixed text and mappings shared by the file tools (M1-9d-1; 06 §2.2, §2.3, §1 rule 3; 11 §5).
//
// I-5, I-7: no slot takes a path, a file name, a link or any other value. A refusal names what
// happened and the plain next step; words such as storage provider, link signing or network
// internals never appear (11 §5.1). Local settings links (11 §6.1 `{url}`) are not offered: the
// local settings page has not landed, so the next step says who can act instead.
import type { CoreErrorCode, FilesNeedsSetup } from '@4thtech-io/core';
import type { AttachRefusal } from './context.js';
import { fail, type HandlerOutput } from './result.js';
import { NPX_COMMAND } from './cli-command.js';

export const FILE_TEXT = Object.freeze({
  noFolder: 'No folder is allowed for sending files yet, so nothing was sent.',
  noFolderNextStep: `Tell the user: files can only be sent from a folder they allow. In a terminal they opened themselves, they run \`${NPX_COMMAND} policy allow-folder <path>\`, with \`--agent <name>\` if they have more than one agent. Then call again.`,
  outsideFolder: "That file isn't in a folder the user allows for sending, so nothing was sent.",
  outsideFolderNextStep: `Ask the user to put the file in a folder they allow for sending, or to allow its folder: in a terminal they opened themselves, they run \`${NPX_COMMAND} policy allow-folder <path>\`, with \`--agent <name>\` if they have more than one agent. Then call again.`,
  notAllowed: "That path can't be sent: it must be a full path to a regular, visible file.",
  notAllowedNextStep:
    "Use the file's full path. Hidden files and protected private folders can never be sent.",
  notFound: "That file wasn't found, so nothing was sent.",
  notFoundNextStep: 'Check the full path of the file and call again.',
  ownStorage: 'This file is too large for the free encrypted file service, so nothing was sent.',
  ownStorageNextStep:
    "Tell the user this file needs their own file storage, which isn't set up yet. Only they can set it up. A smaller file can be sent now.",
  policyStorage:
    "The user's rules keep files in their own storage, which isn't set up yet, so nothing was sent.",
  fileTooLarge: "This file is larger than the user's rules allow, so nothing was sent.",
  fileTooLargeNextStep: 'Send a smaller file. Only the user can change their size limit for files.',
  payloadTooLarge: "These files don't fit in one message, so nothing was sent.",
  payloadTooLargeNextStep: 'Send fewer or smaller files in this message, or send them one by one.',
  storageUnavailable: "File storage isn't available right now, so nothing was sent.",
  storageUnavailableNextStep: `Try again later. If it keeps failing, the user can run \`${NPX_COMMAND} doctor\` in their own terminal.`,
  storageFailed: "The file couldn't be stored, so nothing was sent.",
  storageFailedNextStep: `Try again later. If it keeps failing, the user can run \`${NPX_COMMAND} doctor\` in their own terminal.`,
  fileChanged: 'The file changed while it was being sent, so nothing was sent.',
  fileChangedNextStep: 'Wait until the file is no longer being written, then call again.',
  filesUnavailable: "Files can't be sent or saved here right now, so nothing was done.",
  filesUnavailableNextStep: `Tell the user AgentLink could not use files on this machine. They can run \`${NPX_COMMAND} doctor\` in their own terminal.`,
});

/** The `needs_setup` for a path the platform refused (06 §2.3; nothing was opened or sent). */
export function attachRefusal(reason: AttachRefusal): HandlerOutput {
  switch (reason) {
    case 'no_folder':
      return fail(
        'needs_setup',
        FILE_TEXT.noFolder,
        FILE_TEXT.noFolderNextStep,
        'NO_ALLOWED_FOLDER',
      );
    case 'outside_folder':
      return fail(
        'needs_setup',
        FILE_TEXT.outsideFolder,
        FILE_TEXT.outsideFolderNextStep,
        'OUTSIDE_ALLOWED_FOLDER',
      );
    case 'not_found':
      return fail('not_found', FILE_TEXT.notFound, FILE_TEXT.notFoundNextStep, 'FILE_NOT_FOUND');
    default:
      return fail(
        'rejected',
        FILE_TEXT.notAllowed,
        FILE_TEXT.notAllowedNextStep,
        'PATH_NOT_ALLOWED',
      );
  }
}

/** The core's file `needs_setup` reasons (06 §2.3, 07 §5.6) in plain language. */
export function filesNeedsSetup(reason: FilesNeedsSetup): HandlerOutput {
  switch (reason) {
    case 'no_folder':
    case 'outside_folder':
      return attachRefusal(reason);
    case 'no_own_storage':
      return fail(
        'needs_setup',
        FILE_TEXT.policyStorage,
        FILE_TEXT.ownStorageNextStep,
        'NEEDS_OWN_STORAGE',
      );
    default:
      // `size` and `quota`: above the drop's size cap or its weekly allowance (D-48).
      return fail(
        'needs_setup',
        FILE_TEXT.ownStorage,
        FILE_TEXT.ownStorageNextStep,
        'NEEDS_OWN_STORAGE',
      );
  }
}

/** Fixed results for the core's file error codes; undefined for any other code. */
export function fileErrorOutput(code: CoreErrorCode): HandlerOutput | undefined {
  switch (code) {
    case 'storage_unavailable':
      return fail(
        'error',
        FILE_TEXT.storageUnavailable,
        FILE_TEXT.storageUnavailableNextStep,
        'STORAGE_UNAVAILABLE',
      );
    case 'storage_failed':
      return fail(
        'error',
        FILE_TEXT.storageFailed,
        FILE_TEXT.storageFailedNextStep,
        'STORAGE_FAILED',
      );
    case 'file_changed':
      return fail('error', FILE_TEXT.fileChanged, FILE_TEXT.fileChangedNextStep, 'FILE_CHANGED');
    case 'files_unavailable':
    case 'files_invalid':
      return fail(
        'error',
        FILE_TEXT.filesUnavailable,
        FILE_TEXT.filesUnavailableNextStep,
        'FILES_UNAVAILABLE',
      );
    default:
      return undefined;
  }
}

/** RFC 3339 UTC, seconds, from unix seconds. */
export const isoSeconds = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
