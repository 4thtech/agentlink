// First-run copy (d1 Local-firstrun with the DESIGN-ADJ-1 (a) fixes LF-1 and LF-3; UX audit 1b, 1c,
// 1d; D-120). Plain words only (11 §5): no key, hash, wallet, gas, chain or transaction in the default
// view. The owner fingerprint is an identity value (11 §5.2) and is shown once setup is done.
//
// M1-UX-FIRSTRUN-V2 (D-130 (1), (2); 11 §5.5, §6.2.1; copy proposed, owner confirms at merge): the
// passkey-first flow, Protect approvals (with the folders) → Your backup code (save form, "I saved
// it") → Recovery kit → Ready. The button names the platform. The backup code is never "password".
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';

/** The platform the page runs on, for the button and the browser hint (11 §6.2.1). */
export type Platform = 'mac' | 'windows' | 'other';

/** What the platform calls its sensor, in copy. */
export const SENSOR: Readonly<Record<Platform, string>> = {
  mac: 'Touch ID',
  windows: 'Windows Hello',
  other: 'your passkey',
};

/** A browser on this platform that gives AgentLink a passkey it can use (docs PRF matrix, #536). */
export const WORKING_BROWSER: Readonly<Record<Platform, string>> = {
  mac: 'Safari',
  windows: 'Chrome or Edge',
  other: 'Chrome',
};

export const FIRST_RUN = {
  loading: 'Checking this computer…',

  // U3-g (b11 §28.3): one screen names the agent and protects it.
  protectTitle: 'Set up your agent',
  // 11 §6.2.1: the folders setup creates, shown before the gesture.
  foldersTitle: 'Your folders',
  folders: [
    ['Send from', '~/AgentLink/Send'],
    ['Receive into', '~/AgentLink/Inbox'],
    ['Proofs in', '~/AgentLink/Proofs'],
  ] as const,
  foldersNote:
    'One confirmation protects approvals, sets up this agent and lets your AI send files you put in the Send folder. Changing folders is optional, later in Files.',
  // The button names the platform (08 §1 first run v2).
  useTouchId: 'Use Touch ID',
  useWindowsHello: 'Use Windows Hello',
  usePasskey: 'Use a passkey',
  passkeyNote:
    'Your browser shows its own dialog for Touch ID, Windows Hello or your passkey. AgentLink never draws that dialog.',
  // M1-UX-PRF-MATRIX copy (11 §6.2.1): no passkey AgentLink can use in this browser.
  noPrf: (sensor: string, browser: string): string =>
    `${sensor} doesn't work in this browser for AgentLink. Open this page in ${browser} to use it, or continue with a backup code only.`,
  backupOnly: 'Continue with a backup code only',
  waiting: 'Waiting for your passkey…',

  // 11 §5.5 "Backup code at first run" (D-130 (1)).
  backupTitle: 'Your backup code',
  doneBody: 'Approvals on this computer are protected.',
  doneNoPasskeyBody:
    "This browser can't protect approvals with a passkey here, so this backup code is how you approve on this computer.",
  backupBody: (sensor: string): string =>
    `This opens your approvals if ${sensor} isn't available. Never give it to your AI.`,
  backupLost:
    "Lost it? You can't get this code back. Your recovery kit restores everything instead.",
  saveToManager: 'Save in my password manager',
  saveAsked: 'If your browser or password manager offered to save it, accept there.',
  savedAs: 'Saved as',
  savedAsLabel: (computer: string): string => `AgentLink backup code – ${computer}`,
  clipboardWarning: 'Other apps can read your clipboard.',
  savedIt: 'I saved it',
  // The first policy's outcome (D-130 (2)).
  sendAllowed:
    'Your AI can send files you put in ~/AgentLink/Send. Nothing else on this computer can be sent.',
  sendNotAllowed:
    "AgentLink couldn't allow your Send folder, so your AI can't send files yet. You can allow a folder later in Files.",
  sendNotConfirmed:
    "Your Send folder was set up, but AgentLink couldn't confirm it. Run `agentlink doctor` in your own terminal.",
  fingerprintLabel: 'Your owner fingerprint',
  fingerprintNote: 'Run `agentlink doctor` in your own terminal: it shows the same fingerprint.',
  backupLabel: 'Backup code',
  shownOnce: 'Shown once',
  copy: 'Copy',
  copied: 'Copied',
  // 08 §1 `done_unconfirmed`.
  unconfirmed: "Setup finished, but we couldn't confirm one step. Your agent may need a restart.",
  unconfirmedTitle: 'Almost there.',

  // U3-a (D-138; 08 §1): the end of first run lands on Home.
  toHome: 'Go to Home',
  // The recovery kit is put off ("Later", remembered for the banner) when the backup code is saved.
  leaving: 'Opening Home…',

  alreadyTitle: 'Approvals are already protected on this computer',
  alreadyBody:
    "If you didn't set this up yourself, don't use this agent: run `agentlink doctor` in your own terminal and compare the owner fingerprint.",

  unsupportedTitle: "This browser can't make a passkey",
  unsupportedBody:
    'Open this page in Chrome, Edge or Safari, or set up approvals in your own terminal:',
  unsupportedCommand: 'agentlink owner init',
  tryAgain: 'Try again',
  startAgain: 'Start again',
} as const;

