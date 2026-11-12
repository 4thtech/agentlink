// Shell copy (11 §5: no "wallet", "gas", "seed phrase" or "transaction"). Page copy lives with each
// page; only the shell and the shared stub state are here.
import { sensorWord } from './presence-word.js';
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
  /** REL051-CF2 (R1-CLASS-02; 11 §5 "Can't reach the message network"): the status bar while no relay is reachable. */
  networkUnreachable: "Can't reach the message network. Messages wait and send when it's back.",
  /** REL051-CF2: the same state on the ID chip (short). */
  networkUnreachableChip: "Can't reach the network",
  /** REL051-CF2: the status bar until the first relay check from this computer has finished. */
  networkChecking: 'Checking the connection…',
  goTo: 'Go to',
  goToButton: 'Go to…',
  goToFind: 'Go to a page or run a command',
  goToNone: 'Nothing found.',
  goToHint: 'Type a name, then Enter.',
  /** W4-SHELL-V2: the top bar (A4) and the section menu (Decision 48). */
  sections: 'Sections',
  homeLabel: 'Home',
  settingsNav: 'Settings',
  expandMenu: 'Expand menu',
  collapseMenu: 'Collapse menu',
  collapse: 'Collapse',
  advanced: 'Advanced',
  help: 'Help',
  helpGetStarted: 'Get started',
  helpShortcuts: 'Keyboard shortcuts',
  helpGuide: 'User guide',
  helpReport: 'Report a problem',
  hood: 'Under the hood',
  hoodTooltip: 'Show the technical details. Nothing here changes how the app works.',
  hoodOn: 'Under the hood is on',
  hoodOff: 'Under the hood is off',
  liveStatus: 'Live status',
  hoodServerVersion: 'Version',
  hoodServerPort: 'Port',
  hoodServerRelays: 'Relays',
  hoodServerLastSync: 'Last checked',
  hoodServerDataFolder: 'Data folder',
  hoodServerUptime: 'Uptime',
  hoodUptimeUnderMinute: 'Under a minute',
  close: 'Close',
  shortcutsTitle: 'Keyboard shortcuts',
  shortcutGoTo: 'Go to a page or command',
  shortcutHood: 'Turn Under the hood on or off',
  shortcutShow: 'Show shortcuts',
  shortcutClose: 'Close a menu or dialog',
  shortcutMove: 'Move in a list',
  reportTitle: 'Report a problem',
  reportWhat: 'What went wrong?',
  reportPlaceholder: 'e.g. Claude Code shows Not running but it is open',
  reportDiagnostics:
    'Add diagnostics (versions and statuses only, no messages, keys or file names)',
  reportCancel: 'Cancel',
  reportCopy: 'Copy report',
  reportCopied: 'Copied. Paste it into an email or an issue.',
  guideOpens: 'The user guide opens in your browser.',
} as const;

export const PAGE_TITLES = {
  firstRun: 'Set up AgentLink',
  getStarted: 'Get started',
  inbox: 'Inbox',
  people: 'People',
  liveActivity: 'Live activity',
  filesFolder: 'Files folder',
  settings: 'Settings',
  home: 'Home',
  approvals: 'Approvals',
  approve: 'Approval',
  activity: 'Activity',
  messages: 'Messages',
  contacts: 'People',
  agents: 'My IDs',
  get touchId(): string {
    return `${sensorWord()} & master code`;
  },
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
  // WP-R4: Touch ID has its own page (WP-S2), so this entry is Backup & restore.
  backupTouchId: 'Backup & restore',
  defaultRules: 'Default rules',
  notifications: 'Notifications',
  activityLog: 'Activity log',
  filesStorage: 'Files & storage',
  network: 'Relays & network',
  diagnostics: 'Diagnostics',
  connectionsMap: 'Connections map',
} as const;

/** Shown under every code field (F26): what the master code is, never a terminal command. */
export const EARLIER_OWNER_CODE_HINT =
  'Your master code is the code you saved when you first set up AgentLink.';
