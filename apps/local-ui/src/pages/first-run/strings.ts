// First-run copy (d1 Local-firstrun with the DESIGN-ADJ-1 (a) fixes LF-1 and LF-3; UX audit 1b, 1c,
// 1d; D-120). Plain words only (11 §5): no key, hash, wallet, gas, chain or transaction in the default
// view. The owner fingerprint is an identity value (11 §5.2) and is shown once setup is done.

export const STEPS = ['Protect approvals', 'Recovery kit', 'Ready'] as const;

export const FIRST_RUN = {
  stepOf: (n: number): string => `Step ${String(n)} of ${String(STEPS.length)}`,
  loading: 'Checking this computer…',

  protectTitle: 'Protect your approvals',
  // LF-1 (11 §6.2.1, D-67, D-68).
  protectBody:
    'Approvals need you: each approval, or each list of approvals you review together, asks for your passkey, owner code or owner passphrase, and only after you click Approve. Never give them to your AI.',
  createPasskey: 'Create a passkey',
  passkeyNote:
    'Your browser shows its own passkey dialog (Touch ID, Windows Hello or your phone). AgentLink never draws that dialog.',
  // UX audit 1b: one neutral line instead of the amber box.
  desktopTip: 'Tip: the desktop app (coming soon) protects approvals more strongly.',
  waiting: 'Waiting for your passkey…',
  untilTitle: 'Until this is done',
  // LF-3 (06 §3).
  untilBody:
    'Your agent can send and receive messages, but anything that needs you waits here: new contacts, proofs your rules ask about, folder access, document keys and accepting terms.',

  doneTitle: 'Approvals are protected',
  doneBody: 'Your passkey now protects approvals on this computer.',
  doneNoPasskeyBody:
    "Your browser made a passkey, but it can't protect approvals here. Use this owner code to approve instead.",
  fingerprintLabel: 'Your owner fingerprint',
  fingerprintNote: 'Run `agentlink doctor` in your own terminal: it shows the same fingerprint.',
  // D-120 (1): the owner code is the backup, collapsed by default.
  backupSummary: 'Backup way to approve',
  backupLabel: 'Owner code',
  backupExplain:
    'If your passkey is ever gone, this code approves instead. Keep it in your password manager. Never give it to your AI. It is shown only now.',
  copy: 'Copy',
  copied: 'Copied',
  // 08 §1 `done_unconfirmed`.
  unconfirmed: "Setup finished, but we couldn't confirm one step. Your agent may need a restart.",
  unconfirmedTitle: 'Almost there.',
  continue: 'Continue',

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
  keychain:
    "Your computer's password store refused the request. Unlock it, then run `agentlink doctor` in your own terminal.",
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
