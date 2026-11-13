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
