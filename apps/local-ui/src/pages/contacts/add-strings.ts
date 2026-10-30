// UX2-d2: the Add contact sheet's copy (b11 §21.7; 11 §5). `{name}` is always the name rule's
// output or the name the owner typed, rendered as React text. The sheet never says the link is
// "secure", "safe" or "encrypted" (b11 §21.3): it is single use and expires, and that is all it says.
export const ADD_STRINGS = {
  addContact: 'Add contact',
  back: 'Back',
  close: 'Close',
  tabsLabel: 'Add contact',
  inviteSomeone: 'Invite someone',
  haveInvite: 'I have an invite',
  whoFor: 'Who is it for? (optional)',
  whoForHint: 'Helps you recognise them when they answer.',
  nameInvalid: 'Use letters, numbers and spaces, up to 32.',
  createInvite: 'Create invite',
  creating: 'Creating…',
  inviteReadyPlain: 'Invite ready',
  copyInvite: 'Copy invite',
  copied: 'Copied',
  inviteCopied: 'Invite copied',
  copyFailed: "Couldn't copy. Select the text above and copy it.",
  share: 'Share…',
  shareTitle: 'AgentLink invite',
  shareFailed: "Sharing didn't work. Use Copy invite instead.",
  showQr: 'Show QR code',
  hideQr: 'Hide QR code',
  qrCaption: "Scan it with their phone's camera.",
  done: 'Done',
  notSentYet: "You haven't sent the invite yet. Close anyway?",
  closeAnyway: 'Close anyway',
  keepOpen: 'Keep it open',
  cantCreate: "Couldn't create the invite. Try again in a minute.",
  tryAgain: 'Try again',
  notSetUp: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
  sessionExpired: 'This page has expired. Ask your AI to open AgentLink again.',
  pasteLabel: 'Paste the invite link',
  pasteHint: 'It starts with https://agentlink.4thtech.io/i#',
  checkInvite: 'Check invite',
  checking: 'Checking the invite…',
  isThisWho: 'Is this who you expected?',
  connect: 'Connect',
  cancel: 'Cancel',
  inviteExpired: 'This invite has expired.',
  inviteUsed: 'This invite was already used.',
  inviteDamaged: "This link isn't a complete AgentLink invite. Ask for it again.",
  ownInvite: 'This is your own invite.',
  cantUse: "This invite can't be used here.",
  askForNew: 'Ask the person who sent it for a new invite.',
  offline: "Can't reach AgentLink on this computer. Try again in a minute.",
  connectRefused: "Couldn't connect with this invite. Nothing was changed. Check it again.",
  advanced: 'Advanced',
  longLink: 'Use a long link',
  longLinkHint:
    'A longer link that holds everything itself. Nothing is stored on the AgentLink service.',
  cancelInvite: 'Cancel',
  cantCancel: "Couldn't cancel the invite. Try again in a minute.",
  unavailableInvite:
    "This invite can't be used anymore. It may have expired, been used or been cancelled. Ask for a new one.",
  busyTryAgain: "AgentLink couldn't check the invite just now. Try again in a minute.",
  pendingLabel: 'Invites waiting for an answer',
  daysLeftLabel: 'Time left',
} as const;

/** The ready heading: "Invite ready for {name}", or "Invite ready" without a name. */
export function inviteReady(name: string | undefined): string {
  return name === undefined ? ADD_STRINGS.inviteReadyPlain : `Invite ready for ${name}`;
}

/** The expiry line under the ready text. */
export function worksUntil(date: string): string {
  return `Works once, until ${date}.`;
}

/** The safety line (b11 §21.3): bold part first, then the plain advice. */
export function safetyLead(name: string | undefined): string {
  return name === undefined
    ? 'Send it only to the person you mean. Anyone with this link can connect once.'
    : `Send it only to ${name}. Anyone with this link can connect once.`;
}

export const SAFETY_ADVICE =
  "A private chat, email or text message is fine. Don't post it publicly.";

export function safetyLine(name: string | undefined): string {
  return `${safetyLead(name)} ${SAFETY_ADVICE}`;
}

/** The QR code's accessible name: never the link itself (b11 §21.6). */
export function qrLabel(name: string | undefined): string {
  return name === undefined ? 'QR code of the invite' : `QR code of the invite for ${name}`;
}

/** The pending row (b11 §21.3, Closing). */
export function waitingToAccept(name: string | undefined): string {
  return `Waiting for ${name ?? 'them'} to accept`;
}

/** The expiry under a pending row. */
export function expiresIn(days: number): string {
  return days === 1 ? 'Expires in 1 day' : `Expires in ${String(days)} days`;
}

export function daysLeft(days: number): string {
  return days === 1 ? '1 day left' : `${String(days)} days left`;
}

export function connectingTo(name: string): string {
  return `Connecting to ${name}…`;
}

/** The presence summary before Touch ID: what Connect does, by name. */
export function connectSummary(name: string): string {
  return `Connect to ${name}.`;
}
