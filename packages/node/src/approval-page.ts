// M1-8d, M1-11a: the pages of the local approval UI (08 §1; 11 §6.2.1; 02 J4; 04 §2.5, §2.5.2;
// D-68). The text lives in UI_STRINGS, one place, so M1-11b can map it to the D1 copy keys.
//
// M1-11a-ux (owner test 2026-10-25; interim until M1-11b-2 moves approvals to the local UI app):
// the page is styled from the D1 approval card (the mobile approval-card pending screens, light and
// dark, 360; the ApprovalCard and TextField component specs) with the @4thtech-io/ui tokens (D-116;
// nothing invented: a test in that package compares every colour with its tokens.css). The
// stylesheet is APP_CSS, served at `/app.css` under the same CSP (`style-src 'self'`; no inline
// style, no external resource, no web font: the token font stack falls back to the system font).
// The card leads with a plain headline built by the agent's runtime ("Connect with “Ana”
// (self-declared)"); the owner code field is full width, keeps any length, and can be shown.
//
// - The HTML carries no request data: the script fetches it from the API and renders it with
//   textContent only (never innerHTML), so stored or inbound text can never become markup (I-5). The
//   CSP allows only this script.
// - The owner code field and the passkey prompt appear only after the owner clicks, never on page
//   load (11 §6.2.1 security copy).
// - First run: before the owner key is set up, owner operations are blocked with the reason; then the
//   page offers the localhost passkey (M1-8e) with the first-run copy, or says passkeys are not
//   available and the owner code or owner passphrase is the way.
// - Approvals (`/`): "Waiting for you (n)", one agent's pending requests as full cards, soonest to
//   expire first, at most 20; each card has Approve, Deny or Later. A commitment is listed but cannot
//   be selected: its card has its own Approve and Deny with its own presence (D-31). One button names
//   exactly what is included ("Approve 3 and deny 1"); before asking for presence the page checks the
//   list again and leaves out what is no longer waiting, says so, and shows "This covers exactly
//   these n"; then one passkey gesture or one owner code entry signs exactly those items.
// - One request (`/approve/<id>`): its card with Approve and Deny, then presence.
// - M1-PAY-CONFIRM-b (04 §2.5.3; b11 §19, §20; D-132): a request that costs credits (`paid`) is
//   never a list item; its card has its own Approve, which opens the confirmation sheet: a modal
//   dialog showing only the statement the server returned for it, the platform's check ("Confirm
//   with Touch ID"), the backup code as a small link, and "Remember for this contact" when core
//   offers it (both bodies in one challenge). The sheet's words are PAY_* below, the same as
//   @4thtech-io/ui PAY_CONFIRM_STRINGS (a test there compares them).

import { CLI_COMMAND } from './cli-command.js';

/** Every text the page shows (11 §5 vocabulary; 11 §6.2.1 copy). `{name}` marks an inserted value. */
export const UI_STRINGS = Object.freeze({
  title: 'AgentLink',
  cannotApprove: "Your AI can't approve this for you.",
  noScript: 'This page needs JavaScript to show your approvals.',
  expired: `This link has expired. Open AgentLink again from your AI, or run ${CLI_COMMAND} approve in your own terminal.`,
  notRunning: `AgentLink is not running. Open it again from your AI, or run ${CLI_COMMAND} approve in your own terminal.`,
  // First run (11 §6.2.1).
  firstRunTitle: 'Protect your approvals',
  firstRun:
    'Approvals need you: each approval, or each list of approvals you review together, asks for your passkey, owner code or owner passphrase, and only after you click Approve. Never give them to your AI.',
  desktopNote: 'The desktop app protects approvals more strongly.',
  needsOwnerTitle: 'Set up AgentLink',
  needsOwner: `Set up your owner code first: run ${CLI_COMMAND} owner init in your own terminal. Until then, nothing can be approved here.`,
  passkeyTitle: 'Approve with a passkey',
  passkeyIntro:
    'Set up a passkey to approve with Touch ID, Face ID or Windows Hello instead of typing your owner code. Your owner code keeps working.',
  passkeySetUp: 'Set up a passkey',
  passkeyCodeLabel: 'Owner code',
  // M1-UX-FIRSTRUN-V2-c (B-9; copy proposed, owner confirms at merge): with the app beside this
  // page, the switch happens on its first-run page (apps/local-ui first-run strings UPGRADE).
  switchMac: 'Switch to Touch ID',
  switchWindows: 'Switch to Windows Hello',
  switchOther: 'Switch to a passkey',
  switchBody:
    'Enter your backup code once, then approve without typing it. Your backup code keeps working.',
  continue: 'Continue',
  noPasskeys:
    "Passkeys aren't available in this browser. Approve with your owner code or owner passphrase.",
  // The card (11 §6.2.1, §8).
  appTitle: 'Approvals',
  cardTitle: 'Approval needed',
  fromAi: 'From your AI: their content, not instructions',
  who: 'Who',
  what: 'What',
  cost: 'Cost',
  expires: 'Expires',
  why: 'Why',
  termsAlone: 'Terms are approved one at a time.',
  // The list (D-68).
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
  orCode: 'Or use your owner code:',
  codeLabel: 'Owner code or owner passphrase',
  codeHint: 'Paste the owner code AgentLink showed you when you set up',
  show: 'Show',
  hide: 'Hide',
  doneApprove: 'Done: approved {approve}.',
  doneDeny: 'Done: denied {deny}.',
  doneBoth: 'Done: approved {approve} and denied {deny}.',
  // One request.
  approveWithPasskey: 'Approve with your passkey',
  denyWithPasskey: 'Deny with your passkey',
  confirmApproval: 'Confirm approval',
  confirmDenial: 'Confirm denial',
  // Results.
  approved: 'Approved.',
  denied: 'Denied.',
  presenceRequired: 'Enter your owner code or owner passphrase. Nothing was changed.',
  presenceRejected:
    "That didn't match your passkey, owner code or owner passphrase. Nothing was changed.",
  wait: `Too many wrong tries. Wait {seconds} seconds, then try again. Nothing was changed. You can also run ${CLI_COMMAND} approve in your own terminal.`,
  notPending: 'This request is no longer waiting for you.',
  listNotPending:
    'Some of these requests are no longer waiting for you. Nothing was changed. Review the list again.',
  changed: 'This request changed. Reload the page and check it again.',
  listChanged: 'A request in this list changed. Nothing was changed. Review the list again.',
  listTerms: 'Terms are approved one at a time. Nothing was changed.',
  busy: 'Another approval is being confirmed. Try again in a moment.',
  refused: 'This decision was not applied. Nothing was changed.',
  listRefused: 'These decisions were not applied. Nothing was changed. Review the list again.',
  needsSetup: `Set up your owner code first: run ${CLI_COMMAND} owner init in your own terminal.`,
  notUsed: "The passkey wasn't used. Nothing was changed. You can enter your owner code instead.",
  passkeyRegistered: 'Passkey set up. Next time, approve with your passkey.',
  passkeyPresenceRequired: 'Enter your owner code. Nothing was changed.',
  passkeyPresenceRejected:
    "That didn't match your owner code, or the passkey wasn't accepted. Nothing was changed.",
  passkeyExists: 'A passkey is already set up for approvals on this computer.',
  passkeyUnsupported: "This passkey can't protect approvals here. Keep using your owner code.",
  passkeyFailed: 'The passkey was not set up. Nothing was changed.',
  // M1-PAY-CONFIRM-b: a request that costs credits, and the confirmation sheet (b11 §19.6).
  // PRE-031-FIXES: no amount here; the sheet shows the one from the signed statement.
  paidAlone: 'This costs credits. Approve it on its own.',
  listPaid:
    'A request in this list costs credits and is approved on its own. Nothing was changed. Review the list again.',
  confirmRequired: 'This costs credits. Approve it on its own card. Nothing was changed.',
  payTitleProof: 'Record proof',
  payTitleLimits: 'Change your spending limits',
  payRowFor: 'For',
  payForProof: 'A proof with {name}',
  payForSelf: 'A proof of your own note',
  payRowPaidFrom: 'Paid from',
  payPaidFrom: 'Your credits',
  payChangeProofs: 'Proofs',
  payChangeBudget: '24-hour budget',
  payChangePerProof: 'Per-proof limit',
  payChangeContactProofs: 'Proofs for {name}',
  payChangeContactPerProof: 'Per-proof limit for {name}',
  payAContact: 'a contact',
  payNotSet: 'Not set',
  payRuleAllow: 'Automatic',
  payRuleApproval: 'Ask me',
  payRuleDeny: 'Never',
  payChangedTo: '{old} to {new}',
  payTrustCredits: 'Your credits stay yours; 4thTech never holds them.',
  payTrustAi: "Your AI can't confirm this for you.",
  payRemember: 'Remember for this contact',
  payRememberHint: 'Next time, proofs like this for {name} run without asking.',
  payConfirmMac: 'Confirm with Touch ID',
  payConfirmWindows: 'Confirm with Windows Hello',
  payConfirmOther: 'Confirm with your passkey',
  payWaitingMac: 'Waiting for Touch ID',
  payWaitingWindows: 'Waiting for Windows Hello',
  payWaitingOther: 'Waiting for your passkey',
  payCancel: 'Cancel',
  payUseBackup: 'Use backup code instead',
  payCodeLabel: 'Backup code',
  payCodeHint: 'The backup code AgentLink showed you when you set up.',
  payConfirmCode: 'Confirm',
  payClose: 'Close',
  payRecordingProof: 'Confirming…',
  payRecordingLimits: 'Saving your limits…',
  payDoneProof: 'Done. Your AI records the proof now.',
  payDoneLimits: 'Done. Your limits are saved.',
  payCancelled: 'Not confirmed. Nothing was paid.',
  payNotVerified: "Couldn't confirm it was you. Try again.",
  payExpired: 'This request expired.',
  payDecided: 'Already decided on another screen.',
  payChanged: 'Something changed since you opened this. Check it again.',
  payUpdateNeeded:
    'Your passkey needs to be set up again for paid actions. Use your backup code this time.',
  payWrongCode: "That backup code didn't match. Nothing was paid.",
  payTriesUsed: 'Too many wrong backup codes. Nothing was paid.',
  payWait: 'Too many wrong tries. Wait {seconds} seconds, then try again. Nothing was paid.',
  payBusy: 'Another confirmation is running. Try again in a moment.',
  payStillWorking: "Still working. Your AI will let you know when it's done. You can close this.",
  payRefusedProof: "Couldn't approve this. Nothing was paid.",
  payRefusedLimits: "Couldn't save your limits. Nothing changed.",
  payFailedStart: "This can't be confirmed right now. Nothing was paid.",
  payNotOffered: "Remembering isn't available for this request.",
  payCents: '{cents} cents',
  payDollars: '{dollars} dollars',
  payDollarsCents: '{dollars} dollars and {cents} cents',
});

