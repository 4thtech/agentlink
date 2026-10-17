// `agentlink_respond_to_terms` (06 §2.2a, §2.5; 04 §3.4, §3.4.2; D-31, D-55, D-74; M1-9q).
//
// 1. Argument combinations first, before anything is read: `terms` only with `counter` (and a
//    counter needs them), `note` never with `accept` → INVALID_ARGUMENT. The agent never sends the
//    terms of an answer; the core copies them from the stored offer.
// 2. Core `respondToTerms` (M1-32) does the rest: the envelope must be the contact's newest `offer`
//    (a) or their `accept` of one of our unexpired offers (b); `accept` is a commitment under one
//    scope, decided by the `commitments` policy (M1-20): a policy grant runs now (auto-accept within
//    the owner's limits), otherwise one owner request → `pending_approval`. The retry with the
//    `approvalId` runs each part at most once (APPROVAL_USED after); a newer version voids it.
// 3. `pending_approval` carries the fixed M1a `nextStep` (06 §2.5 step 2, no URL) and a summary
//    built from the core's card data: the contact under the 06 §2.1 rule, the version, nothing else.
//
// `clientRequestId` goes to the core (M1-32-b): a repeat returns the original result, another
// request under the key is IDEMPOTENCY_KEY_REUSED, a concurrent repeat is IN_PROGRESS (as send).
//
// I-4: nothing here creates, decides or widens an approval; `approvalId` is passed to the core,
// which re-verifies the owner's stored signature. I-5, I-7: the terms, the note and anything the
// counterparty wrote never reach a summary, `nextStep`, error or log line.
import type { RespondToTermsInput } from '@agentlink/core';
import { displayRef } from './contacts.js';
import type { ToolContext } from './context.js';
import {
  fail,
  internalError,
  invalidArgument,
  notAvailable,
  ok,
  pendingApproval,
  type HandlerOutput,
} from './result.js';
import { copy } from './strings/index.js';
import {
  TERMS_TEXT,
  askSummary,
  dateOf,
  nameOf,
  termsApprovalState,
  termsCoreError,
  termsInProgress,
  termsRefusal,
} from './terms-common.js';
import { noOwnerCard } from './text.js';

interface RespondInput {
  envelopeId: string;
  decision: 'accept' | 'reject' | 'counter';
  terms?: Record<string, unknown>;
  note?: string;
  approvalId?: string;
  clientRequestId?: string;
}

/** Shown when the sender cannot be named (the core decided anyway; summaries only). */
const UNNAMED = 'your contact';

export async function respondToTermsHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  const { envelopeId, decision, terms, note, approvalId, clientRequestId } = input as RespondInput;
  // 1. 06 §2.2a: never terms with accept or reject; a counter needs them; no note with accept.
  if ((decision === 'counter') !== (terms !== undefined)) return invalidArgument();
  if (decision === 'accept' && note !== undefined) return invalidArgument();

  const { client, logger } = context;
  const tools = client.terms;
  if (tools === undefined) return notAvailable();
  if ((await client.self()) === undefined) {
    return fail(
      'needs_setup',
      noOwnerCard(context.agentName).summary,
      noOwnerCard(context.agentName).nextStep,
    );
  }

  const request: RespondToTermsInput = {
    envelopeId,
    decision,
    ...(terms === undefined ? {} : { terms }),
    ...(note === undefined ? {} : { note }),
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(clientRequestId === undefined ? {} : { clientRequestId }),
  };
  let result;
  try {
    result = await tools.respond(request);
  } catch (error) {
    const mapped = termsCoreError(error);
    if (mapped === undefined) throw error; // callTool: fixed INTERNAL
    logger.info('respond to terms refused', { kind: 'core' });
    return mapped;
  }

  switch (result.status) {
    case 'in_progress':
      return termsInProgress();
    case 'approval_state':
      return termsApprovalState(context, 'agentlink_respond_to_terms', result);
    case 'pending_approval':
      logger.info('terms approval requested', { requests: 1 });
      return pendingApproval(context, result.approvalId, askSummary(result.card), { decision });
    case 'rejected':
      logger.info('respond to terms refused', { kind: 'terms' });
      return termsRefusal(
        result.code,
        decision === 'accept',
        result.code === 'APPROVAL_USED' && result.envelopeId !== undefined
          ? { envelopeId: result.envelopeId }
          : {},
      );
    case 'ok': {
      const sender = await tools.senderOf(envelopeId);
      const name = sender === undefined ? UNNAMED : nameOf(displayRef(sender.id, sender.display));
      const fields = {
        decision: result.decision,
        thread: result.thread,
        termsId: result.termsId,
        version: result.version,
        termsHash: result.termsHash,
        ...(result.envelopeId === undefined ? {} : { envelopeId: result.envelopeId }),
      };
      logger.info('terms answer done', { answers: 1 });
      switch (result.decision) {
        case 'counter':
          return ok(TERMS_TEXT.counterSent(result.version, name), fields);
        case 'reject':
          return ok(
            copy('chat.commitment.rejectedUnrecorded', {
              contactName: name,
              version: result.version,
            }),
            fields,
          );
        case 'accept':
          return ok(
            result.receipt?.status === 'waiting_for_record' && result.receipt.until !== undefined
              ? copy('chat.commitment.acceptedPending', {
                  version: result.version,
                  contactName: name,
                  date: dateOf(result.receipt.until),
                })
              : TERMS_TEXT.accepted(result.version, name),
            fields,
          );
        default:
          return internalError();
      }
    }
    default:
      return internalError();
  }
}
