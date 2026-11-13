// Fixed text and mappings shared by the file tools (M1-9d-1; 06 §2.2, §2.3, §1 rule 3; 11 §5).
//
// I-5, I-7: no slot takes a path, a file name, a link or any other value. A refusal names what
// happened and the plain next step; words such as storage provider, link signing or network
// internals never appear (11 §5.1). The allowed-folder steps name the app's own control (Settings,
// Files, Allow a folder). ATT-ALLOW-LINK: under `agentlink mcp`, the no-folder result also carries
// the app link to Settings > Files with the Send folder filled in (withAllowFolderLink); otherwise
// only an approval request has a local app link (06 §2.5).
import type { CoreErrorCode, FilesNeedsSetup } from '@4thtech-io/core';
import type { AttachRefusal, ToolContext } from './context.js';
import { fail, resultIsValid, type HandlerOutput } from './result.js';
import { NPX_COMMAND } from './cli-command.js';

export const FILE_TEXT = Object.freeze({
  noFolder: 'No folder is allowed for sending files yet, so nothing was sent.',
  // ATT-ALLOW-LINK: the app only, never a terminal command. Home offers "Allow Send folder"; Settings,
  // Files, Allow a folder is the other way. No tool can allow a folder (I-4), only the user, with
  // Touch ID or the master code in the app.
  noFolderNextStep:
    "Tell the user: files can only be sent from a folder they allow. On Home in the AgentLink app they choose Allow Send folder, or they open Settings, then Files, then Allow a folder. You can't allow it for them. Then put the file in their Send folder, or in the folder they allowed, and call again.",
  outsideFolder: "That file isn't in a folder the user allows for sending, so nothing was sent.",
  outsideFolderNextStep: `Tell the user: this file's folder isn't allowed yet. In the AgentLink app they open Settings, then Files, then Allow a folder, and choose the folder the file is in. You can't allow it for them. Then call again. Without the app, in a terminal they opened themselves they run \`${NPX_COMMAND} policy allow-folder <path>\` (add \`--agent <name>\` if they have more than one ID).`,
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

/**
 * ATT-ALLOW-LINK: the app page the no-folder result links to: Settings > Files with the Send folder
 * filled in. Fixed: nothing from a call reaches it. It only fills the field; the owner reviews and
 * confirms with presence in the app (I-4).
 */
export const ALLOW_SEND_FOLDER_PAGE = '/settings/files?folder=~%2FAgentLink%2FSend';

/** The local UI origin (08 §1, D-79): `http://localhost:<port>`, nothing else. */
const UI_ORIGIN = /^http:\/\/localhost:([1-9][0-9]{0,4})$/;

/** The origin of an allow-folder link, or undefined when it is anything but the fixed page. */
function allowFolderOrigin(url: string): string | undefined {
  if (!url.endsWith(ALLOW_SEND_FOLDER_PAGE)) return undefined;
  const origin = url.slice(0, url.length - ALLOW_SEND_FOLDER_PAGE.length);
  const port = UI_ORIGIN.exec(origin)?.[1];
  return port !== undefined && Number(port) <= 65_535 ? origin : undefined;
}

/**
 * ATT-ALLOW-LINK: the no-folder nextStep with the app link, fixed text around the one checked url.
 * No terminal command. Throws for any url other than the fixed page on the local UI origin.
 */
export function allowFolderLinkNextStep(url: string): string {
  if (allowFolderOrigin(url) === undefined) throw new Error('not the allow-folder link');
  return `Never open or fetch this link yourself. Tell the user: files can only be sent from a folder they allow. They allow their Send folder in the AgentLink app, on Home or at ${url}, and confirm it themselves. You can't allow it for them. Then put the file in their Send folder and call again.`;
}

/**
 * ATT-ALLOW-LINK: adds the allow-folder link to a NO_ALLOWED_FOLDER result (`url` and the link
 * nextStep). Fails closed to the fixed result: no provider, a provider that fails or gives nothing,
 * a url that is not the fixed page on the local UI origin, an origin that does not match it, or a
 * result that breaks a rule. Only the url is taken from the provider; the text is ours.
 */
export async function withAllowFolderLink(
  output: HandlerOutput,
  context: ToolContext,
): Promise<{ readonly output: HandlerOutput; readonly origins: readonly string[] }> {
  const unchanged = { output, origins: context.urlOrigins };
  const result = output.result;
  if (
    context.allowFolderLink === undefined ||
    result.status !== 'needs_setup' ||
    result.code !== 'NO_ALLOWED_FOLDER' ||
    result.url !== undefined ||
    output.text !== undefined
  ) {
    return unchanged;
  }
  let link: Awaited<ReturnType<NonNullable<ToolContext['allowFolderLink']>>>;
  try {
    link = await context.allowFolderLink();
  } catch {
    // The error could carry a value (I-7): never logged or returned.
    return unchanged;
  }
  if (link === undefined || typeof link.url !== 'string') return unchanged;
  const origin = allowFolderOrigin(link.url);
  if (origin === undefined || origin !== link.origin) return unchanged;
  const linked: HandlerOutput = {
    result: { ...result, url: link.url, nextStep: allowFolderLinkNextStep(link.url) },
  };
  const origins = [...context.urlOrigins, origin];
  return resultIsValid(linked.result, origins) ? { output: linked, origins } : unchanged;
}

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
