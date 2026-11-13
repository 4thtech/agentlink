// RET-4 (D-148; 11 §5 "Delete sheet", "After deleting", "Conversation menu", "Free up space"): the
// words of Delete history, Archive and Free up space. Plain words only: no "wallet", "gas", "seed
// phrase" or "transaction". Another party's name is passed in as text (I-5).
import { sizeWords } from '../storage/data.js';

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

export const HISTORY_STRINGS = {
  // Conversation menu (RET-4, RET-5)
  archive: 'Archive',
  unarchive: 'Unarchive',
  archived: 'Archived. Your AI still sees it.',
  unarchived: 'Back in your list.',
  undo: 'Undo',
  deleteHistory: 'Delete history…',
  select: 'Select',
  cancel: 'Cancel',
  selectMessage: 'Select this message',
  deleteSelected: (n: number): string => `Delete ${plural(n, 'message', 'messages')}`,

  // Delete sheet
  titlePerson: (name: string): string => `Delete history with ${name}?`,
  titleSelected: (n: number): string => `Delete ${plural(n, 'message', 'messages')}?`,
  titleFree: 'Delete from this computer?',
  counts: (messages: number | undefined, files: number | undefined, bytes: number): string =>
    [
      ...(messages === undefined ? [] : [plural(messages, 'message', 'messages')]),
      ...(files === undefined ? [] : [plural(files, 'file', 'files')]),
      sizeWords(bytes),
    ].join(', '),
  onlyHere: (name: string | undefined): string =>
    name === undefined
      ? 'Only on this computer; your contacts keep their copies and are not told.'
      : `Only on this computer; ${name} keeps their copy and is not told.`,
  proofsStay: 'Proofs stay valid. Older backups may still contain it.',
  kept: (n: number): string =>
    `${String(n)} kept: still needed for your contact, an approval or an agreement.`,
  keptWhat: 'Kept: pairing, agreed terms, approvals, receipts.',
  alsoFiles: 'Also move saved files to Trash',
  alsoFilesHelp: "Only files AgentLink saved that you haven't moved or changed.",
  what: 'What to delete',
  whatBoth: 'Messages and files',
  whatMessages: 'Messages only',
  whatFiles: 'Files only',
  olderThan: 'Older than',
  anyAge: 'Any age',
  days30: '30 days',
  days90: '90 days',
  days365: '1 year',
  more: 'More than one delete is needed for everything; run it again afterwards.',
  nothing: 'Nothing to delete here.',
  planning: 'Checking what this removes…',
  planFailed: "This couldn't be checked just now. Try again.",
  retry: 'Try again',
  deleteWith: (sensor: string): string => `Delete with ${sensor}`,
  deleteWithCode: 'Delete with your master code',
  statement: 'Delete these messages and files from this computer.',
  changed: 'What would be deleted changed. Check it again.',

  // After deleting
  deleted: (messages: number, files: number): string =>
    messages > 0 || files === 0
      ? `Deleted ${plural(messages, 'message', 'messages')}.`
      : `Deleting ${plural(files, 'file', 'files')}.`,
  nothingDeleted: 'Nothing was deleted.',
  tooLate: 'It was already deleted.',
  moved: (n: number): string => `Moved ${plural(n, 'file', 'files')} to the Trash.`,
  noTrash: (n: number): string =>
    `${plural(n, 'file', 'files')} couldn't go to the Recycle Bin here. Remove them yourself.`,
  leftAlone: (n: number): string =>
    `${plural(n, 'file was', 'files were')} left alone: moved or changed since AgentLink saved them.`,
  notDone: "The delete didn't finish. Nothing more was removed. Try again.",
  notarizedNote: 'Message deleted on this computer. Its proof is still valid.',

  // Free up space (Settings > Storage)
  freeTitle: 'Free up space',
  freeLead:
    'Delete old messages and saved files from this computer. Your contacts keep their copies.',
  person: 'Person',
  everyone: 'Everyone',
  filesOnly: 'Files only',
  review: 'Review',
  removes: (messages: number, files: number, bytes: number): string =>
    `This removes ${String(messages)} messages and ${String(files)} files (${sizeWords(bytes)}).`,
  showInFinder: 'Show in Finder',
  showInFolder: 'Show in folder',
  revealFailed: "The folder didn't open. Try again.",
} as const;
