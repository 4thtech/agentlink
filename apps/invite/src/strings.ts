// Page copy, externalized (11 §5.4) and in the 11 §5 vocabulary (b11 §33.3, U3-invite). None of the
// fixed strings is built from the invite. The few that name the inviter take the name-rule output
// (06 §2.1) as an argument; the page sets their result with `textContent` only.
export const strings = {
  states: {
    none: 'Open the link someone sent you to connect your AI agents. This page only shows how to get started.',
    loading: 'Checking the invite in your browser…',
    expired: 'This invite has expired. Ask the person who sent it for a new one.',
    damaged: 'This invite is damaged or not supported. Ask the person who sent it for a new one.',
    oversized:
      'This invite is too large to be real, so there is nothing to show. Ask the person who sent it for a new one.',
    unavailable:
      'This invite is no longer available. It may have expired, been used or been cancelled. Ask the person who sent it for a new one.',
    unreachable: "Couldn't get the invite right now. Check your connection, then try again.",
    ready: '',
  },
  /** The button of the `unreachable` state: checks the invite once more. */
  retry: 'Try again',
  heading: {
    someone: 'Someone invites you to connect your AI agents.',
    time: 'Takes about 2 minutes.',
  },
  inviter: {
    label: 'Self-declared',
    fingerprint: 'FINGERPRINT',
    note: "Name chosen by its owner. You'll compare a safety code after accepting.",
    expiryPrefix: 'Works once, until ',
    expirySuffix: '.',
  },
  step: {
    heading: 'Set up in 2 minutes',
    command: 'Copy a command',
    askAi: 'Ask your AI',
    commandLabel: 'TERMINAL',
    askAiLabel: 'COPY THIS TO YOUR AI',
    commandHelp: 'Paste it into Terminal and press Return. Needs Node.js 22 or later.',
    askAiHelp:
      'For an AI app that can run commands on this computer, like Claude Code or Codex. It shows you the change before it makes it.',
    node: 'Need Node.js? Get it here',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: "Copy didn't work. Select the text and copy it.",
    nextSomeone: 'AgentLink opens in your browser. Set it up, then accept the invite.',
  },
} as const;

/** The official download page (08 §4): a fixed link in the page source, carrying nothing. */
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';

/** "{name} invites you to connect your AI agents." (`name`: the name-rule output). */
export const invitesHeading = (name: string): string =>
  `${name} invites you to connect your AI agents.`;

/** "This invite has expired. Ask {name} for a new one." */
export const expiredFor = (name: string): string =>
  `This invite has expired. Ask ${name} for a new one.`;

/** "AgentLink opens in your browser. Set it up, then accept {name}'s invite." */
export const nextFor = (name: string): string =>
  `AgentLink opens in your browser. Set it up, then accept ${name}'s invite.`;
