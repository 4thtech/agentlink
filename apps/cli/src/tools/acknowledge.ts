// `agentlink_acknowledge` (06 §2.4, §2.0, §2.2a; 04 §3.4.2; D-31, D-55; M1-9d-2).
//
// Core `acknowledge` (M1-7g) signs a receipt on a record a contact made for this agent, after its
// on-chain checks: `opened` when the user actually asked to open the item (the description says so;
// the core cannot know), `accepted` / `rejected` as commitments under `commitments.accept`
// (`pending_approval`), exclusive, and only on records without `terms`: a record with `terms` is
// `USE_RESPOND_TO_TERMS` and nothing is signed (D-55). This handler maps the result. Summaries carry
// no contact name: the core's approval summary (which names the contact by its stored name) is never
// passed through (I-5).
//
// `delivered` (M1-33d; 06 §2.4, §3; D-109) is the user's own yes, for example after the inbox said a
// contact asked for a delivery receipt: no owner approval, as for `opened`, and the core signs at
// most one per record (I-6). A request alone never reaches here; only the user's answer does.
import type { AcknowledgeInput } from '@4thtech-io/core';
import type { ToolContext } from './context.js';
import {
  invalidArgument,
  isOutput,
  needsIdentity,
  notAvailable,
  proofThrown,
} from './proofs-common.js';
import { receiptDisclosure, withDisclosure } from './strings/privacy.js';
import { fail, internalError, ok, pendingApproval, type HandlerOutput } from './result.js';
import { NPX_COMMAND } from './cli-command.js';

export const ACK_TEXT = Object.freeze({
  recorded: 'Receipt recorded: {receipt}.',
  recording: 'Receipt signed: {receipt}. It is being recorded; this usually takes under a minute.',
  recordingNextStep:
    'Call agentlink_get_proof with this envelopeId in a minute to see the receipt.',
  approval:
    "Confirming this message with a receipt commits the user, so it needs the owner's approval first.",
  notRecorded: 'That message has no proof to acknowledge, so nothing was signed.',
  notRecordedNextStep:
    'Receipts apply only to messages a contact recorded. Check the envelopeId in agentlink_inbox.',
  notFound: "That message wasn't found, so nothing was signed.",
  notFoundNextStep: 'Check the envelopeId in agentlink_inbox, then call again.',
  useRespond:
    'An offer is accepted or rejected only through agentlink_respond_to_terms, so nothing was signed.',
  useRespondNextStep:
    'Use agentlink_respond_to_terms with this envelopeId and decision accept or reject; one approval covers the answer and its receipt.',
  conflict: 'This record was already accepted or rejected the other way, so nothing was signed.',
  conflictNextStep: 'Tell the user. Accepted and rejected are final and exclusive.',
  policyDenied: "The owner's rules don't allow this receipt, so nothing was signed.",
  policyDeniedNextStep:
    'Tell the user their AgentLink rules blocked this. Only they can change the rules.',
  approvalInvalid: "That approval can't be used for this receipt, so nothing was signed.",
  approvalInvalidNextStep:
    'Call again without approvalId to ask the owner again, or check it with agentlink_get_approval.',
  unavailable: "Receipts aren't available on this machine, so nothing was signed.",
  unavailableNextStep: `Tell the user receipts need AgentLink set up with proof support. They can run \`${NPX_COMMAND} doctor\`.`,
});

const RECEIPT_WORD: Readonly<Record<string, string>> = Object.freeze({
  OPENED: 'opened',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  DELIVERED: 'delivered',
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function refusal(code: string): HandlerOutput {
  switch (code) {
    case 'NOT_RECORDED':
      return fail('not_found', ACK_TEXT.notRecorded, ACK_TEXT.notRecordedNextStep, code);
    case 'ENVELOPE_NOT_FOUND':
      return fail('not_found', ACK_TEXT.notFound, ACK_TEXT.notFoundNextStep, code);
    case 'USE_RESPOND_TO_TERMS':
      return fail('error', ACK_TEXT.useRespond, ACK_TEXT.useRespondNextStep, code);
    case 'RECEIPT_CONFLICT':
      return fail('rejected', ACK_TEXT.conflict, ACK_TEXT.conflictNextStep, code);
    case 'POLICY_DENIED':
      return fail('rejected', ACK_TEXT.policyDenied, ACK_TEXT.policyDeniedNextStep, code);
    case 'APPROVAL_INVALID':
      return fail('rejected', ACK_TEXT.approvalInvalid, ACK_TEXT.approvalInvalidNextStep, code);
    case 'PROOFS_UNAVAILABLE':
      return fail('error', ACK_TEXT.unavailable, ACK_TEXT.unavailableNextStep, code);
    default:
      return internalError();
  }
}

export async function acknowledgeHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const { envelopeId, type, approvalId } = input;
  if (typeof envelopeId !== 'string' || typeof type !== 'string') return invalidArgument();
  if (type !== 'delivered' && type !== 'opened' && type !== 'accepted' && type !== 'rejected') {
    return invalidArgument();
  }
  const self = await needsIdentity(context);
  if (isOutput(self)) return self;
  const proofs = context.client.proofs;
  if (proofs === undefined) return notAvailable();

  const request: AcknowledgeInput = {
    envelopeId,
    type,
    ...(typeof approvalId === 'string' ? { approvalId } : {}),
  };
  let result;
  try {
    result = await proofs.acknowledge(request);
  } catch (error) {
    return proofThrown(error);
  }
  context.logger.info('acknowledge', { status: result.status });
  switch (result.status) {
    case 'ok': {
      const receipt = RECEIPT_WORD[result.receipt];
      if (receipt === undefined) return internalError();
      const fields = { recordId: result.recordId, receipt: result.receipt };
      // 11 §5.6: every receipt is public (D-109); delivered says the item was received.
      const note = receiptDisclosure(type);
      const say = (text: string): string =>
        note === undefined ? text : withDisclosure(text, note);
      return result.onChain
        ? ok(say(ACK_TEXT.recorded.replace('{receipt}', receipt)), fields)
        : fail(
            'submitted',
            say(ACK_TEXT.recording.replace('{receipt}', receipt)),
            ACK_TEXT.recordingNextStep,
            undefined,
            fields,
          );
    }
    case 'pending_approval': {
      const note = receiptDisclosure(type);
      return pendingApproval(
        context,
        result.approvalId,
        note === undefined ? ACK_TEXT.approval : withDisclosure(ACK_TEXT.approval, note),
      );
    }
    case 'rejected':
      return refusal(result.code);
    default:
      return internalError();
  }
}
