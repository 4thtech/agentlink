// The invite deep link (plan 2026-11-12 Decision 4, WP-D9; 08 §4 "One step from an invite link").
//
// The invite page's "Open in the AgentLink app" button opens `agentlink://join#<payload>`. The
// shell reads that link from exactly two places, both already narrowed by main.ts / switches.ts:
// - Windows and Linux: the one argument after `--` (the scheme is registered as `"<exe>" -- "%1"`),
//   on a first launch from argv, on a second launch from the single-instance additionalData (never
//   the second instance's raw argv);
// - macOS: the `open-url` event.
//
// toInviteLink accepts only the exact prefix `agentlink://join#` followed by a payload that, put
// after the canonical prefix `https://agentlink.4thtech.io/i#`, matches the same two patterns as
// `agentlink join` (apps/cli/src/commands/join.ts), the invite page (apps/invite/src/prompt.ts) and
// the installers: 1 to 21 846 base64url characters, or `2.` and 43 base64url characters whose last
// one has zero trailing bits. A test compares the pattern sources with join.ts and prompt.ts.
// That character set has no space, quote, `#`, `%`, `:` or `/`, so a link with a switch appended
// (`agentlink://x --remote-debugging-port=1`), a second link, percent-encoding, another host or
// path, or any confusable character is ignored: null, silently, nothing logged or shown (I-5, I-7).
// Other schemes never get here (switches.ts), and are refused here too.
//
// The rebuilt canonical link goes to the core over the pipe (`invite`, shared/protocol.ts). The core
// runs the D-69 decoder and Accept step 1, keeps it as the waiting invite in memory and opens the
// join screen ("Accept {name}'s invite?"); accepting needs the owner's presence. The answer comes
// back as `invite-result` with a fixed word; the shell shows the fixed copy below for the outcomes
// where no page opens. Residual (plan Decision 4): any website can trigger the scheme; the most it
// can do is show that screen or one of these dialogs.

import {
  INVITE_LINK_PREFIX,
  isCanonicalInviteLink,
  type InviteOutcome,
} from '../shared/protocol.js';

/** The only deep link the shell acts on. */
export const DEEP_LINK_JOIN_PREFIX = 'agentlink://join#';

/** 08 §4, the long form (equal to `CANONICAL` in apps/cli/src/commands/join.ts). */
export const INVITE_LONG_PATTERN = /^https:\/\/agentlink\.4thtech\.io\/i#[A-Za-z0-9_-]{1,21846}$/;
/** 08 §4 / D-139, the short form (equal to `SHORT` in apps/cli/src/commands/join.ts). */
export const INVITE_SHORT_PATTERN =
  /^https:\/\/agentlink\.4thtech\.io\/i#2\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** Longest deep link that can be valid: the prefix and the long-form payload cap. */
const MAX_JOIN_LINK_CHARS = DEEP_LINK_JOIN_PREFIX.length + 21_846;

/**
 * The canonical invite link for an `agentlink://join#<payload>` deep link, or null to ignore it.
 * Pure; never throws; never logs.
 */
export function toInviteLink(deepLink: unknown): string | null {
  if (typeof deepLink !== 'string') return null;
  if (deepLink.length > MAX_JOIN_LINK_CHARS) return null;
  if (!deepLink.startsWith(DEEP_LINK_JOIN_PREFIX)) return null;
  // Canonical rebuild: the page's own prefix and the payload only, never anything else of the link.
  const link = `${INVITE_LINK_PREFIX}${deepLink.slice(DEEP_LINK_JOIN_PREFIX.length)}`;
  if (!INVITE_LONG_PATTERN.test(link) && !INVITE_SHORT_PATTERN.test(link)) return null;
  // The pipe's own check (the core refuses anything else as a protocol violation).
  return isCanonicalInviteLink(link) ? link : null;
}

/**
 * The fixed text for an `invite-result` (11 §5; the wording of `agentlink join`, JOIN_TEXT, for an
 * app link). `waiting` has none: the join screen opens. Nothing from the invite is ever inserted.
 */
export const INVITE_RESULT_COPY: Readonly<Record<Exclude<InviteOutcome, 'waiting'>, string>> =
  Object.freeze({
    invite_waiting:
      'Finish or close the invite already open in AgentLink, then open the link again.',
    refused:
      "This isn't a complete AgentLink invite. Open the invite page again and use its button.",
    expired: 'This invite has expired. Ask the person who sent it for a new one.',
    unavailable:
      'This invite is no longer available. It may have expired, been used or been cancelled. Ask the person who sent it for a new one.',
    unreachable:
      "AgentLink couldn't fetch this invite. Check your connection, then open the link again.",
    failed:
      "AgentLink couldn't open this invite. Open the link again, or ask the person who sent it for a new one.",
  });

/** The dialog title for an invite result. */
export const INVITE_RESULT_TITLE = 'AgentLink invite';

/** The fixed text for `outcome`, or null when there is nothing to show (`waiting`, unknown). */
export function inviteResultCopy(outcome: InviteOutcome): string | null {
  if (outcome === 'waiting') return null;
  return Object.prototype.hasOwnProperty.call(INVITE_RESULT_COPY, outcome)
    ? INVITE_RESULT_COPY[outcome]
    : null;
}
