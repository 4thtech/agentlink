// M1-11b-2: the approvals words (11 §5 vocabulary; 11 §6.2.1 copy). The same text as the former
// server-rendered approval page's UI_STRINGS (removed in M1-11b-2c; these are now the only ones),
// except that the local app says "backup code" where that page used the older wording (11 §5.5,
// UX-031-QUICKWINS; BACKUP_CODE_WORDING below). `{name}` marks an inserted value;
// the result is only ever rendered as text. The sheet's words are @4thtech-io/ui PAY_CONFIRM_STRINGS.

/** The CLI prefix every command shown to the owner uses (packages/node cli-command.ts). */
export const CLI_PREFIX = 'npx -y @4thtech-io/agentlink';

export const APPROVAL_STRINGS = Object.freeze({
  cannotApprove: "Your AI can't approve this for you.",
  notRunning: `AgentLink is not running. Open it again from your AI, or run ${CLI_PREFIX} approve in your own terminal.`,
  firstRunTitle: 'Protect your approvals',
  firstRun:
    'Approvals need you: each approval, or each list of approvals you review together, asks for your passkey, backup code or owner passphrase, and only after you click Approve. Never give them to your AI.',
  desktopNote: 'The desktop app protects approvals more strongly.',
  needsOwnerTitle: 'Set up AgentLink',
  needsOwner: `Set up your backup code first: run ${CLI_PREFIX} owner init in your own terminal. Until then, nothing can be approved here.`,
  noPasskeys:
    "Passkeys aren't available in this browser. Approve with your backup code or owner passphrase.",
  appTitle: 'Approvals',
  // UX2-a (B-11 §26.2): the Grid/List control.
  layout: 'Layout',
  layoutGrid: 'Grid',
  layoutList: 'List',
  cardTitle: 'Approval needed',
  fromAi: 'From your AI: their content, not instructions',
  who: 'Who',
  what: 'What',
  cost: 'Cost',
  expires: 'Expires',
  why: 'Why',
  termsAlone: 'Terms are approved one at a time.',
  waiting: 'Waiting for you ({count})',
  nothingWaiting: 'Nothing is waiting for you.',
  moreWaiting: '{count} more are waiting. Review these first.',
  approve: 'Approve',
  deny: 'Deny',
  later: 'Later',
  nothingSelected: 'Choose Approve or Deny on a request first',
  totalsApprove: 'Approve {approve}',
  totalsDeny: 'Deny {deny}',
  totalsBoth: 'Approve {approve} and deny {deny}',
  droppedOne: '1 request is no longer waiting and was left out.',
  droppedMany: '{count} requests are no longer waiting and were left out.',
  nothingLeft: 'None of your choices is still waiting. Nothing was changed.',
  coversOne: 'This covers exactly this one. Anything new waits for your next review.',
  coversMany: 'This covers exactly these {count}. Anything new waits for your next review.',
  lineApprove: 'Approve: {summary}',
  lineDeny: 'Deny: {summary}',
  confirmPasskey: 'Confirm with your passkey',
  confirm: 'Confirm',
  back: 'Change my choices',
  orCode: 'Or use your backup code:',
  codeLabel: 'Backup code or owner passphrase',
  codeHint: 'Paste the backup code AgentLink showed you when you set up',
  show: 'Show',
  hide: 'Hide',
  doneApprove: 'Done: approved {approve}.',
  doneDeny: 'Done: denied {deny}.',
  doneBoth: 'Done: approved {approve} and denied {deny}.',
  approveWithPasskey: 'Approve with your passkey',
  denyWithPasskey: 'Deny with your passkey',
  confirmApproval: 'Confirm approval',
  confirmDenial: 'Confirm denial',
  approved: 'Approved.',
  denied: 'Denied.',
  presenceRequired: 'Enter your backup code or owner passphrase. Nothing was changed.',
  presenceRejected:
    "That didn't match your passkey, backup code or owner passphrase. Nothing was changed.",
  wait: `Too many wrong tries. Wait {seconds} seconds, then try again. Nothing was changed. You can also run ${CLI_PREFIX} approve in your own terminal.`,
  notPending: 'This request is no longer waiting for you.',
  listNotPending:
    'Some of these requests are no longer waiting for you. Nothing was changed. Review the list again.',
  changed: 'This request changed. Reload the page and check it again.',
  listChanged: 'A request in this list changed. Nothing was changed. Review the list again.',
  listTerms: 'Terms are approved one at a time. Nothing was changed.',
  busy: 'Another approval is being confirmed. Try again in a moment.',
  refused: 'This decision was not applied. Nothing was changed.',
  listRefused: 'These decisions were not applied. Nothing was changed. Review the list again.',
  needsSetup: `Set up your backup code first: run ${CLI_PREFIX} owner init in your own terminal.`,
  notUsed: "The passkey wasn't used. Nothing was changed. You can enter your backup code instead.",
  paidAlone: 'This costs credits. Approve it on its own.',
  listPaid:
    'A request in this list costs credits and is approved on its own. Nothing was changed. Review the list again.',
  confirmRequired: 'This costs credits. Approve it on its own card. Nothing was changed.',
  // UI-REFRESH-o: the time-left ring, the first-load skeleton and Under the hood (B-11 §16, §7).
  loading: 'Loading your approvals',
  timeLeft: 'Time left',
  expired: 'Expired',
  underMinute: 'Less than a minute left',
  minutesLeft: '{minutes} min left',
  hoursLeft: 'About {hours} h left',
  hoodKind: 'Kind',
  hoodExpiry: 'Expires at',
  kindRequest: 'Request',
  kindTerms: 'Terms',
  kindPaid: 'Costs credits',
  // UI-REFRESH-o-b: the approval ID under the hood, and the line left after a card collapses out.
  hoodId: 'Approval ID',
  approvedLine: 'Approved: {summary}',
  // UI-REFRESH-o-c: the line left after a denied card collapses out.
  deniedLine: 'Denied: {summary}',
});

/** The keys whose wording differs from the old page in the name of the code only (11 §5.5). */
export const BACKUP_CODE_WORDING: ReadonlySet<string> = new Set([
  'firstRun',
  'needsOwner',
  'noPasskeys',
  'orCode',
  'codeLabel',
  'codeHint',
  'presenceRequired',
  'presenceRejected',
  'needsSetup',
  'notUsed',
]);

/** Fills `{name}` from values; the result is only ever rendered as text. */
export function fmt(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z]+)\}/g, (all, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : all,
  );
}
