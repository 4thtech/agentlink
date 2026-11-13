// N5/N6 copy (11 §5; PLAN-NOTIFY §4.1, §4.4). Plain words. A person is named only by the owner's own
// contact list (bold, React text); never message text, a file name, a link or an amount (11 §5.7).
export const NOTIFY_STRINGS = {
  bell: 'Notifications',
  bellNew: (n: number): string => `Notifications, ${n > 9 ? 'more than 9' : String(n)} new`,
  announce: (n: number): string =>
    n === 0 ? '' : n === 1 ? '1 new notification' : `${String(n)} new notifications`,
  title: 'Notifications',
  markAll: 'Mark all read',
  settings: 'Notification settings',
  needsYou: 'Needs you',
  fresh: 'New',
  earlier: 'Earlier',
  empty: 'Nothing new. Approvals and messages for your IDs show up here.',
  openActivity: 'Open Activity',
  unread: 'Unread',
  aContact: 'a contact',
  approvals: (n: number): string =>
    n === 1 ? 'An approval is waiting for you' : `${String(n)} approvals are waiting for you`,
  approvalsLine: 'Review on Home',
  messages: (n: number): string =>
    n === 1 ? 'New message from ' : `${String(n)} new messages from `,
  files: (n: number): string =>
    n === 1 ? 'A file arrived from ' : `${String(n)} files arrived from `,
  personLine: 'Open Home',
  update: 'A new version of AgentLink is ready',
  updateLine: 'Settings › Updates',
  network: "Can't reach the message network",
  networkLine: "Messages wait and send when it's back.",
  justNow: 'just now',
  minutes: (n: number): string => `${String(n)} min ago`,
  hours: (n: number): string => `${String(n)} h ago`,
  days: (n: number): string => (n === 1 ? 'yesterday' : `${String(n)} days ago`),
} as const;

export const NOTIFY_SETTINGS_STRINGS = {
  title: 'Notifications',
  intro:
    'The bell at the top of the app always lists what is new. Here you choose what AgentLink may also tell you outside the app.',
  approvals: 'Approvals waiting',
  approvalsHint:
    'When your AI asks for an approval and AgentLink cannot open it in your browser, a short alert on this computer says one is waiting. It names no one and never approves anything.',
  // N7: the desktop app's native notifications (fixed words; a click opens the app at that page).
  approvalsHintDesktop:
    'A notification says an approval is waiting. It names no one and never approves anything. Click it to open the approval in AgentLink.',
  messages: 'New messages',
  messagesHint:
    'A notification when a contact sends you a message. It never shows what the message says.',
  files: 'Files received',
  filesHint: "A notification when a contact sends you a file. It never shows the file's name.",
  updates: 'Updates',
  updatesHint: 'A notification when a new version of AgentLink is ready to install.',
  showNames: 'Show names in notifications',
  showNamesHint:
    'Use the names you gave your contacts on People. Off: a notification says "a contact". Anyone who can see your screen can read them.',
  saveFailed: "Couldn't save this choice. Try again.",
} as const;
