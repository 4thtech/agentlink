// First-run copy (d1 Local-firstrun with the DESIGN-ADJ-1 (a) fixes LF-1 and LF-3; UX audit 1b, 1c,
// 1d; D-120). Plain words only (11 §5): no key, hash, wallet, gas, chain or transaction in the default
// view. The ID tag is an identity value (11 §5.2) and is shown once setup is done.
//
// M1-UX-FIRSTRUN-V2 (D-130 (1), (2); 11 §5.5, §6.2.1; copy proposed, owner confirms at merge): the
// passkey-first flow, Protect approvals (with the folders) → Your master code (save form, "I saved
// it") → Recovery kit → Ready. The button names the platform. The master code is never "password".
import { FAILURE_COPY } from '../../api/failure-reasons.js';
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
  protectTitle: "Create your AI app's ID",
  // 11 §6.2.1: the folders setup creates, shown before the gesture.
  foldersTitle: 'Your folders',
  folders: [
    ['Send from', '~/AgentLink/Send'],
    ['Receive into', '~/AgentLink/Inbox'],
    ['Proofs in', '~/AgentLink/Proofs'],
  ] as const,
  foldersNote:
    'One confirmation protects approvals, sets up this ID and lets your AI send files you put in the Send folder. Changing folders is optional, later in Files.',
  // The button names the platform (08 §1 first run v2).
  useTouchId: 'Use Touch ID',
  useWindowsHello: 'Use Windows Hello',
  usePasskey: 'Use a passkey',
  passkeyNote:
    'Your browser shows its own dialog for Touch ID, Windows Hello or your passkey. AgentLink never draws that dialog.',
  // M1-UX-PRF-MATRIX copy (11 §6.2.1): no passkey AgentLink can use in this browser.
  // F49: `browser` is undefined when the page already runs in the browser that would be suggested.
  noPrf: (sensor: string, browser: string | undefined): string =>
    browser === undefined
      ? `${sensor} on this computer can't protect approvals yet. Continue with a master code only.`
      : `${sensor} doesn't work in this browser for AgentLink. Open this page in ${browser} to use it, or continue with a master code only.`,
  backupOnly: 'Continue with a master code only',
  waiting: 'Waiting for your passkey…',

  // 11 §5.5 "Master code at first run" (D-130 (1)).
  backupTitle: 'Your master code',
  doneBody: 'Approvals on this computer are protected.',
  // M1-11s-c-c: shown prominently, before the code, when no passkey protects approvals.
  doneNoPasskeyTitle: 'Save your master code — you need it to approve.',
  doneNoPasskeyBody:
    "This browser can't protect approvals with a passkey here, so this master code is how you approve on this computer.",
  /** R1-UI-02: leaving the once-only code screen (Skip to Home) asks first. */
  leaveCode:
    "Your master code is shown only once. If you leave now it is gone and we can't show it again. Copy it or save it as a file first. Leave anyway?",
  backupBody: (sensor: string): string =>
    `Your master code approves changes when ${sensor} isn't available and unlocks your AgentLink key. Save it once. We can't recover it for you. Never give it to your AI.`,
  backupLost:
    "Lost it? You can't get this code back. Save a recovery kit too: it gets AgentLink back on any computer.",
  saveToManager: 'Save in my password manager',
  saveAsked: 'If your browser or password manager offered to save it, accept there.',
  savedAs: 'Saved as',
  savedAsLabel: (computer: string): string => `AgentLink master code – ${computer}`,
  clipboardWarning: 'Other apps can read your clipboard.',
  savedIt: 'I saved it',
  // The first policy's outcome (D-130 (2)).
  sendAllowed:
    'Your AI can send files you put in ~/AgentLink/Send. Nothing else on this computer can be sent.',
  sendNotAllowed:
    "AgentLink couldn't allow your Send folder, so your AI can't send files yet. You can allow a folder later in Files.",
  sendNotConfirmed:
    "Your Send folder was set up, but AgentLink couldn't confirm it. Run `agentlink doctor` in your own terminal.",
  fingerprintLabel: 'Your ID tag',
  fingerprintNote: 'Run `agentlink doctor` in your own terminal: it shows the same ID tag.',
  backupLabel: 'Master code',
  shownOnce: 'Shown once',
  copy: 'Copy',
  copied: 'Copied',
  // F49: Copy never fails silently; "Save as file" downloads a small .txt (local only).
  copyFailed: "Couldn't copy here. Select the code above and copy it, or save it as a file.",
  saveFile: 'Save as file',
  fileSavedShort: 'Saved',
  fileSaved: 'Saved to your Downloads folder as agentlink-backup-code.txt. Keep that file private.',
  fileFailed: "Couldn't save a file here. Copy the code or save it in your password manager.",
  // 08 §1 `done_unconfirmed`.
  unconfirmed: "Setup finished, but we couldn't confirm one step. Your AI app may need a restart.",
  unconfirmedTitle: 'Almost there.',

  // U3-a (D-138; 08 §1): the end of first run lands on Home.
  toHome: 'Go to Home',
  // The recovery kit is put off ("Later", remembered for the banner) when the master code is saved.
  leaving: 'Opening Home…',

  alreadyTitle: 'Approvals are already protected on this computer',
  alreadyBody:
    "If you didn't set this up yourself, don't use this ID: run `agentlink doctor` in your own terminal and compare the ID tag.",

  unsupportedTitle: "This browser can't make a passkey",
  unsupportedBody:
    'Open this page in Chrome, Edge or Safari, or set up approvals in your own terminal:',
  unsupportedCommand: 'agentlink owner init',
  tryAgain: 'Try again',
  startAgain: 'Start again',
  /** W4-WIZARD: step 2 without an app found on this computer. */
  yourAiApp: 'your AI app',
  noAppYet: 'Connect an AI app later',
  noAppCreateBody:
    "We create your ID. No AI app is connected yet: install one, then connect it in Settings > AI apps. Your confirmation proves it's you.",
  notFoundCreateBody: (app: string): string =>
    `${app} isn't on this computer yet, so nothing is added to it now. We create the ID; install ${app}, then connect it in Settings > AI apps.`,
  notFoundTitle: (app: string): string => `${app} isn't on this computer yet`,
  notFoundBody: (app: string): string =>
    `Install ${app}, then come back to Get started. Nothing changed. You can pick another AI app.`,
} as const;

