// Inbox copy (W4-INBOX, W4-FILES-SAVE; 11 §5; b11 §34.4, §34.9). Plain words: no "wallet", "gas",
// "seed phrase", "transaction", no link, key or path talk. Other people's words and file names are
// never part of these strings; the page shows them only inside the untrusted container (I-5).
import type { FileSaveOutcome } from '@4thtech-io/types/ui-contract/inbox';

export const INBOX_STRINGS = {
  title: 'Inbox',
  needsYou: 'Needs you',
  conversations: 'Conversations',
  allCaughtUp: 'All caught up',
  allCaughtUpHint: 'Nothing needs you right now. New messages, files and approvals appear here.',
  noConversations: 'No conversations yet.',
  noConversationsHint:
    'Invite someone. When their agent writes to yours, the conversation appears here.',
  newMessage: 'New message',
  fileFrom: 'File from {name}',
  approvalLabel: 'Needs your approval',
  backToInbox: 'Inbox',
  conversationWith: 'Conversation with {name}',
  fromThem: 'From {name}',
  fromYou: 'From your agent',
  replyHint: 'To reply, ask your AI.',
  noMessages: 'No messages with {name} yet.',
  loading: 'Loading your Inbox…',
  unavailable: "Your Inbox can't be loaded right now. Try again in a minute.",
  notSetUp: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
  sessionExpired: 'This page has expired. Ask your AI to open AgentLink again.',
  tryAgain: 'Try again',
  // Files in a conversation and in Needs you (W4-FILES-SAVE, 11 §5.7).
  arrivedNotSaved: 'Arrived · not saved',
  saveToInbox: 'Save to Inbox',
  savedAs: 'Saved as',
  expired: 'Expired. It can no longer be saved.',
  sentFile: 'Sent',
  confirmPasskey: 'Confirm with your passkey',
  confirmSave: 'Confirm save',
  saveStepLabel: 'Save this file to your Inbox folder',
  saving: 'Saving…',
  approve: 'Approve',
  saveOutcome: {
    saved: 'Saved to your Inbox folder.',
    already_saved: 'This file is already in your Inbox folder.',
    not_found: "This file isn't here any more.",
    too_large: "This file is larger than your rules allow to receive, so it wasn't saved.",
    integrity_failed: "The file didn't arrive complete and unchanged, so it wasn't saved.",
    expired: 'This file is no longer available. Ask the sender to send it again.',
    location_refused:
      "This file came from a place AgentLink doesn't download from, so it wasn't saved.",
    policy_denied: "Your rules don't allow saving this file, so it wasn't saved.",
    inbox_unavailable: "Your Inbox folder can't take files right now, so nothing was saved.",
    download_failed: "The file couldn't be downloaded. Try again later.",
    refused: 'Not saved. Try again.',
    bad_request: "Couldn't save it. Try again.",
    not_set_up: "AgentLink isn't set up on this computer yet. Ask your AI to set up AgentLink.",
    unavailable: "Couldn't save it. Try again.",
  } satisfies Readonly<Record<FileSaveOutcome, string>>,
  presenceRejected:
    "That didn't match your passkey, backup code or owner passphrase. Nothing was saved.",
  presenceNotUsed:
    "The passkey wasn't used. Nothing was saved. You can enter your backup code instead.",
  busy: 'Another change is in progress. Try again in a moment.',
  wait: 'Too many wrong tries. Wait {seconds} seconds, then try again. Nothing was saved.',
  offline: "AgentLink isn't answering. Nothing was saved. Try again.",
} as const;

/** `{name}`-style slots filled with plain text. */
export function fmt(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
}
