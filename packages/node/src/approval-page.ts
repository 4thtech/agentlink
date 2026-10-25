// M1-8d, M1-11a: the pages of the local approval UI (08 §1; 11 §6.2.1; 02 J4; 04 §2.5, §2.5.2;
// D-68). The text lives in UI_STRINGS, one place, so M1-11b can map it to the D1 copy keys.
//
// M1-UX-APPROVAL-PAGE (owner test 2026-10-25; interim until M1-11b-2 moves approvals to
// apps/local-ui): the page is styled from the D1 approval card (docs/design/d1/screens/mobile/
// approval-card--pending--{light,dark}--360, d1/components/ApprovalCard.md, TextField.md) with the
// packages/ui tokens (D-116; nothing invented: a test compares every colour with tokens.css). The
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
// - "Remember for this contact" is not offered yet (it needs the per-contact rules of G-32); it is
//   never part of the list's single confirmation (04 §2.5.2).

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
});

/** The page shell. `csrf` is base64url (checked by the caller), so it needs no escaping. */
export function pageHtml(csrf: string): string {
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
    HEADER,
    '<main id="app" class="al-page">',
    `<p class="al-lede">${UI_STRINGS.cannotApprove}</p>`,
    `<noscript>${UI_STRINGS.noScript}</noscript>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The AgentLink mark (packages/ui brand.tsx, 16 px form), inline: markup, not a loaded resource. */
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
      // PRF is supported but only evaluated when the passkey is used: one more gesture.
      return assertionBody(bytes(credential.rawId));
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
    needs_setup: S.needsSetup
  };
  var LIST_RESULT = {
    presence_required: S.presenceRequired,
    presence_rejected: S.presenceRejected,
    not_pending: S.listNotPending,
    changed: S.listChanged,
    commitment: S.listTerms,
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
    // Results and the presence step go here, above the footer.
    var slot = el('div', null, 'al-slot');
    box.appendChild(slot);
    if (ownerReady) {
      // Deny first, Approve as the wider primary (D1); neither is a default button (11 §8).
      var actions = el('div', null, 'al-approval-actions');
      ['deny', 'approve'].forEach(function (decision) {
        var b = button(decision === 'approve' ? S.approve : S.deny,
          decision === 'approve' ? 'al-btn-primary al-btn-lg' : 'al-btn-lg');
        b.addEventListener('click', function () { confirmStep(item, decision, slot, actions); });
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
        if (item.commitment || !ownerReady) { card(item, listHolder); return; }
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
        return live[p.item.approvalId] === p.item.actionDigest && !p.item.commitment;
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
 * The page stylesheet served at `/app.css` (M1-UX-APPROVAL-PAGE; D-116). The colours are the
 * packages/ui design tokens (tokens.css, dark first, light under prefers-color-scheme), copied by
 * value because this package does not depend on packages/ui; approval-page.test.ts fails on any
 * difference. Sizes and spacing follow the same tokens and components.css (`.al-approval`,
 * `.al-field`, `.al-btn`, `.al-untrusted`). No url(), no @import, no web font.
 */
export const APP_CSS = `:root {
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
`;
