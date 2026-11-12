// Settings › Backup & Touch ID copy (W4-SETTINGS-ADVANCED; 11 §5). Says what is true today: the recovery kit
// is saved from a terminal (agentlink backup export), so there is no button here until the app can.
export const BACKUP_STRINGS = {
  title: 'Backup & Touch ID',
  kitTitle: 'Recovery kit',
  kitBody:
    'Your recovery kit lets you get back in on a new computer. To save it, open a terminal on this computer and run: agentlink backup export',
  kitPending: 'You put this off during setup. Keep your backup code safe until you save the kit.',
  touchTitle: 'Touch ID',
  touchBody:
    'Touch ID, or the login of your computer, confirms anything that changes who can act for you. Your AI never sees it.',
} as const;
