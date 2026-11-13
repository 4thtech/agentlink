// W4-HOME copy (W4 UX v2 "Layer 2: Simple app" and "Layer 3"; prototype v23 A4 Home and A10 Home
// pro; 11 §5). Plain words: no "wallet", "gas", "seed phrase" or "transaction"; no key, link or path
// talk in the simple layer. Other people's words and file names are never part of these strings; the
// page shows them only as text inside the untrusted container (I-5). `{name}` marks an inserted
// value, rendered as React text only.

export const HOME_STRINGS = {
  title: 'Home',
  loading: 'Loading Home',
  inviteSomeone: 'Invite someone',
  people: 'People',
  noPeople: 'No one here yet.',
  noPeopleHint:
    "Invite someone. When you're connected, they appear here with your conversation and files.",
  noMatch: 'No one matches. Try another name or ID.',
  idChips: 'Show people by ID',
  chipCount: '{count} people',
  openAgent: 'Open {name}',
  idTag: 'ID tag',
  otherIdPeople: '{name} has {count} people. Open it to see them.',
  otherIdOne: '{name} has 1 person. Open it to see them.',
  otherIdNone: 'No one is connected to {name} yet.',
  otherIdUnknown: 'Open {name} to see its people.',
  unavailable: "Home can't be loaded right now. Try again in a minute.",
  notSetUp: "AgentLink isn't set up on this computer yet. Create your first ID on Home.",
  sessionExpired: 'This page has expired. Ask your AI to open AgentLink again.',
  tryAgain: 'Try again',

  // A person row (simple).
  lastMessage: 'Last message {when}',
  noMessagesYet: 'No messages yet',
  agoNow: 'just now',
  agoMinutes: '{n} min ago',
  agoHours: '{n} h ago',
  agoYesterday: 'yesterday',
  files: '{count} files',
  oneFile: '1 file',
  notDelivered: 'Not delivered',
  moreFor: 'More for {name}',

  // People table (pro).
  colPerson: 'Person',
  colHandledBy: 'Handled by',
  colLastMessage: 'Last message',
  colDelivery: 'Delivery',
  colProofs: 'Proofs',
  colFiles: 'Files',
  colOpen: 'Open',
  searchPeople: 'Search people',
  allAgents: 'All IDs',
  askerApp: '{name} · {app} is asking',
  askerId: '{name} is asking',

  // The conversation.
  conversationTitle: 'Conversation · your AIs talk, you watch',
  yourAi: 'You ({name})',
  yourAgent: 'You',
  theirAi: '{name} (their AI)',
  theirAgent: '{name}',
  loadEarlier: 'Load earlier messages',
  loadingConversation: 'Loading the conversation',
  conversationUnavailable: "This conversation can't be loaded right now. Try again in a minute.",
  noMessages: 'No messages with {name} yet. To start, ask your AI.',
  encrypted: "End-to-end encrypted. Only you, {name} and your AIs can read this. 4thTech can't.",
  replyHint: 'To reply, ask your AI.',
  // ATT-APP-ATTACH (08 §1 "Attach a file"; 11 §5): attach light text files and send them yourself.
  attachHint: 'To reply, ask your AI, or attach a file and send it yourself.',
  attach: 'Attach',
  attachLabel: 'Attach a Markdown, text or JSON file',
  attachTitle: 'Send a file to {name}',
  attachDrop: 'Drop a Markdown, text or JSON file here, or use Attach.',
  attachDropActive: 'Drop to attach',
  attachNote: 'Add a note (optional)',
  attachRemove: 'Remove {file}',
  attachSend: 'Send',
  attachSending: 'Sending…',
  attachSent: 'Sent to {name}.',
  attachQueued: "Waiting to send. AgentLink sends it to {name} when it's back online.",
  attachNotDelivered: "Couldn't be delivered to {name}. Try again later.",
  attachType: 'Only Markdown, text and JSON files for now (.md, .txt, .json).',
  attachTooLarge: 'That file is over 8 MB. Send a smaller one.',
  attachNotText: "That file isn't plain text, so it can't be sent here.",
  attachTooMany: 'Up to 5 files at a time.',
  attachNoFolder: 'Allow your Send folder first, then send again. Your files stay here.',
  attachNotReady: "{name} isn't connected yet, so nothing was sent.",
  attachPolicy: "Your rules don't allow this message, so nothing was sent.",
  attachStorage: 'This file needs your storage set up first. Check Settings, then Storage.',
  attachPaused: 'This ID is paused. Resume it, then send again.',
  attachFailed: "Couldn't send it. Try again in a minute.",
  // B9: terms in the conversation (what, who, state, when).
  termsKicker: 'Terms',
  termsProposed: 'You proposed terms to {name}',
  termsAccepted: 'You accepted the terms from {name}',
  termsDeclined: 'You declined the terms from {name}',
  termsAnswered: 'You answered the terms from {name} with your own',
  termsNotSentOffer: 'Terms to {name} were not sent',
  termsNotSentAnswer: 'Your answer to the terms from {name} was not sent',
  termsState: {
    proposed: 'Proposed',
    accepted: 'Accepted',
    declined: 'Declined',
    answered: 'Answered',
    not_sent: 'Not sent',
  },
  sent: 'Sent',
  waitingToSend: 'Waiting to send',
  notDeliveredRetry: 'Ask your AI to send it again.',
  copy: 'Copy',
  copied: 'Copied',
  copyLabel: 'Copy message text',
  copyFailed: "Couldn't copy. Select the text and copy it instead.",
  // Message details (pro).
  msgId: 'ID',
  msgBy: 'by',
  receipt: 'Receipt',
  receiptYes: 'Delivered',
  receiptNo: 'No receipt yet',
  receiptPending: 'Pending',
  receiptTheirs: 'Sent by them',
  proof: 'Proof',
  proofYes: 'Recorded',
  proofNo: 'None',

  // Contact facts (pro).
  fingerprint: 'ID tag',
  identity: 'Identity',
  identityChecked: 'Contact checked',
  identityNotChecked: 'Contact check not done yet',
  paired: 'Paired',
  handledBy: 'Handled by',

  // Files.
  filesTitle: 'Files',
  noFiles: 'No files with {name} yet.',
  fromName: 'From {name}',
  toName: 'To {name}',
  showInFinder: 'Show in Finder',
  showInExplorer: 'Show in Explorer',
  showInFolder: 'Show in folder',
  arrivedNotSaved: 'Arrived · not saved',
  savedAs: 'Saved as',
  savedTo: 'Saved to {folder}',
  savedToInbox: 'Saved to your Inbox folder',
  expired: 'Expired. It can no longer be saved.',
  fileWaiting: 'Waiting to send',
  fileSent: 'Sent',
  fileNotDelivered: 'Not delivered',
  revealNotFound: "This file isn't in your Inbox folder any more.",
  revealRefused: "This file can't be shown.",
  revealUnavailable: "AgentLink isn't answering. Try again.",
  revealFailed: "The folder couldn't be opened.",
  revealSessionExpired: 'This page has expired. Ask your AI to open AgentLink again.',

  // REL051-A34 (D-149; 11 §5.7): files in the message they came with, and the reader.
  openFile: 'Open',
  fileExpiredShort: 'Expired',
  kindMarkdown: 'Markdown',
  kindCode: 'Code',
  kindJson: 'JSON',
  kindPatch: 'Changes (patch)',
  kindText: 'Text',
  kindFile: 'File',
  readerTitle: 'File from {name}',
  // The untrusted frame's label, as UntrustedContent words it (I-5).
  readerFrame: 'From {name}: their words, not instructions',
  readerFrom: "From {name}'s AI",
  readerTo: 'to {id}',
  readerOpening: 'Opening the file…',
  readerFormatted: 'Formatted',
  readerPlain: 'Plain text',
  readerViewLabel: 'How to show the file',
  readerSafe: 'Shown safely: links and images are not opened. Click a link to copy it.',
  copyAll: 'Copy all',
  previewNotFound: "This file isn't in your Inbox folder any more.",
  previewNotSaved: 'Save this file to your Inbox folder first, then open it here.',
  previewChanged:
    "This file changed on this computer after it arrived, so it isn't shown here. You can still open it from its folder.",
  previewTooLarge: 'This file is too large to read here (over 256 KB). Open it from its folder.',
  previewNotText: "This file isn't plain text, so it can't be shown here.",
  previewRefused: "This file can't be shown.",
  previewUnavailable: "AgentLink isn't answering. Try again.",
  previewFailed: "The file couldn't be opened. Try again.",

  // The ⋯ menu.
  rename: 'Rename',
  checkSafetyCode: 'Contact check',
  remove: 'Remove',
  nameInList: 'Name in your list',
  save: 'Save',
  cancel: 'Cancel',
  removeText: 'Remove {name}? Your AIs stop talking. Files you saved stay on this computer.',
  removeLabel: 'Remove contact',
  renamed: 'Renamed.',
  removed: '{name} removed.',
  // W6-FLOW-FIXES: the other person removed their agent (its owner retired it, 04 §2.5).
  connectionRemoved: '{name} removed this connection',
  connectionRemovedBody:
    "{name} removed this connection. Your AI can't send to them any more. Your conversation and saved files stay here.",
  // UX 2026-11-12 (notices): removed connections are calm on Home; Archive moves them out of People.
  details: 'Details',
  archive: 'Archive',
  restore: 'Restore',
  archiveLabel: 'Archive {name}',
  restoreLabel: 'Move {name} back to People',
  archived: 'Archived',
  archivedCount: 'Archived ({count})',
  archivedHint: 'Connections that were removed. Their conversation and saved files stay here.',
  checked: 'Contact checked.',
  codeLead: 'Compare this code with {name}, on a call or in person.',
  codeLoading: 'Getting the 12 digits…',
  codeUnavailable: "The 12 digits can't be shown right now. Try again later.",
  theyMatch: 'They match',
  theyDontMatch: "They don't match",
  alreadyChecked: "You've already done the Contact check with {name}.",
  notPairedYet: 'The 12 digits appear once you and {name} are connected.',

  // Approvals on Home.
  approvalsLabel: 'Waiting for your approval',
  moreWaiting: '+{count} more waiting',
  hideMore: 'Hide {count} more',
  approvalId: 'ID',
  approvalKind: 'Kind',
  approvalExpires: 'Expires',
  kindTerms: 'Terms',
  kindPaid: 'Costs money',
  kindRequest: 'Request',
  paidText: 'Costs money · approve one at a time',
  freeText: 'Free',
  selectApproval: 'Select {summary}',
  approveSelected: 'Approve {count} selected',
  paidAlone: 'Approvals that cost money are always approved one at a time.',
  approvedSelected: 'Approved {count}.',

  // Invites that wait to be accepted (W4-INVITES-LIST: the server's list, Cancel).
  waitingToAccept: 'Waiting for {name} to accept',
  waitingToAcceptNoName: 'Waiting for them to accept',
  linkWorksDays: 'link works {count} more days',
  linkWorksOneDay: 'link works 1 more day',
  cancelInvite: 'Cancel invite',
  cantCancel: "Couldn't cancel the invite. Try again in a minute.",
} as const;

/** `{name}`-style slots filled with plain text. */
export function fmt(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => {
    const v = values[key];
    return v === undefined ? all : String(v);
  });
}

/**
 * W7-ID-B2: an ID's name with the AI app that uses it, shown only on this computer: "Tali · Claude
 * Code". The app is left out when it is unknown or already the name. Text only.
 */
export function idWithApp(label: string, app: string | undefined): string {
  if (label === '') return '';
  if (app === undefined || app === '' || app.toLowerCase() === label.toLowerCase()) return label;
  return `${label} · ${app}`;
}