/** Options for the page shell. */
export interface PageHtmlOptions {
  /**
   * M1-11b-2a: draw the local app's sidebar (Approvals current) so the owner can reach the other
   * pages. Only when the app is bundled: without it the other links would answer 404.
   */
  readonly appNav?: boolean;
}

/** The page shell. `csrf` is base64url (checked by the caller), so it needs no escaping. */
export function pageHtml(csrf: string, options: PageHtmlOptions = {}): string {
  const main = [
    HEADER,
    '<main id="app" class="al-page">',
    `<p class="al-lede">${UI_STRINGS.cannotApprove}</p>`,
    `<noscript>${UI_STRINGS.noScript}</noscript>`,
    '</main>',
  ];
  const body =
    options.appNav === true
      ? [
          '<div class="al-shell-main">',
          appSidebar(),
          '<div class="al-shell-content">',
          ...main,
          '</div>',
          '</div>',
        ]
      : main;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="agentlink-csrf" content="${csrf}">`,
    `<title>${UI_STRINGS.title}</title>`,
    '<link rel="stylesheet" href="/app.css">',
    '<script src="/app.js" defer></script>',
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * M1-11b-2a: the local app's sidebar (apps/local-ui `NAV_ITEMS` in the @4thtech-io/ui AppShell),
 * copied by value because this package depends on neither. Drift tests next to the originals fail
 * on any difference: apps/local-ui/src/approval-page-nav.test.ts (items) and
 * packages/ui/src/components/approval-page-icons.test.ts (icons). Fixed text and fixed same-origin
 * paths only: no token, no request data. Goes away when M1-11b-2 moves Approvals into the app.
 */
export const APP_NAV: readonly AppNavLink[] = Object.freeze([
  { label: 'Approvals', icon: 'approval', path: '/' },
  { label: 'Activity', icon: 'activity', path: '/settings/activity' },
  { label: 'Messages', icon: 'inbox', path: '/settings/messages' },
  { label: 'Contacts', icon: 'users', path: '/settings/contacts' },
  { label: 'Files', icon: 'folder', path: '/settings/files' },
  { label: 'Proofs & credits', icon: 'proof-seal', path: '/settings/proofs' },
  { label: 'Rules', icon: 'sliders-horizontal', path: '/settings/rules' },
  { label: 'Settings', icon: 'settings', path: '/settings/backup' },
]);

/** One sidebar link. */
export interface AppNavLink {
  readonly label: string;
  readonly icon: string;
  readonly path: string;
}

/** The sidebar icons (@4thtech-io/ui icon-data.ts, 24-unit stroke icons) as fixed SVG markup. */
const NAV_ICONS: Readonly<Record<string, string>> = {
  approval:
    '<path d="M6.5 5.2A8 8 0 0 1 20 11v2"/><path d="M4 11a8 8 0 0 1 .6-3"/><path d="M4 15v-2"/><path d="M8 20v-7a4 4 0 0 1 8 0v2"/><path d="M12 13v8"/><path d="M16 19v2"/>',
  activity:
    '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'proof-seal':
    '<path d="M12 2.5 21.5 12 12 21.5 2.5 12Z"/><path d="M12 8.5 15.5 12 12 15.5 8.5 12Z"/>',
  'sliders-horizontal':
    '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

function navIcon(name: string): string {
  return (
    '<svg class="al-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    `${NAV_ICONS[name] ?? ''}</svg>`
  );
}

/** Approvals is the current page on `/` and `/approve/<id>`. Labels are fixed text; `&` is escaped. */
function appSidebar(): string {
  const links = APP_NAV.map((item) => {
    const open =
      item.path === '/'
        ? `<a class="al-nav is-active" href="${item.path}" aria-current="page">`
        : `<a class="al-nav" href="${item.path}">`;
    const label = item.label.replace(/&/g, '&amp;');
    return `<li>${open}${navIcon(item.icon)}<span>${label}</span></a></li>`;
  });
  return [
    '<nav class="al-side" aria-label="Main">',
    `<div class="al-side-brand">${MARK}<span>${UI_STRINGS.title}</span></div>`,
    '<ul>',
    ...links,
    '</ul>',
    '</nav>',
  ].join('');
}

/** The AgentLink mark (@4thtech-io/ui Mark, 16 px form), inline: markup, not a loaded resource. */
const MARK =
  '<svg class="al-mark" width="24" height="24" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path class="al-mark-ink" d="M1 1.5H5V3.5H3V12.5H5V14.5H1Z M15 1.5H11V3.5H13V12.5H11V14.5H15Z"/>' +
  '<path class="al-mark-seal" d="M8 4.5L11.5 8L8 11.5L4.5 8Z"/></svg>';

/** The top bar of the D1 approvals screen: the mark, the screen title and the product name. */
const HEADER = [
  '<header class="al-top">',
  MARK,
  `<div><h1>${UI_STRINGS.appTitle}</h1><p>${UI_STRINGS.title}</p></div>`,
  '</header>',
].join('');

/** The 401 page (11 §6.2.1 "local link expired"). Fixed text; nothing from the request. */
export const EXPIRED_HTML = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<title>${UI_STRINGS.title}</title><link rel="stylesheet" href="/app.css"></head>`,
  `<body>${HEADER}<main class="al-page"><section class="al-card"><h2>${UI_STRINGS.title}</h2>`,
  `<p>This link has expired. Open AgentLink again from your AI, or run <code>${CLI_COMMAND} approve</code> in your own terminal.</p>`,
  '</section></main></body></html>',
  '',
].join('\n');

/**
 * The page script body. Static: it holds no token, no CSRF value and no request data; `S` is
 * UI_STRINGS, prepended as JSON.
 *
 * M1-8e, the localhost passkey: the page asks the authenticator only after the owner clicks
 * (11 §6.2.1), with RP ID `localhost`, user verification required, the stored credential in
 * `allowCredentials` and the PRF extension over the owner's PRF salt, and sends the credential ID,
 * the authenticator data, the user handle and the PRF output to this server only. A PRF-less
 * authenticator registers nothing and the owner code stays the way to approve.
 */