/**
 * What a setup answer means, in plain words. The server answers fixed `status` and `reason` codes
 * (08 §1, M1-11s-c); nothing from the request or an error text is ever shown.
 */
export const SETUP_MESSAGES = {
  // b11 §28.3.
  cancelled: 'Not protected yet. Try again.',
  label_invalid:
    "That name can't be used. Use letters, numbers and single spaces, up to 32 characters.",
  expired: 'This step took too long. Nothing changed. Try again.',
  not_pending: 'This step took too long. Nothing changed. Try again.',
  busy: 'Another setup or approval is running. Wait a moment, then try again.',
  wait: (seconds: number): string =>
    `Too many tries. Wait ${String(seconds)} seconds, then try again.`,
  presence_required: "Your browser didn't send the passkey. Nothing changed. Try again.",
  presence_rejected: "That passkey couldn't be used here. Nothing changed. Try again.",
  invalid: 'Something went wrong on this page. Reload it and try again.',
  unavailable:
    "Setup can't run from this page right now. Ask your AI to open AgentLink again, or run `agentlink owner init` in your own terminal.",
  rolled_back: "Setup didn't finish, so nothing was kept. Start again.",
  // M1-UX-FIRSTRUN-V2: the Send folder was refused before the gesture (nothing began).
  folder_not_empty:
    'The folder AgentLink/Send in your home folder already holds files. Move them out, then try again. Nothing changed.',
  folder_unavailable:
    "AgentLink couldn't use the folder AgentLink/Send in your home folder: it must be a plain folder, not a link or a file. Fix it, then try again. Nothing changed.",
  keychain:
    "Your computer's keychain refused the request. Unlock it, then run `agentlink doctor` in your own terminal.",
  check_failed:
    "We couldn't check this computer's setup. Run `agentlink doctor` in your own terminal.",
  internal: "Setup didn't finish. Run `agentlink doctor` in your own terminal.",
  offline: "AgentLink isn't answering. Ask your AI to open AgentLink again.",
  session_expired: 'This link has expired. Ask your AI to open AgentLink again.',
  forbidden: "This page couldn't be checked. Ask your AI to open AgentLink again.",
  unknown: "Setup didn't finish. Run `agentlink doctor` in your own terminal.",
  // IR-M1-11b-1-1 L-2: the connection dropped after finish was sent, and the re-check says the owner
  // exists: the setup probably finished, but its answer (with the backup code) never arrived.
  finishedNoCode:
    "Setup probably finished, but the connection dropped before your backup code could be shown. Approve with your passkey. If your passkey doesn't work, run `agentlink doctor` in your own terminal.",
  notFinished: "The connection dropped and setup didn't finish. Nothing was kept. Try again.",
} as const;

/** M1-UX-FIRSTRUN-V2-c: what the switch is called on each platform. */
const SWITCH_TITLE: Readonly<Record<Platform, string>> = {
  mac: 'Switch to Touch ID',
  windows: 'Switch to Windows Hello',
  other: 'Switch to a passkey',
};
const ON_TITLE: Readonly<Record<Platform, string>> = {
  mac: 'Touch ID is on',
  windows: 'Windows Hello is on',
  other: 'Your passkey is on',
};
const APPROVE_WITH: Readonly<Record<Platform, string>> = {
  mac: 'Approve with Touch ID.',
  windows: 'Approve with Windows Hello.',
  other: 'Approve with a passkey.',
};

/**
 * M1-UX-FIRSTRUN-V2-c (B-9; 08 §1 first run v2; 11 §5.5, §6.2.1; copy proposed, owner confirms at
 * merge): an owner set up before 0.3.0 (in the terminal, with the code `owner init` printed, the backup code
 * in the local app) enters it once, then one passkey gesture. The backup code keeps working.
 */
export const UPGRADE = {
  title: (platform: Platform): string => SWITCH_TITLE[platform],
  body: (sensor: string): string =>
    `Enter your backup code once, then approve with ${sensor} instead of typing it. Your backup code keeps working when ${sensor} isn't available. Never give it to your AI.`,
  codeLabel: 'Backup code',
  // 0.2.0 owners know the code by its terminal name (the one shared hint, src/strings.ts).
  codeHint: EARLIER_OWNER_CODE_HINT,
  noPrf: (sensor: string, browser: string): string =>
    `${sensor} doesn't work in this browser for AgentLink. Open this page in ${browser} to switch. Until then, approve with your backup code.`,
  doneTitle: (platform: Platform): string => ON_TITLE[platform],
  doneBody: (sensor: string): string =>
    `Next time, approve with ${sensor}. Your backup code still works if ${sensor} isn't available, so keep it saved.`,
  // U3-a (D-138): the end of the first-run page lands on Home.
  toHome: 'Go to Home',
  // The next step on every app page (b11 Home "Next step"; the d1 shared-states banner).
  bannerTitle: (platform: Platform): string => APPROVE_WITH[platform],
  bannerBody: 'Enter your backup code once to switch. It keeps working as your backup.',
  bannerAction: (platform: Platform): string => SWITCH_TITLE[platform],
} as const;

