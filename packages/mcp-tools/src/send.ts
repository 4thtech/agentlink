// `agentlink_send` (06 §2.2, §1 rules 3 and 6; 07 §2 `sendMessage`, §3.3; D-55, D-70; M1-9p).
//
// 1. A `body` with a `terms` key is refused first with `USE_TERMS_TOOLS` (D-55, 06 §2.0): nothing is
//    resolved, sent or stored. The schema already refuses `type: offer | accept | reject`.
// 2. At most one of `text` and `body`, and at least one of `text`, `body` and `path` (M1-9d-1).
// 3. The `to` argument is resolved to an active contact (ID or shown name; AMBIGUOUS_CONTACT); a
//    contact whose pairing is not complete gets nothing.
// 4. Core `sendMessage` (M1-7k) does the rest: policy, envelope, outbox, first publish, and the
//    `clientRequestId` idempotency (a repeat returns the original result and publishes nothing).
//    A paired contact may Talk without approval (D-70), so in M1a no send returns
//    `pending_approval` and an `approvalId` changes nothing (it matters once `notarize` lands, M1-9d).
// 5. With `path` (M1-9d-1; 06 §2.3, 04 §4): before the core is called, the platform checks the path
//    with realpath against `files.allowedFolders` without opening it; outside or no folder is
//    `needs_setup`, a hidden, protected or malformed path `PATH_NOT_ALLOWED`. The core then checks
//    the realpath again, decides inline or stored (D-85; the drop or own storage, 07 §5.6) and reads
//    the file once. The result's `file` carries name, size, hash, delivery and expiry only: never a
//    link, a locator or a key (IR-D48-1 F15f).
//
// 6. With `notarize` (M1-9d-2; 06 §2.2 "the proofs policy applies as for agentlink_notarize"): the
//    message is sent first (free, and not a commitment), then core `notarize` records it under
//    policy `proofs.*`, exactly as agentlink_notarize does. The result is the send's fields plus
//    `proof` (a ProofStatus); a proof that is not `ok` gives the result its status (pending_approval,
//    needs_credits, submitted, …) with a summary that says the message was sent. Its approval is the
//    agentlink_notarize one, so the nextStep finishes through agentlink_notarize with the envelopeId.
//    A repeat with `approvalId` must carry the same `clientRequestId`, so the core returns the kept
//    send instead of sending again; without one it is refused before anything is sent.
//
// 7. With `file: {name, content}` (FILES-AI-1, D-152; 06 §2.3 "Send by content"): exactly one of
//    `path` and `file`, never with `body`. The core gets `contentFile`: it checks the name and the
//    content, the contact policy, the Send folder and the daily budget, has the platform's Attach
//    writer save it into the root of the ID's own Send folder, and sends the bytes in memory. Its
//    refusals become the fixed 06 §2.3 texts; the result's `file.name` is the saved name, and the
//    summary names only it and the Send folder in its fixed `~` form. Neither `name` nor `content`
//    reaches a summary, `nextStep`, error or log line otherwise. Nothing here picks a folder (I-4).
//
// I-5, I-7: the message text, the body, the path, the file's name and content and the `to` query
// are agent-written (steerable) text: none of it reaches a summary, `nextStep`, error or log line. Summaries name the contact under the
// 06 §2.1 rule only. Core errors become fixed text by their code; any other failure is INTERNAL.
import { CoreError, type CoreErrorCode, type SendMessageInput } from '@4thtech-io/core';
import { contactRef, renderRef, resolveContact } from './contacts.js';
import type { AttachedFile, ToolClient, ToolContext } from './context.js';
import {
  attachRefusal,
  contentFileRefusal,
  fileErrorOutput,
  filesNeedsSetup,
  FILE_TEXT,
  isoSeconds,
  savedAndSentSummary,
} from './files-common.js';
import {
  fail,
  internalError,
  invalidArgument,
  notAvailable,
  ok,
  type HandlerOutput,
} from './result.js';
import { notarizeOutput, notarizeWithFreeCredits, proofThrown } from './proofs-common.js';
import { copy } from './strings/index.js';
import { TOOL_TEXT, noOwnerCard, noOwnerResult } from './text.js';
import { NPX_COMMAND } from './cli-command.js';

