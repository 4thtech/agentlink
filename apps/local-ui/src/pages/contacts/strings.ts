// Contacts copy (11 §5: plain words; never "wallet", "gas", "seed phrase", "transaction", a key, an
// address or a hash in the default view; 11 §5.2 names and labels; 04 §3.6.1 safety code; UX audit
// 3b, 10a). A contact's name is never part of a fixed string: the helpers below take the name as
// formatted by the ui name rule and the page renders the result as text.
export const CONTACTS_STRINGS = {
  listLabel: 'Your contacts',
  loading: 'Loading…',
  emptyTitle:
    'No contacts yet. Ask your AI to create an invite and send it to someone you work with.',
  emptyPrompt: 'Create an AgentLink invite for Marko.',
  notSetUp: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
  listUnavailable: "Your contacts can't be loaded right now. Try again in a minute.",
  blocked: 'Blocked',
  blockedDetail: 'Blocked. Messages from this contact are dropped.',
  revoked: 'No longer active',
  revokedDetail: "This contact's agent was shut down by its owner. Messages from it are dropped.",
  waiting: 'Waiting for their agent',
  waitingDetail:
    'Waiting for their agent to answer the invite. The safety code shows here once it does.',
  mismatchChip: 'Safety code did not match',
  safetyCode: 'Safety code',
  safetyExplain:
    'Compare these 12 digits with the other person by call or in person; if they match, it’s really them.',
  sameName: 'Another contact has the same name.',
  codeLoading: 'Loading the safety code…',
  codeUnavailable: "Can't show the safety code right now. Try again in a minute.",
  theyMatch: 'They match',
  theyDontMatch: "They don't match",
  skip: 'Skip',
  compareCode: 'Compare safety code',
  checked: 'Safety code checked.',
  matched: 'Matched. This contact now shows as Safety code checked.',
  mismatchTitle: 'The codes are different.',
  keep: 'Keep for now',
  rename: 'Rename',
  renameLabel: 'New name',
  renameHint: 'Up to 32 letters. Only you see it.',
  saveName: 'Save name',
  renamed: 'Renamed.',
  aliasInvalid: 'Use letters, numbers and spaces, up to 32.',
  aliasTaken: 'Another contact already has this name. Pick a different one.',
  contactUnknown: 'This contact is no longer here. Reload the page.',
  renameUnavailable: "The name can't be checked right now. Try again in a minute.",
  remove: 'Remove',
  removeContact: 'Remove contact',
  removeExplain:
    'Remove this contact? Messages from its agent are dropped. To connect again, ask them for a new invite.',
  removed: 'Contact removed.',
  cancel: 'Cancel',
  presenceIntro: 'Confirm it’s you. Never give your backup code to your AI.',
  usePasskey: 'Confirm with your passkey',
  useCode: 'Use your backup code instead',
  ownerCode: 'Backup code',
  confirm: 'Confirm',
  presenceRejected: "That didn't match your backup code or passkey. Nothing was changed.",
  presenceRequired: 'Enter your backup code or use your passkey. Nothing was changed.',
  passkeyNotUsed: "The passkey wasn't used. Nothing was changed. You can enter your backup code.",
  busy: 'Another change is in progress. Try again in a moment.',
  refused:
    'Nothing was changed. If you were comparing the safety code, it may have changed: compare it again.',
  notApplied: 'Nothing was changed. Try again.',
  sessionExpired: 'This page has expired. Ask your AI to open AgentLink again.',
  failed: "That didn't work. Nothing was changed. Try again in a minute.",
} as const;

export function countLine(n: number): string {
  return n === 1 ? '1 contact' : `${String(n)} contacts`;
}

/** The safety-code nudge (UX audit 3b). `name` is the name-rule output. */
export function nudge(name: string): string {
  return `Want to be sure it’s really ${name}? Call them or meet, and compare these 12 digits. It takes about 30 seconds. Both screens should show the same code.`;
}

export function mismatchBody(name: string): string {
  return `The invite may have been copied or changed on the way. Remove this contact, then ask ${name} for a new invite through a channel you trust.`;
}

export function since(date: string): string {
  return `Connected ${date}`;
}

export function waitSeconds(seconds: number): string {
  return `Too many wrong tries. Wait ${String(seconds)} seconds, then try again. Nothing was changed.`;
}

export const SUMMARY = {
  check: (name: string): string => `Mark ${name} as Safety code checked.`,
  rename: (name: string, alias: string): string => `Rename ${name} to “${alias}”.`,
  remove: (name: string): string => `Remove ${name}.`,
} as const;
