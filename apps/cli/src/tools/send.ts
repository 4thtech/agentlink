// `agentlink_send` (06 §2.2, §1 rules 3 and 6; 07 §2 `sendMessage`, §3.3; D-55, D-70; M1-9p).
//
// 1. A `body` with a `terms` key is refused first with `USE_TERMS_TOOLS` (D-55, 06 §2.0): nothing is
//    resolved, sent or stored. The schema already refuses `type: offer | accept | reject`.
// 2. Exactly one of `text` and `body` (`path` arrives with M1-9d).
// 3. The `to` argument is resolved to an active contact (ID or shown name; AMBIGUOUS_CONTACT); a
//    contact whose pairing is not complete gets nothing.
// 4. Core `sendMessage` (M1-7k) does the rest: policy, envelope, outbox, first publish, and the
//    `clientRequestId` idempotency (a repeat returns the original result and publishes nothing).
//    A paired contact may Talk without approval (D-70), so in M1a no send returns
//    `pending_approval` and an `approvalId` changes nothing (it matters once `notarize` lands, M1-9d).
//
// I-5, I-7: the message text, the body and the `to` query are agent-written (steerable) text: none
// of it reaches a summary, `nextStep`, error or log line. Summaries name the contact under the
// 06 §2.1 rule only. Core errors become fixed text by their code; any other failure is INTERNAL.
import { CoreError, type CoreErrorCode, type SendMessageInput } from '@4thtech-io/core';
import { contactRef, renderRef, resolveContact } from './contacts.js';
import type { ToolContext } from './context.js';
import { fail, internalError, invalidArgument, ok, type HandlerOutput } from './result.js';
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
});

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
      return undefined;
  }
}

export async function sendHandler(input: unknown, context: ToolContext): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const { to, text, body, type, replyTo, clientRequestId } = input;
  // 1. D-55: before anything else, so a negotiation never even resolves a contact.
  if (isPlainObject(body) && Object.hasOwn(body, 'terms')) return useTermsTools();
  // 2. The schema checked each field's type; here only their combination.
  if (typeof to !== 'string' || (text === undefined) === (body === undefined)) {
    return invalidArgument();
  }

  const { client, logger } = context;
  if ((await client.self()) === undefined) {
    return fail(
      'needs_setup',
      noOwnerCard(context.agentName).summary,
      noOwnerCard(context.agentName).nextStep,
    );
  }

  // 3. The contact.
  const resolved = resolveContact(to, await client.contacts());
  if (!resolved.ok) return resolved.output;
  if (resolved.contact.pairing !== 'complete') return contactNotReady();
  const ref = contactRef(resolved.contact);

  // 4. The core send.
  const request: SendMessageInput = {
    to: resolved.contact.id,
    ...(typeof text === 'string' ? { text } : {}),
    ...(isPlainObject(body) ? { body } : {}),
    type: (type ?? 'text') as NonNullable<SendMessageInput['type']>,
    ...(typeof replyTo === 'string' ? { replyTo } : {}),
    ...(typeof clientRequestId === 'string' ? { clientRequestId } : {}),
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
      logger.info('message sent', { messages: 1 });
      return ok(copy('chat.status.ok.sent', { contactName: name, contactFirstName: name }), {
        envelopeId: result.envelopeId,
        thread: result.thread,
        sentAt: result.sentAt,
      });
    }
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
        default:
          // A refusal code this version does not know: fixed text, never undefined (IR-M1-9p-1 F03).
          return internalError();
      }
    default:
      return internalError();
  }
}