/**
 * What a setup answer means, in plain words. The server answers fixed `status` and `reason` codes
 * (08 §1, M1-11s-c); nothing from the request or an error text is ever shown.
 */
export const SETUP_MESSAGES = {
  // b11 §28.3.
  cancelled: 'Not protected yet. Try again.',
  no_agent: 'Set up your ID first.',
  finish_restore: 'A restore was not finished. Choose your kit again to finish it.',
  label_invalid:
    "That name can't be used. Use letters, numbers, single spaces and . ' - up to 32 characters.",
  expired: 'This step took too long. Nothing changed. Try again.',
  not_pending: 'This step took too long. Nothing changed. Try again.',
  busy: 'Another setup or approval is running. Wait a moment, then try again.',
  wait: (seconds: number): string =>
    `Too many tries. Wait ${String(seconds)} seconds, then try again.`,
  presence_required: "Your browser didn't send the passkey. Nothing changed. Try again.",
  presence_rejected: "That passkey couldn't be used here. Nothing changed. Try again.",
  invalid: 'Something went wrong on this page. Reload it and try again.',
  unavailable: "Setup can't run from this page right now. Close this tab and run AgentLink again.",
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
  // R2: one line per fixed reason (api/failure-reasons.ts); new copy, owner confirms at merge.
  storage_unreachable: FAILURE_COPY.storage_unreachable,
  relay_unreachable: FAILURE_COPY.relay_unreachable,
  ai_app_running: FAILURE_COPY.ai_app_running,
  ai_app_config_unwritable: FAILURE_COPY.ai_app_config_unwritable,
  keychain_unavailable: "AgentLink couldn't check this computer's keychain. Try again.",
  concurrent_change: FAILURE_COPY.concurrent_change,
  internal: FAILURE_COPY.internal,
  offline: "AgentLink isn't answering. Ask your AI to open AgentLink again.",
  session_expired: 'This link has expired. Ask your AI to open AgentLink again.',
  forbidden: "This page couldn't be checked. Ask your AI to open AgentLink again.",
  unknown: "Setup didn't finish. Run `agentlink doctor` in your own terminal for details.",
  // W4-ONE-TOUCH (D-140; 11 §5.8): the AI app picked on the same screen.
  quit_first: 'Quit Claude Desktop first. Nothing changed. Then try again.',
  app_unavailable:
    "This AI app can't be connected from here right now. Nothing changed. Leave it out with Not now, or try again.",
  changed: 'Its settings changed since you looked. Nothing was saved. Try again.',
  tries_exhausted: 'That was the third try. Nothing was saved. Start again.',
  // IR-M1-11b-1-1 L-2: the connection dropped after finish was sent, and the re-check says the owner
  // exists: the setup probably finished, but its answer (with the master code) never arrived.
  finishedNoCode:
    "Setup probably finished, but the connection dropped before your master code could be shown. Approve with your passkey. If your passkey doesn't work, run `agentlink doctor` in your own terminal.",
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
 * merge): an owner set up before 0.3.0 (in the terminal, with the code `owner init` printed, the master code
 * in the local app) enters it once, then one passkey gesture. The master code keeps working.
 */
