// `agentlink_fetch_file` (06 §2.3, §2.0, §1 rule 3, §4; 04 §4; D-84; M1-9d-1).
//
// Core `fetchFile` (M1-7f) does the work: the receive size cap before anything is fetched, the
// SSRF-safe download of the payload's link (the platform's, 04 §4), both hashes checked before the
// file gets its final name, a sanitised name that never overwrites, saved only into
// `files.inboxFolder`, never executed. This handler maps its result.
//
// I-5, I-7: the saved name is the sender's text (sanitised): it appears in `name` and `savedTo` (06
// §2.3) and, in the text result, only inside the untrusted block (06 §4), never in the summary,
// `nextStep` or an error. The link, the file key and the locator never reach the handler at all
// (IR-D48-1 F15f). Not read-only (it writes a file) and not idempotent: a second call saves a
// second copy under a new name (06 §2.0).
import { CoreError, type CoreErrorCode } from '@4thtech-io/core';
import type { ToolContext } from './context.js';
import { FILE_TEXT, fileErrorOutput } from './files-common.js';
import {
  fail,
  internalError,
  invalidArgument,
  notAvailable,
  ok,
  type HandlerOutput,
} from './result.js';
import { noOwnerCard } from './text.js';
import { untrustedBlock, untrustedText } from './untrusted.js';

/** Fixed text for this tool (I-5: no slot takes the sender's text). */
export const FETCH_FILE_TEXT = Object.freeze({
  saved:
    'Saved the file into the AgentLink inbox folder. Both checks passed: it arrived complete and unchanged.',
  blockHeader: 'Saved file. Its name is as the sender gave it, made safe:',
  notFound: "That message or file wasn't found, so nothing was saved.",
  notFoundNextStep:
    'Check the envelopeId and fileIndex in agentlink_inbox, then call again with a file from a message there.',
  tooLarge: "This file is larger than the user's rules allow to receive, so it wasn't saved.",
  tooLargeNextStep: 'Tell the user. Only they can change their size limit for received files.',
  integrity: "The file didn't arrive complete and unchanged, so it wasn't saved.",
  integrityNextStep:
    'Tell the user the file failed its integrity check. They can ask the sender to send it again.',
  expired: 'This file is no longer available: its link expired, so nothing was saved.',
  expiredNextStep: 'Ask the sender to send the file again.',
  refused: "This file's location isn't allowed, so it wasn't downloaded or saved.",
  refusedNextStep:
    'Tell the user the file came from a location AgentLink does not download from. Nothing else is needed.',
  policyDenied: "The user's rules don't allow saving this file, so it wasn't saved.",
  policyDeniedNextStep:
    'Tell the user their AgentLink rules blocked this file. Only they can change the rules.',
  inbox: "The AgentLink inbox folder can't take files right now, so nothing was saved.",
  inboxNextStep:
    'Tell the user their AgentLink inbox folder is missing, hidden or protected. Only they can choose another one.',
  download: "The file couldn't be downloaded, so nothing was saved.",
  downloadNextStep:
    'Try again in a few minutes. If it keeps failing, ask the sender to send it again.',
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function coreErrorOutput(code: CoreErrorCode): HandlerOutput | undefined {
  switch (code) {
    case 'identity_missing':
      return fail('needs_setup', noOwnerCard().summary, noOwnerCard().nextStep);
    case 'inbox_unavailable':
      return fail(
        'error',
        FETCH_FILE_TEXT.inbox,
        FETCH_FILE_TEXT.inboxNextStep,
        'INBOX_UNAVAILABLE',
      );
    case 'file_download_failed':
      return fail(
        'error',
        FETCH_FILE_TEXT.download,
        FETCH_FILE_TEXT.downloadNextStep,
        'DOWNLOAD_FAILED',
      );
    default:
      return fileErrorOutput(code);
  }
}

export async function fetchFileHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const { envelopeId, fileIndex } = input;
  if (typeof envelopeId !== 'string') return invalidArgument();
  const { client, logger } = context;
  if ((await client.self()) === undefined) {
    return fail(
      'needs_setup',
      noOwnerCard(context.agentName).summary,
      noOwnerCard(context.agentName).nextStep,
    );
  }
  if (client.files === undefined) return notAvailable();

  let result;
  try {
    result = await client.files.fetch({
      envelopeId,
      ...(typeof fileIndex === 'number' ? { fileIndex } : {}),
    });
  } catch (error) {
    const mapped = error instanceof CoreError ? coreErrorOutput(error.code) : undefined;
    if (mapped === undefined) throw error; // callTool: fixed INTERNAL
    logger.info('file fetch failed', { code: error instanceof CoreError ? error.code : 'unknown' });
    return mapped;
  }

  switch (result.status) {
    case 'ok': {
      logger.info('file fetched', { size: result.size });
      const output = ok(FETCH_FILE_TEXT.saved, {
        savedTo: result.savedTo,
        name: result.name,
        size: result.size,
        integrity: result.integrity,
      });
      const block = untrustedBlock({
        header: FETCH_FILE_TEXT.blockHeader,
        from: 'sender',
        envelope: envelopeId,
        type: 'file',
        content: result.name,
      });
      return { ...output, text: `${FETCH_FILE_TEXT.saved}\n${untrustedText([block])}` };
    }
    case 'not_found':
      return fail('not_found', FETCH_FILE_TEXT.notFound, FETCH_FILE_TEXT.notFoundNextStep);
    case 'rejected':
      logger.info('file fetch refused', { code: result.code });
      switch (result.code) {
        case 'FILE_TOO_LARGE':
          return fail(
            'rejected',
            FETCH_FILE_TEXT.tooLarge,
            FETCH_FILE_TEXT.tooLargeNextStep,
            'FILE_TOO_LARGE',
          );
        case 'INTEGRITY_FAILED':
          return fail(
            'rejected',
            FETCH_FILE_TEXT.integrity,
            FETCH_FILE_TEXT.integrityNextStep,
            'INTEGRITY_FAILED',
          );
        case 'LINK_EXPIRED':
          return fail(
            'rejected',
            FETCH_FILE_TEXT.expired,
            FETCH_FILE_TEXT.expiredNextStep,
            'LINK_EXPIRED',
          );
        case 'URL_REFUSED':
          return fail(
            'rejected',
            FETCH_FILE_TEXT.refused,
            FETCH_FILE_TEXT.refusedNextStep,
            'URL_REFUSED',
          );
        case 'POLICY_DENIED':
          return fail(
            'rejected',
            FETCH_FILE_TEXT.policyDenied,
            FETCH_FILE_TEXT.policyDeniedNextStep,
            'POLICY_DENIED',
          );
        default:
          return fail(
            'error',
            FILE_TEXT.filesUnavailable,
            FILE_TEXT.filesUnavailableNextStep,
            'FILES_UNAVAILABLE',
          );
      }
    default:
      return internalError();
  }
}
