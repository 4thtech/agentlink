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
// I-5, I-7: the message text, the body, the path and the `to` query are agent-written (steerable)
// text: none of it reaches a summary, `nextStep`, error or log line. Summaries name the contact under the
// 06 §2.1 rule only. Core errors become fixed text by their code; any other failure is INTERNAL.
import { CoreError, type CoreErrorCode, type SendMessageInput } from '@4thtech-io/core';
import { contactRef, renderRef, resolveContact } from './contacts.js';
import type { AttachedFile, ToolContext } from './context.js';
import {
  attachRefusal,
  fileErrorOutput,
  filesNeedsSetup,
  FILE_TEXT,
  isoSeconds,
} from './files-common.js';
import {
  fail,
  internalError,
  invalidArgument,
  notAvailable,
  ok,
  type HandlerOutput,
} from './result.js';
import { notarizeOutput, proofThrown } from './proofs-common.js';
import { copy } from './strings/index.js';
import { TOOL_TEXT, noOwnerCard } from './text.js';

/** Fixed text for this tool (I-5: no slot takes another party's or the agent's text). */
export const SEND_TEXT = Object.freeze({
  useTermsTools: "Offers and answers to offers can't be sent as a message, so nothing was sent.",
  useTermsToolsNextStep:
    'Use agentlink_propose_terms to make an offer, or agentlink_respond_to_terms to answer one.',
  contactNotReady: "That contact isn't connected yet, so nothing was sent.",
  contactNotReadyNextStep:
    'The pairing finishes when their agent answers. Call agentlink_list_contacts later to check.',
  keyReused: 'That clientRequestId was already used for a different message, so nothing was sent.',
  keyReusedNextStep:
    'Use a new clientRequestId for a new message, or the same request to repeat it.',
  inProgress: 'This message is already being sent by another call, so nothing more was done.',
  inProgressNextStep: 'Wait a few seconds, then call again with the same clientRequestId.',
  policyDenied: "The owner's rules don't allow this message, so nothing was sent.",
  policyDeniedNextStep:
    'Tell the user their AgentLink rules blocked this message. Only they can change the rules.',
  networkNextStep:
    'Try again in a minute. If it keeps failing, the user can run `agentlink doctor`.',
  revoked: 'The owner has turned this agent off, so nothing was sent.',
  revokedNextStep: 'Tell the user this agent was revoked. Only they can set up a new one.',
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

export async function sendHandler(input: unknown, context: ToolContext): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const { to, text, body, type, replyTo, clientRequestId, path, notarize, approvalId } = input;
  // 1. D-55: before anything else, so a negotiation never even resolves a contact.
  if (isPlainObject(body) && Object.hasOwn(body, 'terms')) return useTermsTools();
  // 2. The schema checked each field's type; here only their combination.
  if (
    typeof to !== 'string' ||
    (text !== undefined && body !== undefined) ||
    (text === undefined && body === undefined && path === undefined)
  ) {
    return invalidArgument();
  }

  // 6. A repeat with an approval must name the first call's request, so nothing is sent twice.
  const withProof = notarize === true;
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
    return fail(
      'needs_setup',
      noOwnerCard(context.agentName).summary,
      noOwnerCard(context.agentName).nextStep,
    );
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
      return attachRefusal(outcome.reason);
    }
    attached = outcome.file;
  }

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
      logger.info('message sent', { messages: 1, files: attached === undefined ? 0 : 1 });
      const fields = {
        envelopeId: result.envelopeId,
        thread: result.thread,
        sentAt: result.sentAt,
      };
      const summary = copy('chat.status.ok.sent', { contactName: name, contactFirstName: name });
      let sentFields: Record<string, unknown> = fields;
      if (attached !== undefined) {
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
      if (!withProof) return ok(summary, sentFields);
      return withProofOf(result.envelopeId, summary, sentFields, approvalId, self.agentId, context);
    }
    case 'needs_setup':
      logger.info('file send needs setup', { reason: result.reason });
      return filesNeedsSetup(result.reason);
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
        default:
          // A refusal code this version does not know: fixed text, never undefined (IR-M1-9p-1 F03).
          return internalError();
      }
    default:
      return internalError();
  }
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
): Promise<HandlerOutput> {
  const proofs = context.client.proofs;
  if (proofs === undefined || !ENVELOPE_ID.test(envelopeId)) return internalError();
  let proofOut: HandlerOutput;
  try {
    const result = await proofs.notarize({
      envelopeId,
      ...(typeof approvalId === 'string' ? { approvalId } : {}),
    });
    proofOut = notarizeOutput(result, context, agentId, {
      approvalSummary: SEND_TEXT.proofApproval,
      approvalNextStepTail: SEND_TEXT.proofApprovalTail.replace('{envelopeId}', envelopeId),
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
  const { chain, recordId, fee, receipts, agentAddress, topUpUrl } = rest as Record<
    string,
    unknown
  >;
  const proof = {
    status: PROOF_STATUSES.has(status) ? status : 'error',
    ...(chain === undefined ? {} : { chain }),
    ...(recordId === undefined ? {} : { recordId }),
    ...(fee === undefined ? {} : { fee }),
    receipts: Array.isArray(receipts) ? receipts : [],
  };
  context.logger.info('message proof', { status });
  return {
    result: {
      ...sentFields,
      status,
      summary: `${sentSummary} ${summary}`,
      ...(nextStep === undefined ? {} : { nextStep }),
      ...(code === undefined ? {} : { code }),
      ...(pending === undefined ? {} : { approvalId: pending }),
      ...(url === undefined ? {} : { url }),
      ...(agentAddress === undefined ? {} : { agentAddress }),
      ...(topUpUrl === undefined ? {} : { topUpUrl }),
      proof,
    },
  };
}
