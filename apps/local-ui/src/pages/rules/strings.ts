// The Rules page's copy (11 §5, §5.6, §6.2.1; DESIGN-ADJ-1 RU-2…RU-6, LS-1; UX audit 6a–6c). Plain
// words only: no 11 §5.1 term (rules.test.tsx checks the rendered page). The warning sentences of the
// confirm screen are in warnings.ts (D-119).

export const RULES_STRINGS = {
  eyebrow: 'What your agent may do without asking',
  savingNote: 'Saving asks for your passkey',
  loading: 'Loading your rules…',
  summaryTitle: 'Rules in force',
  summaryNote: 'This is what your agent follows right now.',
  hoodVersion: 'Rules version',
  everyday: 'Everyday',
  moreRules: 'More rules',

  allowed: 'Allowed',
  askMe: 'Ask me',
  // M1-PAY-CONFIRM-b: a spending change continues to the confirmation sheet (b11 §19.1).
  continueToConfirm: 'Continue',
  never: 'Never',
  allow: 'Allow',
  askEveryTime: 'Ask me every time',
  recommended: 'recommended',
  hold: 'Hold for my review',
  drop: 'Drop',

  proofTitle: 'Add proof',
  proofHelp: 'Each proof uses credits and is public.',
  proofOff: 'Your agent never adds proof.',
  budget: 'Proof budget in any 24 hours',
  askOver: 'Ask me over',
  invitesTitle: 'New contacts',
  invitesHelp: 'Ask me before connecting with a new contact.',
  termsTitle: 'Accepting terms',
  termsHelp: 'Accepting commits you. Never approved from a notification.',

  unknownTitle: 'Requests from unknown senders',
  unknownHelp: 'Only an invite adds a contact.',
  whoTitle: 'Who can message your agent',
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
  limitsHelp: 'Your agent accepts on its own only within these limits.',
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
    `Your agent will commit you to deliver whatever this contact writes, for at least ${amount}. Only turn this on for contacts you trust.`,
  someAmount: 'the amount you set',
  noListed: 'No contacts are listed for this yet.',

  changes: (n: number): string => (n === 1 ? '1 change' : `${String(n)} changes`),
  unsaved: 'Unsaved',
  reviewSave: 'Review and save',
  discard: 'Discard',
  invalidAmount: 'Enter an amount in dollars, like 5 or 0.50.',
  invalidSize: 'Enter a size from 1 to 10240 MB.',

  confirmTitle: 'Before you save',
  confirmIntro: 'These changes let your agent do more without asking. Tick each one to confirm.',
  noWarnings: "These changes don't let your agent do more without asking.",
  keepTitle: 'Keep delivery receipts on',
  keepText:
    'Delivery receipts are on from an older default. Each one shows publicly that a proof reached your agent, never the content.',
  codeLabel: 'Backup code or owner passphrase',
  codeHint: 'Never give it to your AI.',
  save: 'Save with passkey',
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
  sessionExpired:
    'This link has expired. Open AgentLink again from your AI, or run `agentlink ui`.',
  passkeyCancelled: 'The passkey was not used. Try again.',
  invalidEdit: "These changes can't be saved. Check the values and try again.",

  unavailable: "Your rules couldn't be loaded. Try again in a minute.",
  notSetUp: 'Set up AgentLink first. Your rules appear here after that.',
  notValid:
    "Your rules couldn't be checked, so everything that costs money or commits you asks first. Run `agentlink policy recover` in your own terminal.",
} as const;
