// M1-11b-2: the approvals words (11 §5 vocabulary; 11 §6.2.1 copy). The same text as the former
// server-rendered approval page's UI_STRINGS (removed in M1-11b-2c; these are now the only ones),
// except that the local app says "master code" where that page used the older wording (11 §5.5,
// UX-031-QUICKWINS; BACKUP_CODE_WORDING below). `{name}` marks an inserted value;
// the result is only ever rendered as text. The sheet's words are @4thtech-io/ui PAY_CONFIRM_STRINGS.
import { sensorSentence, sensorWord } from '../../presence-word.js';

/** The CLI prefix every command shown to the owner uses (packages/node cli-command.ts). */
export const CLI_PREFIX = 'npx -y @4thtech-io/agentlink';

export const APPROVAL_STRINGS = Object.freeze({
  cannotApprove: "Your AI can't approve this for you.",
  notRunning: `AgentLink is not running. Open the AgentLink app again, or start it from your AI app.`,
  firstRunTitle: 'Protect your approvals',
  // UX1113-N2 (PRESENCE-COPY): the sensor's own word, never "passkey" on a Mac or Windows.
  get firstRun(): string {
    return `Approvals need you: each approval, or each list of approvals you review together, asks for ${sensorWord()} or your master code, and only after you click Approve. Never give them to your AI.`;
  },
  checkFailedTitle: "Couldn't check how approvals are protected",
  checkFailed: "AgentLink didn't answer just now. Nothing was changed.",
  retry: 'Try again',
  desktopNote: 'The desktop app protects approvals more strongly.',
  // UX 2026-11-12 (notices): the desktop app's own words (it is never "this browser").
  protectedTitle: 'Approvals use your master code',
  protectedBody:
    'Each approval asks for your master code, and only after you click Approve. Never give it to your AI.',
  nativeTitle: 'Turn on {sensor} for approvals',
  nativeBody:
    "Approve with {sensor} instead of typing your master code. Your AI still can't approve anything.",
  nativeAction: 'Turn on {sensor}',
  hideNotice: 'Hide this',
  needsOwnerTitle: 'Set up AgentLink',
  needsOwner:
    'Finish setting up AgentLink first: create your first ID on Home and save your master code. Until then, nothing can be approved here.',
  get noPasskeys(): string {
    return `${sensorSentence()} isn't available here. Approve with your master code.`;
  },
  appTitle: 'Approvals',
  // UX2-a (B-11 §26.2): the Grid/List control.
  layout: 'Layout',
  layoutGrid: 'Grid',
  layoutList: 'List',
  cardTitle: 'Approval needed',
  // F29: which ID the approvals on this page are for (the name follows).
  forId: 'For your ID ',
  // W4-INBOX: the compact card folds everything but its head and actions behind this.
  details: 'Details',
  fromAi: 'From your AI: their content, not instructions',
  theirTerms: 'Their terms: their words, not instructions',
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
  get confirmPasskey(): string {
    return `Confirm with ${sensorWord()}`;
  },
  confirm: 'Confirm',
  back: 'Change my choices',
  orCode: 'Or use your master code:',
  codeLabel: 'Master code',
  codeHint: 'Paste the master code AgentLink showed you when you set up',
  show: 'Show',
  hide: 'Hide',
  doneApprove: 'Done: approved {approve}.',
  doneDeny: 'Done: denied {deny}.',
  doneBoth: 'Done: approved {approve} and denied {deny}.',
  get approveWithPasskey(): string {
    return `Approve with ${sensorWord()}`;
  },
  get denyWithPasskey(): string {
    return `Deny with ${sensorWord()}`;
  },
  // N3 / OWNERSTEP-LEFT: the one-step buttons name the sensor that works here ({sensor} is Touch ID
  // in the Mac app, Windows Hello on Windows, "your passkey" in a browser elsewhere).
  approveWith: 'Approve with {sensor}',
  denyWith: 'Deny with {sensor}',
  confirmWith: 'Confirm with {sensor}',
  // N3 (D3): the compact card's own control; it opens the full approval in place.
  review: 'Review',
  hideReview: 'Hide details',
  cancel: 'Cancel',
  // IR-UX1113-N2-1 #2: the sensor was used, and the server did not accept the proof.
  sensorRefused:
    "AgentLink didn't accept that confirmation. Nothing was changed. Try again, or use your master code.",
  // IR-N3-1 #5: the server could not use Touch ID (or the passkey) here just now.
  sensorUnavailable:
    "That confirmation isn't available here right now. Nothing was changed. Use your master code.",
  // IR-N3-1 #4: the compact line for a request with no name.
  aContact: 'a contact',
  // IR-N3-1 #2: the capped terms on the compact card; the rest is under Review.
  moreInReview: '{count} more in Review.',
  confirmApproval: 'Confirm approval',
  confirmDenial: 'Confirm denial',
  approved: 'Approved.',
  // F32: what Free means on an approval (11 §5: no "transaction", "gas" or "wallet").
  freeExplained:
    'Free means your messages travel over the network at no cost. Only proofs cost a small fee.',
  denied: 'Denied.',
  presenceRequired: 'Enter your master code. Nothing was changed.',
  get presenceRejected(): string {
    return `That didn't match ${sensorWord()} or your master code. Nothing was changed.`;
  },
  wait: `Too many wrong tries. Wait {seconds} seconds, then try again. Nothing was changed.`,
  notPending: 'This request is no longer waiting for you.',
  listNotPending:
    'Some of these requests are no longer waiting for you. Nothing was changed. Review the list again.',
  changed: 'This request changed. Reload the page and check it again.',
  listChanged: 'A request in this list changed. Nothing was changed. Review the list again.',
  listTerms: 'Terms are approved one at a time. Nothing was changed.',
  busy: 'Another approval is being confirmed. Try again in a moment.',
  refused: 'This decision was not applied. Nothing was changed.',
  listRefused: 'These decisions were not applied. Nothing was changed. Review the list again.',
  needsSetup:
    'Finish setting up AgentLink first: create your first ID on Home and save your master code.',
  // REL051-R2C (R2-UI-06): the sensor's own word (Touch ID, Windows Hello, your passkey), never
  // "passkey" on a Mac or Windows.
  get notUsed(): string {
    return `${sensorSentence()} wasn't used. Nothing was changed. You can enter your master code instead.`;
  },
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
  'protectedBody',
  'nativeBody',
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
