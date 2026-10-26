// The approval action of `agentlink_accept_invite` (04 §3.4.1; M1-9o, IR-M1-9l-1 F02). The tool and
// the CLI `accept --approval` both build it here, so one owner approval serves either surface: the
// action digest is the sha256 of its JCS form, and a one-byte difference would make the other
// surface's retry refuse (fail closed, but a needless second ask).
//
// Shape: `{tool, args: {inviteUrl}, context: {triggers, inviteId, counterparty}}`. `args` is the tool
// input after defaults, without `approvalId` and `clientRequestId`; `inviteUrl` is put in its full
// link form (the prefix added to a bare link code), so both spellings of one invite build one action
// and one approval serves either (M1-13a follow-up). `inviteId` and `counterparty`
// come from the decoded link, so an approval for one invite can never be used for another (I-4).
// Runtime-agnostic: core only.
import { INVITE_LINK_PREFIX, decodeInviteLink } from '@4thtech-io/core';

export interface AcceptInviteAction {
  readonly tool: 'agentlink_accept_invite';
  readonly args: { readonly inviteUrl: string };
  readonly context: {
    readonly triggers: readonly ['contacts.acceptInvites'];
    readonly inviteId: string;
    readonly counterparty: { readonly agentId: string; readonly ownerKey: string };
  };
}

/**
 * Builds the action for `inviteUrl`. Throws core's fixed `invite_*` errors for a link that does not
 * decode (the caller has normally checked it already).
 */
export async function acceptInviteAction(inviteUrl: string): Promise<AcceptInviteAction> {
  const invite = await decodeInviteLink(inviteUrl);
  return {
    tool: 'agentlink_accept_invite',
    args: {
      inviteUrl: inviteUrl.startsWith(INVITE_LINK_PREFIX)
        ? inviteUrl
        : `${INVITE_LINK_PREFIX}${inviteUrl}`,
    },
    context: {
      triggers: ['contacts.acceptInvites'],
      inviteId: invite.inviteId,
      counterparty: {
        agentId: invite.card.agentEvm,
        ownerKey: invite.card.ownerNostr.slice(2),
      },
    },
  };
}

/** The approval summary the owner sees (`contactName` is the name-rule form, one line). */
export const acceptInviteApprovalSummary = (contactName: string): string =>
  `Accept an invite from ${contactName}`;
