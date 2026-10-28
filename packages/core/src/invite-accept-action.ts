// The approval action of accepting an invite (04 §3.4.1; M1-9o, IR-M1-9l-1 F02), and the invite's
// ready-to-send text (06 §2.1, 11 §6.1 J7). UX2-d1 moved both here from mcp-tools, so the MCP tool,
// the CLI `accept --approval` and the local app's accept route build one action (one owner approval
// serves every surface: the action digest is the sha256 of its JCS form, and a one-byte difference
// would make another surface's retry refuse) and one share text.
//
// Shape: `{tool, args: {inviteUrl}, context: {triggers, inviteId, counterparty}}`. `args` is the tool
// input after defaults, without `approvalId` and `clientRequestId`; `inviteUrl` is put in its full
// link form (the prefix added to a bare link code), so both spellings of one invite build one action
// and one approval serves either (M1-13a follow-up). `inviteId` and `counterparty` come from the
// decoded link, so an approval for one invite can never be used for another (I-4).
//
// I-7: the link carries the invite secret. Nothing here logs it; the action holding it is sealed by
// the approval store, and the share text goes only to the user's own agent or page.
import { INVITE_LINK_PREFIX, decodeInviteLink } from './invite-link.js';
import { renderContactName } from './names.js';
import type { PendingContact } from './pairing.js';

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
 * Builds the action for `inviteUrl` through the one codec (D-69). Throws core's fixed `invite_*`
 * errors for a link that does not decode (the caller has normally checked it already).
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

/** C0 and C1 controls and the line and paragraph separators. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_BREAK = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');

/**
 * IR UX2-d1 (Medium): the one approval summary for accepting `contact`'s invite, on every surface
 * (MCP tool, CLI, local app), so a request reused through `findOpen` reads the same everywhere. It
 * shows what 04 §3.6 Accept step 2 requires: the name under the name rule with its label, and the
 * short owner fingerprint. One line: controls and line breaks become spaces.
 */
export function acceptInviteSummary(contact: PendingContact): string {
  const name = renderContactName(contact.display).replace(CONTROL_OR_BREAK, ' ').trim();
  const owner = contact.ownerFingerprint.short.replace(CONTROL_OR_BREAK, ' ').trim();
  return acceptInviteApprovalSummary(`${name} (owner ${owner})`);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The ready-to-send invite text (11 §6.1 J7): the fixed template, the expiry as "4 Nov 2026" (UTC)
 * and the link. The same text as the MCP strings table's `chat.status.ok.inviteShare` (a drift test
 * in mcp-tools pins it). It holds the link: never log it (I-7).
 */
export function inviteShareText(inviteUrl: string, expiresAt: number): string {
  const at = new Date(expiresAt * 1000);
  const date = `${String(at.getUTCDate())} ${MONTHS[at.getUTCMonth()] ?? ''} ${String(at.getUTCFullYear())}`;
  return `Let's connect our AI agents with AgentLink. Open this link and follow the steps; it works once, until ${date}: ${inviteUrl}`;
}
