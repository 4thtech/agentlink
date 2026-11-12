// Contacts copy (11 §5: plain words; never "wallet", "gas", "seed phrase", "transaction", a key, an
// address or a hash in the default view; 11 §5.2 names and labels; 04 §3.6.1 Contact check; UX audit
// 3b, 10a). A contact's name is never part of a fixed string: the helpers below take the name as
// formatted by the ui name rule and the page renders the result as text.
export const CONTACTS_STRINGS = {
  listLabel: 'Your people',
  lead: 'The people your AI can message. You connect by invite, and only you and they can read what is sent.',
  archivedLabel: 'Archived',
  archivedFoot:
    "Connections that ended. Your AI can't send to them. Their conversation and saved files stay until you delete them.",
  theyRemoved: 'They removed this connection.',
  connectedAgain: (date: string): string =>
    `You connected again on ${date}, so nothing is missing.`,
  oldConversation: 'The old conversation stays here.',
  olderConnection: 'older connection',
  open: 'Open',
  checkContact: 'Check contact',
  invitesWaiting: 'Invites waiting',
  detailTitle: 'Person',
  closeSheet: 'Close',
  loading: 'Loading…',
  emptyTitle:
    'No people yet. Ask your AI to create an invite and send it to someone you work with.',
  emptyPrompt: 'Create an AgentLink invite for Marko.',
  notSetUp: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
  listUnavailable: "Your people can't be loaded right now. Try again in a minute.",
  blocked: 'Blocked',
  blockedDetail: 'Blocked. Messages from this person are dropped.',
  revoked: 'No longer active',
  revokedDetail: 'This person turned this ID off. Messages from it are dropped.',
  // UX 2026-11-12 (notices): the full explanation lives here, not on Home.
  revokedTitle: 'They removed this connection.',
  revokedMore:
    "Your AI can't send to them any more. Your conversation and saved files stay here. On Home you can archive them.",
  waiting: 'Waiting for them',
  waitingDetail: 'Waiting for them to answer the invite. The 12 digits show here once it does.',
  mismatchChip: '12 digits did not match',
  safetyCode: 'Contact check',
  safetyExplain:
    'Compare these 12 digits with the other person by call or in person; if they match, it’s really them.',
  wasName: (former: string): string => `(was ${former})`,
  keepBoth: 'Keep both',
  removeOlder: 'Remove older',
  codeLoading: 'Loading the 12 digits…',
  codeUnavailable: "Can't show the 12 digits right now. Try again in a minute.",
  theyMatch: 'They match',
  theyDontMatch: "They don't match",
  skip: 'Skip',
  compareCode: 'Compare the 12 digits',
  checked: 'Contact checked.',
  matched: 'Matched. This person now shows as Contact checked.',
  mismatchTitle: 'The codes are different.',
  keep: 'Keep for now',
  rename: 'Rename',
  renameLabel: 'New name',
  renameHint: 'Up to 32 letters. Only you see it.',
  saveName: 'Save name',
  renamed: 'Renamed.',
  aliasInvalid: 'Use letters, numbers and spaces, up to 32.',
  aliasTaken: 'Another person already has this name. Pick a different one.',
  contactUnknown: 'This person is no longer here. Reload the page.',
  renameUnavailable: "The name can't be checked right now. Try again in a minute.",
  remove: 'Remove',
  removeContact: 'Remove person',
  removeExplain:
    'Remove this person? Messages from them are dropped. To connect again, ask them for a new invite.',
  removed: 'Removed.',
  // UX1112 WP-12 (F-2; D-72; 11 §6.2 "Rename and Block"): block or unblock one person.
  block: 'Block',
  unblock: 'Unblock',
  blockContact: 'Block person',
  blockExplain:
    "Block this person? Messages from them are dropped until you unblock them. They aren't told.",
  blockedNow: 'Blocked.',
  unblocked: 'Unblocked. Messages from this person arrive again.',
  cancel: 'Cancel',
  presenceIntro: 'Confirm it’s you. Never give your master code to your AI.',
  usePasskey: 'Confirm with your passkey',
  /** F24: the same button with the platform's own word (SENSOR: Touch ID, Windows Hello, your passkey). */
  usePasskeyOn: (sensor: string): string => `Confirm with ${sensor}`,
  useCode: 'Use your master code instead',
  ownerCode: 'Master code',
  confirm: 'Confirm',
  // F49: the one primary action when no passkey is set up here (the master code confirms).
  confirmWithCode: 'Confirm with your master code',
  presenceRejected: "That didn't match your master code or passkey. Nothing was changed.",
  presenceRequired: 'Enter your master code or use your passkey. Nothing was changed.',
  passkeyNotUsed: "The passkey wasn't used. Nothing was changed. You can enter your master code.",
  busy: 'Another change is in progress. Try again in a moment.',
  refused:
    'Nothing was changed. If you were comparing the 12 digits, they may have changed: compare them again.',
  notApplied: 'Nothing was changed. Try again.',
  sessionExpired: 'This page has timed out. Open AgentLink again from your AI app.',
  failed: "That didn't work. Nothing was changed. Try again in a minute.",
} as const;

