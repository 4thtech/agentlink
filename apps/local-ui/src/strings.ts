// Shell copy (11 §5: no "wallet", "gas", "seed phrase" or "transaction"). Page copy lives with each
// page; only the shell and the shared stub state are here.
export const SHELL_STRINGS = {
  appName: 'AgentLink',
  navLabel: 'Main',
  skipToContent: 'Skip to content',
  /** Read after the Approvals badge's number: "3 waiting for you" (UI-REFRESH-o-b). */
  approvalsWaiting: 'waiting for you',
  /** Read after the Messages badge's number: "3 new" (UI-REFRESH-o-d). */
  messagesNew: 'new',
  /** The Home item's whole name while Start here is shown (UX2-g, B-11 §27.4). */
  homeSetup: 'Home, setup not finished',
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
  /** W4-SHELL: the avatar menu at the right of the top bar (b11 §34.1). */
  accountMenu: 'Settings and more',
  goTo: 'Go to',
  goToFind: 'Find a page',
  goToNone: 'Nothing by that name.',
  goToHint: 'Type a name, then Enter.',
} as const;

export const PAGE_TITLES = {
  firstRun: 'Set up AgentLink',
  inbox: 'Inbox',
  settings: 'Settings',
  home: 'Home',
  approvals: 'Approvals',
  approve: 'Approval',
  activity: 'Activity',
  messages: 'Messages',
  contacts: 'Contacts',
  agents: 'Agents',
  apps: 'AI apps',
  files: 'Files',
  storage: 'Storage',
  proofs: 'Proofs & credits',
  rules: 'Rules',
  backup: 'Backup',
  appearance: 'Appearance',
  advanced: 'Advanced',
  about: 'About',
  // W4-SHELL: the Settings and Advanced entries (b11 §34.6); the pages keep their own headings.
  backupTouchId: 'Backup & Touch ID',
  defaultRules: 'Default rules',
  notifications: 'Notifications',
  activityLog: 'Activity log',
  filesStorage: 'Files & storage',
  network: 'Network & relays',
  diagnostics: 'Diagnostics',
} as const;

/** Shown under every code field: 0.2.0 owners only know the code from the terminal (B-9 not built yet). */
export const EARLIER_OWNER_CODE_HINT =
  'Set up before 0.3.0? Use the owner code from `npx -y @4thtech-io/agentlink owner init`.';
