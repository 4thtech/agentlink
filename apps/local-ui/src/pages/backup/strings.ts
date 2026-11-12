// Settings › Backup & Touch ID copy (W4-SETTINGS-ADVANCED; WP-11, F-1, D-117 A; 11 §5; 07 §9.4). The
// recovery kit is saved here, behind Touch ID or the master code. Restore stays in the terminal.
export const BACKUP_STRINGS = {
  title: 'Backup & Touch ID',
  kitTitle: 'Recovery kit',
  kitBody:
    'Your recovery kit gets you back in on a new computer: this ID, its contacts and its messages, locked under a new recovery code.',
  kitPending: 'You put this off during setup. Keep your master code safe until you save the kit.',
  saveKit: 'Save recovery kit',
  saveAnother: 'Save a new recovery kit',
  saveHint: 'Asks for Touch ID or your master code first.',
  confirmSummary: (label: string): string => `Save a recovery kit for ${label}`,
  thisId: 'this ID',
  saving: 'Saving your recovery kit…',
  savedIn: (folder: string): string =>
    folder === 'Home' ? 'Saved in your home folder:' : `Saved in your ${folder} folder:`,
  codeTitle: 'Your recovery code',
  shownOnce: 'Shown once',
  codeBody:
    'You need this code and the kit file to restore. Keep them apart, for example the code on paper and the file on a USB stick. Never give the code to your AI.',
  copy: 'Copy',
  copied: 'Copied',
  copyNote: 'Other apps can read your clipboard.',
  savedIt: 'I saved it',
  done: 'Recovery kit saved. You can save a new one at any time; each one has its own code.',
  privacy: 'Anyone with the kit and its code can read your messages. Keep both safe.',
  notHere: "This ID's recovery kit can't be saved from the app on this computer.",
  cantCheck: "Can't reach AgentLink on this computer. Try again in a minute.",
  notApplied: 'Nothing was saved. Try again.',
  failed: "Couldn't write the recovery kit. Nothing was saved. Try again.",
  touchTitle: 'Touch ID',
  touchBody:
    'Touch ID, or the login of your computer, confirms anything that changes who can act for you. Your AI never sees it.',
} as const;
