// Fixed text, refusal codes and the core-error mapping of the terms tools (M1-9q; 06 §2.2a, §2.5;
// 11 §6.1 "Commitments"; D-55).
//
// I-5: the subject, deliverables, price, deadlines and notes of any offer are the counterparty's (or
// the agent's) text. None of it reaches a summary, `nextStep`, error or log line. The only inserted
// values are a contact name under the 06 §2.1 rule (made one line), a version number and dates we
// format ourselves. Codes are fixed constants, never values.
//
// The M1a approval summaries are the 11 §6.1 commitment sentences without their "Review and
// approve: {url}" tail: M1a has no URL (D-73 (3)), and the fixed `nextStep` names the owner's
// `agentlink approve` command instead (06 §2.5 step 2). Moving these sentences into the copy sheet
// is M1-9g's (owner of strings/ after M1-9o/p/q).
import {
  CoreError,
  type CommitmentCard,
  type ProposeTermsResult,
  type TermsCode,
} from '@4thtech-io/core';
import { renderRef, type ContactRef } from './contacts.js';
import type { ToolContext } from './context.js';
import { approvalStateOf } from './get-approval.js';
import { INVITE_TEXT } from './invite-common.js';
import {
  fail,
  internalError,
  invalidArgument,
  notAvailable,
  pendingApproval,
  type HandlerOutput,
} from './result.js';
import { SEND_TEXT } from './send.js';
import { copy, formatDate } from './strings/index.js';
import { TOOL_TEXT, noOwnerCard } from './text.js';
import { removeInvisible } from './untrusted.js';

export const TERMS_TEXT = Object.freeze({
  // Refusals (06 §2.2a; 04 §3.4.2). Nothing was sent or recorded in any of them.
  useRespond:
    'That offer is not your own newest unanswered offer to this contact, so nothing was sent.',
  useRespondNextStep:
    "To answer the contact's offer, call agentlink_respond_to_terms with decision counter.",
  superseded: 'A newer version of these terms exists, so nothing was sent.',
  supersededNextStep:
    'Call agentlink_inbox to see the newest version. Answer it only if the user asks you to.',
  expired: 'These terms have expired, so nothing was sent.',
  expiredNextStep: 'Tell the user. If they still want a deal, either side can send a new offer.',
  notAParty: "This agent isn't one of the two sides of those terms, so nothing was sent.",
  notAPartyNextStep: 'Check the envelopeId from agentlink_inbox and call again.',
  notRecorded: "Their acceptance has no proof record yet, so there's nothing to add yours to.",
  notRecordedNextStep: 'Nothing else is needed now. Tell the user their acceptance arrived.',
  usedNextStep:
    'Nothing else is needed. If the user wants to accept again, call without approvalId and the owner decides again.',
  approvalVoid: "That approval can't be used for this answer any more, so nothing was sent.",
  approvalVoidNextStep:
    'The terms, the contact or the decision changed since the owner looked. Tell the user, and call again without approvalId only if they ask you to.',
  notFound: "I couldn't find that offer from a contact, so nothing was sent.",
  notFoundNextStep:
    'Call agentlink_inbox to see received offers, then use the envelopeId it shows.',
  rulesNextStep: 'Tell the user. Only they can change their AgentLink rules.',
  // Successes.
  offerSent: (version: number, name: string, date: string): string =>
    `Sent version ${String(version)} of your terms. ${copy('chat.commitment.waiting', {
      contactName: name,
      date,
    })}`,
  counterSent: (version: number, name: string): string =>
    `Sent version ${String(version)} of the terms to ${name}. They can accept it, reject it or send a new version.`,
  accepted: (version: number, name: string): string =>
    `Accepted version ${String(version)} of the terms from ${name}.`,
  // Approval summaries (11 §6.1 "Commitments", M1a form without the URL).
  askAccept: (version: number, name: string): string =>
    `Accepting ${name}'s terms (version ${String(version)}) commits you. One approval covers your acceptance and its proof.`,
  askConfirm: (version: number, name: string): string =>
    `${name} accepted your terms (version ${String(version)}) and recorded it. Adding your acceptance makes this a proof of agreement and commits you.`,
  askFirmOffer: (name: string): string =>
    `Sending a firm offer with proof to ${name} commits you if they accept.`,
  askLate: (version: number, newVersion: number, name: string): string =>
    `${name} accepted version ${String(version)} after you sent version ${String(newVersion)}. The owner reviews it before your acceptance is added.`,
});

