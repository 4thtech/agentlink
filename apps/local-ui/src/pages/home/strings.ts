// Home page copy (UI-REFRESH-g; B-11 §4, §7; 11 §5: plain words, no "wallet", "gas", "seed phrase",
// "transaction", "relay"). Checked by strings.test.ts against the 11 §5.1 never-say list.
export const HOME_STRINGS = {
  title: 'Home',
  greetingMorning: 'Good morning',
  greetingAfternoon: 'Good afternoon',
  greetingEvening: 'Good evening',
  loading: 'Loading Home…',
  tilesLabel: 'Your agent at a glance',
  // Agent tile
  agentTitle: 'Agent',
  agentRunning: 'Running',
  agentPaused: 'Paused',
  agentNotRunning: 'Not running',
  agentNeedsSetup: 'Needs setup',
  agentRunningLine: 'Ready to send and receive.',
  agentPausedLine: 'Nothing is sent or received for now.',
  agentNotRunningLine: 'Start your AI app to bring your agent online.',
  agentNeedsSetupLine: 'Finish setting up to start.',
  // Network tile
  networkTitle: 'Network',
  networkConnected: 'Connected',
  networkReconnecting: 'Reconnecting…',
  networkOffline: 'Offline',
  networkNotConnected: 'Not connected',
  // Waiting for you tile
  waitingTitle: 'Waiting for you',
  waitingNone: 'Nothing is waiting.',
  review: 'Review',
  oneMinuteLeft: '1 min left',
  lessThanMinute: 'Less than a minute left',
  // Credits tile
  creditsTitle: 'Credits',
  creditsMeter: 'Credits',
  creditsNone: 'Free test credits arrive with your first proof.',
  creditsUnavailable: "Can't check right now.",
  // Last activity tile
  activityTitle: 'Last activity',
  activityNone: 'Nothing yet. Approvals and proofs show up here.',
  activityList: 'Last three events',
  // States
  asOf: 'as of',
  errorLine: "Couldn't read the latest. Trying again.",
  offlineLine: "Can't reach AgentLink on this computer. Showing the last values.",
  // Under the hood
  hoodVersion: 'Version',
  hoodRoutes: 'Routes up',
} as const;

/** `{n} min left` for the soonest waiting request. */
export function minutesLeft(minutes: number): string {
  if (minutes <= 0) return HOME_STRINGS.lessThanMinute;
  return minutes === 1 ? HOME_STRINGS.oneMinuteLeft : `${String(minutes)} min left`;
}

export function creditsLine(balance: string, proofs: number): string {
  return `${balance}, about ${String(proofs)} ${proofs === 1 ? 'proof' : 'proofs'}`;
}

export function waitingCount(n: number): string {
  return n === 1 ? '1 request waiting' : `${String(n)} requests waiting`;
}

export function routesLine(up: number, total: number): string {
  return `${String(up)} of ${String(total)}`;
}

// Start here (UX2-g; B-11 §27; owner decision 7.1). It replaces the Next step card. Plain words per
// 11 §5; the platform word on the protect step comes from first-run (FIRST_RUN.useTouchId and kin).
export const START_STRINGS = {
  title: 'Start here',
  progressLabel: 'Start here',
  loading: 'Loading Start here…',
  protect: 'Protect approvals',
  protectBody: 'Approve with a quick touch instead of a code.',
  invite: 'Invite your first contact',
  inviteBody: 'Create an invite and send it to someone you work with.',
  check: 'Check the safety code with them',
  recommended: '(recommended)',
  compare: 'Compare safety code',
  send: 'Send your first message',
  sendBody: 'Ask your AI to say hello.',
  kit: 'Save your recovery kit',
  kitBody: 'It lets you get back in if this computer is lost.',
  kitAction: 'Save it now',
  allSet: "You're all set.",
  addContact: 'Add contact',
  // Empty states elsewhere point to step 2.
  emptyContacts: 'No contacts yet. Invite someone to start.',
  emptyMessages: 'No messages yet. Invite someone first, then ask your AI to say hello.',
  emptyFiles: 'No files yet. Invite someone first.',
  // Status words for done / next / later, read out with the step.
  stateDone: 'Done',
  stateNext: 'Next',
  stateLater: 'Not yet',
} as const;

/** `{n} of {total}` */
export function startProgress(done: number, total: number): string {
  return `${String(done)} of ${String(total)}`;
}

export function startWaiting(name: string | null): string {
  return name === null ? 'Waiting for your contact to accept' : `Waiting for ${name} to accept`;
}

/** The prompt for step 4. The name is the owner's own alias; otherwise our own template only. */
export function startHello(name: string | null): string {
  return name === null
    ? 'Say hello to my new contact on AgentLink.'
    : `Say hello to ${name} on AgentLink.`;
}

export function startStepDone(step: string, done: number, total: number): string {
  return `Step done: ${step}. ${startProgress(done, total)}.`;
}
