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
  // Screen-reader words after a tab's number.
  waitingLabel: {
    received: 'waiting to be saved',
    sent: 'waiting to send',
    folders: 'waiting',
  },
  // Stepped bars on rows in flight (no byte progress is served, so no determinate bar).
  progressArriving: 'File arriving',
  progressSending: 'File sending',
  arrivingSteps: ['Arrived', 'Saved'],
  sendingSteps: ['Waiting to send', 'Sent', 'Delivered'],
  // Under the hood: what the lists hold, nothing private.
  hoodFiles: 'Files listed',
  hoodSize: 'Size listed',
  hoodFolders: 'Folders allowed',
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
  // A sent file the outbox gave up on: no receipt will come and nothing waits for it.
  sentNotDelivered: 'Not delivered. Ask your AI to send it again.',
  // MSG-FILES-IO-h, Show in Finder (11 §5.7): "Show in Finder" on macOS, "Show in folder" elsewhere.
  showInFinder: 'Show in Finder',
  showInFolder: 'Show in folder',
  revealNotFound:
    "This file isn't in your Inbox folder any more. You may have moved or renamed it.",
  revealRefused: "This file can't be shown. It isn't a plain file in your Inbox folder.",
  revealUnavailable: "Your Inbox folder can't be opened right now. Try again in a minute.",
  revealFailed: "The folder didn't open. Try again.",
  revealSessionExpired: 'This page has expired. Ask your AI to open AgentLink again.',
} as const;

/** For a list that could not be refreshed: the time it was last loaded, e.g. "14:02". */
export const asOf = (time: string): string => `Showing the list as of ${time}.`;