/** First letter up, for a sensor name that starts a sentence ("your passkey" → "Your passkey"). */
const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * HOTFIX-045-TOUCHID (11 §5, §6.2.1; copy proposed, owner confirms at merge): why a presence sheet
 * asks for the master code instead of Touch ID, and the one-time switch inside the sheet. `sensor` is
 * the platform's name for it (first-run strings.ts SENSOR); `browser` one that works (WORKING_BROWSER).
 */
export const PASSKEY_WHY = {
  not_set_up_here: (sensor: string): string =>
    `${cap(sensor)} isn't set up for AgentLink on this computer yet, so this asks for your master code.`,
  other_owner: (sensor: string): string =>
    `${cap(sensor)} on this computer was set up for a different owner, so this asks for your master code.`,
  // F49: `browser` is undefined when the page already runs in the browser that would be suggested.
  browser: (sensor: string, browser: string | undefined): string =>
    browser === undefined
      ? `This browser can't use ${sensor} for AgentLink yet, so this asks for your master code.`
      : `This browser can't use ${sensor} for AgentLink. Enter your master code, or open AgentLink in ${browser}.`,
  // F49: a switch already failed in this browser (no PRF), so the sheet stops offering it.
  noSwitchHere: (sensor: string): string =>
    `${cap(sensor)} on this computer can't protect approvals yet, so this asks for your master code.`,
  unknown: (sensor: string): string =>
    `Couldn't check ${sensor} just now, so this asks for your master code.`,
  switchIntro: (sensor: string): string =>
    `Enter your master code once, then touch ${sensor}. After that, confirm here with ${sensor}. Your master code keeps working.`,
  switchCancel: 'Not now',
  switched: (sensor: string): string => `${cap(sensor)} is on. Now confirm with ${sensor}.`,
  switchCancelled: "The switch didn't happen. Nothing changed. You can still use your master code.",
  switchUnsupported: (sensor: string, browser: string | undefined): string =>
    browser === undefined
      ? `${cap(sensor)} on this computer can't protect approvals yet, so AgentLink uses your master code. Nothing changed.`
      : `${cap(sensor)} can't protect approvals in this browser. Nothing changed. Keep using your master code, or open AgentLink in ${browser}.`,
} as const;

/** Under the hood labels and values (B-11 §16). */
export const HOOD = {
  fingerprint: 'ID tag',
  identity: 'Identity level',
  paired: 'Paired',
  checked: 'Contact checked',
  selfDeclared: 'Not checked yet',
} as const;

export function countLine(n: number, waiting = 0): string {
  const people = n === 1 ? '1 person' : `${String(n)} people`;
  if (waiting === 0) return people;
  return `${people} · ${String(waiting)} invite${waiting === 1 ? '' : 's'} waiting`;
}

/** "Last message 2 h ago · connected 3 Nov" (dates and ages are plain text). */
export function personLine(last: string | undefined, connected: string): string {
  return `${last === undefined ? 'No messages yet' : `Last message ${last}`} · connected ${connected}`;
}

/** The safety-code nudge (UX audit 3b). `name` is the name-rule output. */
export function nudge(name: string): string {
  return `Want to be sure it’s really ${name}? Call them or meet, and compare these 12 digits. It takes about 30 seconds. Both screens should show the same code.`;
}

export function mismatchBody(name: string): string {
  return `The invite may have been copied or changed on the way. Remove this person, then ask ${name} for a new invite through a channel you trust.`;
}

/**
 * M1-UX3-DUP-CONTACTS (owner decision 8): shown on the newer of two contacts with the same owner.
 * `name` is the older contact's name-rule output and `date` its pairing day; rendered as text.
 */
export function secondConnection(name: string, date: string): string {
  return `Looks like a second connection with ${name} (paired ${date}). Keep both, or remove the older one?`;
}

/** The pending invite line. `name` is the name-rule output; the page renders it as text. */
export function waitingFor(name: string): string {
  return `Waiting for ${name}`;
}

export function since(date: string): string {
  return `Connected ${date}`;
}

export function waitSeconds(seconds: number): string {
  return `Too many wrong tries. Wait ${String(seconds)} seconds, then try again. Nothing was changed.`;
}

export const SUMMARY = {
  check: (name: string): string => `Mark ${name} as Contact checked.`,
  rename: (name: string, alias: string): string => `Rename ${name} to ${alias}.`,
  remove: (name: string): string => `Remove ${name}.`,
  block: (name: string): string => `Block ${name}.`,
  unblock: (name: string): string => `Unblock ${name}.`,
} as const;