/** Fixed text for this tool (I-5: no slot takes another party's or the agent's text). */
export const SEND_TEXT = Object.freeze({
  useTermsTools: "Offers and answers to offers can't be sent as a message, so nothing was sent.",
  useTermsToolsNextStep:
    'Use agentlink_propose_terms to make an offer, or agentlink_respond_to_terms to answer one.',
  contactNotReady: "That contact isn't connected yet, so nothing was sent.",
  contactNotReadyNextStep:
    'The pairing finishes when they answer. Call agentlink_list_contacts later to check.',
  keyReused: 'That clientRequestId was already used for a different message, so nothing was sent.',
  keyReusedNextStep:
    'Use a new clientRequestId for a new message, or the same request to repeat it.',
  inProgress: 'This message is already being sent by another call, so nothing more was done.',
  inProgressNextStep: 'Wait a few seconds, then call again with the same clientRequestId.',
  policyDenied: "The owner's rules don't allow this message, so nothing was sent.",
  policyDeniedNextStep:
    'Tell the user their AgentLink rules blocked this message. Only they can change the rules.',
  networkNextStep: `Try again in a minute. If it keeps failing, the user can run \`${NPX_COMMAND} doctor\`.`,
  revoked: 'The owner has turned this AgentLink ID off, so nothing was sent.',
  revokedNextStep: 'Tell the user this AgentLink ID was revoked. Only they can set up a new one.',
  tooLarge: 'The message is too large to send, so nothing was sent.',
  tooLargeNextStep: 'Send a shorter message, or split it into several.',
  replyNotFound: "The message this replies to wasn't found, so nothing was sent.",
  replyNotFoundNextStep: 'Check the replyTo envelopeId, or send without replyTo.',
  // M1-9d-2: `notarize` (06 §2.2).
  notarizeRetry:
    'An approvalId with notarize needs the clientRequestId of the first call, so nothing was sent.',
  notarizeRetryNextStep:
    'To finish adding proof to a message already sent, call agentlink_notarize with its envelopeId and the approvalId.',
  proofApproval: "Adding proof to this message needs the owner's approval.",
  proofApprovalTail:
    'The message is already sent: to finish, call agentlink_notarize with envelopeId {envelopeId} and this approvalId.',
  // M1-33d: the approval covers the receipt request too, so the finishing call repeats it.
  proofApprovalTailReceipt:
    'The message is already sent: to finish, call agentlink_notarize with envelopeId {envelopeId}, requestReceipt true and this approvalId.',
  // IR-M1-9d-2 M2: the message went out, only its proof did not.
  proofFailed: 'Its proof was not added.',
  proofFailedNextStep:
    'The message is already sent. To add its proof later, call agentlink_notarize with envelopeId {envelopeId}; if it keeps failing, tell the user.',
});

const ENVELOPE_ID = /^[A-Za-z0-9_-]{22}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const useTermsTools = (): HandlerOutput =>
  fail('error', SEND_TEXT.useTermsTools, SEND_TEXT.useTermsToolsNextStep, 'USE_TERMS_TOOLS');

const contactNotReady = (): HandlerOutput =>
  fail('error', SEND_TEXT.contactNotReady, SEND_TEXT.contactNotReadyNextStep, 'CONTACT_NOT_READY');

/** The fixed result for a core error code, or undefined for INTERNAL (the caller rethrows). */
function coreErrorOutput(code: CoreErrorCode): HandlerOutput | undefined {
  switch (code) {
    case 'transport_unavailable':
      return fail('error', copy('chat.status.error.network'), SEND_TEXT.networkNextStep, 'NETWORK');
    case 'identity_missing':
      return fail('needs_setup', noOwnerCard().summary, noOwnerCard().nextStep);
    case 'identity_revoked':
      return fail('error', SEND_TEXT.revoked, SEND_TEXT.revokedNextStep, 'AGENT_REVOKED');
    case 'contact_not_active':
      return contactNotReady();
    case 'contact_not_found':
      return fail('not_found', TOOL_TEXT.contactNotFound, TOOL_TEXT.contactNotFoundNextStep);
    case 'envelope_too_large':
      return fail('error', SEND_TEXT.tooLarge, SEND_TEXT.tooLargeNextStep, 'MESSAGE_TOO_LARGE');
    case 'thread_invalid':
      return fail(
        'not_found',
        SEND_TEXT.replyNotFound,
        SEND_TEXT.replyNotFoundNextStep,
        'REPLY_NOT_FOUND',
      );
    case 'payload_invalid':
    case 'type_not_sendable':
      return invalidArgument();
    default:
      return fileErrorOutput(code);
  }
}

/**
 * FILES-AI-2 (06 §2.3): the ID's own pinned Send folder in its fixed `~` form for the AI-side texts,
 * or undefined (no runtime support, none pinned, an error). Never a value from the call.
 */
async function ownSendFolder(client: ToolClient): Promise<string | undefined> {
  try {
    return await client.files?.sendFolder?.();
  } catch {
    return undefined;
  }
}

