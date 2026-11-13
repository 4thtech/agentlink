// U3-h: Agents copy (b11 §29; 11 §5). "keys" appears only in the Remove sheet, because it is what is
// deleted. No "wallet", "gas", "seed phrase" or "transaction".
import { sensorWord } from '../../presence-word.js';
/**
 * W4-AGENTS (I-5; IR-W4-AGENTS-SEC-1 L1): an agent label inside a title, a statement or an aria
 * name is its own bidi-isolated run (U+2068 … U+2069), so no character in it can reorder the words
 * around it. Rendered text elsewhere uses `<bdi>`.
 */
export const iso = (label: string): string => `\u2068${label}\u2069`;

export const AGENTS_STRINGS = {
  title: 'My IDs',
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
  switch: 'Open',
  rename: 'Rename',
  inviteSomeone: 'Invite someone',
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
  // W8-S4 (F16, F21; 04 §2.5 "Finishing a removal"; 11 §5.8 "Unfinished removal").
  notFullyRemoved: (label: string): string => `${iso(label)} wasn't fully removed`,
  finishRemoving: 'Finish removing',
  finishTitle: (label: string): string => `Finish removing ${iso(label)}`,
  get finishTouchId(): string {
    return `Finish with ${sensorWord()}`;
  },
  finishStatement: (label: string): string => `Finish removing ${iso(label)}`,
  empty: 'No IDs yet. An ID is created when you connect your first AI app.',
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
  get saveTouchId(): string {
    return `Save with ${sensorWord()}`;
  },
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
  exportFirst: 'Save recovery kit first',
  typeName: "Type the ID's name to confirm",
  typeNameLabel: (label: string): string => `Type ${iso(label)} to confirm`,
  typeNameDisabled: 'Type the name to enable this',
  // UX1113-N2: the one button is the gesture; the sensor's word comes from the platform.
  renameWith: (sensor: string): string => `Rename with ${sensor}`,
  renameWithCode: 'Rename with your master code',
  removeWith: (sensor: string): string => `Remove with ${sensor}`,
  removeWithCode: 'Remove with your master code',
  finishWith: (sensor: string): string => `Finish with ${sensor}`,
  finishWithCode: 'Finish with your master code',
  removeAnywayWith: (sensor: string): string => `Remove anyway with ${sensor}`,
  removeAnywayWithCode: 'Remove anyway with your master code',
  resumeWith: (sensor: string): string => `Resume with ${sensor}`,
  resumeWithCode: 'Resume with your master code',
  updateContactsWith: (sensor: string): string => `Update contacts with ${sensor}`,
  updateContactsWithCode: 'Update contacts with your master code',
  updateNameWith: (sensor: string): string => `Update name with ${sensor}`,
  updateNameWithCode: 'Update name with your master code',
  get removeTouchId(): string {
    return `Remove with ${sensorWord()}`;
  },
  quitAny: (label: string): string => `Quit any AI app that uses ${iso(label)} first.`,
  /** F22: a CLI app (Terminal sessions); no count is read, so no number is claimed. */
  quitTerminal: (app: string): string =>
    `${app} sessions in Terminal are still using this ID. Close them, then check again.`,
  /** F22: a desktop app that keeps running after its window closes. */
  quitBackground: (app: string): string =>
    `${app} keeps running in the background after you close its window. Quit it from its menu, then check again.`,
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
  intro:
    'An ID is how one of your AI apps appears on AgentLink. The people you connect with see its name.',
  // WP-I1 (spec §4): the card words.
  workingNow: 'Working now',
  readyWord: 'Ready',
  pausedWord: 'Paused',
  notUsedYet: 'Not used by any AI app yet',
  openSuffix: ' · this is the ID you are looking at',
  noAppConnected: 'No AI app is connected to this ID.',
  connectAiApp: 'Connect an AI app',
  peopleCount: (n: number): string => (n === 1 ? 'person' : 'people'),
  kitBacked: (date: string): string => `Backed up ${date}`,
  kitNone: 'Not in a kit',
  kitLabel: 'recovery kit',
  moreLabel: 'More about this ID',
  // The name nudge (I-3): a machine name such as macbook-agent-1.
  nudgeBefore: 'People see this ID as ',
  nudgeAfter: '. Give it a name they will recognise, like your own.',
  // UX1113-QA2: two IDs with the same name (a restore next to an ID of the same name keeps both).
  duplicateBefore: 'Another of your IDs is also called ',
  duplicateAfter: '. Give this one a name people can tell apart.',
  // The "how it fits" strip (spec §2.1).
  fitLabel: 'How it fits together',
  fitHide: 'Hide this',
  fitApp: 'Your AI app',
  fitAppBody: 'Claude Code, Codex…',
  fitUses: 'Uses',
  fitId: 'Your ID',
  fitIdBody: 'A name, an inbox, your rules',
  fitTalks: 'Talks to',
  fitPeople: 'People',
  fitPeopleBody: 'Their AI apps, by invite',
  aiApps: 'AI apps',
  /** D-144 improvement (c): which AI apps use this ID. */
  usedBy: (apps: readonly string[]): string => `Used by ${apps.join(', ')}`,
  notUsed: 'Not used by any AI app',
  /** The local-only "Tali · Claude Code" (D-144 improvement (a)); the app is never sent to contacts. */
  withApp: (label: string, apps: readonly string[]): string =>
    apps.length === 0 ? label : `${label} · ${apps.join(', ')}`,
  /**
   * W8-S4 (F20): the same, short enough for one line (the switcher): "Tali · Claude Code and 1
   * more", as the card's "Ready in Claude Code and 1 more".
   */
  withAppShort: (label: string, apps: readonly string[]): string =>
    apps.length === 0
      ? label
      : apps.length === 1
        ? `${label} · ${apps[0] ?? ''}`
        : `${label} · ${apps[0] ?? ''} and ${apps.length - 1} more`,
  backUp: 'Back up',
  disconnect: 'Disconnect',
  noAppsYet: 'No AI app is set up for this ID yet.',
  manageApps: 'All AI apps',
  useAppsPage: 'Open All AI apps to change this one.',
  quitFirstHint:
    'Quit the AI app first, then open it again. AgentLink sets it up; nothing to copy or paste.',
  restartToFinish: (app: string): string => `Restart ${app} to finish.`,
  backupTitle: 'Recovery kit',
  // UX1113: one recovery kit covers every ID; it is saved in Settings › Backup & restore.
  backupHint:
    'One recovery kit covers all your IDs. Save it, check it and restore from it in Backup & restore.',
  backupOpen: 'Open Backup & restore',
  switching: (label: string): string => `Opening ${iso(label)}…`,

  // Pause (08 §1 "Pause an ID", D-143 (5)): one click, no Touch ID; Resume with Touch ID.
  pause: 'Pause',
  resume: 'Resume',
  pauseTitle: (label: string): string => `Pause ${iso(label)}?`,
  pauseBody: (label: string): string =>
    `Your AI apps can't send or receive messages as ${iso(label)} until you resume it. Nothing is deleted.`,
  /** After the label (in its own bdi run): "{label} is paused". */
  isPaused: ' is paused',
  get resumeTouchId(): string {
    return `Resume with ${sensorWord()}`;
  },
  resumeStatement: (label: string): string => `Resume ${iso(label)}`,
  pauseFailed: "Couldn't pause it. Try again.",
  resumeFailed: "Couldn't resume it. Try again.",
  notPaused: 'It is not paused any more.',

  // Rename (D-141, 11 §5.8).
  renameHint: 'People see this name.',
  get renameTouchId(): string {
    return `Rename with ${sensorWord()}`;
  },
  renamedTold: (label: string): string =>
    `Renamed. Your contacts will see ${label} next time they're online.`,
  renameLimited: (label: string, time: string): string =>
    `You can rename ${label} again at ${time}.`,
  renamePending: 'Your last rename is still reaching your contacts. Try again in a minute.',
  // WP-1: the server could not offer the rename that updates the card (an app started before 0.4.14).
  renameRestart:
    "This ID can't be renamed from here yet. Quit the AgentLink app and open it again, then try again. Nothing was changed.",
  /** Before the card name (in its own bdi run): "Contacts still see {cardName}". */
  contactsStillSee: 'Contacts still see ',
  updateContacts: 'Update contacts',
  // WP-1 (R-1): the same note for an ID with no contacts yet (F23: no word about contacts).
  /** Before the card name (in its own bdi run): "New invites still show {cardName}". */
  newInvitesStillShow: 'New invites still show ',
  updateName: 'Update name',
  /** After the label (in its own bdi run): "… so everyone sees {label}." */
  get noteHint(): string {
    return `One ${sensorWord()}, so everyone sees `;
  },
  // WP-1 (R-2): the invite asks for the update first.
  /** Before the card name: "Your invites still show {cardName}". */
  invitesStillShow: 'Your invites still show ',
  /** Before the card name (in its own bdi run): "Invite as {cardName}". */
  inviteAs: 'Invite as ',

  // Fleet (A11, Under the hood).
  fleetSummary: (working: number, ready: number, rest: number): string =>
    `${working} working · ${ready} ready · ${rest} not running or paused`,
  search: 'Search',
  searchPlaceholder: 'ID or AI app',
  show: 'Show',
  allStatuses: 'All statuses',
  // W7-HARNESS-TERM: "harness" is allowed in Under the hood only (11 §5.1 exception); the rest of the app says "AI app".
  aiApp: 'AI app (harness)',
  allApps: 'All AI apps',
  sortBy: 'Sort by',
  sortActivity: 'Most recent activity',
  sortName: 'Name',
  sortStatus: 'Status',
  colAgent: 'ID',
  colApps: 'AI app (harness)',
  colFolder: 'Folder',
  harnessHint:
    'AI apps: developers call them harnesses, the program that runs your AI and connects it to AgentLink.',
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
  openForKit: (label: string): string => `Open ${iso(label)} to save its recovery kit?`,
  seeAllActivity: 'See all activity',
  seeRules: 'Change rules',
  noActivity: 'Nothing yet while this page is open.',
  sparkLabel: (app: string, n: number, word: string): string =>
    `${app}: ${word}. ${n} checks while this page was open.`,
  historyNote: 'History shows while this page is open; it is not kept.',
  ruleProofs: (word: string): string => `Add a proof: ${word}`,
  ruleContacts: (word: string): string => `New people: ${word}`,
  ruleFiles: (send: number, receive: number): string =>
    `Files: send up to ${send} MB, receive up to ${receive} MB`,
  ruleAllow: 'Allowed',
  ruleAsk: 'Ask me',
  ruleNever: 'Never',
  rulesUnavailable: "Couldn't read the rules just now.",
  peopleUnavailable: "Couldn't read the people just now.",
} as const;
