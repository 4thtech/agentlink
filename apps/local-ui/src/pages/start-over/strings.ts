// OWNER-START-OVER (D-153; 11 §5): the copy of "Forgot your master code? Start over on this
// computer". 11 §5.1: ID, master code, recovery kit; never wallet, key, seed phrase or password.
// String keys `local.startOver.*` (11 §5.4).
import type { Platform } from '../first-run/strings.js';

/** The link under every master code field. */
export const FORGOT_LINK = 'Forgot your master code?';

/** What the person types to go on (the server checks it again). */
export const PHRASE = 'start over';

/** Where the OS keeps AgentLink's saved items, in the platform's own word. */
export const STORE_WORD: Readonly<Record<Platform, string>> = {
  mac: 'Keychain',
  windows: 'Credential Manager',
  other: "this computer's keychain",
};

export const WARN = {
  kicker: 'Forgot your master code?',
  title: 'Start over on this computer?',
  lead: "Without your master code, AgentLink can't approve anything for your IDs here. If you have your recovery kit, restore instead: you keep your IDs, people and history.",
  restore: 'Restore from recovery kit',
  lostTitle: 'If you start over',
  lost: [
    'Your IDs on this computer stop working. People you talk to will need a new invite from you.',
    'Messages and files of those IDs can no longer be opened in AgentLink.',
    'Your AI apps lose their AgentLink ID until you set up a new one.',
  ],
  kept: (store: string): string =>
    `AgentLink moves its folder to a backup and deletes nothing in it. It removes only its own items from ${store}.`,
  goOn: 'Start over instead',
  back: 'Back',
} as const;

export const CONFIRM = {
  title: 'Type start over to continue',
  label: 'Type start over',
  hint: 'This is the last step before AgentLink starts over on this computer.',
  button: (sensor: string | undefined): string =>
    sensor === undefined ? 'Start over' : `Start over with ${sensor}`,
  browserNote:
    'Your browser asks you to confirm it’s you with Touch ID or Windows Hello. Without them, you type start over once more.',
  /** Desktop app without Touch ID or Windows Hello: the second typing comes next. */
  next: 'Continue',
  working: 'Starting over…',
  back: 'Back',
} as const;

/** Owner decision (14 Nov 2026): no sensor on this computer, so the phrase is typed twice. */
export const AGAIN = {
  title: 'Type start over once more',
  lead: "This computer can't confirm it's you with Touch ID or Windows Hello, so type it again to be sure. AgentLink then starts over.",
  label: 'Type start over again',
  button: 'Start over',
} as const;

export const DONE = {
  title: 'You can start fresh',
  backup: (path: string): string => `Your old folder is kept as ${path}.`,
  appsTitle: 'Quit and reopen your AI apps',
  apps: 'Until you do, they keep using the old ID and keep writing into the backup folder.',
  passkeys:
    'Passkeys named AgentLink stay in your browser or system settings. You can delete them there.',
  next: 'Set up AgentLink',
  earlierTitle: 'The earlier start over is finished',
  earlier:
    'AgentLink removed what an earlier start over left behind. Your current IDs and master code were not changed.',
} as const;

export const PARTIAL = {
  moveTitle: "AgentLink couldn't start over",
  move: 'Nothing was changed. Quit your AI apps, then try again.',
  keychainTitle: 'Almost done',
  keychain: (path: string | null, store: string): string =>
    `${path === null ? 'Your old folder is kept as a backup.' : `Your old folder is kept as ${path}.`} Some of AgentLink's items in ${store} couldn't be removed yet. Try again to finish.`,
  retry: 'Try again',
} as const;

/** One fixed line per problem; nothing is silent. */
export const PROBLEM_TEXT = {
  phrase: 'Type start over exactly as shown.',
  expired: 'That took too long. Try again.',
  presence_required: 'Confirm it’s you to start over.',
  presence_rejected: (sensor: string): string =>
    `${sensor} didn't confirm it's you. Nothing was changed.`,
  cancelled: 'You closed the prompt. Nothing was changed.',
  unsupported:
    "This browser can't confirm it's you. Open the AgentLink app, or use a browser with Touch ID, Windows Hello or a security key. Nothing was changed.",
  busy: 'AgentLink is already starting over. Wait a moment.',
  wait: (seconds: number): string => `Too many tries. Try again in ${String(seconds)} seconds.`,
  open_app: 'Open the AgentLink app to start over. Nothing was changed.',
  failed: 'Something went wrong. Try again: starting over again is safe.',
  offline: "AgentLink isn't answering. Check that the app is running, then try again.",
} as const;

export const UNFINISHED = {
  title: 'Finish starting over',
  lead: 'An earlier start over on this computer did not finish. Finish it to set up AgentLink again.',
} as const;
