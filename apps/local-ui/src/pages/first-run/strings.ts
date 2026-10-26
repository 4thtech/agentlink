// First-run copy (d1 Local-firstrun with the DESIGN-ADJ-1 (a) fixes LF-1 and LF-3; UX audit 1b, 1c,
// 1d; D-120). Plain words only (11 §5): no key, hash, wallet, gas, chain or transaction in the default
// view. The owner fingerprint is an identity value (11 §5.2) and is shown once setup is done.
//
// M1-UX-FIRSTRUN-V2 (D-130 (1), (2); 11 §5.5, §6.2.1; copy proposed, owner confirms at merge): the
// passkey-first flow, Protect approvals (with the folders) → Your backup code (save form, "I saved
// it") → Recovery kit → Ready. The button names the platform. The backup code is never "password".

export const STEPS = ['Protect approvals', 'Backup code', 'Recovery kit', 'Ready'] as const;

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
  stepOf: (n: number): string => `Step ${String(n)} of ${String(STEPS.length)}`,
  loading: 'Checking this computer…',

  protectTitle: 'Protect your approvals',
  // 11 §6.2.1 (D-130 (1); D-67, D-68): the copy must not claim more.
  protectBody: (sensor: string): string =>
    `Approvals need you: each approval, or each list of approvals you review together, asks for ${sensor} (or your backup code), and only after you click Approve. Never give your backup code to your AI.`,
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
  // UX audit 1b: one neutral line instead of the amber box.
  desktopTip: 'Tip: the desktop app (coming soon) protects approvals more strongly.',
  waiting: 'Waiting for your passkey…',
  untilTitle: 'Until this is done',
  // LF-3 (06 §3).
  untilBody:
    'Your agent can send and receive messages, but anything that needs you waits here: new contacts, proofs your rules ask about, folder access, document keys and accepting terms.',

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

  kitTitle: 'Save your recovery kit',
  kitBody:
    'If this computer is lost, the recovery kit brings your agent and its contacts back. Nobody else has a copy, including 4thTech.',
  saveKit: 'Save kit',
  saveKitSoon: 'Saving the kit from this page arrives in an update.',
  later: 'Later',
  laterNote: "We'll remind you until it's saved.",

  readyTitle: "You're set",
  readyBody: 'Go back to your AI app and say:',
  readyPrompt: 'Create an AgentLink invite for a colleague.',
  readyPromptTitle: 'Say this to your AI',
  readyClose: 'You can close this tab.',
  readyRestart: "If your AI app doesn't see AgentLink yet, restart it first.",

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
  cancelled: "The passkey wasn't created. Nothing changed. Try again when you're ready.",
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