/** A shown contact name (06 §2.1 rule), kept to one line for a summary. */
export const oneLineName = (shown: string): string =>
  removeInvisible(shown).replace(/\s+/g, ' ').trim();

export const nameOf = (ref: ContactRef): string => oneLineName(renderRef(ref));

/** Our date for a unix-seconds instant, e.g. "20 Oct". */
export const dateOf = (seconds: number): string => formatDate(new Date(seconds * 1000));

/** Strict RFC 3339 UTC with whole seconds (the 06 §2.2a `validUntil` form). */
export const isoOf = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The approval summary for a pending commitment, from the core's card data (06 §2.2a, 11 §6.1). */
export function askSummary(card: CommitmentCard): string {
  const name = oneLineName(card.counterparty.shown);
  if (card.lateAccept !== null) {
    return TERMS_TEXT.askLate(
      card.lateAccept.acceptedVersion,
      card.lateAccept.newestOwnVersion,
      name,
    );
  }
  return card.decision === 'confirm'
    ? TERMS_TEXT.askConfirm(card.version, name)
    : TERMS_TEXT.askAccept(card.version, name);
}

/**
 * The fixed result for a core refusal code. `accepting` picks the commitments wording of
 * POLICY_DENIED (11 §6.1 "Your rules don't let this agent accept terms").
 */
export function termsRefusal(
  code: TermsCode,
  accepting: boolean,
  fields: Readonly<Record<string, unknown>> = {},
): HandlerOutput {
  switch (code) {
    case 'INVALID_ARGUMENT':
      return invalidArgument();
    case 'USE_RESPOND_TO_TERMS':
      return fail('error', TERMS_TEXT.useRespond, TERMS_TEXT.useRespondNextStep, code);
    case 'TERMS_SUPERSEDED':
      return fail('rejected', TERMS_TEXT.superseded, TERMS_TEXT.supersededNextStep, code);
    case 'TERMS_EXPIRED':
      return fail('rejected', TERMS_TEXT.expired, TERMS_TEXT.expiredNextStep, code);
    case 'NOT_A_PARTY':
      return fail('rejected', TERMS_TEXT.notAParty, TERMS_TEXT.notAPartyNextStep, code);
    case 'NOT_RECORDED':
      return fail('rejected', TERMS_TEXT.notRecorded, TERMS_TEXT.notRecordedNextStep, code);
    case 'APPROVAL_USED':
      return fail('rejected', copy('chat.commitment.used'), TERMS_TEXT.usedNextStep, code, fields);
    case 'APPROVAL_VOID':
      return fail('rejected', TERMS_TEXT.approvalVoid, TERMS_TEXT.approvalVoidNextStep, code);
    case 'POLICY_DENIED':
      return accepting
        ? fail('rejected', copy('chat.status.rejected.rules'), TERMS_TEXT.rulesNextStep, code)
        : fail('rejected', SEND_TEXT.policyDenied, SEND_TEXT.policyDeniedNextStep, code);
    case 'IDEMPOTENCY_KEY_REUSED':
      // The same wording and code as agentlink_send (06 §1 rule 6).
      return fail('rejected', SEND_TEXT.keyReused, SEND_TEXT.keyReusedNextStep, code);
    case 'NOTARIZE_UNAVAILABLE':
      // The M1a schemas have no `notarize`; proofs arrive with M1-9d.
      return notAvailable();
    default:
      // A code this version does not know: fixed text, never undefined (IR-M1-9p-1 F03).
      return internalError();
  }
}

/** Another call holds this clientRequestId: nothing more was done (as agentlink_send; 07 §3.3). */
export const termsInProgress = (): HandlerOutput =>
  fail('error', SEND_TEXT.inProgress, SEND_TEXT.inProgressNextStep, 'IN_PROGRESS');

/**
 * A repeat of a call whose kept result was `pending_approval`, after that approval stopped being
 * pending (07 §3.3 "Stale approvals"): the approval's current state as `agentlink_get_approval`
 * reports it (06 §2.5), never the stale result. Fixed text only.
 */