const SCRIPT = String.raw`
  var csrf = document.querySelector('meta[name="agentlink-csrf"]').getAttribute('content');
  var app = document.getElementById('app');
  var ID = /^\/approve\/(apr_[A-Za-z0-9_-]{22})$/;
  var APPROVAL_ID = /^apr_[A-Za-z0-9_-]{22}$/;
  var MAX_LIST = 20;
  var canPasskey = !!(window.PublicKeyCredential && navigator.credentials);
  var passkey = null;
  var ownerReady = true;

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, kind) {
    var b = el('button', text, 'al-btn' + (kind ? ' ' + kind : ''));
    b.type = 'button';
    return b;
  }
  var uid = 0;
  /** Fills {name} from values; the result is only ever used as textContent. */
  function fmt(template, values) {
    return template.replace(/\{([a-z]+)\}/g, function (all, name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : all;
    });
  }
  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers['X-AgentLink-CSRF'] = csrf;
    options.headers = headers;
    options.credentials = 'same-origin';
    options.cache = 'no-store';
    return fetch(path, options);
  }
  function say(target, text) {
    var p = el('p', text, 'al-status');
    p.setAttribute('role', 'status');
    target.appendChild(p);
    return p;
  }

  // Bytes helpers for the passkey body: each field prefixed by its 16-bit big-endian length.
  function fromB64(text) {
    var s = text.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytes(buffer) { return buffer ? new Uint8Array(buffer) : new Uint8Array(0); }
  function fields(list) {
    var n = 0;
    list.forEach(function (f) { n += 2 + f.length; });
    var out = new Uint8Array(n);
    var at = 0;
    list.forEach(function (f) {
      out[at] = f.length >> 8;
      out[at + 1] = f.length & 255;
      out.set(f, at + 2);
      at += 2 + f.length;
    });
    return out;
  }
  function challenge() {
    var c = new Uint8Array(32);
    window.crypto.getRandomValues(c);
    return c;
  }
  function prfOf(credential) {
    var ext = credential.getClientExtensionResults ? credential.getClientExtensionResults() : {};
    var prf = ext && ext.prf;
    var first = prf && prf.results && prf.results.first;
    return { enabled: !!(prf && (prf.enabled || first)), output: first ? new Uint8Array(first) : new Uint8Array(0) };
  }
  function prfExtension() {
    return { prf: { eval: { first: fromB64(passkey.prfSalt) } } };
  }
  /** One gesture: the assertion body for the stored credential (or credentialId). */
  function assertionBody(credentialId) {
    return navigator.credentials.get({ publicKey: {
      challenge: challenge(),
      rpId: 'localhost',
      allowCredentials: [{ type: 'public-key', id: credentialId }],
      userVerification: 'required',
      timeout: 120000,
      extensions: prfExtension()
    } }).then(function (credential) {
      var prf = prfOf(credential);
      var body = fields([bytes(credential.rawId), bytes(credential.response.authenticatorData),
        bytes(credential.response.userHandle), prf.output]);
      prf.output.fill(0);
      return body;
    });
  }
  /** Creates the passkey; resolves the assertion body, or null when it has no PRF. */
  function createBody() {
    return navigator.credentials.create({ publicKey: {
      challenge: challenge(),
      rp: { id: 'localhost', name: 'AgentLink' },
      user: { id: fromB64(passkey.userId), name: 'AgentLink owner', displayName: 'AgentLink owner' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 120000,
      extensions: prfExtension()
    } }).then(function (credential) {
      var prf = prfOf(credential);
      if (prf.output.length === 32 && credential.response.getAuthenticatorData) {
        var body = fields([bytes(credential.rawId), bytes(credential.response.getAuthenticatorData()),
          fromB64(passkey.userId), prf.output]);
        prf.output.fill(0);
        return body;
      }
      if (!prf.enabled) return null;
      // PRF is supported but only evaluated when the passkey is used: one more gesture. That
      // get() carries no credential key, so the create() authenticator data goes along as a fifth
      // field (M1-PAY-CONFIRM-b): the server keeps the key from it for paid actions (rule 5).
      var creation = credential.response.getAuthenticatorData
        ? bytes(credential.response.getAuthenticatorData()) : new Uint8Array(0);
      return assertionBody(bytes(credential.rawId)).then(function (body) {
        if (creation.length < 37) return body;
        var extra = fields([creation]);
        var out = new Uint8Array(body.length + extra.length);
        out.set(body, 0);
        out.set(extra, body.length);
        body.fill(0);
        return out;
      });
    });
  }
  function hasPasskey() { return canPasskey && passkey && passkey.registered; }

  var RESULT = {
    applied_approve: S.approved,
    applied_deny: S.denied,
    presence_required: S.presenceRequired,
    presence_rejected: S.presenceRejected,
    not_pending: S.notPending,
    changed: S.changed,
    busy: S.busy,
    refused: S.refused,
    needs_setup: S.needsSetup,
    confirm_required: S.confirmRequired
  };
  var LIST_RESULT = {
    presence_required: S.presenceRequired,
    presence_rejected: S.presenceRejected,
    not_pending: S.listNotPending,
    changed: S.listChanged,
    commitment: S.listTerms,
    paid_item_in_batch: S.listPaid,
    busy: S.busy,
    refused: S.listRefused,
    invalid: S.listRefused,
    needs_setup: S.needsSetup
  };
  var PASSKEY_RESULT = {
    registered: S.passkeyRegistered,
    presence_required: S.passkeyPresenceRequired,
    presence_rejected: S.passkeyPresenceRejected,
    passkey_exists: S.passkeyExists,
    passkey_unsupported: S.passkeyUnsupported,
    busy: S.busy,
    needs_setup: S.needsSetup,
    failed: S.passkeyFailed
  };
  function waitText(out) {
    var seconds = typeof out.retryAfter === 'number' && out.retryAfter > 0 ? Math.ceil(out.retryAfter) : 1;
    return fmt(S.wait, { seconds: seconds });
  }

  /**
   * The card's content (D1 ApprovalCard): the plain headline, the facts the owner decides on, the
   * terms, then what the AI chose in its own marked region. Every value is textContent (I-5).
   */
  function cardBody(item, box) {
    box.className = 'al-card al-approval';
    if (APPROVAL_ID.test(item.approvalId)) box.setAttribute('data-approval', item.approvalId);
    box.appendChild(el('p', S.cardTitle, 'al-approval-type'));
    var d = item.details;
    if (!d) {
      box.appendChild(el('h2', item.summary));
      return;
    }
    box.appendChild(el('h2', d.headline || d.what));
    var facts = el('dl', null, 'al-approval-rows');
    [[S.who, d.who], [S.what, d.what], [S.cost, d.cost], [S.expires, d.expires], [S.why, d.rule]].forEach(function (pair) {
      facts.appendChild(el('dt', pair[0]));
      facts.appendChild(el('dd', pair[1]));
    });
    box.appendChild(facts);
    if (d.terms && d.terms.length) {
      var terms = el('div', null, 'al-terms');
      d.terms.forEach(function (line) { terms.appendChild(el('p', line)); });
      box.appendChild(terms);
    }
    if (d.fromAi && d.fromAi.length) {
      var region = el('figure', null, 'al-untrusted');
      region.setAttribute('role', 'group');
      region.setAttribute('aria-label', S.fromAi);
      region.appendChild(el('figcaption', S.fromAi, 'al-untrusted-label'));
      var args = el('dl', null, 'al-untrusted-body');
      d.fromAi.forEach(function (f) {
        args.appendChild(el('dt', f.name));
        var value = el('dd');
        value.appendChild(el('pre', f.value));
        args.appendChild(value);
      });
      region.appendChild(args);
      box.appendChild(region);
    }
  }

  /** The footer every approval carries (11 §6.2.1 security copy). */
  function foot(box) {
    box.appendChild(el('p', S.cannotApprove, 'al-approval-foot'));
  }

  // --- One request: its own Approve or Deny, then presence ---------------------------------------

  function card(item, holder) {
    var box = el('section');
    cardBody(item, box);
    if (item.commitment) box.appendChild(el('p', S.termsAlone, 'al-note'));
    if (item.paid) {
      box.appendChild(el('p', S.paidAlone, 'al-note'));
    }
    // Results and the presence step go here, above the footer.
    var slot = el('div', null, 'al-slot');
    box.appendChild(slot);
    if (ownerReady) {
      // Deny first, Approve as the wider primary (D1); neither is a default button (11 §8).
      var actions = el('div', null, 'al-approval-actions');
      ['deny', 'approve'].forEach(function (decision) {
        var b = button(decision === 'approve' ? S.approve : S.deny,
          decision === 'approve' ? 'al-btn-primary al-btn-lg' : 'al-btn-lg');
        b.addEventListener('click', function () {
          // M1-PAY-CONFIRM-b: approving a request that costs credits is the confirmation sheet's.
          if (item.paid && decision === 'approve') {
            paySheet({ flow: 'proof', approvalId: item.approvalId }, function () {
              actions.hidden = true;
              say(slot, S.approved);
            });
            return;
          }
          confirmStep(item, decision, slot, actions);
        });
        actions.appendChild(b);
      });
      slot.appendChild(actions);
    }
    foot(box);
    holder.appendChild(box);
  }

  function sendDecision(item, decision, box, actions, body, presence, done) {
    var headers = presence
      ? { 'Content-Type': 'application/octet-stream', 'X-AgentLink-Digest': item.actionDigest, 'X-AgentLink-Presence': 'passkey' }
      : { 'Content-Type': 'application/octet-stream', 'X-AgentLink-Digest': item.actionDigest };
    return api('/api/approvals/' + item.approvalId + '/' + decision, {
      method: 'POST', headers: headers, body: body
    }).then(function (res) { return res.json(); }).then(function (out) {
      body.fill(0);
      done();
      if (out.status === 'wait') say(box, waitText(out));
      else {
        var key = out.status === 'applied' ? 'applied_' + out.decision : out.status;
        say(box, RESULT[key] || RESULT.refused);
      }
      if (out.status === 'presence_rejected' || out.status === 'presence_required' ||
          out.status === 'busy' || out.status === 'wait') {
        actions.hidden = false;
      }
    }, function () {
      body.fill(0);
      say(box, S.notRunning);
    });
  }

  /**
   * The owner code field (D1 TextField, mono): full width, any length (no maxlength), paste and
   * password managers welcome, never autocompleted or corrected, hidden until the owner shows it.
   * The value lives only in the input and is cleared on submit.
   */
  function codeForm(labelText, submitText, onSecret) {
    uid += 1;
    var id = 'owner-code-' + uid;
    var hintId = id + '-hint';
    var form = el('form', null, 'al-field al-code');
    var label = el('label', labelText, 'al-field-label');
    label.htmlFor = id;
    form.appendChild(label);
    var wrap = el('div', null, 'al-input-wrap');
    var input = el('input', null, 'al-input al-mono');
    input.id = id;
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('aria-describedby', hintId);
    wrap.appendChild(input);
    var toggle = button(S.show, 'al-btn-ghost al-btn-sm al-toggle');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('aria-controls', id);
    function reveal(on) {
      input.type = on ? 'text' : 'password';
      toggle.textContent = on ? S.hide : S.show;
      toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    toggle.addEventListener('click', function () { reveal(input.type === 'password'); });
    wrap.appendChild(toggle);
    form.appendChild(wrap);
    var hint = el('p', S.codeHint, 'al-field-hint');
    hint.id = hintId;
    form.appendChild(hint);
    var submit = el('button', submitText, 'al-btn al-btn-primary al-btn-lg al-btn-block');
    submit.type = 'submit';
    form.appendChild(submit);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submit.disabled = true;
      var secret = new TextEncoder().encode(input.value);
      input.value = '';
      reveal(false);
      Promise.resolve(onSecret(secret)).then(function () { submit.disabled = false; });
    });
    return form;
  }

  function confirmStep(item, decision, box, actions) {
    actions.hidden = true;
    var step = el('div', null, 'al-step');
    box.appendChild(step);
    function done() { step.remove(); }
    if (hasPasskey()) {
      // The passkey stays the first way; the owner code is the fallback below it.
      var use = button(decision === 'approve' ? S.approveWithPasskey : S.denyWithPasskey,
        'al-btn-primary al-btn-lg al-btn-block');
      use.addEventListener('click', function () {
        use.disabled = true;
        assertionBody(fromB64(passkey.credentialId)).then(function (body) {
          return sendDecision(item, decision, box, actions, body, true, done);
        }, function () {
          use.disabled = false;
          say(box, S.notUsed);
        });
      });
      step.appendChild(use);
      step.appendChild(el('p', S.orCode, 'al-or'));
    }
    step.appendChild(codeForm(S.codeLabel, decision === 'approve' ? S.confirmApproval : S.confirmDenial,
      function (body) { return sendDecision(item, decision, box, actions, body, false, done); }));
  }

  // --- First run: the owner key, then the localhost passkey (M1-8e) ------------------------------

  function firstRun(holder) {
    if (!ownerReady) {
      var blocked = el('section', null, 'al-card al-panel');
      blocked.appendChild(el('h2', S.needsOwnerTitle));
      blocked.appendChild(el('p', S.needsOwner));
      holder.appendChild(blocked);
      return;
    }
    if (hasPasskey()) return;
    if (canPasskey && passkey && document.querySelector('.al-side')) {
      // M1-UX-FIRSTRUN-V2-c: the app is here, so its first-run page is the one place to switch.
      // A fixed same-origin link: no token, no code, no query.
      var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.userAgent;
      var title = /mac/i.test(platform) ? S.switchMac : /win/i.test(platform) ? S.switchWindows : S.switchOther;
      var next = el('section', null, 'al-card al-panel');
      next.appendChild(el('h2', title));
      next.appendChild(el('p', S.switchBody));
      var go = el('a', title, 'al-btn al-btn-primary al-btn-lg al-btn-block');
      go.href = '/first-run';
      next.appendChild(go);
      holder.appendChild(next);
      return;
    }
    var box = el('section', null, 'al-card al-panel');
    box.appendChild(el('h2', canPasskey && passkey ? S.passkeyTitle : S.firstRunTitle));
    box.appendChild(el('p', S.firstRun));
    if (!canPasskey || !passkey) {
      box.appendChild(el('p', S.noPasskeys));
      box.appendChild(el('p', S.desktopNote, 'al-note'));
      holder.appendChild(box);
      return;
    }
    box.appendChild(el('p', S.passkeyIntro));
    box.appendChild(el('p', S.desktopNote, 'al-note'));
    var start = button(S.passkeySetUp, 'al-btn-primary al-btn-lg al-btn-block');
    box.appendChild(start);
    start.addEventListener('click', function () {
      start.hidden = true;
      var form = codeForm(S.passkeyCodeLabel, S.continue, function (code) {
        return createBody().then(function (assertion) {
          if (assertion === null) {
            code.fill(0);
            form.remove();
            say(box, S.passkeyUnsupported);
            return null;
          }
          var body = new Uint8Array(2 + code.length + assertion.length);
          body[0] = code.length >> 8;
          body[1] = code.length & 255;
          body.set(code, 2);
          body.set(assertion, 2 + code.length);
          code.fill(0);
          assertion.fill(0);
          return api('/api/owner/passkey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: body
          }).then(function (res) { return res.json(); }).then(function (out) {
            body.fill(0);
            form.remove();
            say(box, out.status === 'wait' ? waitText(out) : (PASSKEY_RESULT[out.status] || S.passkeyFailed));
            if (out.status === 'registered') { passkey.registered = true; loadPasskey(); }
            else if (out.status !== 'passkey_exists' && out.status !== 'passkey_unsupported') { start.hidden = false; }
          });
        }).catch(function () {
          code.fill(0);
          form.remove();
          start.hidden = false;
          say(box, S.notUsed);
        });
      });
      box.appendChild(form);
    });
    holder.appendChild(box);
  }

  function loadPasskey() {
    return api('/api/owner/passkey').then(function (res) {
      if (res.status === 503) { ownerReady = false; return null; }
      return res.status === 200 ? res.json() : null;
    }).then(function (out) {
      passkey = out && out.passkey && out.passkey.rpId === 'localhost' ? out.passkey : null;
    }, function () { passkey = null; });
  }

  // --- Review together (D-68, 04 §2.5.2) ---------------------------------------------------------

  function byExpiry(a, b) {
    if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
    return a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0;
  }
  function counts(choices) {
    var approve = 0;
    var deny = 0;
    choices.forEach(function (c) { if (c.decision === 'approve') approve += 1; else deny += 1; });
    return { approve: approve, deny: deny };
  }
  function totalsText(c) {
    if (c.deny === 0) return fmt(S.totalsApprove, c);
    if (c.approve === 0) return fmt(S.totalsDeny, c);
    return fmt(S.totalsBoth, c);
  }
  function doneText(c) {
    if (c.deny === 0) return fmt(S.doneApprove, c);
    if (c.approve === 0) return fmt(S.doneDeny, c);
    return fmt(S.doneBoth, c);
  }

  var notices = el('div', null, 'al-notices');
  var listHolder = el('div', null, 'al-list');

  function renderList() {
    return api('/api/approvals').then(function (res) { return res.json(); }).then(function (out) {
      listHolder.textContent = '';
      var all = (out.approvals || []).slice().sort(byExpiry);
      listHolder.appendChild(el('h2', fmt(S.waiting, { count: all.length }), 'al-section-title'));
      if (all.length === 0) { say(listHolder, S.nothingWaiting); return; }
      var shown = all.slice(0, MAX_LIST);
      var choices = {};
      var summary = button(S.nothingSelected, 'al-btn-primary al-btn-lg al-btn-block');
      summary.disabled = true;
      var radios = [];
      function update() {
        var picked = shown.filter(function (i) { return choices[i.approvalId]; })
          .map(function (i) { return { item: i, decision: choices[i.approvalId] }; });
        summary.disabled = picked.length === 0;
        summary.textContent = picked.length === 0 ? S.nothingSelected : totalsText(counts(picked));
        return picked;
      }
      shown.forEach(function (item) {
        if (item.commitment || item.paid || !ownerReady) { card(item, listHolder); return; }
        var box = el('section');
        cardBody(item, box);
        var group = el('div', null, 'al-choices');
        group.setAttribute('role', 'radiogroup');
        [['approve', S.approve], ['deny', S.deny], ['later', S.later]].forEach(function (pair) {
          var label = el('label', null, 'al-choice');
          var input = el('input');
          input.type = 'radio';
          input.name = 'choice-' + item.approvalId;
          input.value = pair[0];
          input.checked = pair[0] === 'later';
          input.addEventListener('change', function () {
            if (pair[0] === 'later') delete choices[item.approvalId];
            else choices[item.approvalId] = pair[0];
            update();
          });
          radios.push(input);
          label.appendChild(input);
          label.appendChild(el('span', pair[1]));
          group.appendChild(label);
        });
        box.appendChild(group);
        foot(box);
        listHolder.appendChild(box);
      });
      if (all.length > shown.length) say(listHolder, fmt(S.moreWaiting, { count: all.length - shown.length }));
      if (!ownerReady) return;
      var bar = el('div', null, 'al-bar');
      bar.appendChild(summary);
      listHolder.appendChild(bar);
      summary.addEventListener('click', function () {
        var picked = update();
        if (picked.length === 0) return;
        summary.hidden = true;
        radios.forEach(function (r) { r.disabled = true; });
        reviewStep(picked, bar, function () {
          summary.hidden = false;
          radios.forEach(function (r) { r.disabled = false; });
        });
      });
    }, function () { say(listHolder, S.notRunning); });
  }

  /** 04 §2.5.2 steps 4-6: check again, show exactly what is included, then presence once. */
  function reviewStep(picked, bar, reopen) {
    notices.textContent = '';
    api('/api/approvals').then(function (res) { return res.json(); }).then(function (out) {
      var live = {};
      (out.approvals || []).forEach(function (i) { live[i.approvalId] = i.actionDigest; });
      var kept = picked.filter(function (p) {
        return live[p.item.approvalId] === p.item.actionDigest && !p.item.commitment && !p.item.paid;
      });
      var dropped = picked.length - kept.length;
      if (dropped === 1) say(notices, S.droppedOne);
      else if (dropped > 1) say(notices, fmt(S.droppedMany, { count: dropped }));
      if (kept.length === 0) { say(notices, S.nothingLeft); renderList(); return; }
      var step = el('div', null, 'al-card al-panel al-step');
      var lines = el('ul', null, 'al-lines');
      kept.forEach(function (p) {
        lines.appendChild(el('li', fmt(p.decision === 'approve' ? S.lineApprove : S.lineDeny, { summary: p.item.summary })));
      });
      step.appendChild(lines);
      step.appendChild(el('p', kept.length === 1 ? S.coversOne : fmt(S.coversMany, { count: kept.length })));
      var items = kept.map(function (p) {
        return p.item.approvalId + ':' + p.item.actionDigest + ':' + (p.decision === 'approve' ? 'a' : 'd');
      }).join(',');
      function send(body, presence) {
        var headers = { 'Content-Type': 'application/octet-stream', 'X-AgentLink-Items': items };
        if (presence) headers['X-AgentLink-Presence'] = 'passkey';
        return api('/api/approvals/review', { method: 'POST', headers: headers, body: body })
          .then(function (res) { return res.json(); }).then(function (result) {
            body.fill(0);
            if (result.status === 'applied') {
              step.remove();
              say(notices, doneText(counts(kept)));
              renderList();
              return;
            }
            say(step, result.status === 'wait' ? waitText(result) : (LIST_RESULT[result.status] || S.listRefused));
            if (result.status !== 'presence_rejected' && result.status !== 'presence_required' &&
                result.status !== 'busy' && result.status !== 'wait') {
              step.remove();
              say(notices, result.status === 'wait' ? waitText(result) : (LIST_RESULT[result.status] || S.listRefused));
              renderList();
            }
          }, function () { body.fill(0); say(step, S.notRunning); });
      }
      if (hasPasskey()) {
        var use = button(S.confirmPasskey, 'al-btn-primary al-btn-lg al-btn-block');
        use.addEventListener('click', function () {
          use.disabled = true;
          assertionBody(fromB64(passkey.credentialId)).then(function (body) {
            return send(body, true);
          }, function () { say(step, S.notUsed); }).then(function () { use.disabled = false; });
        });
        step.appendChild(use);
        step.appendChild(el('p', S.orCode, 'al-or'));
      }
      step.appendChild(codeForm(S.codeLabel, S.confirm, function (body) { return send(body, false); }));
      var back = button(S.back, 'al-btn-ghost al-btn-block');
      back.addEventListener('click', function () { step.remove(); reopen(); });
      step.appendChild(back);
      bar.appendChild(step);
    }, function () { say(notices, S.notRunning); reopen(); });
  }

  // --- M1-PAY-CONFIRM-b: the confirmation sheet for a paid action (b11 §19; 04 §2.5.3) ---------
  //
  // The page names the flow only; the server builds the statement from stored data and answers
  // it with a fresh challenge (POST /api/ui/pay-confirm/begin). The sheet shows only that
  // statement. One WebAuthn get() with that challenge and user verification required, or the
  // backup code, then POST /api/ui/pay-confirm/finish. Every value is textContent (I-5).

  var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var PAY_FIELDS = {
    'proofs.notarize': 'rule', 'proofs.dailyBudgetUSD': 'usd', 'proofs.perActionMaxUSD': 'usd',
    'contactRules.proofs.notarize': 'rule', 'contactRules.proofs.perActionMaxUSD': 'usd'
  };
  var USD = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;

  function payPlatform() {
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
    return /mac/i.test(p) ? 'Mac' : /win/i.test(p) ? 'Windows' : 'Other';
  }
  function usdText(v) {
    var parts = String(v).split('.');
    var frac = parts[1] || '';
    if (frac.length === 0) return '$' + parts[0];
    while (frac.length < 2) frac += '0';
    return '$' + parts[0] + '.' + frac;
  }
  function usdSpoken(v) {
    var parts = String(v).split('.');
    var dollars = parts[0];
    var frac = ((parts[1] || '') + '00');
    var rest = frac.slice(2);
    var end = rest.length;
    while (end > 0 && rest.charAt(end - 1) === '0') end -= 1;
    rest = rest.slice(0, end);
    var cents = String(Number(frac.slice(0, 2))) + (rest ? '.' + rest : '');
    if (dollars === '0') return fmt(S.payCents, { cents: cents });
    if (cents === '0') return fmt(S.payDollars, { dollars: dollars });
    return fmt(S.payDollarsCents, { dollars: dollars, cents: cents });
  }
  /** The statement as the server returned it, checked; null when it is anything else. */
  function payStatement(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    var keys = Object.keys(v).sort().join(',');
    if (keys !== 'amountUsd,changes,counterparty,kind,purpose,v' || v.v !== 1) return null;
    if (v.kind !== 'proof' && v.kind !== 'proof_remember' && v.kind !== 'limits') return null;
    if (v.kind === 'limits' ? v.amountUsd !== null || v.purpose !== 'limits_change' : typeof v.amountUsd !== 'string' || !USD.test(v.amountUsd) || v.purpose !== 'proof') return null;
    if (v.counterparty !== null && (typeof v.counterparty !== 'string' || v.counterparty.length === 0 || v.counterparty.length > 200)) return null;
    if (!Array.isArray(v.changes) || v.changes.length > 32) return null;
    for (var i = 0; i < v.changes.length; i += 1) {
      var c = v.changes[i];
      if (!c || typeof c !== 'object' || !PAY_FIELDS[c.field]) return null;
      var kind = PAY_FIELDS[c.field];
      var okValue = function (x) {
        return x === null || (typeof x === 'string' && (kind === 'usd' ? USD.test(x) : /^(allow|approval|deny)$/.test(x)));
      };
      if (!okValue(c.old) || !okValue(c['new'])) return null;
    }
    return v;
  }
  function payValue(field, value) {
    if (value === null) return S.payNotSet;
    if (PAY_FIELDS[field] === 'usd') return usdText(value);
    return value === 'allow' ? S.payRuleAllow : value === 'approval' ? S.payRuleApproval : S.payRuleDeny;
  }
  function payChangeLabel(c, name) {
    var who = name || S.payAContact;
    if (c.field === 'proofs.notarize') return S.payChangeProofs;
    if (c.field === 'proofs.dailyBudgetUSD') return S.payChangeBudget;
    if (c.field === 'proofs.perActionMaxUSD') return S.payChangePerProof;
    if (c.field === 'contactRules.proofs.notarize') return fmt(S.payChangeContactProofs, { name: who });
    return fmt(S.payChangeContactPerProof, { name: who });
  }
  function svg(tag, attrs) {
    var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }
  /** The ring (waiting, recording) that closes into a check (done). Vector strokes only. */
  function payRing(state) {
    var ring = svg('svg', { viewBox: '0 0 48 48', width: '48', height: '48', 'aria-hidden': 'true', focusable: 'false' });
    ring.setAttribute('class', 'al-pay-ring');
    ring.setAttribute('data-state', state);
    ring.appendChild(svg('circle', { cx: '24', cy: '24', r: '20', 'class': 'al-pay-ring-track' }));
    ring.appendChild(svg('circle', { cx: '24', cy: '24', r: '20', 'class': 'al-pay-ring-arc', pathLength: '100' }));
    if (state === 'done') ring.appendChild(svg('path', { d: 'M15 24.5l6 6 12-13', 'class': 'al-pay-check', pathLength: '100' }));
    return ring;
  }

  /**
   * Opens the sheet for input ({ flow: 'proof', approvalId } here). onApplied runs once after
   * the server applied it. Focus starts on the title and returns to the opener on close.
   */
  function paySheet(input, onApplied) {
    var opener = document.activeElement;
    var platform = payPlatform();
    var st = {
      phase: 'loading', statement: null, ceremony: null, publicKey: null, stale: false,
      remember: false, offered: false, backup: false, closed: false, notice: null, error: null
    };
    uid += 1;
    var titleId = 'pay-title-' + uid;
    var amountId = 'pay-amount-' + uid;
    var forId = 'pay-for-' + uid;
    var overlay = el('div', null, 'al-pay-overlay');
    var sheet = el('div', null, 'al-pay-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', titleId);
    sheet.setAttribute('aria-describedby', amountId + ' ' + forId);
    sheet.setAttribute('data-motion', reducedMotion ? 'reduced' : 'full');
    sheet.tabIndex = -1;
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    var timer = null;
    var shownOnce = false;

    function close() {
      if (timer) { clearTimeout(timer); timer = null; }
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (opener && opener.focus && document.contains(opener)) opener.focus();
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        if (st.phase === 'recording' || st.phase === 'waiting') return;
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      var list = Array.prototype.filter.call(sheet.querySelectorAll('button, input, [href]'), function (n) {
        return !n.disabled && !n.hidden;
      });
      if (list.length === 0) return;
      var first = list[0];
      var last = list[list.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);

    function isLimits() { return st.statement && st.statement.kind === 'limits'; }
    /** The passkey can confirm only when the server offers it (its key is kept, rule 5). */
    function payPasskey() {
      return hasPasskey() && !!st.publicKey && (st.publicKey.allowCredentials || []).length > 0;
    }
    function confirmLabel() { return S['payConfirm' + platform]; }
    function waitingLabel() { return S['payWaiting' + platform]; }
    function liveText() {
      if (st.phase === 'waiting') return waitingLabel();
      if (st.phase === 'recording') return isLimits() ? S.payRecordingLimits : S.payRecordingProof;
      if (st.phase === 'done') return isLimits() ? S.payDoneLimits : S.payDoneProof;
      return st.notice || '';
    }

    function render() {
      var keepFocus = sheet.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;
      sheet.textContent = '';
      var grab = el('div', null, 'al-pay-grab');
      grab.setAttribute('aria-hidden', 'true');
      sheet.appendChild(grab);
      var v = st.statement;
      var title = el('h2', v ? (v.kind === 'limits' ? S.payTitleLimits : S.payTitleProof) : S.payTitleProof, 'al-pay-title');
      title.id = titleId;
      title.tabIndex = -1;
      sheet.appendChild(title);
      if (v && v.amountUsd !== null) {
        var amount = el('p', usdText(v.amountUsd), 'al-pay-amount');
        amount.id = amountId;
        amount.setAttribute('aria-label', usdSpoken(v.amountUsd));
        sheet.appendChild(amount);
      }
      if (v) {
        var rows = el('dl', null, 'al-pay-rows');
        if (v.kind !== 'limits') {
          rows.appendChild(el('dt', S.payRowFor));
          var forValue = el('dd', v.counterparty ? fmt(S.payForProof, { name: v.counterparty }) : S.payForSelf);
          forValue.id = forId;
          rows.appendChild(forValue);
          rows.appendChild(el('dt', S.payRowPaidFrom));
          rows.appendChild(el('dd', S.payPaidFrom));
        }
        v.changes.forEach(function (c) {
          rows.appendChild(el('dt', payChangeLabel(c, v.counterparty)));
          var dd = el('dd', null, 'al-pay-change');
          dd.setAttribute('aria-label', fmt(S.payChangedTo, { old: payValue(c.field, c.old), 'new': payValue(c.field, c['new']) }));
          dd.appendChild(el('span', payValue(c.field, c.old), 'al-pay-old'));
          var arrow = el('span', ' → ', 'al-pay-arrow');
          arrow.setAttribute('aria-hidden', 'true');
          dd.appendChild(arrow);
          dd.appendChild(el('span', payValue(c.field, c['new']), 'al-pay-new'));
          rows.appendChild(dd);
        });
        sheet.appendChild(rows);
        var trust = el('div', null, 'al-pay-trust');
        trust.appendChild(el('p', S.payTrustCredits));
        trust.appendChild(el('p', S.payTrustAi));
        sheet.appendChild(trust);
      }
      if (st.offered && !st.closed && (st.phase === 'ready' || st.phase === 'backup')) {
        var rem = el('label', null, 'al-check al-pay-remember');
        var box = el('input');
        box.type = 'checkbox';
        box.checked = st.remember;
        box.setAttribute('data-key', 'remember');
        box.addEventListener('change', function () { setRemember(box.checked); });
        rem.appendChild(box);
        var words = el('span');
        words.appendChild(el('span', S.payRemember));
        if (v && v.counterparty) words.appendChild(el('span', fmt(S.payRememberHint, { name: v.counterparty }), 'al-field-hint'));
        rem.appendChild(words);
        sheet.appendChild(rem);
      }
      var status = el('div', null, 'al-pay-status');
      if (st.phase === 'waiting' || st.phase === 'recording' || st.phase === 'done') {
        status.appendChild(payRing(st.phase));
      }
      var live = el('p', liveText(), 'al-pay-live');
      live.setAttribute('aria-live', 'polite');
      status.appendChild(live);
      if (st.error) {
        var alert = el('p', st.error, 'al-pay-alert');
        alert.setAttribute('role', 'alert');
        status.appendChild(alert);
      }
      sheet.appendChild(status);

      var actions = el('div', null, 'al-pay-actions');
      if (st.closed || (st.phase === 'done' && reducedMotion)) {
        var closeB = button(S.payClose, 'al-btn-primary al-btn-lg al-btn-block');
        closeB.setAttribute('data-key', 'close');
        closeB.addEventListener('click', close);
        actions.appendChild(closeB);
      } else if (st.phase === 'ready' && v && payPasskey() && !st.backup) {
        var go = button(confirmLabel(), 'al-btn-primary al-btn-lg al-btn-block');
        go.setAttribute('data-key', 'confirm');
        go.addEventListener('click', usePasskey);
        actions.appendChild(go);
      } else if (st.phase === 'backup' || (st.phase === 'ready' && v && !payPasskey())) {
        st.phase = 'backup';
        var form = codeForm(S.payCodeLabel, S.payConfirmCode, function (code) { return useCode(code); });
        actions.appendChild(form);
      }
      if (!st.closed && st.phase !== 'done' && st.phase !== 'recording') {
        var cancel = button(S.payCancel, 'al-btn-ghost al-btn-block');
        cancel.setAttribute('data-key', 'cancel');
        cancel.addEventListener('click', close);
        actions.appendChild(cancel);
      }
      if (!st.closed && st.phase === 'ready' && v && payPasskey()) {
        var link = button(S.payUseBackup, 'al-btn-ghost al-btn-sm al-pay-link');
        link.setAttribute('data-key', 'backup');
        link.addEventListener('click', function () { st.backup = true; st.phase = 'backup'; st.error = null; render(); });
        actions.appendChild(link);
      }
      sheet.appendChild(actions);
      var again = keepFocus ? sheet.querySelector('[data-key="' + keepFocus + '"]') : null;
      if (!shownOnce && v) { shownOnce = true; title.focus(); }
      else if (again) again.focus();
      else if (!sheet.contains(document.activeElement)) title.focus();
    }

    function stop(text, isError) {
      st.closed = true;
      st.phase = 'ready';
      if (isError) st.error = text; else st.notice = text;
      render();
    }

    /** Begin: the server's statement and challenge. Resolves true when ready. */
    function begin() {
      var flow = { flow: input.flow, approvalId: input.approvalId };
      if (st.remember) flow.remember = true;
      return api('/api/ui/pay-confirm/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-AgentLink-Input': b64json(flow) }
      }).then(function (res) { return res.json(); }).then(function (out) {
        if (out.status === 'not_offered' && st.remember) {
          st.remember = false;
          st.offered = false;
          st.notice = S.payNotOffered;
          return begin();
        }
        var statement = out.status === 'ready' ? payStatement(out.statement) : null;
        if (!statement || typeof out.ceremony !== 'string' || !out.publicKey) {
          if (out.status === 'not_pending') stop(S.payDecided, false);
          else if (out.status === 'busy') { st.error = S.payBusy; st.phase = 'ready'; render(); }
          else stop(S.payFailedStart, false);
          return false;
        }
        var before = st.statement ? JSON.stringify(st.statement) : null;
        st.statement = statement;
        st.ceremony = out.ceremony;
        st.publicKey = out.publicKey;
        st.stale = false;
        st.offered = out.rememberOffered === true;
        if (st.phase === 'loading') st.phase = 'ready';
        if (before !== null && before !== JSON.stringify(statement)) {
          st.phase = st.backup ? 'backup' : 'ready';
          st.notice = S.payChanged;
          render();
          return false;
        }
        render();
        return true;
      }, function () { stop(S.payFailedStart, false); return false; });
    }
    function setRemember(on) {
      st.remember = on;
      st.notice = null;
      st.error = null;
      begin();
    }
    function fresh() { return st.stale ? begin() : Promise.resolve(true); }

    function finish(body, presence) {
      var headers = { 'Content-Type': 'application/octet-stream', 'X-AgentLink-Input': b64json({ ceremony: st.ceremony }) };
      if (presence) headers['X-AgentLink-Presence'] = 'passkey';
      var shown = setTimeout(function () { st.phase = 'recording'; render(); }, 400);
      return api('/api/ui/pay-confirm/finish', { method: 'POST', headers: headers, body: body })
        .then(function (res) { return res.json().then(function (out) { return { http: res.status, out: out }; }); })
        .then(function (r) {
          clearTimeout(shown);
          body.fill(0);
          outcome(r.out.status, r.out, presence);
        }, function () {
          clearTimeout(shown);
          body.fill(0);
          stop(S.payStillWorking, false);
        });
    }
    function outcome(status, out, presence) {
      st.notice = null;
      st.error = null;
      if (presence || status !== 'presence_rejected') st.stale = true;
      if (status === 'applied') {
        st.phase = 'done';
        render();
        onApplied();
        if (!reducedMotion) timer = setTimeout(close, 1200);
        return;
      }
      st.phase = st.backup ? 'backup' : 'ready';
      if (status === 'presence_rejected' && !presence) { st.stale = false; st.error = S.payWrongCode; }
      else if (status === 'verification_required' || status === 'presence_rejected' || status === 'presence_required') st.error = S.payNotVerified;
      else if (status === 'passkey_update_needed') { st.backup = true; st.phase = 'backup'; st.notice = S.payUpdateNeeded; }
      else if (status === 'tries_exhausted') return stop(S.payTriesUsed, false);
      else if (status === 'expired' || status === 'unknown') return stop(S.payExpired, false);
      else if (status === 'not_pending') return stop(S.payDecided, false);
      else if (status === 'changed') { st.notice = S.payChanged; begin(); return; }
      else if (status === 'wait') {
        var seconds = typeof out.retryAfter === 'number' && out.retryAfter > 0 ? Math.ceil(out.retryAfter) : 1;
        st.error = fmt(S.payWait, { seconds: seconds });
      } else if (status === 'busy') st.error = S.payBusy;
      else if (status === 'refused') return stop(isLimits() ? S.payRefusedLimits : S.payRefusedProof, true);
      else return stop(S.payStillWorking, false);
      render();
    }

    function usePasskey() {
      st.notice = null;
      st.error = null;
      fresh().then(function (ok) {
        if (!ok) return;
        var pk = st.publicKey;
        st.phase = 'waiting';
        render();
        var prf = new Uint8Array(0);
        navigator.credentials.get({ publicKey: {
          challenge: fromB64(pk.challenge),
          rpId: pk.rpId,
          allowCredentials: (pk.allowCredentials || []).map(function (id) { return { type: 'public-key', id: fromB64(id) }; }),
          userVerification: 'required',
          timeout: pk.timeoutMs,
          extensions: { prf: { eval: { first: fromB64(pk.prfSalt) } } }
        } }).then(function (credential) {
          prf = prfOf(credential).output;
          var r = credential.response;
          var body = fields([bytes(credential.rawId), bytes(r.authenticatorData), bytes(r.clientDataJSON),
            bytes(r.signature), bytes(r.userHandle), prf]);
          prf.fill(0);
          return finish(body, true);
        }, function () {
          // The person dismissed the system prompt: nothing was sent, the challenge still holds.
          st.phase = 'ready';
          st.notice = S.payCancelled;
          render();
        });
      });
    }
    function useCode(code) {
      return fresh().then(function (ok) {
        if (!ok) { code.fill(0); return null; }
        return finish(code, false);
      });
    }

    render();
    begin();
  }
  function b64json(value) {
    var utf8 = new TextEncoder().encode(JSON.stringify(value));
    var bin = '';
    for (var i = 0; i < utf8.length; i += 1) bin += String.fromCharCode(utf8[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // --- Start -------------------------------------------------------------------------------------

  var match = ID.exec(location.pathname);
  var holder = el('div', null, 'al-stack');
  app.appendChild(holder);
  loadPasskey().then(function () {
    if (match) {
      if (!ownerReady) firstRun(holder);
      api('/api/approvals/' + match[1]).then(function (res) {
        if (res.status === 404) { say(holder, S.notPending); return null; }
        return res.json();
      }).then(function (out) { if (out) card(out.approval, holder); });
    } else {
      firstRun(holder);
      holder.appendChild(notices);
      holder.appendChild(listHolder);
      renderList();
    }
  });
`;

