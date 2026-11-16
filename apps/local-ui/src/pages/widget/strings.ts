// Menu bar widget copy (D-155; 11 §5.9; b11 §25.4). Plain words per 11 §5: never "wallet", "gas",
// "seed phrase" or "transaction"; never "online" for a contact (AgentLink knows only the last exchange).
export const WIDGET_STRINGS = {
  title: 'AgentLink',
  loading: 'Loading…',
  statusLabel: 'Status',
  running: 'Running',
  paused: 'Paused',
  notRunning: 'Not running',
  connecting: 'Connecting…',
  updateReady: 'Update ready',
  needsSetup: 'Needs setup',
  noAppsActive: 'No AI app active',
  processGone: "AgentLink isn't running. Start your AI app, then try again.",
  readError: "Couldn't read the latest. Trying again.",
  needs: 'Needs you',
  review: 'Review',
  noneWaiting: 'Nothing is waiting.',
  connected: 'Connected now',
  noApps: 'No AI app is connected right now.',
  contacts: 'Contacts',
  noContacts: 'No exchanges today.',
  activeNow: 'Active now',
  today: 'Today',
  messages: 'New messages',
  noMessages: 'No new messages.',
  untrustedNote: 'Previews come from other agents. Shown as plain text.',
  todayTitle: 'Today',
  legendIn: 'In',
  legendOut: 'Out',
  legendProofs: 'Proofs',
  legendFiles: 'Files',
  live: 'Live',
  noLive: 'Nothing yet today.',
  openApp: 'Open AgentLink',
  pause: 'Pause',
  resume: 'Resume',
  thisComputer: 'This computer',
  pausedLine: 'Nothing is sent or received for now.',
  quit: 'Quit',
  unknownContact: 'A contact',
  working: 'Working',
  ready: 'Ready',
  idle: 'Idle',
  appPaused: 'Paused',
  notRunningApp: 'Not running',
  aFile: 'a file',
} as const;

export function waitingForYou(n: number): string {
  return `${String(n)} waiting for you`;
}
export function newFiles(n: number): string {
  return n === 1 ? '1 new file' : `${String(n)} new files`;
}
export function newCount(n: number): string {
  return `${String(n)} new`;
}
export function appsActive(n: number): string {
  return n === 1 ? '1 AI app active' : `${String(n)} AI apps active`;
}
export function lastActivity(ago: string): string {
  return `last activity ${ago}`;
}
/** "now", "4 min", "2 h", "3 d" (the short form; the sentence adds "ago"). */
export function shortAgo(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return 'now';
  if (s < 3_600) return `${String(Math.floor(s / 60))} min`;
  if (s < 86_400) return `${String(Math.floor(s / 3_600))} h`;
  return `${String(Math.floor(s / 86_400))} d`;
}
export function agoWords(seconds: number): string {
  const short = shortAgo(seconds);
  return short === 'now' ? 'just now' : `${short} ago`;
}
export function todayLabel(inN: number, outN: number, proofs: number, files: number): string {
  return `Today by hour: ${String(inN)} in, ${String(outN)} out, ${String(proofs)} proofs, ${String(files)} files`;
}
export function moreMessages(n: number): string {
  return `+${String(n)} more`;
}
export function rowLabel(name: string, count: number, ago: string): string {
  return `${name}, ${newCount(count)}, ${ago}. Open chat`;
}