export async function sendHandler(input: unknown, context: ToolContext): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const { to, text, body, type, replyTo, clientRequestId, path, file, notarize, approvalId } =
    input;
  const requestReceipt = input['requestReceipt'] === true;
  // 1. D-55: before anything else, so a negotiation never even resolves a contact.
  if (isPlainObject(body) && Object.hasOwn(body, 'terms')) return useTermsTools();
  // 2. The schema checked each field's type; here only their combination.
  if (
    typeof to !== 'string' ||
    (text !== undefined && body !== undefined) ||
    (text === undefined && body === undefined && path === undefined && file === undefined)
  ) {
    return invalidArgument();
  }
  // 7. D-152: exactly one of `path` and `file`, and `file` never with `body`.
  const byContent = file !== undefined;
  if (
    byContent &&
    (path !== undefined ||
      body !== undefined ||
      !isPlainObject(file) ||
      typeof file['name'] !== 'string' ||
      typeof file['content'] !== 'string' ||
      Object.keys(file).some((k) => k !== 'name' && k !== 'content'))
  ) {
    return invalidArgument();
  }

  // 6. A repeat with an approval must name the first call's request, so nothing is sent twice.
  const withProof = notarize === true;
  // M1-33d (06 §2.2): a delivery receipt is asked for through the proof, so only with notarize.
  if (requestReceipt && !withProof) return invalidArgument();
  if (withProof && typeof approvalId === 'string' && typeof clientRequestId !== 'string') {
    return fail(
      'error',
      SEND_TEXT.notarizeRetry,
      SEND_TEXT.notarizeRetryNextStep,
      'INVALID_ARGUMENT',
    );
  }

  const { client, logger } = context;
  const self = await client.self();
  if (self === undefined) {
    return noOwnerResult(context);
  }
  // Without the proof platform nothing is sent: the user asked for a message with proof.
  if (withProof && client.proofs === undefined) return notAvailable();

  // 3. The contact.
  const resolved = resolveContact(to, await client.contacts());
  if (!resolved.ok) return resolved.output;
  if (resolved.contact.pairing !== 'complete') return contactNotReady();
  const ref = contactRef(resolved.contact);

  // 5. The file: checked, never opened here (06 §2.3, 04 §4).
  let attached: AttachedFile | undefined;
  if (typeof path === 'string') {
    if (client.files === undefined) return notAvailable();
    const outcome = await client.files.attach(path);
    if (!outcome.ok) {
      logger.info('file send refused', { reason: outcome.reason });
      return attachRefusal(outcome.reason, await ownSendFolder(client));
    }
    attached = outcome.file;
  }
  // 7. The cloud agent has no file platform: answered as for `path`, nothing written.
  if (byContent && client.files === undefined) return notAvailable();

  // 4. The core send.
  // A file sent with no text or body travels with an empty text (06 §2.2: `text` then travels as
  // its message).
  const message = typeof text === 'string' ? text : body === undefined ? '' : undefined;
  const request: SendMessageInput = {
    to: resolved.contact.id,
    ...(typeof message === 'string' ? { text: message } : {}),
    ...(isPlainObject(body) ? { body } : {}),
    type: (type ?? 'text') as NonNullable<SendMessageInput['type']>,
    ...(typeof replyTo === 'string' ? { replyTo } : {}),
    ...(typeof clientRequestId === 'string' ? { clientRequestId } : {}),
    ...(attached === undefined ? {} : { files: [attached.file] }),
    ...(byContent && isPlainObject(file)
      ? { contentFile: { name: String(file['name']), content: String(file['content']) } }
      : {}),
  };
  let result;
  try {
    result = await client.send(request);
  } catch (error) {
    const mapped = error instanceof CoreError ? coreErrorOutput(error.code) : undefined;
    if (mapped === undefined) throw error; // callTool: fixed INTERNAL, nothing logged but the tool
    logger.info('send refused', { code: error instanceof CoreError ? error.code : 'unknown' });
    return mapped;
  }

  switch (result.status) {
    case 'ok': {
      const name = renderRef(ref);
      logger.info('message sent', {
        messages: 1,
        files: attached === undefined && !byContent ? 0 : 1,
      });
      // REL051-CF2: `delivery` says whether the relays took it (sent) or it waits (queued); a core
      // that does not report it keeps the old answer.
      const delivery = result.delivery;
      const fields = {
        envelopeId: result.envelopeId,
        thread: result.thread,
        sentAt: result.sentAt,
        ...(delivery === undefined ? {} : { delivery }),
      };
      const summary =
        delivery === 'queued'
          ? withProof
            ? copy('chat.status.ok.queuedProof', {})
            : copy('chat.status.ok.queued', { contactName: name })
          : delivery === 'not_delivered'
            ? copy('chat.status.ok.notDelivered', { contactName: name })
            : copy('chat.status.ok.sent', { contactName: name, contactFirstName: name });
      let sentFields: Record<string, unknown> = fields;
      let shown = summary;
      const saved = byContent ? result.contentFile : undefined;
      const sentContent = byContent ? result.files?.find((f) => f.index === 0) : undefined;
      if (byContent && (saved === undefined || sentContent === undefined)) {
        // A send resumed after a crash (07 §3.3 "Resume") keeps no file fields: the message went
        // out, so the plain sent summary without the file slot, never INTERNAL.
      } else if (saved !== undefined && sentContent !== undefined) {
        const sent = sentContent;
        sentFields = {
          ...fields,
          file: {
            name: saved.name,
            size: saved.size,
            plaintextSha256: saved.plaintextSha256,
            delivery: sent.delivery,
            expiresAt: sent.expiresAt === null ? null : isoSeconds(sent.expiresAt),
          },
        };
        // 06 §2.3 "Result": the fixed sentence; with `queued` the 06 §2.2 "not sent yet" line too.
        // With a proof its words follow, so the sentence keeps room for them (06 §1 rule 2).
        const room = withProof ? 300 : undefined;
        shown =
          delivery === 'not_delivered'
            ? summary
            : delivery === 'queued'
              ? savedAndSentSummary(saved.name, saved.sendFolder, name, summary, room)
              : savedAndSentSummary(saved.name, saved.sendFolder, name, '', room);
      } else if (attached !== undefined) {
        const sent = result.files?.find((f) => f.index === 0);
        if (sent === undefined) return internalError();
        sentFields = {
          ...fields,
          file: {
            name: attached.name,
            size: attached.size,
            plaintextSha256: await attached.plaintextSha256(),
            delivery: sent.delivery,
            expiresAt: sent.expiresAt === null ? null : isoSeconds(sent.expiresAt),
          },
        };
      }
      if (!withProof) return ok(shown, sentFields);
      return withProofOf(
        result.envelopeId,
        shown,
        sentFields,
        approvalId,
        self.agentId,
        context,
        name,
        requestReceipt,
        delivery !== undefined && delivery !== 'sent',
      );
    }
    case 'needs_setup':
      logger.info('file send needs setup', { reason: result.reason });
      return filesNeedsSetup(result.reason, await ownSendFolder(client));
    case 'in_progress':
      return fail('error', SEND_TEXT.inProgress, SEND_TEXT.inProgressNextStep, 'IN_PROGRESS');
    case 'rejected':
      switch (result.code) {
        case 'USE_TERMS_TOOLS':
          return useTermsTools();
        case 'IDEMPOTENCY_KEY_REUSED':
          return fail(
            'rejected',
            SEND_TEXT.keyReused,
            SEND_TEXT.keyReusedNextStep,
            'IDEMPOTENCY_KEY_REUSED',
          );
        case 'POLICY_DENIED':
          return fail(
            'rejected',
            SEND_TEXT.policyDenied,
            SEND_TEXT.policyDeniedNextStep,
            'POLICY_DENIED',
          );
        case 'FILE_TOO_LARGE':
          return fail(
            'rejected',
            FILE_TEXT.fileTooLarge,
            FILE_TEXT.fileTooLargeNextStep,
            'FILE_TOO_LARGE',
          );
        case 'PAYLOAD_TOO_LARGE':
          return fail(
            'rejected',
            FILE_TEXT.payloadTooLarge,
            FILE_TEXT.payloadTooLargeNextStep,
            'PAYLOAD_TOO_LARGE',
          );
        default: {
          // FILES-AI-1: the `file` refusals (06 §2.3), fixed text by code.
          const content = byContent ? contentFileRefusal(result.code) : undefined;
          if (content !== undefined) {
            logger.info('file send refused', { code: result.code });
            return content;
          }
          // A refusal code this version does not know: fixed text, never undefined (IR-M1-9p-1 F03).
          return internalError();
        }
      }
    default:
      return internalError();
  }
}

