// The Rules page's copy (11 §5, §5.6, §6.2.1; DESIGN-ADJ-1 RU-2…RU-6, LS-1; UX audit 6a–6c). Plain
// words only: no 11 §5.1 term (rules.test.tsx checks the rendered page). The warning sentences of the
// confirm screen are in warnings.ts (D-119).

import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR } from '../first-run/strings.js';

export const RULES_STRINGS = {
  lead: 'What your AI may do without asking you. Everything else waits for your approval on Home.',
  pickerLabel: 'Rules for',
  masterCode: 'your master code',
  changedTag: 'Changed',
  moreHelp: 'File sizes, who can message this ID, limits for accepting terms, exports',
  moreState: (n: number, changed: number): string =>
    changed === 0
      ? `${String(n)} rules · all at their defaults`
      : `${String(n)} rules · ${String(changed)} changed`,
  barWider: (sensor: string): string =>
    `lets your AI do more without asking. Saving asks for ${sensor}.`,
  barPlain: (sensor: string): string => `Saving asks for ${sensor}.`,
  loading: 'Loading your rules…',
  summaryTitle: 'Rules in force',
  summaryNote: 'This is what your AI follows right now.',
  hoodVersion: 'Rules version',
  everyday: 'Everyday',
  moreRules: 'More rules',

  allowed: 'Allowed',
  askMe: 'Ask me',
  // M1-PAY-CONFIRM-b: a spending change continues to the confirmation sheet (b11 §19.1).
  continueToConfirm: 'Continue',
  never: 'Never',
  allow: 'Allowed',
  askEveryTime: 'Ask me',
  recommended: 'recommended',
  hold: 'Hold for me',
  drop: 'Drop',

  proofTitle: 'Add a public proof',
  proofHelp:
    'Each proof costs credits and is public. Allowed up to the amounts below in any 24 hours, then it asks.',
  proofOff: 'Your AI never adds proof.',
  budget: 'Proof budget in any 24 hours',
  askOver: 'Ask me over',
  invitesTitle: 'Connect with someone new',
  summaryInvites: 'New contacts',
  invitesHelp: 'Your AI asks before it accepts or sends an invite.',
  termsTitle: 'Accepting terms',
  termsHelp: 'Accepting commits you. This is never approved from a notification.',

  unknownTitle: 'Messages from someone you have not connected with',
  unknownHelp: "Only an invite adds a person. Strangers can't reach your AI.",
  whoTitle: 'Who can message this ID',
  whoPaired: 'Paired contacts',
  whoListed: (n: number): string =>
    n === 1 ? 'Only the 1 contact you listed' : `Only the ${String(n)} contacts you listed`,
  filesTitle: 'Files',
  filesSummary: (send: number, receive: number): string =>
    `Only from allowed folders · send up to ${String(send)} MB · receive up to ${String(receive)} MB`,
  sendLabel: 'Send up to (MB)',
  receiveLabel: 'Receive up to (MB)',
  exportsTitle: 'Exports that open the document',
  exportsHelp: 'Anyone with such an export can read the document.',

  limitsTitle: 'Limits for accepting terms',
  limitsHelp: 'Your AI accepts on its own only within these limits.',
  buyTitle: 'Auto-accept when I pay, for listed contacts',
  buyHelp: (max: string, n: number): string =>
    `Up to ${max} per agreement, US-dollar terms only. ${n === 1 ? '1 contact' : `${String(n)} contacts`} listed.`,
  buyMax: 'Up to, per agreement ($)',
  sellTitle: "Auto-accept when I'm paid (selling)",
  sellHelpOff: 'Off by default.',
  sellHelpOn: (min: string): string => `When they pay at least ${min}.`,
  sellMin: 'At least, per agreement ($)',
  sellWarningTitle: 'Before you turn this on:',
  sellWarning: (amount: string): string =>
    `Your AI will commit you to deliver whatever this contact writes, for at least ${amount}. Only turn this on for contacts you trust.`,
  someAmount: 'the amount you set',
  noListed: 'No contacts are listed for this yet.',

  changes: (n: number): string => (n === 1 ? '1 change' : `${String(n)} changes`),
  unsaved: 'Unsaved',
  reviewSave: 'Review and save',
  discard: 'Discard',
  invalidAmount: 'Enter an amount in dollars, like 5 or 0.50.',
  invalidSize: 'Enter a size from 1 to 10240 MB.',

  confirmTitle: 'Before you save',
  confirmIntro: 'These changes let your AI do more without asking. Tick each one to confirm.',
  noWarnings: "These changes don't let your AI do more without asking.",
  keepTitle: 'Keep delivery receipts on',
  keepText:
    'Delivery receipts are on from an older default. Each one shows publicly that a proof reached you, never the content.',
  codeLabel: 'Master code',
  codeHint: 'Never give it to your AI.',
  // The confirm button shows with a registered passkey: the platform's word (Touch ID on a Mac).
  save: `Save with ${SENSOR[detectPlatform()]}`,
  saveCode: 'Save',
  back: 'Back to editing',
  preparing: 'Checking your changes…',
  saving: 'Saving…',

  saved: 'Rules saved.',
  wrongCode: "That didn't match. Try again.",
  wait: (s: number): string => `Too many tries. Wait ${String(s)} seconds and try again.`,
  refused: 'Not saved. Review your changes again.',
  stale: 'Your rules changed somewhere else. Reload the page and make your changes again.',
  busy: 'Another approval is in progress. Try again in a moment.',
  failed: "Couldn't save. Try again.",
  sessionExpired: 'This page has expired. Open AgentLink again from your AI app.',
  passkeyCancelled: (sensor: string): string =>
    `${sensor[0]?.toUpperCase() ?? ''}${sensor.slice(1)} was not used. Try again.`,
  invalidEdit: "These changes can't be saved. Check the values and try again.",

  unavailable: "Your rules couldn't be loaded. Try again in a minute.",
  notSetUp: 'Set up AgentLink first. Your rules appear here after that.',
  notValid:
    "Your rules couldn't be checked, so everything that costs money or commits you asks first. Open Advanced to repair them.",
} as const;
