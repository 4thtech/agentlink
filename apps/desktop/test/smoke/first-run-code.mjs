// FIRSTRUN-MATRIX (item 2): first run with the master code, driven over loopback HTTP exactly as the
// app window's page does it (apps/local-ui first-run setup-api.ts), with no browser, no WebAuthn and
// no terminal: the one-shot session link -> session cookie -> the page's CSRF token -> label check ->
// begin -> finish with `presence: 'code'` (an empty body). The shell's own window can't be driven
// (the shell refuses every debugging switch), so this drives the same host the window talks to.
//
// Never prints or returns the session link, the cookie, the CSRF token, the nonce or the master code:
// the result holds fixed facts only. A test (e2e/test/firstrun-matrix.test.ts) runs this same module
// against the local app, so the driver is proven before CI runs it on the built app.
import { setTimeout as sleep } from 'node:timers/promises';

const CODE_GROUPS = /^[A-Z0-9]{4}( [A-Z0-9]{4}){1,15}$/;

/** base64url (no padding) of the UTF-8 JSON of `value`: the operation input header. */
const inputOf = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/**
 * @param {string} sessionUrl the one-shot link the host sent (`ready.sessionUrl`)
 * @param {string} label the name people see
 * @param {{ fetch?: typeof fetch }} [options]
 * @returns {Promise<{ ok: true, passkey: boolean, ownerCodeShape: boolean } | { ok: false, reason: string }>}
 */
export async function createOwnerWithCode(sessionUrl, label, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch;
  let url;
  try {
    url = new URL(sessionUrl);
  } catch {
    return { ok: false, reason: 'the session link is not a URL' };
  }
  const origin = url.origin;
  let cookie = '';
  const take = (res) => {
    const set = res.headers.getSetCookie?.() ?? [];
    for (const line of set) {
      const pair = line.split(';')[0];
      if (pair) cookie = pair;
    }
  };
  const get = (path, extra = {}) =>
    doFetch(`${origin}${path}`, {
      redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...extra },
    });

  // 1. The one-shot link: the host sets the session cookie, then redirects (or a continue page).
  let res = await get(`${url.pathname}${url.search}`);
  take(res);
  if (cookie === '') return { ok: false, reason: `the link set no session (HTTP ${res.status})` };
  await res.arrayBuffer().catch(() => undefined);
  // 2. The page itself: the CSRF token is in its meta tag.
  res = await get(url.pathname);
  if (res.status !== 200) return { ok: false, reason: `the page answered HTTP ${res.status}` };
  const html = await res.text();
  const token = /<meta[^>]+name="agentlink-csrf"[^>]+content="([^"]+)"/.exec(html)?.[1];
  if (token === undefined) return { ok: false, reason: 'the page has no CSRF token' };
  // The app host's generation (the page's fetch guard sends it on every change).
  const generation = /<meta[^>]+name="agentlink-generation"[^>]+content="([0-9]+)"/.exec(html)?.[1];

  const api = async (method, path, input, body) => {
    const r = await doFetch(`${origin}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        cookie,
        origin,
        'X-AgentLink-CSRF': token,
        ...(method === 'POST' && generation !== undefined
          ? { 'X-AgentLink-Generation': generation }
          : {}),
        ...(input === undefined ? {} : { 'X-AgentLink-Input': inputOf(input) }),
        ...(method === 'POST' ? { 'content-type': 'application/octet-stream' } : {}),
      },
      ...(method === 'POST' ? { body: body ?? new Uint8Array(0) } : {}),
    });
    let json;
    try {
      json = await r.json();
    } catch {
      json = undefined;
    }
    return { status: r.status, json };
  };

  // 3. A fresh profile: no owner yet (first run, never the Welcome dead end).
  const status = await api('GET', '/api/ui/first-run');
  if (status.json?.owner !== 'missing') {
    return { ok: false, reason: `first-run says owner=${String(status.json?.owner)}` };
  }
  const checked = await api('GET', `/api/ui/agents/label-check?label=${encodeURIComponent(label)}`);
  if (checked.json?.status !== 'ok') return { ok: false, reason: 'the name was refused' };
  const begun = await api('POST', '/api/ui/first-run/owner/begin', { label });
  const nonce = begun.json?.nonce;
  if (begun.status !== 200 || begun.json?.status !== 'ready' || typeof nonce !== 'string') {
    return { ok: false, reason: `begin: HTTP ${begun.status} ${String(begun.json?.status)}` };
  }
  // 4. The master code only: no WebAuthn, an empty body.
  const done = await api('POST', '/api/ui/first-run/owner/finish', { nonce, presence: 'code' });
  const finished = done.json?.status;
  if (done.status !== 200 || (finished !== 'done' && finished !== 'done_unconfirmed')) {
    return {
      ok: false,
      reason: `finish: HTTP ${done.status} ${String(finished)} ${String(done.json?.reason ?? '')}`,
    };
  }
  const code = done.json?.ownerCode;
  const ownerCodeShape = typeof code === 'string' && CODE_GROUPS.test(code);
  // 5. The owner now exists.
  await sleep(50);
  const after = await api('GET', '/api/ui/first-run');
  if (after.json?.owner !== 'set_up') {
    return { ok: false, reason: `after finish first-run says owner=${String(after.json?.owner)}` };
  }
  return { ok: true, passkey: done.json?.passkey === true, ownerCodeShape };
}