export function termsApprovalState(
  context: ToolContext,
  tool: string,
  stale: Extract<ProposeTermsResult, { status: 'approval_state' }>,
): HandlerOutput {
  const mapped = approvalStateOf(stale.approval);
  if (mapped === 'not_found') {
    return fail('not_found', TOOL_TEXT.approvalNotFound, TOOL_TEXT.approvalNotFoundNextStep);
  }
  switch (mapped.approval) {
    case 'pending':
      return pendingApproval(context, stale.approvalId, TOOL_TEXT.approvalPending);
    case 'approved':
      return {
        result: {
          status: 'pending_approval',
          summary: TOOL_TEXT.approvalApproved,
          approvalId: stale.approvalId,
          nextStep: TOOL_TEXT.approvalFinishTool
            .split('{tool}')
            .join(tool)
            .split('{approvalId}')
            .join(stale.approvalId),
        },
      };
    case 'denied':
      return fail('rejected', TOOL_TEXT.approvalDenied, TERMS_TEXT.approvalVoidNextStep);
    default:
      return fail(
        'rejected',
        mapped.used === true ? copy('chat.commitment.used') : TOOL_TEXT.approvalExpired,
        mapped.used === true ? TERMS_TEXT.usedNextStep : TERMS_TEXT.approvalVoidNextStep,
      );
  }
}

/** The contact is not active or its pairing is not complete: nothing is sent. */
export const contactNotReady = (): HandlerOutput =>
  fail('error', SEND_TEXT.contactNotReady, SEND_TEXT.contactNotReadyNextStep, 'CONTACT_NOT_READY');

/** The fixed result for a thrown core error, or undefined (the caller rethrows → INTERNAL). */
export function termsCoreError(error: unknown): HandlerOutput | undefined {
  if (!(error instanceof CoreError)) return undefined;
  switch (error.code) {
    case 'transport_unavailable':
      return fail('error', copy('chat.status.error.network'), SEND_TEXT.networkNextStep, 'NETWORK');
    case 'identity_missing':
      return fail('needs_setup', noOwnerCard().summary, noOwnerCard().nextStep);
    case 'identity_revoked':
      return fail('error', SEND_TEXT.revoked, SEND_TEXT.revokedNextStep, 'AGENT_REVOKED');
    case 'rotation_pending':
    case 'key_epoch_mismatch':
      return fail(
        'rejected',
        INVITE_TEXT.cannotSend,
        INVITE_TEXT.cannotSendNextStep,
        'AGENT_CANNOT_SEND',
      );
    case 'contact_not_active':
      return contactNotReady();
    case 'contact_not_found':
      return fail('not_found', TOOL_TEXT.contactNotFound, TOOL_TEXT.contactNotFoundNextStep);
    case 'envelope_too_large':
      return fail('error', SEND_TEXT.tooLarge, SEND_TEXT.tooLargeNextStep, 'MESSAGE_TOO_LARGE');
    case 'payload_invalid':
      return invalidArgument();
    // The scope expired while the owner request was being stored (M1-32-d): the terms' refusal.
    case 'approval_scope_expired':
      return termsRefusal('TERMS_EXPIRED', true);
    default:
      return undefined;
  }
}

// ---- Names instead of addresses (M1-22-b; 06 §2.1, §4; 11 §5) -------------------------------------

/** Our own agent in a summary or a role field (11 §5: the user is "you"). */
export const YOU = 'you';
/** A paired contact whose shown name came out empty after the one-line cleaning. */
export const A_CONTACT = 'a contact';

/** The 04 §2 address form: `0x` and 40 lowercase hex characters. */
const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * Who an agent address is, in words: "you" for our own agent, the contact's shown name (06 §2.1
 * rule: owner alias or restricted name, with its label) for a paired contact, or "a contact" when
 * that name is empty. An address that is neither returns undefined: it is never shown outside the
 * untrusted block (I-5), so the caller leaves it out.
 */
export function addressLabel(
  address: unknown,
  selfId: string,
  contacts: ReadonlyMap<string, ContactRef>,
): string | undefined {
  if (typeof address !== 'string' || !ADDRESS.test(address)) return undefined;
  if (address === selfId) return YOU;
  const ref = contacts.get(address);
  if (ref === undefined) return undefined;
  return oneLineName(ref.name) === '' ? A_CONTACT : nameOf(ref);
}
