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
  // Next step card
  nextStepLabel: 'Next step',
  nextContactTitle: 'Connect your first contact',
  nextContactBody: 'Add someone your AI can exchange messages with.',
  nextContactAction: 'Add a contact',
  nextKitTitle: 'Save your recovery kit',
  nextKitBody: 'It lets you get back in if this computer is lost.',
  nextKitAction: 'Save it now',
  nextPasskeyBody: 'Approve with a quick touch instead of a code.',
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
