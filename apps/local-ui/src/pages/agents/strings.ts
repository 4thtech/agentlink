// U3-h: Agents copy (b11 §29; 11 §5). "keys" appears only in the Remove sheet, because it is what is
// deleted. No "wallet", "gas", "seed phrase" or "transaction".
/**
 * W4-AGENTS (I-5; IR-W4-AGENTS-SEC-1 L1): an agent label inside a title, a statement or an aria
 * name is its own bidi-isolated run (U+2068 … U+2069), so no character in it can reorder the words
 * around it. Rendered text elsewhere uses `<bdi>`.
 */
export const iso = (label: string): string => `\u2068${label}\u2069`;

export const AGENTS_STRINGS = {
  title: 'IDs',
  open: 'Open',
  worksFrom: 'Works from',
  notConnected: 'Not connected to an AI app',
  noAiApp: 'No AI app',
  noAppNoContacts: 'No AI app, no contacts',
  add: 'Add ID',
  manage: 'Manage IDs',
  // W4-SHELL (b11 §34.2): the switcher's menu.
  newAgent: 'New ID',
  manageAgentsApps: 'Manage IDs & apps',
  notConnectedYet: 'Not connected yet',
  connectFreeApp: (app: string): string => `Connect ${app}`,
  switch: 'Switch',
  rename: 'Rename',
  connect: 'Connect',
  remove: 'Remove',
  more: 'More',
  tryAgain: 'Try again',
  notNow: 'Not now',
  cancel: 'Cancel',
  close: 'Close',
  running: 'Running',
  notRunning: 'Not running',
  removalNotFinished: 'Removal not finished',
  removalReason: 'Removing it stopped part-way. Nothing else was affected.',
  empty: 'No IDs left. Add one to keep using AgentLink.',
  loadError: "Couldn't load your IDs.",
  loading: 'Loading your IDs',
  findAgent: 'Find an ID',
  openApp: 'Open the AgentLink app to switch.',
  agentChanged: 'You switched IDs. Nothing was changed.',
  viewLabel: 'View',
  list: 'List',
  map: 'Map',
  mapSoon: 'The map arrives in an update. The list has everything you need.',
  switcherLabel: 'IDs',
  renameField: 'Name',
  saveTouchId: 'Save with Touch ID',
  labelInvalid: "That name can't be used. Change it and try again.",
  notRenamed: 'Not renamed yet. Try again.',
  renameFailed: "Couldn't rename it. Try again.",
  removeTitle: (label: string): string => `Remove ${iso(label)}?`,
  removingTitle: (label: string): string => `Removing ${iso(label)}…`,
  removeIntro: 'This will delete, from this computer:',
  keysAndSettings: (label: string): string => `${iso(label)}'s keys and settings`,
  history: (contacts: number | null): string =>
    contacts === null
      ? 'Its message and file history'
      : `Its message and file history (${contacts} ${contacts === 1 ? 'contact' : 'contacts'})`,
  itsEntry: (app: string): string => `Its entry in ${app}`,
  contactsTold: (label: string, n: number): string =>
    `Your ${n} ${n === 1 ? 'contact' : 'contacts'} will be told ${iso(label)} is retired.`,
  cantUndo: "This can't be undone.",
  exportFirst: 'Export history first',
  typeName: "Type the ID's name to confirm",
  typeNameLabel: (label: string): string => `Type ${iso(label)} to confirm`,
  typeNameDisabled: 'Type the name to enable this',
  removeTouchId: 'Remove with Touch ID',
  quitAny: (label: string): string => `Quit any AI app that uses ${iso(label)} first.`,
  quitApp: (app: string): string => `Quit ${app} first.`,
  agentFolder: (folder: string): string => `ID folder: ${folder}`,
  checkAgain: 'Check again',
  removeAnywayQ: "Remove anyway? Contacts can't be told now.",
  removeAnyway: 'Remove anyway',
  notRemoved: 'Not removed. Try again.',
  removeFailed: (label: string): string =>
    `Couldn't finish removing ${iso(label)}. Nothing else was changed.`,
  removed: (label: string): string => `${iso(label)} was removed.`,
  nowShowing: (label: string): string => `Now showing ${iso(label)}`,
  tidyNote: (n: number): string =>
    n === 1
      ? "1 of your IDs isn't connected to an AI app and has no contacts."
      : `${n} of your IDs aren't connected to an AI app and have no contacts.`,
  tidyHint: 'If they were only for testing, you can remove them.',
  tidyUp: 'Tidy up',
  contactsCount: (n: number | null): string =>
    n === null ? 'Contacts not readable just now' : `${n} ${n === 1 ? 'contact' : 'contacts'}`,
  switcherName: (label: string, apps: string, state: string): string =>
    `ID: ${label}, ${apps}, ${state}. Switch ID.`,
  renameStatement: (from: string, to: string): string => `Rename ${iso(from)} to ${iso(to)}`,
  removeStatement: (label: string): string => `Remove ${iso(label)}`,

  // W4-AGENTS (W4 UX v2 "Agents"; 08 §1 "Live AI-app status" words; "AI app", never "harness").
  intro: 'Each ID is the identity an AI app uses on AgentLink. Status updates by itself.',
  aiApps: 'AI apps',
  /** D-144 improvement (c): which AI apps use this ID. */
  usedBy: (apps: readonly string[]): string => `Used by ${apps.join(', ')}`,
  notUsed: 'Not used by any AI app',
  /** The local-only "Tali · Claude Code" (D-144 improvement (a)); the app is never sent to contacts. */
  withApp: (label: string, apps: readonly string[]): string =>
    apps.length === 0 ? label : `${label} · ${apps.join(', ')}`,
  backUp: 'Back up',
  disconnect: 'Disconnect',
  noAppsYet: 'No AI app is set up for this ID yet.',
  manageApps: 'All AI apps',
  useAppsPage: 'Open All AI apps to change this one.',
  quitFirstHint:
    'Quit the AI app first, then open it again. AgentLink sets it up; nothing to copy or paste.',
  restartToFinish: (app: string): string => `Restart ${app} to finish.`,
  backupTitle: 'Recovery kit',
  backupHint: 'Save a recovery kit. Keep it somewhere safe, away from this computer.',
  backupLink: 'Back up recovery kit',
  switching: (label: string): string => `Opening ${iso(label)}…`,

  // Pause (08 §1 "Pause an ID", D-143 (5)): one click, no Touch ID; Resume with Touch ID.
  pause: 'Pause',
  resume: 'Resume',
  pauseTitle: (label: string): string => `Pause ${iso(label)}?`,
  pauseBody: (label: string): string =>
    `Your AI apps can't send or receive messages as ${iso(label)} until you resume it. Nothing is deleted.`,
  /** After the label (in its own bdi run): "{label} is paused". */
  isPaused: ' is paused',
  resumeTouchId: 'Resume with Touch ID',
  resumeStatement: (label: string): string => `Resume ${iso(label)}`,
  pauseFailed: "Couldn't pause it. Try again.",
  resumeFailed: "Couldn't resume it. Try again.",
  notPaused: 'It is not paused any more.',

  // Rename (D-141, 11 §5.8).
  renameHint: 'People see this name.',
  renameTouchId: 'Rename with Touch ID',
  renamedTold: (label: string): string =>
    `Renamed. Your contacts will see ${label} next time they're online.`,
  renameLimited: (label: string, time: string): string =>
    `You can rename ${label} again at ${time}.`,
  renamePending: 'Your last rename is still reaching your contacts. Try again in a minute.',
  /** Before the card name (in its own bdi run): "Contacts still see {cardName}". */
  contactsStillSee: 'Contacts still see ',
  updateContacts: 'Update contacts',

  // Fleet (A11, Under the hood).
  fleetSummary: (working: number, ready: number, rest: number): string =>
    `${working} working · ${ready} ready · ${rest} not running or paused`,
  search: 'Search',
  searchPlaceholder: 'ID or AI app',
  show: 'Show',
  allStatuses: 'All statuses',
  aiApp: 'AI app',
  allApps: 'All AI apps',
  sortBy: 'Sort by',
  sortActivity: 'Most recent activity',
  sortName: 'Name',
  sortStatus: 'Status',
  colAgent: 'ID',
  colApps: 'Used by',
  colStatus: 'Status',
  colPeople: 'People',
  colLast: 'Last active',
  now: 'now',
  never: 'never',
  selectAll: 'Select all IDs',
  selectOne: (label: string): string => `Select ${label}`,
  selected: (n: number): string => (n === 1 ? '1 ID selected' : `${n} IDs selected`),
  selectedRegion: 'Selected IDs',
  clear: 'Clear',
  noMatch: 'No IDs match.',
  fleetCaption: 'Your IDs',

  // One agent's page.
  backToAgents: 'IDs',
  noSuchAgent: 'No ID called that on this computer.',
  folder: (name: string): string => `Folder ${name}`,
  people: 'People',
  rules: 'Rules',
  activity: 'Activity',
  backup: 'Backup',
  noPeople: 'No people yet.',
  reading: 'Loading…',
  peopleOther: (label: string): string => `Open ${iso(label)} to see its people.`,
  rulesOther: (label: string): string => `Open ${iso(label)} to see its rules.`,
  openAgent: 'Open this ID',
  seeAllActivity: 'See all activity',
  seeRules: 'Change rules',
  noActivity: 'Nothing yet while this page is open.',
  sparkLabel: (app: string, n: number, word: string): string =>
    `${app}: ${word}. ${n} checks while this page was open.`,
  historyNote: 'History shows while this page is open; it is not kept.',
  ruleProofs: (word: string): string => `Add a proof: ${word}`,
  ruleContacts: (word: string): string => `New contacts: ${word}`,
  ruleFiles: (send: number, receive: number): string =>
    `Files: send up to ${send} MB, receive up to ${receive} MB`,
  ruleAllow: 'Allowed',
  ruleAsk: 'Ask me',
  ruleNever: 'Never',
  rulesUnavailable: "Couldn't read the rules just now.",
  peopleUnavailable: "Couldn't read the people just now.",
} as const;
