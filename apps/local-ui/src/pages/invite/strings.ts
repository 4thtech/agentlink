// W4-PEOPLE-INVITE: the copy of the Invite screen, the pending-invite row, the person menu and the
// Connected moment (prototype v23 A3, A5–A7; 11 §5). `{name}` is always the name the owner typed or
// the name rule's output, rendered as React text. No "wallet", "gas", "seed phrase", "transaction",
// "key" or "relay" here. The safety code stays 12 digits in 0.4.6 (words later).
export const INVITE_STRINGS = {
  title: 'Invite someone',
  intro: 'Send them this link. When they accept, your AIs can talk.',
  back: 'Home',
  whoFor: 'Who is it for?',
  optional: 'Optional',
  whoForHint: "Only for your list. It isn't sent anywhere.",
  placeholder: 'e.g. Denis',
  nameInvalid: 'Use letters, numbers and spaces, up to 32.',
  linkLabel: 'Invite link',
  making: 'Making your link…',
  copy: 'Copy',
  copied: 'Copied',
  copiedAnnounce: 'Invite link copied',
  copyFailed: "Couldn't copy. Select the link and copy it.",
  email: 'Email',
  emailSubject: 'Connect our AIs on AgentLink',
  share: 'Share',
  shareTitle: 'AgentLink invite',
  shareFailed: "Sharing didn't work. Use Copy instead.",
  onlyThem: 'Only the person with the link can accept.',
  seeTheirs: "See what they'll see",
  hideTheirs: "Hide what they'll see",
  theirsLabel: "What they'll see",
  done: 'Done',
  cantCreate: "Couldn't make the link. Try again in a minute.",
  tryAgain: 'Try again',
  notSetUp: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
  sessionExpired: 'This page has expired. Ask your AI to open AgentLink again.',
  fellBack: "Short links aren't available right now, so this is a long link. It works the same.",
  // Under the hood (pro): the long link, the QR code and the invite's facts.
  details: 'Invite details',
  kind: 'Link',
  kindShort: 'Short link (kept encrypted on the AgentLink service until it is used)',
  kindLong: 'Long link (holds everything itself, nothing stored)',
  expires: 'Expires',
  makeLong: 'Make a long link instead',
  makeShort: 'Make a short link instead',
  showQr: 'Show QR code',
  hideQr: 'Hide QR code',
  qrCaption: "Scan it with their phone's camera.",
  qrLabel: 'QR code of the invite',
  // The pending row.
  someone: 'Someone',
  cancelInvite: 'Cancel invite',
  cancelling: 'Cancelling…',
  cancelled: 'Invite cancelled. The link no longer works.',
  cantCancel: "Couldn't cancel the invite. Try again in a minute.",
  pendingLabel: 'Invites waiting for an answer',
  // The person menu.
  rename: 'Rename',
  checkCode: 'Check safety code',
  remove: 'Remove',
  // The friend's side and the Connected moment.
  nameBySender: 'Name set by the sender',
  acceptBody: (name: string): string =>
    `Your AI and ${name}'s agent can then send each other messages and files. Encrypted end to end. You approve anything that matters.`,
  noAgentLinkYet: 'No AgentLink yet? This installs AgentLink and connects your AI app.',
  notNow: 'Not now',
  declined: (date: string): string =>
    `No problem. Nothing was shared. The link works until ${date}.`,
  safetyCode: 'Safety code',
  codeLoading: 'Getting the safety code…',
  codeLater: 'The safety code appears in People once both agents finish connecting.',
  dontMatch: "Numbers don't match?",
  mismatch: (name: string): string =>
    `Don't send anything yet. Remove ${name} from People and invite them again, in person or on a call.`,
} as const;

/**
 * W4-WIRE-2 (Decision 52 (3)): "Have an invite link? Paste it" on the Invite screen. The refusal
 * sentences are the old Add contact sheet's (11 §5), kept word for word.
 */
export const PASTE_STRINGS = {
  open: 'Have an invite link? Paste it',
  label: 'Paste the invite link',
  hint: 'It starts with https://agentlink.4thtech.io/i#',
  go: 'Continue',
  checking: 'Checking the invite…',
  notLink: "That isn't an AgentLink invite link. Copy the whole link and paste it again.",
  expired: 'This invite has expired.',
  own: 'This is your own invite.',
  damaged: "This link isn't a complete AgentLink invite. Ask for it again.",
  cantUse: "This invite can't be used here.",
  unavailable:
    "This invite can't be used anymore. It may have expired, been used or been cancelled. Ask for a new one.",
  askForNew: 'Ask the person who sent it for a new invite.',
  another: 'Paste another link',
  busy: "AgentLink couldn't check the invite just now. Try again in a minute.",
  offline: "Can't reach AgentLink on this computer. Try again in a minute.",
  notConnected: "Couldn't connect with this invite. Nothing was changed. Check it again.",
  thisAgent: 'this agent',
  connecting: (name: string): string => `Connecting to ${name}…`,
} as const;

/** "Invite link for Denis", or "Invite link". */
export function linkLabel(name: string): string {
  return name === '' ? INVITE_STRINGS.linkLabel : `Invite link for ${name}`;
}

/** "Works for 7 days." (whole days left, at least 1) followed by the one-person line. */
export function worksFor(days: number): string {
  return `Works for ${days === 1 ? '1 day' : `${String(days)} days`}. ${INVITE_STRINGS.onlyThem}`;
}

/** The pending row: "Waiting for Marko to accept · link works 6 more days". */
export function waitingLine(name: string | null, days: number): string {
  const who = name ?? 'them';
  if (days <= 0) return `Waiting for ${who} to accept · the link ends today`;
  return `Waiting for ${who} to accept · link works ${days === 1 ? '1 more day' : `${String(days)} more days`}`;
}

/** The menu button's accessible name. */
export function moreFor(name: string): string {
  return `More for ${name}`;
}

/** The friend's heading (FriendAccept, A6). */
export function invitesYou(name: string): string {
  return `${name} invites you to connect your AIs`;
}

/** The Connected moment's heading (BothConnected, A7). */
export function connectedWith(name: string): string {
  return `You and ${name} are connected`;
}

/** The one last check: the safety code stays 12 digits in 0.4.6. */
export function lastCheck(name: string): string {
  return `One last check: ask ${name} which numbers they see. If they match, you're talking to the right person.`;
}

/** The safety code's spoken form: digits one by one, groups apart. */
export function codeLabel(code: string): string {
  return `Safety code: ${code
    .split(' ')
    .map((g) => g.split('').join(' '))
    .join(', ')}`;
}

/** The email text: the share text the server made (our template around the link). */
export function mailtoOf(shareText: string): string {
  return `mailto:?subject=${encodeURIComponent(INVITE_STRINGS.emailSubject)}&body=${encodeURIComponent(shareText)}`;
}

/** The letter of a letter icon: the first letter or digit (a quoted name starts with “). */
export function letterOf(text: string): string {
  const found = /[\p{L}\p{N}]/u.exec(text);
  return found === null ? '•' : found[0].toUpperCase();
}
