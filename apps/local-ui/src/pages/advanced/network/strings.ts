// NET-UI-A: Advanced › Message network copy (11 §5; Under the hood only, 0.5.14). Servers, never
// "relay". Proposed wording, pending the owner's confirmation (easy to change here): a server that
// cannot be reached and a slow one use the warning tone, not danger (see TONES in view.tsx).
export const NETWORK_STRINGS = {
  /** The page and menu name (11 §5: "message network"). */
  title: 'Message network',
  intro: 'How your encrypted messages travel. Servers only ever see them scrambled.',
  modeAutomatic: 'Automatic',
  modeCustom: 'Your own servers',
  serversHeading: 'Servers',
  /** The words next to a health dot (the dot's shape also differs, never colour alone). */
  health: {
    ready: 'Working',
    slow: 'Slow',
    unreachable: "Can't reach",
    blocked: 'Blocked here',
    unknown: 'Not checked yet',
  },
  sendsAndReads: 'Sends and receives',
  oldServer: 'Old server, read only',
  oldServerUntil: (date: string): string => `Old server, read only until ${date}`,
  connect: (t: string): string => `Connect ${t}`,
  roundTrip: (t: string): string => `Round trip ${t}`,
  counts: (ok: number, failed: number, received: number): string =>
    `Last 24 hours: ${String(ok)} accepted · ${String(failed)} failed · ${String(received)} received`,
  noCounts: 'Nothing counted in the last 24 hours yet',
  lastOk: (ago: string): string => `Last worked ${ago}`,
  neverOk: 'Not heard from yet',
  needsSignIn: 'This server asks for a sign-in.',
  needsPayment: 'This server asks for payment.',
  slowNote: 'Slow right now. Messages still go through the others.',
  downNote: "Can't reach this server. Your messages use the others.",
  blockedNote: 'This network blocks this server. Your messages use the others.',
  // Banners.
  dropTitle: 'Your list has more than 8 servers.',
  drop: (n: number): string =>
    `Updating your contact details keeps the first 8 and drops ${String(n)}.`,
  checkingTitle: 'Checking.',
  checking: 'Checking the servers. This takes a few seconds the first time.',
  noServers: 'No servers reported yet.',
  allHealthy: 'All servers are working.',
  oneSlowTitle: 'One server is slow.',
  oneSlow: 'Your messages still go out through the others, so nothing is wrong on your side.',
  someSlowTitle: (n: number): string => `${String(n)} servers are slow.`,
  someSlow: 'Your messages still go out through the others.',
  oneDownTitle: "One server can't be reached.",
  oneDown:
    'Messages are still going through the other servers. If it keeps failing, AgentLink swaps it for another automatically.',
  someDownTitle: (n: number): string => `${String(n)} servers can't be reached.`,
  someDown: 'Messages are still going through the others.',
  allDownTitle: "Can't reach the message network.",
  allDown:
    "Can't reach the message network from this computer. Messages wait and send when it's back. A school or office network may block it.",
  offlineTitle: 'This computer is offline.',
  offline: (at: string | undefined): string =>
    `Nothing is lost: new messages wait here and go out when you're back online.${
      at === undefined ? '' : ` Showing what we knew at ${at}.`
    }`,
  notRunningTitle: 'AgentLink is not running.',
  notRunning: 'Servers are checked while your AI app is running AgentLink.',
  pausedTitle: 'This ID is paused.',
  paused: 'Servers are not checked while it is paused. These are the ones it uses.',
  needsSetupTitle: 'AgentLink is not set up yet.',
  needsSetup: 'Your servers show up here once it is set up.',
  noAnswer: "AgentLink didn't answer. Check that your AI app is open, then reload.",
  // Contacts.
  reachHeading: 'Reaching your contacts',
  reach: (sharing: number, total: number): string =>
    `${String(sharing)} of ${String(total)} contacts share a server with you`,
  noContacts: 'No contacts yet.',
  /** The owner's wording (2026-11-19). */
  reaches: (n: number): string => `Reaches ${String(n)} ${n === 1 ? 'contact' : 'contacts'}`,
  /** On a server card: how many contacts use this server too. */
  usedBy: (n: number): string => `${String(n)} ${n === 1 ? 'contact' : 'contacts'}`,
  showContacts: "Show contacts' servers",
  hideContacts: "Hide contacts' servers",
  contactsLoading: 'Reading contacts…',
  contactsFailed: "Couldn't read your contacts' servers. Try again in a moment.",
  contactServers: (servers: number, shared: number): string =>
    `${String(servers)} ${servers === 1 ? 'server' : 'servers'} · ${String(shared)} shared with you`,
  shared: 'shared',
  someoneUnknown: 'A contact',
  lastChecked: (ago: string): string => `Last checked ${ago}`,
  // The diagram (NET-DIAGRAM; owner's three columns: this ID, servers, contacts).
  diagramHeadThisId: 'This ID',
  diagramHeadServers: 'Servers',
  diagramHeadContacts: 'Contacts',
  /** The left node: the ID's name (D-144: "agent" never means the ID); the second line is "this computer". */
  diagramAgent: (label: string | undefined): string =>
    label === undefined || label === '' ? 'Your ID' : label,
  diagramThisComputer: 'this computer',
  diagramSendsReads: 'sends and receives',
  diagramReadOnly: 'read only',
  diagramMore: (n: number): string => `+ ${String(n)} more ${n === 1 ? 'contact' : 'contacts'}`,
  diagramMoreShort: (n: number): string => `+${String(n)}`,
  diagramSummary: (servers: number): string =>
    `Diagram: this computer connects to ${String(servers)} ${servers === 1 ? 'server' : 'servers'}. The list below has the same facts.`,
  diagramServerFact: (host: string, role: string, state: string, ms: string | undefined): string =>
    `${host}, ${role}, ${state}${ms === undefined ? '' : `, ${ms}`}`,
  diagramContactsFact: (names: readonly string[], more: number): string =>
    `Contacts who use the same servers: ${names.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}.`,
  legendSends: 'sends and receives',
  legendOld: 'old, read only',
  legendContact: 'contact uses it too',
  legendWorking: 'working',
  legendSlow: 'slow',
  legendDown: "can't reach",
} as const;
