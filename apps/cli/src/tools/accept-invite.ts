// `agentlink_accept_invite` (06 §2.1, §2.5; 04 §3.6, §3.6.1; M1-9o). Policy `contacts.acceptInvites`
// is `approval` by default: the first call stores nothing and returns `pending_approval` with the
// fixed `nextStep` that sends the owner to `agentlink approve` in their own terminal, plus one
// sentence that names this tool, the same `inviteUrl` and the `approvalId`. A call again without the
// ID gets the open request back (the same ID while pending; while approved, a refusal that names the
// ID, never a use), so a confused agent cannot pile up requests (M1-13a follow-up). The retry with
// the `approvalId` pairs once: core re-verifies the owner's stored signature against the digest it
// recomputes from THIS call's action and claims the approval in one compare-and-set (I-4).
//
// The action is built by `acceptInviteAction` (accept-action.ts), the same builder the CLI
// `accept --approval` uses, so one approval serves both. This handler never sets `allowed` from an
// argument: pairing starts only after the policy says `allow` or the approval was used.
//
// I-5: the link, and the name and relays it carries, are untrusted. Nothing from the link is echoed
// except the counterparty's name under the 06 §2.1 rule (restricted name plus label, never the
// self-declared name). No safety code is ever returned (04 §3.6.1).
import type { PendingContact } from '@agentlink/core';
import { acceptInviteAction, acceptInviteApprovalSummary } from './accept-action.js';
import { renderRef, type ContactRef } from './contacts.js';
import type { ToolContext } from './context.js';
import {
  INVITE_TEXT,
  acceptRetryStep,
  approvedNeedsIdStep,
  inviteFailure,
} from './invite-common.js';
import { fail, notAvailable, ok, pendingApproval, type HandlerOutput } from './result.js';
import { removeInvisible } from './untrusted.js';

interface AcceptInput {
  inviteUrl: string;
  approvalId?: string;
}

function refOf(contact: PendingContact): ContactRef {
  return Object.freeze({
    id: contact.id,
    name: contact.display.name,
    label: contact.display.label,
    nameSource: contact.display.nameSource,
  });
}

/** `pending_approval` with the accept-specific retry sentence after the shared nextStep. */
function acceptPending(context: ToolContext, approvalId: string, summary: string): HandlerOutput {
  const out = pendingApproval(context, approvalId, summary);
  return {
    ...out,
    result: {
      ...out.result,
      nextStep: `${out.result.nextStep ?? ''} ${acceptRetryStep(approvalId)}`.trim(),
    },
  };
}

const oneLine = (text: string): string => removeInvisible(text).replace(/\n/g, ' ').trim();

export async function acceptInviteHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  const invites = context.client.invites;
  if (invites === undefined) return notAvailable();
  const { inviteUrl, approvalId } = input as AcceptInput;

  try {
    // Step 1 always runs and stores nothing: decode, strict schema, expiry, both card signatures,
    // name and relays (04 §3.6 Accept). A bad link ends here with fixed text.
    const checked = await invites.check(inviteUrl);
    const ref = refOf(checked);
    const contact = {
      ...ref,
      ownerFingerprint: checked.ownerFingerprint.short,
      pairing: checked.pairing,
      safetyCodeChecked: checked.safetyCodeChecked,
    };
    const action = await acceptInviteAction(inviteUrl);
    const decision = await invites.decision();
    if (decision === 'deny') {
      return fail(
        'rejected',
        INVITE_TEXT.policyDenied,
        INVITE_TEXT.policyDeniedNextStep,
        'POLICY_DENIED',
      );
    }
    const askSummary = acceptInviteApprovalSummary(oneLine(renderRef(ref)));

    if (decision === 'approval') {
      if (approvalId === undefined) {
        // Called again without the ID (M1-13a follow-up): hand back the open request for this same
        // action instead of asking the owner twice. An approved one is never used from here: the
        // call must name it, so the owner's decision stays tied to an explicit retry (I-4).
        const open = await invites.findOpenApproval(action);
        if (open?.status === 'approved') {
          return fail(
            'rejected',
            INVITE_TEXT.approvedNeedsId,
            approvedNeedsIdStep(open.approvalId),
            'APPROVAL_ID_MISSING',
          );
        }
        const id = open?.approvalId ?? (await invites.requestApproval(action, askSummary));
        return acceptPending(context, id, askSummary);
      }
      const used = await invites.useApproval(approvalId, action, decision);
      if (used.status === 'pending') return acceptPending(context, approvalId, askSummary);
      if (used.status === 'denied' || used.status === 'cancelled') {
        return fail(
          'rejected',
          INVITE_TEXT.approvalDenied,
          INVITE_TEXT.approvalDeniedNextStep,
          'APPROVAL_DENIED',
        );
      }
      if (used.status === 'expired') {
        return fail(
          'rejected',
          INVITE_TEXT.approvalExpired,
          INVITE_TEXT.approvalExpiredNextStep,
          'APPROVAL_EXPIRED',
        );
      }
      if (used.status === 'void') {
        return fail(
          'rejected',
          INVITE_TEXT.approvalUsed,
          INVITE_TEXT.approvalUsedNextStep,
          'APPROVAL_USED',
        );
      }
      if (used.status !== 'used') {
        return fail(
          'rejected',
          INVITE_TEXT.approvalVoid,
          INVITE_TEXT.approvalVoidNextStep,
          'APPROVAL_VOID',
        );
      }
    }

    await invites.start(inviteUrl);
    const sent = await invites.publish();
    return ok(sent ? INVITE_TEXT.accepted : INVITE_TEXT.acceptedOffline, {
      nextStep: INVITE_TEXT.acceptedNextStep,
      contact,
    });
  } catch (error) {
    const mapped = inviteFailure(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }
}
