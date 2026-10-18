// Fixed text and core-error mapping for the invite tools (M1-9o; 06 §2.1, §2.5). Nothing here is
// built from a value: an invite link, a label or a name from another party never reaches a summary,
// `nextStep` or error except through the 06 §2.1 name rule (I-5). Moving these sentences into the
// copy sheet is M1-9g's, after M1-9o/p/q.
import { CoreError } from '@4thtech-io/core';
import { approvalIdSchema } from '@4thtech-io/types';
import { fail, type HandlerOutput } from './result.js';
import { noOwnerCard } from './text.js';

export const INVITE_TEXT = Object.freeze({
  createdNext:
    'Show the user the text above so they can send it to the person they want to connect with. The invite works once. Tell them the safety code appears only after the other side accepts, and they compare it in AgentLink, not in this chat.',
  invalidLabel: "That label isn't valid, so no invite was made.",
  invalidLabelNextStep: 'Call the tool again with a short plain label, or none.',
  invalidOptions: "That expiry isn't valid, so no invite was made.",
  invalidOptionsNextStep: 'Call the tool again with 1 to 7 days, or leave it out.',
  inviteInvalid: "That invite link isn't valid, so nothing was done.",
  inviteInvalidNextStep:
    'Ask the user to check the link, or to ask the other person for a new invite.',
  inviteExpired: 'That invite has expired, so nothing was done.',
  inviteExpiredNextStep: 'Ask the user to ask the other person for a new invite.',
  inviteSelf: 'That invite was made by this agent, so nothing was done.',
  inviteSelfNextStep: 'An agent cannot connect with itself. Tell the user.',
  pairingRefused: "AgentLink can't connect with that contact, so nothing was done.",
  pairingRefusedNextStep:
    'Tell the user. They can run `agentlink contacts` in their own terminal to see why.',
  cannotSend: "This agent can't send messages right now, so nothing was done.",
  cannotSendNextStep: 'Tell the user to run `agentlink doctor` in their own terminal to see why.',
  policyDenied: "The user's rules don't let this agent accept invites, so nothing was done.",
  policyDeniedNextStep: 'Tell the user. Only they can change that rule.',
  approvalDenied: "The owner didn't approve accepting this invite, so nothing was done.",
  approvalDeniedNextStep: 'Tell the user. Only call again without approvalId if they ask you to.',
  approvalExpired: 'That approval expired before it was used, so nothing was done.',
  approvalExpiredNextStep: 'Call the tool again without approvalId to ask the owner again.',
  approvalUsed: 'That approval was already used, so nothing was done.',
  approvalUsedNextStep:
    'Check agentlink_list_contacts. If the contact is not there, pairing did not complete: call the tool again without approvalId to ask the owner for a new approval.',
  approvalVoid: "That approval can't be used for this invite, so nothing was done.",
  approvalVoidNextStep: 'Call the tool again without approvalId to ask the owner for a new one.',
  approvalPending: "The owner hasn't decided on this request yet, so nothing was done.",
  approvedNeedsId:
    "The owner already approved accepting this invite, but this call didn't include the approvalId, so nothing was done yet.",
  accepted:
    "Invite accepted. You'll be connected when the other agent answers. The safety code appears on the owner's own screen.",
  acceptedOffline:
    "Invite accepted, but the message network can't be reached right now. AgentLink keeps the answer ready and sends it when the network is back.",
  acceptedNextStep:
    'Tell the user to compare the safety code on their own screen (the local app, or `agentlink contacts --verify` in their own terminal) once they are connected, never in this chat.',
});

/** The core's `apr_` ID: the schema and the exact character pattern (04 §2.4.1). */
const APPROVAL_ID_CHARS = /^apr_[A-Za-z0-9_-]{22}$/;

function checkedApprovalId(approvalId: string): string {
  if (!APPROVAL_ID_CHARS.test(approvalId) || !approvalIdSchema.safeParse(approvalId).success) {
    // The core made this ID; anything else is a bug and becomes the generic internal error.
    throw new Error('approval id out of pattern');
  }
  return approvalId;
}

/**
 * The accept-specific sentence after the `pending_approval` nextStep (M1-13a follow-up): the second
 * call must repeat the same link AND name the approval. The only inserted value is the core's
 * `apr_` ID, checked against its exact pattern first; the link is never echoed (I-5).
 */
export const acceptRetryStep = (approvalId: string): string =>
  `That is: call agentlink_accept_invite with the same inviteUrl and approvalId ${checkedApprovalId(approvalId)}. Without approvalId it does not accept the invite.`;

/** The nextStep when the owner already approved but the call named no approval (M1-13a follow-up). */
export const approvedNeedsIdStep = (approvalId: string): string =>
  `Call agentlink_accept_invite again now with the same inviteUrl and approvalId ${checkedApprovalId(approvalId)}.`;

/**
 * Maps the core's errors for a bad or unusable invite, or an agent that cannot send, to fixed
 * results. Any other error is not mapped (the caller lets it become the generic internal error).
 */
export function inviteFailure(error: unknown): HandlerOutput | undefined {
  if (!(error instanceof CoreError)) return undefined;
  switch (error.code) {
    case 'identity_missing':
      return fail('needs_setup', noOwnerCard().summary, noOwnerCard().nextStep);
    case 'identity_revoked':
    case 'rotation_pending':
    case 'key_epoch_mismatch':
      return fail(
        'rejected',
        INVITE_TEXT.cannotSend,
        INVITE_TEXT.cannotSendNextStep,
        'AGENT_CANNOT_SEND',
      );
    case 'invite_expired':
      return fail(
        'rejected',
        INVITE_TEXT.inviteExpired,
        INVITE_TEXT.inviteExpiredNextStep,
        'INVITE_EXPIRED',
      );
    case 'contact_is_self':
      return fail(
        'rejected',
        INVITE_TEXT.inviteSelf,
        INVITE_TEXT.inviteSelfNextStep,
        'CONTACT_IS_SELF',
      );
    case 'contact_revoked':
    case 'contact_conflict':
    case 'repair_owner_changed':
    case 'repair_epoch_lower':
      return fail(
        'rejected',
        INVITE_TEXT.pairingRefused,
        INVITE_TEXT.pairingRefusedNextStep,
        'PAIRING_REFUSED',
      );
    case 'invite_invalid':
    case 'invite_too_large':
    case 'card_invalid':
    case 'card_owner_signature_invalid':
    case 'card_agent_signature_invalid':
    case 'card_expired':
    case 'name_invalid':
    case 'relays_invalid':
      return fail(
        'error',
        INVITE_TEXT.inviteInvalid,
        INVITE_TEXT.inviteInvalidNextStep,
        'INVALID_INVITE',
      );
    default:
      return undefined;
  }
}
