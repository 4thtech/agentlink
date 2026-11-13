// Settings > Storage copy (retention plan RET-1; 11 §5: plain words, no "wallet", "gas", "seed phrase"
// or "transaction"). RET-4: Free up space's words are in history/strings.ts.
export const STORAGE_STRINGS = {
  title: 'Storage',
  lead: 'What AgentLink keeps on this computer.',
  loading: 'Reading sizes…',
  failed: 'The sizes could not be read just now.',
  retry: 'Try again',
  noIds: 'No IDs yet — nothing stored.',
  current: 'Open now',
  messages: 'Messages',
  savedFiles: 'Saved files',
  files: (n: number): string => `${String(n)} ${n === 1 ? 'file' : 'files'}`,
  total: 'Everything for this ID',
  idUnavailable: 'The sizes of this ID could not be read just now.',
  otherId: 'Open this ID to see the sizes for each person.',
  peopleTitle: 'By person',
  peopleNone: 'Nothing is stored for anyone yet.',
  other: 'Removed people and setup messages',
  filesNote:
    'Files are listed for the last 7 days. The Inbox folder below counts every file in it.',
  exchange: 'Encrypted drop this week',
  exchangeLine: (used: string, quota: string): string => `${used} of ${quota}`,
  inboxTitle: 'Inbox folder',
  inboxLine: (folder: string): string => `Files you receive are saved in ${folder}.`,
  unassigned: 'Unassigned files in Inbox',
  unassignedLine: (n: number, size: string, atLeast: boolean): string =>
    `${atLeast ? 'At least ' : ''}${String(n)} · ${size}`,
  unassignedHelp: 'Saved before AgentLink kept track of them. AgentLink never deletes these.',
  inboxNone: 'No files in the Inbox folder that AgentLink lost track of.',
  inboxUnknown: 'The Inbox folder could not be read just now.',
} as const;

/** RET-6 (D-148; 04 §4.2; 11 §5): Keep automatically. Plain words; the sensor word in the button. */
export const KEEP_STRINGS = {
  title: 'Keep automatically',
  lead: 'AgentLink can clear out old history on this computer once a day. Your contacts keep their copies.',
  messages: 'Keep messages',
  files: 'Keep saved files',
  filesHelp:
    'Only files AgentLink saved in your Inbox folder and that you have not changed. They go to the Trash.',
  forever: 'Forever',
  days: (n: number): string => (n === 365 ? '1 year' : n === 730 ? '2 years' : `${String(n)} days`),
  loading: 'Reading your settings…',
  failed: 'Your settings could not be read just now.',
  retry: 'Try again',
  notValid: 'Your rules need to be confirmed again before this can change. Open Rules to do that.',
  notActive: 'These take effect once your first rules are saved.',
  previewing: 'Checking what this removes…',
  previewNone: 'Right now this removes nothing.',
  previewFailed: 'What this removes could not be checked just now.',
  preview: (messages: number, files: number, size: string): string => {
    const parts: string[] = [];
    if (messages > 0)
      parts.push(`deletes ${String(messages)} ${messages === 1 ? 'message' : 'messages'}`);
    if (files > 0) {
      parts.push(
        `moves ${String(files)} ${files === 1 ? 'file' : 'files'}${messages > 0 ? '' : ` (${size})`} to the Trash`,
      );
    }
    const line = `Right now this ${parts.join(' and ')}`;
    return messages > 0 ? `${line} (${size}).` : `${line}.`;
  },
  onlyHere: 'Only on this computer. Proofs stay valid. Older backups may still contain it.',
  saveWith: (sensor: string): string => `Save with ${sensor}`,
  saveWithCode: 'Save with your master code',
  statement: 'Change how long AgentLink keeps your history on this computer.',
  notUsed: 'Nothing was changed.',
  saved: 'Saved.',
  refused: 'Nothing was changed. Read the settings again and try once more.',
  stale: 'Your rules changed in the meantime. Nothing was changed; check the values and try again.',
} as const;
