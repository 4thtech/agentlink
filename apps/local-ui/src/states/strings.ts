// Shared-state copy (d1 Local-states, `shared-states--all`, with the UX audit 2b, 10a and 10d fixes:
// the non-technical path first, then the terminal; no "owner actions blocked"). Plain words (11 §5).

export const STATE_STRINGS = {
  notAvailableTitle: "This page isn't available yet.",
  notAvailableHint: 'It arrives in an update. Nothing is lost while you wait.',
  notFoundTitle: 'Page not found.',
  notFoundHint: "This page isn't here.",
  notFoundHome: 'Go to Home',

  // Local link invalid (audit 2b).
  linkExpiredTitle: 'This link has expired',
  linkExpiredBody: 'Open AgentLink again to get a new link. It takes a few seconds.',
  linkExpiredCommand: 'npx -y @4thtech-io/agentlink ui',

  // Agent not running.
  notRunningTitle: "AgentLink isn't running",
  notRunningBody:
    "Your AI app starts it when it needs it. Open your AI app, then this page again. Nothing is lost while it's stopped; messages wait on the network. To see what's wrong:",
  notRunningCommand: 'agentlink doctor',

  // First run unfinished (audit 10d: no "owner actions blocked").
  setupUnfinishedTitle: 'Finish setup to approve.',
  setupUnfinishedBody: 'Anything that needs you waits until your approvals are protected.',
  continueSetup: 'Continue setup',

  // Recovery kit "Later" (D-120 (2)).
  kitPendingTitle: 'Save your recovery kit.',
  kitPendingBody: 'If this computer is lost, it brings your ID and its contacts back.',
  kitPendingAfterContact:
    'You have a contact now: save your recovery kit so you can get them back if this computer is lost.',
  saveKit: 'Save kit',

  // Network.
  networkSlow: 'Messages are arriving slowly. Still trying.',
  networkOffline: "Can't reach the message network. Showing what's saved here.",
  networkBack: (count: number): string =>
    count === 0
      ? 'Back online.'
      : `Back online. ${String(count)} new ${count === 1 ? 'message' : 'messages'}.`,

  // Empty and loading.
  emptyTitle: 'Nothing waiting for you.',
  emptyPrompt: 'Create an AgentLink invite for a colleague.',
  loading: 'Checking for new messages…',
  retry: 'Retry',
} as const;

/**
 * R1-UI-12: how to open AgentLink again, in plain steps for the computer in use (the terminal is a
 * small second line). Shown when the app stopped or the link has expired.
 */
export const REOPEN = {
  closedTitle: 'AgentLink closed',
  closedBody:
    'AgentLink was closed, so this page can no longer reach it. Nothing is lost: your messages wait for you.',
  how: 'To open it again:',
  macos: 'Open AgentLink from your Applications folder, or press Cmd + Space and type AgentLink.',
  windows: 'Open AgentLink from the Start menu.',
  linux: 'Open AgentLink from your app menu.',
  other: 'Open AgentLink from your computer, where you installed it.',
  ai: 'Or ask your AI app to open AgentLink for you.',
  reload: 'Then reload this page, or use the new window that opens.',
  terminal: 'If you use a terminal, run this instead:',
} as const;
