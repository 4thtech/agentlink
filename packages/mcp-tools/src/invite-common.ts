// Fixed text and core-error mapping for the invite tools (M1-9o; 06 §2.1, §2.5). Nothing here is
// built from a value: an invite link, a label or a name from another party never reaches a summary,
// `nextStep` or error except through the 06 §2.1 name rule (I-5). Moving these sentences into the
// copy sheet is M1-9g's, after M1-9o/p/q.
import { CoreError, type InviteLimitError } from '@4thtech-io/core';
import { approvalIdSchema } from '@4thtech-io/types';
import { fail, type HandlerOutput } from './result.js';
import { noOwnerCard } from './text.js';
import { NPX_COMMAND } from './cli-command.js';

export const INVITE_TEXT = Object.freeze({
  createdNext:
    'Show the user the text above so they can send it to the person they want to connect with. The invite works once. Then wait for the other side to accept.',
  invalidLabel: "That label isn't valid, so no invite was made.",
  invalidLabelNextStep: 'Call the tool again with a short plain label, or none.',
  invalidOptions: "That expiry isn't valid, so no invite was made.",
  invalidOptionsNextStep: 'Call the tool again with 1 to 7 days, or leave it out.',
  inviteInvalid: "That invite link isn't valid, so nothing was done.",
  inviteInvalidNextStep:
    'Ask the user to check the link, or to ask the other person for a new invite.',
  inviteUnavailable:
    'That invite is no longer available (it expired, was used or was cancelled), so nothing was done.',
  inviteUnavailableNextStep: 'Ask the user to ask the other person for a new invite.',
  inviteFetchFailed: "AgentLink couldn't fetch that invite just now, so nothing was done.",
  inviteFetchFailedNextStep: 'Call the tool again in a minute with the same inviteUrl.',
  inviteExpired: 'That invite has expired, so nothing was done.',
  inviteExpiredNextStep: 'Ask the user to ask the other person for a new invite.',
  inviteSelf: 'That invite was made by this AgentLink ID, so nothing was done.',
  inviteSelfNextStep: 'An AgentLink ID cannot connect with itself. Tell the user.',
  pairingRefused: "AgentLink can't connect with that contact, so nothing was done.",
  pairingRefusedNextStep: `Tell the user. They can run \`${NPX_COMMAND} contacts\` in their own terminal to see why.`,
  cannotSend: "This AgentLink ID can't send messages right now, so nothing was done.",
  cannotSendNextStep: `Tell the user to run \`${NPX_COMMAND} doctor\` in their own terminal to see why.`,
  policyDenied: "The user's rules don't let this AgentLink ID accept invites, so nothing was done.",
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
  accepted: "Invite accepted. You'll be connected when they answer.",
  acceptedOffline:
    "Invite accepted, but the message network can't be reached right now. AgentLink keeps the answer ready and sends it when the network is back.",
  // SEC-INVITE-CAPS (D-156; 06 §2.1): the owner's caps on invites the AI makes.
  limitOpen:
    'You have {count} open invites. Ask your owner to create more in the app, or wait for one to be used or expire.',
  limitDaily:
    'You made {count} invites in the last 24 hours. Ask your owner to create more in the app, or try again after {time} UTC.',
  limitOff: "Your owner hasn't allowed you to create invites. Ask them to create one in the app.",
  limitNextStep:
    'Tell the user. They can create an invite under People in the AgentLink app, or change the limits under Rules.',
  acceptedNextStep:
    'Tell the user they will be connected when the other person answers; nothing else is needed now. The owner can do the Contact check with the contact under People in the AgentLink app; until then the name is self-declared.',
});

/**
 * SEC-INVITE-CAPS (D-156; 06 §2.2): the fixed refusal for a contact the AI connected that waits for
 * the owner. It never names the contact (I-5).
 */
export const WAITING_OWNER_TEXT = Object.freeze({
  summary:
    'This contact is waiting for your owner to keep them in the AgentLink app, so nothing was sent.',
  proofSummary:
    'This contact is waiting for your owner to keep them in the AgentLink app, so no proof or receipt was added.',
  nextStep:
    'Tell the user your AI connected this contact: they can tap Keep under People in the AgentLink app. Their messages still arrive meanwhile.',
});

export const waitingOwner = (): HandlerOutput =>
  fail(
    'rejected',
    WAITING_OWNER_TEXT.summary,
    WAITING_OWNER_TEXT.nextStep,
    'CONTACT_WAITING_OWNER',
  );

/** SEC-INVITE-CAPS: "YYYY-MM-DD HH:MM" in UTC (a number from the core, never input). */
const utcMinute = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ');

/** SEC-INVITE-CAPS: the result for an AI-made invite over the owner's caps (numbers only, I-5). */
export function inviteLimit(error: InviteLimitError): HandlerOutput {
  const count = String(error.max);
  let summary: string;
  if (error.max === 0) summary = INVITE_TEXT.limitOff;
  else if (error.limit === 'open') summary = INVITE_TEXT.limitOpen.replace('{count}', count);
  else {
    summary = INVITE_TEXT.limitDaily
      .replace('{count}', count)
      .replace('{time}', error.resetAt === undefined ? 'a while' : utcMinute(error.resetAt));
  }
  return fail('rejected', summary, INVITE_TEXT.limitNextStep, 'INVITE_LIMIT');
}

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
  `Then retry this call with the same inviteUrl and approvalId ${checkedApprovalId(approvalId)}.`;

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
    case 'concurrent_rotation':
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
    case 'invite_unavailable':
      return fail(
        'rejected',
        INVITE_TEXT.inviteUnavailable,
        INVITE_TEXT.inviteUnavailableNextStep,
        'INVITE_UNAVAILABLE',
      );
    case 'invite_fetch_failed':
      return fail(
        'error',
        INVITE_TEXT.inviteFetchFailed,
        INVITE_TEXT.inviteFetchFailedNextStep,
        'INVITE_FETCH_FAILED',
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