/**
 * REL051-CF2: the proof step's fixed words for a message that is queued, not sent: every "sent"
 * claim of the proof copy is replaced (the proof is added to the message whether or not it went out).
 */
const UNSENT_WORDING: readonly (readonly [RegExp, string])[] = [
  [/^Sent with proof\. /, 'Proof added. '],
  [/^Sent\. /, ''],
  [/The message was sent, but its proof/g, 'Its proof'],
  [/The message is already sent/g, 'The message is saved and goes out on its own'],
  [/a message already sent/g, 'a message that is saved to send'],
];

function unsentWording(text: string): string {
  let out = text;
  for (const [pattern, replacement] of UNSENT_WORDING) out = out.replace(pattern, replacement);
  return out;
}

/** Proof outcomes after a send that are not failures (IR-M1-9d-2 M2). */
const PROOF_PENDING: ReadonlySet<string> = new Set([
  'ok',
  'pending_approval',
  'needs_credits',
  'submitted',
]);

/** ProofStatus statuses (06 §2.4): any other tool status shows as `error` inside `proof`. */
const PROOF_STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'pending_approval',
  'needs_credits',
  'submitted',
  'error',
]);

/** 6. Records the sent message (06 §2.2 `notarize`) and folds the proof into the send result. */
async function withProofOf(
  envelopeId: string,
  sentSummary: string,
  sentFields: Readonly<Record<string, unknown>>,
  approvalId: unknown,
  agentId: string,
  context: ToolContext,
  contactName: string,
  requestReceipt: boolean,
  notSent = false,
): Promise<HandlerOutput> {
  const proofs = context.client.proofs;
  if (proofs === undefined || !ENVELOPE_ID.test(envelopeId)) return internalError();
  let proofOut: HandlerOutput;
  try {
    // M1-36i: the first proof that needs credits claims free test credits once (testnets only);
    // M1-36i-c: after a claim that added credits, a bounded wait for them and one proof retry (the
    // message itself is never sent again).
    const { result, freeCredits } = await notarizeWithFreeCredits(
      proofs,
      {
        envelopeId,
        ...(typeof approvalId === 'string' ? { approvalId } : {}),
        ...(requestReceipt ? { requestReceipt: true } : {}),
      },
      context,
      agentId,
    );
    proofOut = notarizeOutput(result, context, agentId, {
      contactName,
      freeCredits,
      envelopeId,
      approvalSummary: SEND_TEXT.proofApproval,
      approvalNextStepTail: (requestReceipt
        ? SEND_TEXT.proofApprovalTailReceipt
        : SEND_TEXT.proofApprovalTail
      ).replace('{envelopeId}', envelopeId),
    });
  } catch (error) {
    // Every proof-step error after a successful send (IR-M1-9d-2 M2): never INTERNAL, never "nothing
    // was done"; the error itself is never read (it could carry a URL or a value, I-7).
    try {
      proofOut = proofThrown(error);
    } catch {
      proofOut = { result: { status: 'error', summary: '', code: 'PROOF_FAILED' } };
    }
  }
  // Anything but a proof in progress or waiting on the user is a failed proof of a sent message:
  // fixed text, a fixed code (the core's when it is one), the send fields kept.
  if (!PROOF_PENDING.has(proofOut.result.status)) {
    const code =
      typeof proofOut.result.code === 'string' && proofOut.result.code !== 'INTERNAL'
        ? proofOut.result.code
        : 'PROOF_FAILED';
    proofOut = {
      result: {
        status: 'error',
        summary: SEND_TEXT.proofFailed,
        nextStep: SEND_TEXT.proofFailedNextStep.replace('{envelopeId}', envelopeId),
        code,
      },
    };
  }
  const { status, summary, nextStep, code, approvalId: pending, url, ...rest } = proofOut.result;
  const { advanced, recordId, fee, receipts, agentAddress, topUpUrl, receiptRequestNotAdded } =
    rest as Record<string, unknown>;
  const proof = {
    status: PROOF_STATUSES.has(status) ? status : 'error',
    ...(advanced === undefined ? {} : { advanced }),
    ...(recordId === undefined ? {} : { recordId }),
    ...(fee === undefined ? {} : { fee }),
    receipts: Array.isArray(receipts) ? receipts : [],
    ...(receiptRequestNotAdded === true ? { receiptRequestNotAdded: true } : {}),
  };
  context.logger.info('message proof', { status });
  // REL051-CF2: a message that has not gone out yet is never called sent in the proof words.
  const words = (text: string): string => (notSent ? unsentWording(text) : text);
  return {
    result: {
      ...sentFields,
      status,
      summary: `${sentSummary} ${words(summary)}`.trim(),
      ...(nextStep === undefined ? {} : { nextStep: words(nextStep) }),
      ...(code === undefined ? {} : { code }),
      ...(pending === undefined ? {} : { approvalId: pending }),
      ...(url === undefined ? {} : { url }),
      ...(agentAddress === undefined ? {} : { agentAddress }),
      ...(topUpUrl === undefined ? {} : { topUpUrl }),
      proof,
    },
  };
}
