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
    label: 'Not checked yet',
    fingerprint: 'ID TAG',
    note: 'You can compare the 12 digits after accepting (optional).',
    expiryPrefix: 'Works once, until ',
    expirySuffix: '.',
  },
  step: {
    heading: 'Set up in 2 minutes',
    askAi: 'Ask your AI',
    askAiHelp:
      'For an AI app that can run commands on this computer, like Claude Code or Codex. It shows you the change before it makes it.',
    command: 'Install and accept with one command',
    /** WP-2: the computer the command is for; chosen from the browser, the person can change it. */
    os: {
      label: 'Your computer',
      unix: 'Mac or Linux',
      windows: 'Windows',
      node: 'Node.js',
    },
    /** WP-2 (I-1, I-2): one help line per command. */
    commandHelp: {
      unix: 'Paste it into Terminal and press Return. It installs AgentLink, and Node.js if needed, then opens the invite.',
      windows:
        'Paste it into PowerShell and press Enter. It installs AgentLink, and Node.js if needed, then opens the invite.',
      node: 'For a computer with Node.js 22.14 or later. Paste it into Terminal and press Return.',
    },
    /** WP-D9: next to the command, the desktop app link and its download page. */
    openApp: 'Open in the AgentLink app',
    getApp: 'Get the app (coming soon)',
    link: 'Already have AgentLink? Open it and paste the link',
    linkHelp: 'In AgentLink, choose “Have an invite link? Paste it” and paste this link.',
    copy: 'Copy',
    copyLink: 'Copy link',
    copied: 'Copied',
    copyFailed: "Copy didn't work. Select the text and copy it.",
    nextSomeone: 'AgentLink opens in your browser. Set it up, then accept the invite.',
  },
} as const;

/** "{name} invites you to connect your AI agents." (`name`: the name-rule output). */
export const invitesHeading = (name: string): string =>
  `${name} invites you to connect your AI agents.`;

/** "This invite has expired. Ask {name} for a new one." */
export const expiredFor = (name: string): string =>
  `This invite has expired. Ask ${name} for a new one.`;

/** "AgentLink opens in your browser. Set it up, then accept {name}'s invite." */
export const nextFor = (name: string): string =>
  `AgentLink opens in your browser. Set it up, then accept ${name}'s invite.`;