export const UPGRADE = {
  title: (platform: Platform): string => SWITCH_TITLE[platform],
  body: (sensor: string): string =>
    `Enter your master code once, then approve with ${sensor} instead of typing it. Your master code keeps working when ${sensor} isn't available. Never give it to your AI.`,
  codeLabel: 'Master code',
  // 0.2.0 owners know the code by its terminal name (the one shared hint, src/strings.ts).
  codeHint: EARLIER_OWNER_CODE_HINT,
  // F49: `browser` is undefined when the page already runs in the browser that would be suggested.
  noPrf: (sensor: string, browser: string | undefined): string =>
    browser === undefined
      ? `${sensor} on this computer can't protect approvals yet, so AgentLink uses your master code.`
      : `${sensor} doesn't work in this browser for AgentLink. Open this page in ${browser} to switch. Until then, approve with your master code.`,
  doneTitle: (platform: Platform): string => ON_TITLE[platform],
  doneBody: (sensor: string): string =>
    `Next time, approve with ${sensor}. Your master code still works if ${sensor} isn't available, so keep it saved.`,
  // U3-a (D-138): the end of the first-run page lands on Home.
  toHome: 'Go to Home',
  // The next step on every app page (b11 Home "Next step"; the d1 shared-states banner).
  bannerTitle: (platform: Platform): string => APPROVE_WITH[platform],
  bannerBody: 'Enter your master code once to switch. It keeps working as your backup.',
  bannerAction: (platform: Platform): string => SWITCH_TITLE[platform],
} as const;

/** The switch's fixed answers in plain words (setup-api.ts UpgradeProblem); never server text. */
export const UPGRADE_MESSAGES = {
  empty: 'Enter your master code first.',
  presence_rejected: "That master code didn't work. Check it and try again. Nothing changed.",
  presence_required: "Your browser didn't send the master code. Nothing changed. Try again.",
  cancelled: "The passkey wasn't created. Nothing changed. Try again when you're ready.",
  // F49: `browser` is undefined when the page already runs in the browser that would be suggested.
  unsupported: (browser: string | undefined, sensor = 'This passkey'): string =>
    browser === undefined
      ? `${sensor} on this computer can't protect approvals yet, so AgentLink uses your master code. Nothing changed.`
      : `This passkey can't protect approvals here. Nothing changed. Keep approving with your master code, or open this page in ${browser}.`,
  busy: SETUP_MESSAGES.busy,
  wait: SETUP_MESSAGES.wait,
  failed: "The switch didn't finish. Run `agentlink doctor` in your own terminal for details.",
  offline: SETUP_MESSAGES.offline,
  session_expired: SETUP_MESSAGES.session_expired,
  forbidden: SETUP_MESSAGES.forbidden,
} as const;

/** U3-g (b11 §28): Welcome, pick your AI app, name and protect, connect your AI app. */
export const WELCOME = {
  title: 'Private messages between AI agents. Only you and your contact can read them.',
  start: 'Get started',
  what: "What's AgentLink?",
  /** D-147 (spec §6.5): under Get started, for a person who has a recovery kit. */
  restore: 'I have a recovery kit',
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
  label: 'Name people see',
  hint: 'People see this name on your invites.',
  placeholder: 'Your first name, e.g. Ana',
  empty: 'Give this ID a name.',
  /** The name must be 1 to 32 characters (06 §6 label rule). */
  tooLong: 'Use up to 32 characters.',
  change: 'Change',
  changeLabel: (app: string): string => `Change the AI app (${app})`,
  setting: 'Setting up…',
  backupInstead: 'Use your master code instead',
  back: 'Back',
  /** W4-ONE-TOUCH (D-140; 11 §5.8 "Create and connect"): prefilled; unticked = "Not now". */
  connectTo: (app: string): string => `Connect to ${app}`,
  notNow: 'Not now',
  /** W4-ONE-TOUCH: New ID with the master code. */
  confirmCode: 'Confirm with my master code',
  /** W8-F12 (11 §5.5 "master code"; copy proposed, owner confirms at merge): what the code is. */
  codeWhat: 'Your master code is the code you saved when you first set up AgentLink.',
} as const;

/** W4-ONE-TOUCH (D-140; 11 §5.8 "Create and connect"): after the one gesture. */
export const CREATED = {
  ready: (label: string, app: string): string =>
    `${label} is ready in ${app}. Restart ${app} to finish.`,
  notConnected: (label: string, app: string): string =>
    `${label} is ready. ${app} isn't connected yet.`,
  connect: 'Connect',
  later: 'Later',
  next: 'Continue',
} as const;

/** The most code points a name may have (06 §6; the server checks it again). */
export const NAME_MAX = 32;

/** b11 §30.3, §28.4: the connect step in the first-run shell. */
export const CONNECT = {
  title: (app: string): string => `Connect ${app} to this ID`,
  intro: (app: string): string => `This adds one entry to ${app}'s settings.`,
  file: 'File',
  adds: 'Adds',
  entryRegion: 'The entry that will be added',
  folder: (folder: string): string =>
    `ID folder: ${folder}. A backup of the file is saved first. Nothing else in it changes.`,
  loading: 'Checking the settings…',
  apply: (sensor: string): string => `Apply with ${sensor}`,
  applyCode: 'Apply with my master code',
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
  alreadyDone: (app: string): string => `${app} already works with this ID.`,
  codeLabel: 'Master code',
  presenceHint: 'Confirm it’s you. Never give your master code to your AI.',
} as const;
