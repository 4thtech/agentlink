// Shell copy (11 §5: no "wallet", "gas", "seed phrase" or "transaction"). Page copy lives with each
// page; only the shell and the shared stub state are here.
export const SHELL_STRINGS = {
  appName: 'AgentLink',
  navLabel: 'Main',
  notAvailableTitle: "This page isn't available yet.",
  notAvailableHint: 'It arrives in an update. Nothing is lost while you wait.',
  notFoundTitle: "This page isn't here.",
  notFoundHint: 'Pick a page from the menu.',
  themeName: 'Theme',
  themeChange: 'Change',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  offlineChip: 'Not connected',
} as const;

export const PAGE_TITLES = {
  firstRun: 'Set up AgentLink',
  home: 'Home',
  approvals: 'Approvals',
  approve: 'Approval',
  activity: 'Activity',
  messages: 'Messages',
  contacts: 'Contacts',
  files: 'Files',
  storage: 'Storage',
  proofs: 'Proofs & credits',
  rules: 'Rules',
  backup: 'Backup',
  appearance: 'Appearance',
  advanced: 'Advanced',
} as const;

/** Shown under every code field: 0.2.0 owners only know the code from the terminal (B-9 not built yet). */
export const EARLIER_OWNER_CODE_HINT =
  'Set up before 0.3.0? Use the owner code from `npx -y @4thtech-io/agentlink owner init`.';
