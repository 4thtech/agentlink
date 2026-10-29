// The texts the invite page copies (06 §7.1, 08 §4, D-53; U3-invite). Each is a fixed template plus
// the canonical invite link and nothing else: it is pasted as the user's own instruction or command,
// so it must hold nothing another party chose (I-5). The inviter's name and every other payload field
// stay out.
//
// - INSTALL_AND_ACCEPT_TEMPLATE: the D-53 install-and-accept prompt. U3-invite took it off the page;
//   it stays the documented prompt in skills/agentlink/SKILL.md (a test keeps them equal).
// - JOIN_COMMAND_TEMPLATE and ASK_AI_TEMPLATE (U3-invite, 08 §4 "One step from an invite link"): the
//   page's one step, as one command for Terminal or one sentence for the person's own AI.

/** The official D-53 template. `{inviteUrl}` is filled with the canonical link, and only with that. */
export const INSTALL_AND_ACCEPT_TEMPLATE =
  "Install AgentLink for me and accept an invite. If AgentLink is not set up yet, run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, apply it only after I confirm, and tell me the one command to run in my own terminal to protect my approvals; never ask me for the passphrase. Then accept this AgentLink invite: {inviteUrl}. If your AgentLink tools only appear after a restart, accept it with `npx -y @4thtech-io/agentlink accept '{inviteUrl}'` instead.";

/** U3-invite: the command (08 §4). The link is single-quoted; no line break at the end. */
export const JOIN_COMMAND_TEMPLATE = "npx -y @4thtech-io/agentlink join '{inviteUrl}'";

/** U3-invite: the sentence for an AI app that can run commands on this computer (08 §4). */
export const ASK_AI_TEMPLATE =
  "Set up AgentLink for me. Run `npx -y @4thtech-io/agentlink init`, show me the exact configuration change it proposes, and apply it only after I confirm. Then show me this command so I can run it myself in my own terminal, and don't run it for me: `npx -y @4thtech-io/agentlink join '{inviteUrl}'`. It opens the AgentLink app, where I accept the invite. Never ask me for a code or passphrase.";

/**
 * The longest command the page offers (08 §4): `cmd.exe` takes at most 8 191 characters, so above
 * this only the sentence is shown. AgentLink's own invites are far shorter (04 §3.6).
 */
export const MAX_COMMAND_CHARS = 8000;

/** The invite host and path every canonical link starts with (06 §7.1): the page's build constant. */
export const CANONICAL_PREFIX = 'https://agentlink.4thtech.io/i#';

/**
 * 08 §4: `https://agentlink.4thtech.io/i#` and 1 to 21 846 base64url characters (the payload cap of
 * 04 §3.6), nothing else. That set holds no character that sh, bash, zsh, fish, PowerShell or cmd.exe
 * treats specially (no quote, space, line break, `$`, backtick, `;`, `&`, `|`, `<`, `>`, `(`, `)`,
 * `%`, `^`, `!`, `\` or `"`), and the link is single-quoted as well.
 */
const CANONICAL_LINK = /^https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]{1,21846}$/;

/** True for the canonical invite link. */
export const isCanonicalLink = (link: string): boolean => CANONICAL_LINK.test(link);

function fill(template: string, inviteUrl: string): string {
  if (!isCanonicalLink(inviteUrl)) throw new Error('not a canonical invite link');
  return template.replaceAll('{inviteUrl}', inviteUrl);
}

/** The D-53 prompt for a canonical link. Anything else is refused. */
export const buildPrompt = (inviteUrl: string): string =>
  fill(INSTALL_AND_ACCEPT_TEMPLATE, inviteUrl);

/**
 * U3-invite: the command for a canonical link, or undefined when it would be longer than
 * MAX_COMMAND_CHARS (then the page shows only the sentence). Anything else is refused.
 */
export function buildJoinCommand(inviteUrl: string): string | undefined {
  const command = fill(JOIN_COMMAND_TEMPLATE, inviteUrl);
  return command.length > MAX_COMMAND_CHARS ? undefined : command;
}

/** U3-invite: the sentence for a canonical link. Anything else is refused. */
export const buildAskAi = (inviteUrl: string): string => fill(ASK_AI_TEMPLATE, inviteUrl);