/** The switch's fixed answers in plain words (setup-api.ts UpgradeProblem); never server text. */
export const UPGRADE_MESSAGES = {
  empty: 'Enter your backup code first.',
  presence_rejected: "That backup code didn't work. Check it and try again. Nothing changed.",
  presence_required: "Your browser didn't send the backup code. Nothing changed. Try again.",
  cancelled: "The passkey wasn't created. Nothing changed. Try again when you're ready.",
  unsupported: (browser: string): string =>
    `This passkey can't protect approvals here. Nothing changed. Keep approving with your backup code, or open this page in ${browser}.`,
  busy: SETUP_MESSAGES.busy,
  wait: SETUP_MESSAGES.wait,
  failed: "The switch didn't finish. Run `agentlink doctor` in your own terminal.",
  offline: SETUP_MESSAGES.offline,
  session_expired: SETUP_MESSAGES.session_expired,
  forbidden: SETUP_MESSAGES.forbidden,
} as const;

/** U3-g (b11 §28): Welcome, pick your AI app, name and protect, connect your AI app. */
export const WELCOME = {
  title: 'Private messages between AI agents. Only you and your contact can read them.',
  start: 'Get started',
  what: "What's AgentLink?",
  /** The public docs; opens in a new tab and sends no data. */
  whatHref: 'https://wiki.4thtech.io/products/agentlink',
  /** The owner read failed. */
  failed: "Couldn't start AgentLink. Close this tab and run it again.",
} as const;

export const PICK = {
  title: 'Which AI app will you use?',
  found: 'Found',
  later: "I'll choose later",
  next: 'Continue',
  back: 'Back',
  none: 'No AI app found yet. You can connect one later.',
  lookFailed: "Couldn't look for AI apps. You can connect one later.",
  loading: 'Looking for AI apps…',
} as const;

export const NAME = {
  label: 'Name your agent',
  hint: 'Shown to you and your contacts.',
  /** The suggested name follows the chosen app; "My agent" with none (b11 §28.3). */
  suggested: (app: string | undefined): string => (app === undefined ? 'My agent' : `${app} agent`),
  empty: 'Give your agent a name.',
  /** The name must be 1 to 32 characters (06 §6 label rule). */
  tooLong: 'Use up to 32 characters.',
  change: 'Change',
  changeLabel: (app: string): string => `Change the AI app (${app})`,
  setting: 'Setting up…',
  backupInstead: 'Use a backup code instead',
  back: 'Back',
} as const;

/** The most code points a name may have (06 §6; the server checks it again). */
export const NAME_MAX = 32;

/** b11 §30.3, §28.4: the connect step in the first-run shell. */
export const CONNECT = {
  title: (app: string, agent: string): string => `Connect ${app} to ${agent}`,
  intro: (app: string): string => `This adds one entry to ${app}'s settings.`,
  file: 'File',
  adds: 'Adds',
  entryRegion: 'The entry that will be added',
  folder: (folder: string): string =>
    `Agent folder: ${folder}. A backup of the file is saved first. Nothing else in it changes.`,
  loading: 'Checking the settings…',
  apply: (sensor: string): string => `Apply with ${sensor}`,
  applyCode: 'Apply with my backup code',
  later: 'Later',
  connecting: 'Connecting…',
  notYet: 'Not connected yet. Try again.',
  tryAgain: 'Try again',
  checkAgain: 'Check again',
  quitFirst: (app: string): string => `Quit ${app} first.`,
  quitNote: "AgentLink never closes it for you. When it's closed, check again.",
  foreign: "This app already has an AgentLink entry we didn't write.",
  foreignNote: 'AgentLink does not change it. You can connect this app later.',
  unreadable: "Couldn't read its settings.",
  couldntChange: (app: string): string => `Couldn't change ${app}'s settings. Nothing was changed.`,
  changed: 'The settings changed since you looked. Review them again.',
  reviewAgain: 'Review again',
  moveNote: (app: string, from: string, to: string): string =>
    `${app} will use ${to} instead of ${from}.`,
  removed: 'Removed',
  connected: (app: string): string => `${app} is connected.`,
  restart: (app: string): string => `Restart ${app} to finish`,
  restartNote: 'AgentLink never restarts it for you. Open it again when you are ready.',
  alreadyDone: (app: string): string => `${app} already works with this agent.`,
  codeLabel: 'Backup code',
  presenceHint: 'Confirm it’s you. Never give your backup code to your AI.',
} as const;