/** The page script served at `/app.js`: the strings as JSON, then the static script. */
export const APP_JS = `'use strict';\n(function () {\n  var S = ${JSON.stringify(UI_STRINGS)};\n${SCRIPT}})();\n`;

/**
 * The page stylesheet served at `/app.css` (M1-11a-ux; D-116). The colours are the
 * @4thtech-io/ui design tokens (tokens.css, dark first, light under prefers-color-scheme), copied
 * by value because this package does not depend on that one; the drift test in @4thtech-io/ui
 * (approval-page-tokens.test.ts) fails on any difference. Sizes and spacing follow the same tokens and components.css (`.al-approval`,
 * `.al-field`, `.al-btn`, `.al-untrusted`). No url(), no @import, no web font.
 */
export const APP_CSS = `:root {
  --al-color-bg-overlay: rgba(5, 6, 8, 0.72);
  --al-color-diff-removed-fg: #ff8e8e;
  --al-color-diff-added-fg: #4fd1a5;
  --al-color-status-success-fg: #4fd1a5;
  --al-shadow-4: 0 24px 64px rgba(0, 0, 0, 0.6);
  --al-color-bg-canvas: #0b0c0e;
  --al-color-bg-surface: #111316;
  --al-color-bg-raised: #171a1e;
  --al-color-bg-sunken: #08090b;
  --al-color-fg-default: #e7e9ec;
  --al-color-fg-muted: #a1a9b4;
  --al-color-fg-subtle: #8a929d;
  --al-color-fg-on-accent: #0b0c0e;
  --al-color-border-subtle: #1e2227;
  --al-color-border-default: #2a2f36;
  --al-color-border-strong: #68717c;
  --al-color-focus-ring: #ff8a4c;
  --al-color-accent-default: #ff6a1a;
  --al-color-accent-hover: #ff8240;
  --al-color-accent-pressed: #e5590c;
  --al-color-accent-fg: #ff8a4c;
  --al-color-accent-subtle: #2b170b;
  --al-color-status-danger-fg: #ff7b7b;
  --al-color-untrusted-bg: #0d0e10;
  --al-color-untrusted-fg: #c9ced6;
  --al-color-untrusted-border: #7a6740;
  --al-color-untrusted-label-bg: #241e12;
  --al-color-untrusted-label-fg: #d9b66a;
  --al-color-brand-mark: #e7e9ec;
  --al-color-brand-seal: #ff6a1a;
  --al-shadow-2: 0 4px 12px rgba(0, 0, 0, 0.45);
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root {
    --al-color-bg-overlay: rgba(14, 16, 19, 0.48);
    --al-color-diff-removed-fg: #b3191f;
    --al-color-diff-added-fg: #0a6e51;
    --al-color-status-success-fg: #0a6e51;
    --al-shadow-4: 0 24px 64px rgba(14, 16, 19, 0.16);
    --al-color-bg-canvas: #f5f6f7;
    --al-color-bg-surface: #ffffff;
    --al-color-bg-raised: #ffffff;
    --al-color-bg-sunken: #eceef0;
    --al-color-fg-default: #0e1013;
    --al-color-fg-muted: #4f5761;
    --al-color-fg-subtle: #626b76;
    --al-color-fg-on-accent: #0b0c0e;
    --al-color-border-subtle: #e4e7ea;
    --al-color-border-default: #d3d7dc;
    --al-color-border-strong: #848d98;
    --al-color-focus-ring: #c2410c;
    --al-color-accent-default: #ea5a10;
    --al-color-accent-hover: #ff6a1a;
    --al-color-accent-pressed: #d94f06;
    --al-color-accent-fg: #b23a09;
    --al-color-accent-subtle: #ffede2;
    --al-color-status-danger-fg: #b3191f;
    --al-color-untrusted-bg: #f6f4ef;
    --al-color-untrusted-fg: #2a2d31;
    --al-color-untrusted-border: #9c8456;
    --al-color-untrusted-label-bg: #ede4cf;
    --al-color-untrusted-label-fg: #5e4a1b;
    --al-color-brand-mark: #0e1013;
    --al-color-brand-seal: #ff6a1a;
    --al-shadow-2: 0 4px 12px rgba(14, 16, 19, 0.08);
    color-scheme: light;
  }
}
html {
  --al-font-family-sans: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Noto Sans', sans-serif;
  --al-font-family-mono: 'Geist Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  -webkit-text-size-adjust: 100%;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--al-color-bg-canvas);
  color: var(--al-color-fg-default);
  font-family: var(--al-font-family-sans);
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
h1, h2, h3, p, dl, dd, ul, figure { margin: 0; }
code, pre, .al-mono { font-family: var(--al-font-family-mono); }
:focus-visible { outline: 2px solid var(--al-color-focus-ring); outline-offset: 2px; }
[hidden] { display: none !important; }

/* Top bar (D1 approvals screen) */
.al-top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--al-color-bg-surface);
  border-bottom: 1px solid var(--al-color-border-subtle);
}
.al-top h1 { font-size: 16px; line-height: 24px; font-weight: 600; letter-spacing: -0.01em; }
.al-top p { font-size: 12px; line-height: 16px; color: var(--al-color-fg-muted); }
.al-mark { flex: none; }
.al-mark-ink { fill: var(--al-color-brand-mark); }
.al-mark-seal { fill: var(--al-color-brand-seal); }

/* App navigation (M1-11b-2a; components.css .al-shell-main, .al-side, .al-nav: the AppShell sidebar) */
.al-shell-main { display: flex; min-height: 100vh; }
.al-shell-content { flex: 1; min-width: 0; }
.al-side {
  width: 232px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 8px;
  background: var(--al-color-bg-surface);
  border-right: 1px solid var(--al-color-border-default);
}
.al-side-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px 4px;
  font-weight: 600;
}
.al-side ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.al-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 4px;
  border-radius: 4px;
  color: var(--al-color-fg-muted);
  text-decoration: none;
  position: relative;
}
.al-nav:hover {
  background: var(--al-color-bg-raised);
  color: var(--al-color-fg-default);
}
.al-nav.is-active {
  background: var(--al-color-accent-subtle);
  color: var(--al-color-accent-fg);
}
.al-nav.is-active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--al-color-accent-default);
}
.al-nav span { flex: 1; }
.al-icon { flex: none; }
@media (max-width: 600px) {
  .al-side {
    display: none;
  }
}
@media (forced-colors: active) {
  .al-nav.is-active { border: 1px solid CanvasText; forced-color-adjust: auto; }
}

/* Page */
.al-page {
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  padding: 16px 16px 48px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.al-lede, .al-note, .al-or {
  color: var(--al-color-fg-muted);
  font-size: 13px;
  line-height: 18px;
}
.al-stack, .al-list, .al-notices, .al-slot, .al-step, .al-bar {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.al-section-title {
  font-family: var(--al-font-family-mono);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--al-color-fg-muted);
}
.al-status {
  padding: 8px 12px;
  border-radius: 4px;
  background: var(--al-color-bg-sunken);
  border: 1px solid var(--al-color-border-default);
}

/* Card (components.css .al-card, .al-approval) */
.al-card {
  width: 100%;
  background: var(--al-color-bg-raised);
  border: 1px solid var(--al-color-border-default);
  border-radius: 6px;
  box-shadow: var(--al-shadow-2);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.al-card h2 {
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: -0.015em;
}
.al-approval-type {
  font-family: var(--al-font-family-mono);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--al-color-accent-fg);
}
.al-approval-rows {
  display: grid;
  grid-template-columns: minmax(72px, 112px) minmax(0, 1fr);
  gap: 4px 12px;
}
.al-approval-rows dt {
  font-family: var(--al-font-family-mono);
  font-size: 11px;
  line-height: 20px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--al-color-fg-muted);
}
.al-terms { display: flex; flex-direction: column; gap: 4px; }
.al-approval-actions {
  display: grid;
  grid-template-columns: 1fr 1.6fr;
  gap: 8px;
}
.al-approval-foot {
  padding-top: 12px;
  border-top: 1px solid var(--al-color-border-subtle);
  color: var(--al-color-fg-muted);
  font-size: 12px;
  line-height: 16px;
}

/* Untrusted region (components.css .al-untrusted): what the AI chose */
.al-untrusted {
  border: 2px dashed var(--al-color-untrusted-border);
  border-radius: 4px;
  background: var(--al-color-untrusted-bg);
  overflow: hidden;
}
.al-untrusted-label {
  padding: 2px 12px;
  background: var(--al-color-untrusted-label-bg);
  color: var(--al-color-untrusted-label-fg);
  border-bottom: 1px dashed var(--al-color-untrusted-border);
  font-size: 13px;
  line-height: 18px;
}
.al-untrusted-body {
  padding: 12px;
  color: var(--al-color-untrusted-fg);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.al-untrusted-body dt {
  font-family: var(--al-font-family-mono);
  font-size: 11px;
  line-height: 16px;
  color: var(--al-color-fg-muted);
}
.al-untrusted-body pre {
  margin: 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 20px;
}

/* Buttons (components.css .al-btn) */
.al-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  font-family: var(--al-font-family-sans);
  font-weight: 500;
  font-size: 13px;
  line-height: 16px;
  height: 32px;
  padding: 0 12px;
  border-radius: 4px;
  border: 1px solid var(--al-color-border-strong);
  background: var(--al-color-bg-raised);
  color: var(--al-color-fg-default);
  cursor: pointer;
}
.al-btn:hover { background: var(--al-color-bg-sunken); }
.al-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.al-btn-sm { height: 28px; padding: 0 8px; font-size: 12px; }
.al-btn-lg { height: 44px; padding: 0 16px; font-size: 14px; }
.al-btn-block { width: 100%; }
.al-btn-primary {
  background: var(--al-color-accent-default);
  border-color: var(--al-color-accent-default);
  color: var(--al-color-fg-on-accent);
}
.al-btn-primary:hover {
  background: var(--al-color-accent-hover);
  border-color: var(--al-color-accent-hover);
}
.al-btn-primary:active { background: var(--al-color-accent-pressed); }
.al-btn-ghost { background: transparent; border-color: transparent; }

/* Owner code field (components.css .al-field; TextField, mono) */
.al-field { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.al-field-label { color: var(--al-color-fg-muted); font-weight: 500; }
.al-input-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-height: 44px;
  padding-right: 4px;
  border: 1px solid var(--al-color-border-strong);
  border-radius: 4px;
  background: var(--al-color-bg-sunken);
}
.al-input-wrap:focus-within {
  outline: 2px solid var(--al-color-focus-ring);
  outline-offset: 2px;
}
.al-input {
  flex: 1;
  min-width: 0;
  height: 42px;
  border: 0;
  background: transparent;
  color: var(--al-color-fg-default);
  padding: 0 12px;
  font-size: 16px;
  letter-spacing: 0.02em;
  outline: none;
}
.al-toggle { flex: none; }
.al-field-hint { color: var(--al-color-fg-muted); font-size: 12px; line-height: 16px; }
.al-code .al-btn-block { margin-top: 8px; }

/* Review together: Approve, Deny or Later per card (components.css .al-seg) */
.al-choices {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  border: 1px solid var(--al-color-border-strong);
  border-radius: 4px;
  overflow: hidden;
  background: var(--al-color-bg-sunken);
}
.al-choice {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  cursor: pointer;
  font-weight: 500;
  border-left: 1px solid var(--al-color-border-default);
}
.al-choice:first-child { border-left: 0; }
.al-choice input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.al-choice:has(input:checked) {
  background: var(--al-color-bg-raised);
  color: var(--al-color-fg-default);
  box-shadow: inset 0 -2px 0 var(--al-color-accent-default);
}
.al-choice:has(input:focus-visible) {
  outline: 2px solid var(--al-color-focus-ring);
  outline-offset: -2px;
}
.al-lines { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }

/* M1-PAY-CONFIRM-b: the confirmation sheet (b11 §13.1 level 4, §14 motion, §19). The same classes
   as @4thtech-io/ui components.css. Only transform, opacity and stroke-dashoffset animate. */
html {
  --al-pay-duration-fast: 120ms;
  --al-pay-duration-base: 200ms;
  --al-pay-duration-slow: 320ms;
  --al-pay-duration-moment: 480ms;
  --al-pay-duration-ambient: 2000ms;
  --al-pay-duration-ambient-sweep: 1400ms;
  --al-pay-easing-emphasized: cubic-bezier(0.05, 0.7, 0.1, 1);
}
.al-pay-overlay {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--al-color-bg-overlay);
  animation: al-pay-fade var(--al-pay-duration-base) ease-out both;
}
@supports (backdrop-filter: blur(1px)) {
  .al-pay-overlay { backdrop-filter: blur(8px); }
}
.al-pay-sheet {
  position: relative;
  width: 100%;
  max-width: 400px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 24px;
  border: 1px solid var(--al-color-border-subtle);
  border-radius: 16px;
  background: var(--al-color-bg-raised);
  box-shadow: var(--al-shadow-4);
  animation: al-pay-rise var(--al-pay-duration-slow) var(--al-pay-easing-emphasized) both;
}
.al-pay-sheet:focus { outline: none; }
.al-pay-grab { display: none; }
.al-pay-title { margin: 0 0 8px; font-size: 17px; line-height: 24px; font-weight: 600; }
.al-pay-title:focus-visible { outline: 2px solid var(--al-color-focus-ring); outline-offset: 2px; }
.al-pay-amount {
  margin: 0 0 16px;
  font-size: 40px;
  line-height: 44px;
  font-weight: 600;
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
}
.al-pay-rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 18px;
}
.al-pay-rows dt { color: var(--al-color-fg-muted); }
.al-pay-rows dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.al-pay-old { color: var(--al-color-diff-removed-fg); text-decoration: line-through; }
.al-pay-new { color: var(--al-color-diff-added-fg); font-weight: 600; }
.al-pay-arrow { color: var(--al-color-fg-subtle); }
.al-pay-trust { margin: 0 0 16px; color: var(--al-color-fg-muted); font-size: 13px; line-height: 18px; }
.al-pay-trust p { margin: 0 0 4px; }
.al-pay-remember { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 16px; }
.al-pay-remember .al-field-hint { display: block; }
.al-pay-status { display: flex; flex-direction: column; align-items: center; gap: 8px; margin: 0 0 12px; min-height: 20px; }
.al-pay-live { margin: 0; text-align: center; }
.al-pay-alert {
  margin: 0;
  padding: 8px 12px;
  border-left: 2px solid var(--al-color-status-danger-fg);
  color: var(--al-color-status-danger-fg);
  align-self: stretch;
}
.al-pay-actions { display: flex; flex-direction: column; gap: 8px; }
.al-pay-actions .al-btn { min-height: 44px; }
.al-pay-link { align-self: center; min-height: 44px; font-size: 13px; color: var(--al-color-fg-muted); }
.al-pay-ring { width: 48px; height: 48px; overflow: visible; }
.al-pay-ring circle, .al-pay-ring path { fill: none; stroke-width: 2.5; stroke-linecap: round; }
.al-pay-ring-track { stroke: var(--al-color-border-default); }
.al-pay-ring-arc { stroke: var(--al-color-accent-default); stroke-dasharray: 100; stroke-dashoffset: 75; transform-origin: 24px 24px; }
.al-pay-ring[data-state='waiting'] .al-pay-ring-arc { stroke-dashoffset: 100; }
.al-pay-ring[data-state='waiting'] { animation: al-pay-breathe var(--al-pay-duration-ambient) ease-in-out infinite; }
.al-pay-ring[data-state='recording'] .al-pay-ring-arc { animation: al-pay-sweep var(--al-pay-duration-ambient-sweep) linear infinite; }
.al-pay-ring[data-state='done'] .al-pay-ring-arc {
  stroke: var(--al-color-status-success-fg);
  stroke-dashoffset: 0;
  animation: al-pay-close var(--al-pay-duration-moment) var(--al-pay-duration-moment) both;
  animation-timing-function: var(--al-pay-easing-emphasized);
}
.al-pay-check {
  stroke: var(--al-color-status-success-fg);
  stroke-dasharray: 100;
  stroke-dashoffset: 0;
  animation: al-pay-draw var(--al-pay-duration-moment) var(--al-pay-easing-emphasized) both;
}
@keyframes al-pay-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes al-pay-rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes al-pay-breathe { 0%, 100% { opacity: 0.45; transform: scale(0.96); } 50% { opacity: 1; transform: scale(1); } }
@keyframes al-pay-sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes al-pay-close { from { stroke-dashoffset: 75; } to { stroke-dashoffset: 0; } }
@keyframes al-pay-draw { from { stroke-dashoffset: 100; } to { stroke-dashoffset: 0; } }
@media (max-width: 599px) {
  .al-pay-overlay { align-items: flex-end; padding: 0; }
  .al-pay-sheet { max-width: none; border-radius: 16px 16px 0 0; max-height: 100vh; }
  .al-pay-grab { display: block; width: 36px; height: 4px; margin: -12px auto 12px; border-radius: 2px; background: var(--al-color-border-default); }
}
.al-pay-sheet[data-motion='reduced'],
.al-pay-sheet[data-motion='reduced'] *,
.al-pay-overlay:has(.al-pay-sheet[data-motion='reduced']) {
  animation: none !important;
  transition: none !important;
}
@media (prefers-reduced-motion: reduce) {
  .al-pay-overlay, .al-pay-sheet, .al-pay-sheet * { animation: none !important; transition: none !important; }
  .al-pay-ring[data-state='recording'] .al-pay-ring-arc { stroke-dashoffset: 50; }
  .al-pay-ring[data-state='waiting'] .al-pay-ring-arc { stroke-dashoffset: 100; }
}
@media (prefers-reduced-transparency: reduce) {
  .al-pay-overlay { backdrop-filter: none; }
}
@media (forced-colors: active) {
  .al-pay-sheet { border: 1px solid CanvasText; }
  .al-pay-ring circle, .al-pay-ring path { stroke: CanvasText; }
}
`;
