// Compact view copy (UX2-h; B-11 §25). Plain words per 11 §5. The states reuse Home's strings
// (agent words, "Nothing is waiting.", "Review", credits line, errors); only the new strings are here.
export const COMPACT_STRINGS = {
  /** The window title: "AgentLink" only, never counts or names. */
  title: 'AgentLink',
  openCompact: 'Open compact window',
  agentName: 'This computer',
  agentList: 'Agents',
  needsList: 'Waiting for you',
  mostActive: 'Most active',
  contactsList: 'Most active contacts',
  noContacts: 'No contacts yet.',
  addContact: 'Add contact',
  openApp: 'Open AgentLink',
  creditsLabel: 'Credits',
  activeNow: 'Active now',
  today: 'Today',
  quiet: 'Quiet',
  loading: 'Loading…',
  processGone: "AgentLink isn't running. Start your AI app, then reload.",
} as const;

/** `+{n} more` */
export function moreContacts(n: number): string {
  return `+${String(n)} more`;
}

/** The pulse as one image: "14 messages in the last 24 hours". */
export function pulseLabel(n: number): string {
  if (n === 0) return 'No messages in the last 24 hours';
  return n === 1 ? '1 message in the last 24 hours' : `${String(n)} messages in the last 24 hours`;
}
