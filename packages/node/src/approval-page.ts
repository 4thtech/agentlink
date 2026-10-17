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

/** The page script. Static: it holds no token, no CSRF value and no request data. */
export const APP_JS = String.raw`'use strict';
(function () {
  var csrf = document.querySelector('meta[name="agentlink-csrf"]').getAttribute('content');
  var app = document.getElementById('app');
  var ID = /^\/approve\/(apr_[A-Za-z0-9_-]{22})$/;

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

  var RESULT = {
    applied_approve: 'Approved.',
    applied_deny: 'Denied.',
    presence_required: 'Enter your owner code or owner passphrase. Nothing was changed.',
    presence_rejected: "That didn't match your owner code or owner passphrase. Nothing was changed.",
    not_pending: 'This request is no longer waiting for you.',
    changed: 'This request changed. Reload the page and check it again.',
    busy: 'Another approval is being confirmed. Try again in a moment.',
    refused: 'This decision was not applied. Nothing was changed.',
    needs_setup: 'Set up your owner key first: run agentlink owner init in your own terminal.'
  };

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

  function confirmStep(item, decision, box, actions) {
    actions.hidden = true;
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
    box.appendChild(form);
    input.focus();
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submit.disabled = true;
      var body = new TextEncoder().encode(input.value);
      input.value = '';
      api('/api/approvals/' + item.approvalId + '/' + decision, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-AgentLink-Digest': item.actionDigest },
        body: body
      }).then(function (res) { return res.json(); }).then(function (out) {
        body.fill(0);
        form.remove();
        var key = out.status === 'applied' ? 'applied_' + out.decision : out.status;
        say(box, RESULT[key] || RESULT.refused);
        if (out.status === 'presence_rejected' || out.status === 'presence_required' || out.status === 'busy') {
          actions.hidden = false;
        }
      }, function () {
        body.fill(0);
        submit.disabled = false;
        say(box, 'AgentLink is not running. Open it again from your AI, or run agentlink ui.');
      });
    });
  }

  var match = ID.exec(location.pathname);
  var holder = el('div');
  app.appendChild(holder);
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
    });
  }
})();
`;
