// Settings › Backup & Touch ID copy (W4-SETTINGS-ADVANCED; 11 §5). Says what is true today: saving a
// recovery kit from here is its own card, so there is no button for it yet.
export const BACKUP_STRINGS = {
  title: 'Backup & Touch ID',
  kitTitle: 'Recovery kit',
  kitBody:
    'Your recovery kit lets you get back in on a new computer. Saving it from here arrives in an update.',
  kitPending: 'You put this off during setup. Keep your backup code safe until then.',
  touchTitle: 'Touch ID',
  touchBody:
    'Touch ID, or your computer password, confirms anything that changes who can act for you. Your AI never sees it.',
} as const;
