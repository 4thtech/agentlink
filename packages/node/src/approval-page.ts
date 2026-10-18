// M1-8d: the functional, unstyled page of the local approval server (08 §1; 11 §6.2.1). The design
// lands with M1-11a/M1-11b (DESIGN-D1); until then this is the minimum that lets the owner see a
// request and decide it with owner presence. No visual design is invented here (AGENTS.md).
//
// The HTML carries no request data: the script fetches it from the API and renders it with
// textContent only, so stored text can never become markup. The CSP allows only this script.
// The owner code field appears only after the owner clicks Approve or Deny, never on page load
// (11 §6.2.1 security copy).

/** The page shell. `csrf` is base64url (checked by the caller), so it needs no escaping. */
export function pageHtml(csrf: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="agentlink-csrf" content="${csrf}">`,
    '<title>AgentLink</title>',
    '<script src="/app.js" defer></script>',
    '</head>',
    '<body>',
    '<main id="app">',
    '<h1>AgentLink</h1>',
    "<p>Your AI can't approve this for you.</p>",
    '<noscript>This page needs JavaScript to show your approvals.</noscript>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The 401 page (11 §6.2.1 "local link expired"). Fixed text; nothing from the request. */
export const EXPIRED_HTML = [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>AgentLink</title></head>',
  '<body><main><h1>AgentLink</h1>',
  '<p>This link has expired. Open AgentLink again from your AI, or run <code>agentlink ui</code>.</p>',
  '</main></body></html>',
  '',
].join('\n');

/**
 * The page script. Static: it holds no token, no CSRF value and no request data.
 *
 * M1-8e, the localhost passkey: the page asks the authenticator only after the owner clicks
 * (11 §6.2.1), with RP ID `localhost`, user verification required, the stored credential in
 * `allowCredentials` and the PRF extension over the owner's PRF salt, and sends the credential ID,
 * the authenticator data, the user handle and the PRF output to this server only. A PRF-less
 * authenticator registers nothing and the owner code stays the way to approve.
 */
export const APP_JS = String.raw`'use strict';
(function () {
  var csrf = document.querySelector('meta[name="agentlink-csrf"]').getAttribute('content');
  var app = document.getElementById('app');
  var ID = /^\/approve\/(apr_[A-Za-z0-9_-]{22})$/;
  var canPasskey = !!(window.PublicKeyCredential && navigator.credentials);
  var passkey = null;

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
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
    var p = el('p', text);
    p.setAttribute('role', 'status');
    target.appendChild(p);
  }

  // Bytes helpers for the passkey body: u16be-length-prefixed fields.
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

  var RESULT = {
    applied_approve: 'Approved.',
    applied_deny: 'Denied.',
    presence_required: 'Enter your owner code or owner passphrase. Nothing was changed.',
    presence_rejected: "That didn't match your passkey, owner code or owner passphrase. Nothing was changed.",
    not_pending: 'This request is no longer waiting for you.',
    changed: 'This request changed. Reload the page and check it again.',
    busy: 'Another approval is being confirmed. Try again in a moment.',
    refused: 'This decision was not applied. Nothing was changed.',
    needs_setup: 'Set up your owner key first: run agentlink owner init in your own terminal.'
  };
  var PASSKEY_RESULT = {
    registered: 'Passkey set up. Next time, approve with your passkey.',
    presence_required: 'Enter your owner code. Nothing was changed.',
    presence_rejected: "That didn't match your owner code, or the passkey wasn't accepted. Nothing was changed.",
    passkey_exists: 'A passkey is already set up for approvals on this computer.',
    passkey_unsupported: "This passkey can't protect approvals here. Keep using your owner code.",
    busy: 'Another approval is being confirmed. Try again in a moment.',
    needs_setup: RESULT.needs_setup,
    failed: 'The passkey was not set up. Nothing was changed.'
  };
  var NOT_RUNNING = 'AgentLink is not running. Open it again from your AI, or run agentlink ui.';
  var NOT_USED = "The passkey wasn't used. Nothing was changed. You can enter your owner code instead.";

  function card(item, holder) {
    var box = el('section');
    box.appendChild(el('h2', 'Approval needed'));
    box.appendChild(el('p', item.summary));
    box.appendChild(el('p', "Your AI can't approve this for you."));
    var actions = el('div');
    ['approve', 'deny'].forEach(function (decision) {
      var button = el('button', decision === 'approve' ? 'Approve' : 'Deny');
      button.type = 'button';
      button.addEventListener('click', function () { confirmStep(item, decision, box, actions); });
      actions.appendChild(button);
    });
    box.appendChild(actions);
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
      var key = out.status === 'applied' ? 'applied_' + out.decision : out.status;
      say(box, RESULT[key] || RESULT.refused);
      if (out.status === 'presence_rejected' || out.status === 'presence_required' || out.status === 'busy') {
        actions.hidden = false;
      }
    }, function () {
      body.fill(0);
      say(box, NOT_RUNNING);
    });
  }

  function confirmStep(item, decision, box, actions) {
    actions.hidden = true;
    var step = el('div');
    box.appendChild(step);
    function done() { step.remove(); }
    if (canPasskey && passkey && passkey.registered) {
      var use = el('button', decision === 'approve' ? 'Approve with your passkey' : 'Deny with your passkey');
      use.type = 'button';
      use.addEventListener('click', function () {
        use.disabled = true;
        assertionBody(fromB64(passkey.credentialId)).then(function (body) {
          return sendDecision(item, decision, box, actions, body, true, done);
        }, function () {
          use.disabled = false;
          say(box, NOT_USED);
        });
      });
      step.appendChild(use);
      step.appendChild(el('p', 'Or use your owner code:'));
    }
    var form = el('form');
    var label = el('label', 'Owner code or owner passphrase ');
    var input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    label.appendChild(input);
    form.appendChild(label);
    var submit = el('button', decision === 'approve' ? 'Confirm approval' : 'Confirm denial');
    submit.type = 'submit';
    form.appendChild(submit);
    step.appendChild(form);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submit.disabled = true;
      var body = new TextEncoder().encode(input.value);
      input.value = '';
      sendDecision(item, decision, box, actions, body, false, done).then(function () {
        submit.disabled = false;
      });
    });
  }

  /** Setting up the passkey: its own step, after a click, with the owner code once. */
  function passkeySetup(holder) {
    if (!canPasskey || !passkey || passkey.registered) return;
    var box = el('section');
    box.appendChild(el('h2', 'Approve with a passkey'));
    box.appendChild(el('p', 'Set up a passkey to approve with Touch ID, Face ID or Windows Hello instead of typing your owner code. Your owner code keeps working.'));
    var start = el('button', 'Set up a passkey');
    start.type = 'button';
    box.appendChild(start);
    start.addEventListener('click', function () {
      start.hidden = true;
      var form = el('form');
      var label = el('label', 'Owner code ');
      var input = el('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      label.appendChild(input);
      form.appendChild(label);
      var submit = el('button', 'Continue');
      submit.type = 'submit';
      form.appendChild(submit);
      box.appendChild(form);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submit.disabled = true;
        var code = new TextEncoder().encode(input.value);
        input.value = '';
        createBody().then(function (assertion) {
          if (assertion === null) {
            code.fill(0);
            form.remove();
            say(box, PASSKEY_RESULT.passkey_unsupported);
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
            say(box, PASSKEY_RESULT[out.status] || PASSKEY_RESULT.failed);
            if (out.status === 'registered') { passkey.registered = true; loadPasskey(); }
            else if (out.status !== 'passkey_exists' && out.status !== 'passkey_unsupported') { start.hidden = false; }
          });
        }).catch(function () {
          code.fill(0);
          form.remove();
          start.hidden = false;
          say(box, NOT_USED);
        });
      });
    });
    holder.appendChild(box);
  }

  function loadPasskey() {
    return api('/api/owner/passkey').then(function (res) {
      return res.status === 200 ? res.json() : null;
    }).then(function (out) {
      passkey = out && out.passkey && out.passkey.rpId === 'localhost' ? out.passkey : null;
    }, function () { passkey = null; });
  }

  var match = ID.exec(location.pathname);
  var holder = el('div');
  app.appendChild(holder);
  loadPasskey().then(function () {
    if (match) {
      api('/api/approvals/' + match[1]).then(function (res) {
        if (res.status === 404) { say(holder, RESULT.not_pending); return null; }
        return res.json();
      }).then(function (out) { if (out) card(out.approval, holder); });
    } else {
      api('/api/approvals').then(function (res) { return res.json(); }).then(function (out) {
        var list = out.approvals || [];
        holder.appendChild(el('h2', 'Waiting for you (' + list.length + ')'));
        if (list.length === 0) say(holder, 'Nothing is waiting for you.');
        list.forEach(function (item) { card(item, holder); });
        passkeySetup(holder);
      });
    }
  });
})();
`;
