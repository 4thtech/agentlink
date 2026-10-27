// Received and Sent copy (MSG-FILES-IO-f; 11 §5.7; design b11 §17.3). Plain words: no "wallet",
// "gas", "seed phrase", "transaction", no link or key talk. Other people's file names are never part
// of these strings; the page shows them as plain text (I-5). Re-exported from strings.ts.
export const FILES_IO_STRINGS = {
  explainer:
    "You don't upload here. Put files in your Send folder or ask your AI to send them; files you receive appear under Received.",
  tabsLabel: 'Files',
  tabReceived: 'Received',
  tabSent: 'Sent',
  tabFolders: 'Send folders',
  untrustedNote:
    "File names come from other people. They're shown as plain text, and AgentLink never opens a file for you.",
  gotIt: 'Got it',
  loading: 'Loading files…',
  unavailable: "Your files can't be loaded right now. Try again in a minute.",
  notSetUp: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
  tryAgain: 'Try again',
  showMore: 'Show more',
  receivedEmptyTitle: 'No files received yet.',
  receivedEmptyHint: 'Files your contacts send you appear here.',
  sentEmptyTitle: 'No files sent yet.',
  sentEmptyHint: 'Files your AI sends appear here. To send one, ask your AI.',
  from: 'From',
  to: 'To',
  savedAs: 'Saved as',
  mayHaveMoved: 'You may have moved or renamed it since, so it might not be there now.',
  notSaved: 'Not saved yet. Ask your AI to fetch it.',
  expired: 'Expired. It can no longer be fetched.',
  deleted: 'Deleted from this computer.',
  statusSent: 'Sent',
  statusQueued: 'Waiting to send',
  statusNotDelivered: 'Not delivered',
  receiptConfirmed: 'Delivery confirmed',
  receiptNone: 'No delivery confirmation yet',
  availableUntil: 'Available until',
  sentExpired: 'Expired. It can no longer be fetched.',
  sentDeleted: 'Removed after delivery.',
} as const;

/** For a list that could not be refreshed: the time it was last loaded, e.g. "14:02". */
export const asOf = (time: string): string => `Showing the list as of ${time}.`;
