// W4-WIRE-2 / W5-PASTE-ENTRY: the one AgentLink invite link in pasted (or clipboard) text. Shared by
// the paste screen and the clipboard check, so both accept exactly the same forms (fail closed).
/** The canonical invite link prefix (core INVITE_LINK_PREFIX). */
const PREFIX = 'https://agentlink.4thtech.io/i#';
const BARE = 'agentlink.4thtech.io/i#';
/** Short link (04 §3.6.2): `2.` and the 43-character secret. */
const SHORT = /^2\.[A-Za-z0-9_-]{43}$/;
/** Long link (04 §3.6): strict base64url, at most the invite client's bound (invite-api.ts). */
const PAYLOAD = /^[A-Za-z0-9_-]{1,8192}$/;
/** More pasted text than any message with one link in it: refused unread. */
const MAX_TEXT = 32_768;
/** Punctuation a sentence or a quote may put around a link. */
const EDGE = /^[("'<[{“‘]+|[)"'>\]}.,;:!?”’]+$/g;

/**
 * The one AgentLink invite link in pasted text, as `https://agentlink.4thtech.io/i#<code>`, or
 * undefined. Every other text, another host or scheme, a look-alike host or two different links, is
 * refused (fail closed); the server checks the link again.
 */
export function inviteLinkOf(text: string): string | undefined {
  if (text.length > MAX_TEXT) return undefined;
  const found = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(EDGE, '');
    const rest = token.startsWith(PREFIX)
      ? token.slice(PREFIX.length)
      : token.startsWith(BARE)
        ? token.slice(BARE.length)
        : undefined;
    if (rest === undefined) continue;
    if (!SHORT.test(rest) && !PAYLOAD.test(rest)) return undefined;
    found.add(rest);
  }
  if (found.size !== 1) return undefined;
  const [code] = found;
  return `${PREFIX}${code ?? ''}`;
}
