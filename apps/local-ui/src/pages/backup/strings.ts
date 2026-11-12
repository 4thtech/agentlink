// Settings › Backup & restore copy (design-1112 §6.2 to §6.4, §8; WP-R4; 11 §5; 07 §9.4). One recovery
// kit covers all IDs. Restore itself is the wizard of WP-R3 (links only here).
export const BACKUP_STRINGS = {
  title: 'Backup & restore',
  // QA-UTH: Under the hood names the kit format.
  hoodFormat: 'Kit format',
  hoodFormatValue: 'ALKK v1',
  lead: 'A recovery kit is everything you need to get AgentLink back on any computer.',
  // --- status card (three states, plus plain words when the record cannot be read)
  upToDateTitle: "You're backed up",
  staleTitle: 'Your kit is out of date',
  peopleJoined: (n: number): string =>
    n === 1 ? '1 person who joined since' : `${n} people who joined since`,
  noneTitle: 'No recovery kit yet',
  noneLine:
    "If this computer is lost or reset, your IDs, people and messages can't be brought back.",
  unknownTitle: "Can't tell if you have a kit",
  unknownLine:
    "AgentLink couldn't read what it has on record about your recovery kit. You can still save a new one.",
  loading: 'Checking your recovery kit…',
  saveNew: 'Save a new kit',
  saveFirst: 'Save a recovery kit',
  // --- three columns
  colFileTitle: 'The kit file',
  colFileBody:
    'One locked file with all your IDs. Keep a copy off this computer: a USB stick or your cloud drive is fine.',
  showInFinder: 'Show in Finder',
  showFailed: "Couldn't show the file. It may have been moved or deleted.",
  colCodeTitle: 'The recovery code',
  colCodeBody:
    '24 characters, shown once when you save a kit. It unlocks that kit only. Keep it on paper or in a safe place, away from the file.',
  neverToAi: 'Never give it to your AI.',
  colBackTitle: 'Getting back in',
  colBackBody:
    'On any computer: install AgentLink, choose I have a recovery kit, pick the file and type the code. About two minutes.',
  checkLink: 'Check that my kit opens',
  checkLinkNote: 'Save a kit first, then you can check it right away.',
  // --- two lists
  comesBackTitle: 'Comes back from a kit',
  comesBack: [
    'Your IDs and their names',
    'Your people, and whether you checked them',
    'Your messages',
    'Your rules, proofs and credits',
  ],
  againTitle: 'Set up again afterwards',
  again: [
    'Touch ID and a new master code (one step)',
    'Your AI apps (one click each)',
    'Files you received: they are ordinary files in your Files folder, so copy that folder yourself',
    'Your own storage, if you connected one',
  ],
  // --- rows
  restoreTitle: 'Restore from a kit',
  restoreBody:
    'Bring back an ID on this computer. IDs that are already here are never overwritten.',
  restoreAction: 'Restore…',
  moveTitle: 'Moving to a new computer?',
  moveBody:
    'Save a new kit here first, restore it there, then remove AgentLink from this computer.',
  moveAction: 'How to move',
  footnote:
    'Saving a kit asks for Touch ID or your master code. Anyone with both the kit file and its code can read your messages, so keep them apart.',
  // --- saving
  saveHint: 'Asks for Touch ID or your master code first.',
  confirmSummary: (label: string): string => `Save a recovery kit for ${label}`,
  thisId: 'your IDs',
  saving: 'Saving your recovery kit…',
  savedIn: (folder: string): string =>
    folder === 'Home' ? 'Saved in your home folder:' : `Saved in your ${folder} folder:`,
  codeTitle: 'Your recovery code',
  shownOnce: 'Shown once',
  codeBody:
    'You need this code and the kit file to restore. Keep them apart. Never give the code to your AI.',
  copy: 'Copy',
  copied: 'Copied',
  copyNote: 'Other apps can read your clipboard.',
  privacy: 'Anyone with the kit and its code can read your messages. Keep both safe.',
  // --- save checklist (§6.3)
  checklistTitle: 'Three things before you finish',
  stepMove: 'Move the kit file off this computer',
  stepWrite: 'Write down the recovery code',
  stepCheck: 'Check that it opens',
  print: 'Print',
  printBlocked: "Couldn't open the print window. Allow pop-ups for AgentLink, or copy the code.",
  // WP-R2b: IDs the kit does not hold. Only an ID that keeps its keys in a file is backed up in the
  // terminal; the others say plainly why.
  notIncludedTitle: 'Not in this kit',
  notIncludedTerminal:
    'it keeps its keys in a file, not the keychain, so back it up in the terminal.',
  notIncludedCouldNotOpen:
    "it couldn't be opened just now. Save a new kit in a moment to include it.",
  notIncludedOverLimit: 'one kit holds up to 16 IDs.',
  checkNow: 'Check now',
  checking: 'Checking…',
  checkOk: 'This kit opens.',
  checkWrong: "That code doesn't open this kit. Nothing was changed.",
  checkFailed: "Couldn't check the kit just now. Try again.",
  checkUnavailable:
    "Checking a kit isn't available in this version yet. Keep the file and the code safe.",
  tickLabel: (step: string): string => `Done: ${step}`,
  finish: 'Done',
  doneEnableHint: 'Done turns on when all three are ticked.',
  done: (names: string): string =>
    names === '' ? 'Recovery kit saved.' : `Recovery kit saved. It covers ${names}.`,
  notHere: "This ID's recovery kit can't be saved from the app on this computer.",
  cantCheck: "Can't reach AgentLink on this computer. Try again in a minute.",
  notApplied: 'Nothing was saved. Try again.',
  failed: "Couldn't write the recovery kit. Nothing was saved. Try again.",
  // --- printed sheet (built in memory, never written to disk)
  sheetTitle: 'AgentLink recovery kit',
  sheetCode: 'Recovery code',
  sheetFile: 'Kit file',
  sheetDate: 'Date',
  sheetSteps: [
    'Install AgentLink on the new computer.',
    'Choose "I have a recovery kit".',
    'Pick the kit file and type the code above.',
  ],
  sheetKeep: 'Keep this sheet away from the kit file. Never give the code to your AI.',
  // --- slot for the desktop app
  touchSlotLabel: 'Touch ID on this computer',
} as const;
