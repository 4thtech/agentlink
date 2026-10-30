// Settings copy (W4-SETTINGS-ADVANCED; prototype v23 "Settings", A9; 11 §5: plain words, no
// "wallet", "gas", "seed phrase" or "transaction"). One line under each setting says where it stands.
export const SETTINGS_STRINGS = {
  title: 'Settings',
  backup: { title: 'Backup & Touch ID', line: 'Your recovery kit and how you approve things' },
  files: { title: 'Files folder', line: 'Folders your AI may send from, and where received files go' },
  appearance: {
    title: 'Appearance',
    system: 'Match my computer',
    light: 'Light',
    dark: 'Dark',
  },
  rules: { title: 'Rules for approvals', line: 'Ask me before any terms or payment' },
  proofs: {
    title: 'Proofs & credits',
    fallback: 'Credits and the proofs you made',
    credits: (balance: string): string => `${balance} in credits`,
    left: (n: number): string => `about ${String(n)} ${n === 1 ? 'proof' : 'proofs'}`,
  },
  notifications: { title: 'Notifications', line: 'Not yet' },
  advanced: {
    title: 'Advanced',
    line: 'Activity log, network, relays, long invite links',
    activity: 'Activity log',
    network: 'Network',
    relays: 'Relays',
    invites: 'Long invite links',
    open: 'Open',
    auto: 'Picked automatically',
    unknown: 'Not available right now',
    relayCount: (connected: number, total: number): string =>
      `${String(connected)} of ${String(total)} connected`,
  },
} as const;
