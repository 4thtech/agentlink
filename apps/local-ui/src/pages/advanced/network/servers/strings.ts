// NET-UI-B (0.5.15; D-158): "Use your own servers" copy. Source: specs/11 §5.14 (strings proposed,
// owner confirms at merge). A few lines the spec leaves open (offline, not-running, a failed test,
// the generic refusals) are marked "proposed". Servers, never "relay"; a reason is always one of
// these fixed strings, never text a server sent.
import type { TestOutcome, TestReason } from './api.js';

const secs = (ms: number): string => (ms / 1000).toFixed(1);

export const SERVERS_STRINGS = {
  // C1, entry
  entryTitle: 'Want to use servers you run or trust?',
  entryBody: 'Most people never need this. AgentLink picks servers for you.',
  useOwn: 'Use your own servers',
  automaticNow: (n: number): string => `Your servers are automatic (${String(n)})`,
  customNow: 'Your servers',
  changeServers: 'Change servers',
  useAutomatic: "Use AgentLink's automatic servers",
  // C7b
  pausedTitle: 'Paused · Resume to change servers',
  paused: (sensor: string): string => `Your ID is paused. Resume it with ${sensor} first.`,
  finishing: 'An earlier change of this ID is still finishing. Try again in a minute.',
  recentTitle: (date: string): string => `You changed servers on ${date}`,
  recent: (date: string): string =>
    `Servers you left stay readable until ${date}. You can change again or go back to automatic at any time.`,
  // Proposed: states the entry needs that the spec does not word.
  offline: 'This computer is offline. Testing and changing servers needs a connection.',
  notRunning: 'Servers can be changed while your AI app is running AgentLink.',
  needsSetup: 'You can choose your servers once AgentLink is set up.',
  noAnswer: "AgentLink didn't answer. Check that your AI app is open, then reload.",
  // C2, add
  addTitle: 'Your servers',
  addBody: 'Add 2 to 8 servers. We test each one here, on this computer, before you can use it.',
  step: (n: number): string => `Step ${String(n)} of 3`,
  fieldLabel: 'Server address',
  fieldPlaceholder: 'wss://',
  add: 'Add',
  info: 'Public servers only, starting with wss://. Only add servers you run or trust. AgentLink never asks you to add a server.',
  testing: 'Testing…',
  testResults: 'Test results',
  /** The scrolling list of servers in the panel (step 2 and the review). */
  listLabel: 'Your servers',
  already: 'Already added.',
  full: 'That is the most servers you can add.',
  // Proposed: the test itself did not run.
  testFailed: "Couldn't test this one. Try again.",
  testBusy: 'Too many tests in a minute. Try again shortly.',
  testOffline: "Can't test while this computer is offline.",
  retest: 'Test again',
  // Outcomes
  ready: (ms: number | null): string => (ms === null ? 'Ready' : `Ready · ${String(ms)} ms`),
  readyWhy: 'Accepts and returns messages. Works.',
  slow: (ms: number | null): string =>
    ms === null ? 'Ready · slow' : `Ready · slow ${secs(ms)} s`,
  slowWhy: 'Works, but answers slowly. Messages may arrive a little later.',
  signIn: 'Needs sign-in to read',
  signInWhy:
    "It accepts messages but asks for a sign-in before it lets anyone read them. AgentLink can't sign in there, so we can't confirm your messages arrive.",
  refused: {
    not_accepted: [
      "Doesn't accept messages",
      "It refused a test message from someone it doesn't know. Servers like this only take messages from approved people.",
    ],
    not_kept: [
      "Didn't keep the test message",
      "It said yes to the test message but couldn't give it back a moment later.",
    ],
    unreachable: ["Can't reach", 'No answer. Check the address, or whether the server is running.'],
    not_allowed: [
      'Not allowed',
      'Only public internet servers (wss://) can be used. Addresses inside a home or office network are blocked for your safety.',
    ],
    too_small: [
      'Messages too large for it',
      "It only takes messages smaller than AgentLink's. Try another server.",
    ],
    invalid: ['Not a server address', 'Check the address. It starts with wss://.'],
  } as Readonly<Record<TestReason & string, readonly [string, string]>>,
  paid: 'This server may charge for use. Check with whoever runs it.',
  retention: 'Servers should keep messages for at least 7 days.',
  // C3, list
  count: (n: number, max: number): string => `${String(n)} of up to ${String(max)} added.`,
  role: 'Sends and receives',
  remove: 'Remove',
  removeFor: (host: string): string => `Remove ${host}`,
  review: 'Review',
  continue: 'Continue',
  back: 'Back',
  mixInLabel: "Also use AgentLink's automatic servers",
  mixInBody: 'We mix in two healthy ones, so your messages still arrive if yours go down.',
  mixOffTitle: 'Only your servers will carry your messages',
  mixOff:
    'If all of yours are down, nothing gets through until one is back. Most people leave this on.',
  mixBack: 'Turn it back on',
  signInOkTitle: 'One server needs a sign-in to read',
  signInOk:
    "That's fine as long as 2 other servers work, and they do. We can't confirm delivery on this one.",
  needMoreHint: 'Add at least one more server to continue',
  needTwoTitle: 'Two working servers are needed',
  needTwo:
    "One isn't enough: if it goes down, your messages stop. Add another, or go back to automatic.",
  optOutLabel: "Don't also announce on the default servers",
  optOutBody: 'For companies that run everything on their own servers.',
  optOutTitle: 'Only your servers will know this ID',
  // Fully quiet (owner, 20 Nov 2026): what stops at once, what stays 30 days, who may miss you.
  optOut:
    "AgentLink's old public servers stop being used at once; your own previous servers stay readable for 30 days. Another computer can find this ID only with your owner link or a backup. Contacts still using an old copy of your contact details may not reach you until they receive the update.",
  // NET-ANNOUNCE-OPTOUT: the opt-out on its own (C3's switch and warning, 11 §5.14). Proposed:
  // the sheet's titles, confirm buttons, statements, toasts and two refusals.
  announceOffTitle: "Don't also announce on the default servers?",
  announceOnTitle: 'Announce on the default servers again?',
  announceOnBody:
    'Other computers and owner surfaces can find this ID on the default servers again. Your servers stay the same.',
  announceSame: 'Your servers stay the same',
  announceSameBody: 'Only where this ID is announced changes.',
  announceConfirmSensor: (sensor: string): string => `Change this with ${sensor}`,
  announceConfirmCode: 'Change this with your master code',
  announceKeep: 'Keep it as it is',
  announceOffReason:
    "Don't also announce on the default servers. Only your servers will know this ID.",
  announceOnReason: 'Announce on the default servers again.',
  announceOffToast: 'Only your servers announce this ID now.',
  announceOnToast: 'This ID is announced on the default servers again.',
  sameChoice: 'That is already your choice.',
  optOutMixIn:
    "Turn off AgentLink's automatic servers first: change servers and switch the mix-in off.",
  // C4, review
  reviewTitle: 'Review',
  reviewBody: 'Nothing changes until you approve.',
  needsApproval: 'Needs your approval',
  useThese: (n: number): string => `Use these ${String(n)} message servers`,
  yours: (ms: number | null): string => (ms === null ? 'Yours' : `Yours · ${String(ms)} ms`),
  automatic: 'Automatic mix-in',
  leavingTitle: 'Your old servers stay readable for 30 days',
  leaving: (date: string, hosts: string): string =>
    `Until ${date}, nothing sent to your old servers is missed: ${hosts}.`,
  contactsTitle: 'Your contacts get your new details once',
  contactsBody: (n: number): string => `AgentLink sends the update to all ${String(n)} for you.`,
  seeTitle: 'What servers can see',
  see: "That you're online, and scrambled messages. Never what's inside them.",
  confirmSensor: (sensor: string): string => `Use these servers with ${sensor}`,
  confirmCode: 'Use these servers with your master code',
  // C5, the reason the owner confirms (the button's accessible description)
  presenceReason: (n: number): string =>
    `Use ${String(n)} message servers. AgentLink wants to change which servers carry your messages.`,
  notUsed: "That didn't go through. Your servers didn't change.",
  // Refusals
  tooManyOldTitle: 'Too many old servers are still being read',
  tooManyOld: (date: string | undefined): string =>
    date === undefined
      ? 'You can go back to automatic now.'
      : `You can change again from ${date}, or go back to automatic now.`,
  sameList: 'These are already your servers.',
  changed: 'A server answered differently this time. Test again before you continue.',
  invalidList: 'Check the list. Each address starts with wss://, with no duplicates.',
  failed: "That didn't go through. Your servers didn't change.",
  // C6 / C7, progress
  changedTitle: 'Servers changed',
  changedAt: (when: string): string => `${when} · done`,
  telling: (sent: number, total: number): string =>
    `Telling your contacts… ${String(sent)} of ${String(total)}`,
  restWait: "The rest wait if they're offline and get it when they're back.",
  oldUntil: (date: string): string => `Old servers readable until ${date}`,
  sent: 'Sent',
  waiting: 'Waiting',
  doneChip: 'Done',
  allHave: (n: number): string => `All ${String(n)} contacts have your new details`,
  nowUse: (n: number, date: string | undefined): string =>
    `Your messages now use your ${String(n)} servers.${date === undefined ? '' : ` Old ones stay readable until ${date}.`}`,
  anyTime: 'Back to automatic any time',
  toast: 'Servers updated. Your contacts have your new details.',
  // C8, reset
  resetTitle: "Use AgentLink's automatic servers?",
  resetBody: 'Go back to the default. Takes one approval.',
  resetPicks: 'AgentLink picks the servers for you again.',
  resetForgets: 'Your own list is forgotten here.',
  resetLeaving: (date: string): string =>
    `Your custom servers stay readable for 30 days, until ${date}.`,
  resetConfirmSensor: (sensor: string): string => `Use automatic servers with ${sensor}`,
  resetConfirmCode: 'Use automatic servers with your master code',
  resetKeep: 'Keep my servers',
  resetReason:
    "Use AgentLink's automatic servers. AgentLink wants to change which servers carry your messages.",
  resetToast: 'Back to automatic servers. Your contacts have your new details.',
  // Status of a server row
  previous: (date: string): string => `Previous, read until ${date}`,
  close: 'Close',
  loading: 'Reading…',
} as const;

/** The chip tone and fixed words of one test result. Never colour alone: the word is always shown. */
export function outcomeWords(
  outcome: TestOutcome,
  reason: TestReason,
  ms: number | null,
): {
  readonly tone: 'success' | 'warning' | 'danger';
  readonly title: string;
  readonly why: string;
} {
  const S = SERVERS_STRINGS;
  if (outcome === 'ready') return { tone: 'success', title: S.ready(ms), why: S.readyWhy };
  if (outcome === 'slow') return { tone: 'warning', title: S.slow(ms), why: S.slowWhy };
  if (outcome === 'sign_in') return { tone: 'warning', title: S.signIn, why: S.signInWhy };
  const [title, why] = S.refused[reason ?? 'invalid'];
  return { tone: 'danger', title, why };
}
