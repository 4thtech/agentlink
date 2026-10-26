// The install-and-accept prompt (06 §7.1, D-53). It is the official template plus the canonical
// invite link and nothing else: the prompt is pasted as the user's own instruction, so it must hold
// nothing another party chose (I-5). The inviter's name and every other payload field stay out.
//
// This is the M1a variant (no local setup page until M1b); it is the same text as the second prompt
// in skills/agentlink/SKILL.md, and a test keeps them equal. The per-harness variants arrive with
// M1-25; they will add entries here and nothing else.

/** The official template. `{inviteUrl}` is filled with the canonical link, and only with that. */
export const INSTALL_AND_ACCEPT_TEMPLATE =
  "Install AgentLink for me and accept an invite. If AgentLink is not set up yet, run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, apply it only after I confirm, and tell me the one command to run in my own terminal to protect my approvals; never ask me for the passphrase. Then accept this AgentLink invite: {inviteUrl}. If your AgentLink tools only appear after a restart, accept it with `npx -y @4thtech-io/agentlink accept '{inviteUrl}'` instead.";

/** The invite host and path every canonical link starts with (06 §7.1). */
export const CANONICAL_PREFIX = 'https://agentlink.4thtech.io/i#';

/** `https://agentlink.4thtech.io/i#` followed by base64url characters only, so no shell expands it. */
const CANONICAL_LINK = /^https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]+$/;

/** True for the canonical invite link. */
export const isCanonicalLink = (link: string): boolean => CANONICAL_LINK.test(link);

/** The prompt for a canonical link. Anything else is refused: there is no prompt without a checked link. */
export function buildPrompt(inviteUrl: string): string {
  if (!isCanonicalLink(inviteUrl)) throw new Error('not a canonical invite link');
  return INSTALL_AND_ACCEPT_TEMPLATE.replaceAll('{inviteUrl}', inviteUrl);
}
