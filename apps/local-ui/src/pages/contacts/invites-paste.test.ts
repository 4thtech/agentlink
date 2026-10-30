// @vitest-environment jsdom
// W4-WIRE-2 (owner Decision 52 (3)): the Add contact sheet is retired. Its contracts move here, on
// the paths that replace it:
// - the old `?add-contact` marker opens the Invite screen and leaves the address at once;
// - W4-INVITES-LIST: the open invites come from the server, with Cancel on each row;
// - "Have an invite link? Paste it" on the Invite screen: POST /api/ui/invites/check first (no
//   presence), then the friend's card with the name under the name rule and the short owner
//   fingerprint; only Accept asks for presence and posts once to /api/ui/invites/accept, with the
//   link as the operation input. No element attribute or console line ever holds the link (I-5).
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { INVITE_STRINGS as I, PASTE_STRINGS as P } from '../invite/strings.js';
import { ADD_CONTACT_HREF, ADD_CONTACT_MARKER } from './add-contact-link.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { createInviteApi } from './invite-api.js';
import { createOwnerClient } from './owner.js';
import { CONTACTS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PAYLOAD = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-SeCrEtPaYlOaD';
const LINK = `https://agentlink.4thtech.io/i#${PAYLOAD}`;
const SHARE = `Let's connect our AI agents with AgentLink. Open this link and follow the steps; it works once, until 4 Nov 2026: ${LINK}`;
const CREATED = {
  status: 'ok',
  inviteUrl: LINK,
  shareText: SHARE,
  ownerFingerprint: '7F3A·19C2',
  expiresAt: '2026-11-04T12:00:00Z',
  format: 'long',
  inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ',
};
const CHECKED = {
  status: 'ok',
  contact: { name: 'Marko Novak', label: 'self-declared', ownerFingerprint: '7F3A·19C2' },
  expiresAt: '2026-11-04T12:00:00Z',
};
const LIST = '/api/ui/contacts';
const CANCEL = '/api/ui/invites/cancel';
const CREATE = '/api/ui/invites';
const CHECK = '/api/ui/invites/check';
const ACCEPT = '/api/ui/invites/accept';
const NO_PASSKEY = {
  passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
};
const ana = {
  ref: '0x4c21a0f700000000000000000000000000000002',
  name: 'Ana',
  nameSource: 'owner',
  label: 'safety-code-checked',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
};

let host: HTMLElement;
let root: Root;
let logs: unknown[][];
/** W4-INVITES-LIST: the server's open invites; the default routes add to it on create. */
let open: { inviteId: string; name: string | null; expiresAt: string }[];

beforeEach(() => {
  open = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  document.title = 'Contacts · AgentLink';
  history.replaceState(null, '', '/settings/contacts');
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-motion');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

class Answer {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

type Routes = Record<string, unknown>;

function server(routes: Routes): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const body =
      raw === undefined || raw === null
        ? ''
        : ArrayBuffer.isView(raw)
          ? new TextDecoder().decode(raw)
          : String(raw);
    const call = { url, method, headers: new Headers(init?.headers), body };
    calls.push(call);
    const found = routes[`${method} ${url}`];
    const value = typeof found === 'function' ? (found as (c: Call) => unknown)(call) : found;
    if (value instanceof Error) throw value;
    if (value === undefined) return new Response('{}', { status: 404 });
    const answer = value instanceof Answer ? value : new Answer(200, value);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(routes: Routes = {}): Promise<Call[]> {
  const s = server({
    'GET /api/owner/passkey': NO_PASSKEY,
    [`GET ${LIST}`]: { status: 'ok', contacts: [ana] },
    [`GET ${CREATE}`]: () => ({ invites: open }),
    [`POST ${CANCEL}`]: (c: Call) => {
      const { inviteId } = JSON.parse(c.body) as { inviteId: string };
      const had = open.some((o) => o.inviteId === inviteId);
      open = open.filter((o) => o.inviteId !== inviteId);
      return had ? { status: 'cancelled' } : new Answer(404, { error: 'not_found' });
    },
    ...routes,
  });
  const api = createApiClient({ fetch: s.fetch, token: 't' });
  const owner = createOwnerClient({ fetch: s.fetch, token: 't' });
  const invites = createInviteApi({ fetch: s.fetch, token: 't' });
  await act(async () => {
    root.render(createElement<ContactsPageProps>(ContactsPage, { api, owner, invites }));
    await Promise.resolve();
  });
  await settle();
  return s.calls;
}

const text = (): string => document.body.textContent ?? '';

function buttons(label: string): HTMLButtonElement[] {
  return [...document.body.querySelectorAll('button')].filter(
    (b) => (b.textContent ?? '').trim() === label,
  );
}

function button(label: string): HTMLButtonElement {
  const found = buttons(label)[0];
  if (found === undefined) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
}

async function click(target: string | HTMLElement): Promise<void> {
  await act(async () => {
    (typeof target === 'string' ? button(target) : target).click();
  });
  await settle();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const l = [...document.body.querySelectorAll('label')].find(
    (x) => (x.textContent ?? '').trim() === label,
  );
  const el = l === undefined ? null : document.getElementById(l.htmlFor);
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    throw new Error(`no field "${label}"`);
  }
  return el;
}

/** Every attribute of every element in the document that holds the link or its payload. */
function attributesWithLink(): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (attr.value.includes(PAYLOAD) || attr.value.includes('agentlink.4thtech.io/i')) {
        out.push(`${el.tagName.toLowerCase()}[${attr.name}]`);
      }
    }
  }
  return out;
}

function inputOf(call: Call): unknown {
  const raw = call.headers.get('x-agentlink-input');
  if (raw === null) return undefined;
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

const posts = (calls: Call[], url: string): Call[] =>
  calls.filter((c) => c.method === 'POST' && c.url === url);

describe('the old Add contact marker', () => {
  it('opens the Invite screen instead, and drops the marker at once', async () => {
    expect(ADD_CONTACT_HREF).toBe('/contacts?invite');
    history.replaceState(null, '', `/settings/contacts?${ADD_CONTACT_MARKER}`);
    await mount();
    expect(document.body.querySelector('[role="tab"]')).toBeNull();
    expect(document.body.querySelector('h1')?.textContent).toBe('Invite someone');
    expect(location.search).toBe('');
    expect(location.pathname).toBe('/settings/contacts');
  });
});

describe('W4-INVITES-LIST: open invites from the server', () => {
  const rowsEl = (): HTMLElement | null => document.querySelector('.ct-invites');
  const BO = { inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ', name: 'Bo', expiresAt: '2999-01-01T00:00:00Z' };
  const NONE = {
    inviteId: 'BwcHBwcHBwcHBwcHBwcHBw',
    name: null,
    expiresAt: '2999-01-01T00:00:00Z',
  };

  it('shows the server rows on load: name or a neutral line, expiry, a Cancel each', async () => {
    open = [BO, NONE];
    await mount();
    const el = rowsEl();
    expect(el?.querySelectorAll('li').length).toBe(2);
    expect(el?.textContent).toContain('Waiting for Bo to accept');
    expect(el?.textContent).toContain('Waiting for them to accept');
    // W4-PEOPLE-INVITE: the rows are PendingInviteRow (prototype v23 A4).
    expect(el?.textContent).toMatch(/link works [\d,]+ more days/);
    const cancels = [...(el?.querySelectorAll('button') ?? [])].filter(
      (b) => (b.textContent ?? '').trim() === 'Cancel invite',
    );
    expect(cancels.length).toBe(2);
  });

  it('shows nothing when there are none, and when the list cannot be read', async () => {
    await mount();
    expect(rowsEl()).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ [`GET ${CREATE}`]: new Answer(500, {}) });
    expect(rowsEl()).toBeNull();
  });

  it('cancels with one octet-stream POST of the ID, then re-reads and drops the row', async () => {
    open = [BO, NONE];
    const calls = await mount();
    const first = rowsEl()?.querySelector('li button') as HTMLButtonElement;
    const reads = calls.filter((c) => c.method === 'GET' && c.url === CREATE).length;
    await click(first);
    const [call, ...more] = posts(calls, CANCEL);
    expect(more).toEqual([]);
    expect(call?.headers.get('content-type')).toBe('application/octet-stream');
    expect(call?.headers.get('x-agentlink-csrf')).toBe('t');
    expect(call?.headers.get('x-agentlink-presence')).toBeNull();
    expect(JSON.parse(call?.body ?? '')).toEqual({ inviteId: BO.inviteId });
    expect(calls.filter((c) => c.method === 'GET' && c.url === CREATE).length).toBeGreaterThan(
      reads,
    );
    // The cancelled row stays for this visit and says the link no longer works (A4).
    expect(rowsEl()?.querySelectorAll('li').length).toBe(2);
    expect(rowsEl()?.querySelector('li')?.textContent).toContain(
      'Invite cancelled. The link no longer works.',
    );
    expect(rowsEl()?.querySelector('li')?.querySelector('button')).toBeNull();
  });

  it('drops a row the server no longer has (not found) without an error', async () => {
    open = [BO];
    await mount({
      [`POST ${CANCEL}`]: () => {
        open = [];
        return new Answer(404, { error: 'not_found' });
      },
    });
    await click(rowsEl()?.querySelector('li button') as HTMLButtonElement);
    expect(rowsEl()).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('says so once when cancel fails, and keeps the row', async () => {
    open = [BO];
    await mount({ [`POST ${CANCEL}`]: new Answer(500, {}) });
    await click(rowsEl()?.querySelector('li button') as HTMLButtonElement);
    expect(rowsEl()?.querySelectorAll('li').length).toBe(1);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(I.cantCancel);
  });

  it('keeps the rows when there are no contacts, instead of the empty state', async () => {
    open = [BO];
    await mount({ [`GET ${LIST}`]: { status: 'ok', contacts: [] } });
    expect(text()).toContain('Waiting for Bo to accept');
  });
});

describe('W4-WIRE-2: Paste it on the Invite screen', () => {
  async function paste(routes: Routes = {}, value = LINK): Promise<Call[]> {
    history.replaceState(null, '', '/settings/contacts?invite');
    const calls = await mount({
      [`POST ${CHECK}`]: CHECKED,
      [`POST ${CREATE}`]: { ...CREATED, inviteId: 'BwcHBwcHBwcHBwcHBwcHBw' },
      ...routes,
    });
    await click(P.open);
    await type(field(P.label), value);
    return calls;
  }

  it('keeps Continue disabled while the field is empty; the field is multi-line', async () => {
    history.replaceState(null, '', '/settings/contacts?invite');
    await mount();
    await click(P.open);
    expect(button(P.go).disabled).toBe(true);
    await type(field(P.label), LINK);
    expect(button(P.go).disabled).toBe(false);
    expect(field(P.label)).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('checks first without presence, then shows who invites you with name, label and fingerprint', async () => {
    const calls = await paste();
    await click(P.go);
    const [call] = posts(calls, CHECK);
    expect(call?.headers.get('content-type')).toBe('application/octet-stream');
    expect(call?.headers.get('x-agentlink-presence')).toBeNull();
    expect(JSON.parse(call?.body ?? '')).toEqual({ invite: LINK });
    expect(posts(calls, ACCEPT)).toEqual([]);
    expect(text()).toContain('“Marko Novak” invites you to connect your AIs');
    expect(text()).toContain('Name set by the sender');
    expect(text()).toContain('7F3A·19C2');
    expect(buttons('Accept with your backup code').length).toBe(1);
    expect(attributesWithLink()).toEqual([]);
  });

  it('the shared message goes to the check as the link alone', async () => {
    const calls = await paste({}, SHARE);
    await click(P.go);
    expect(JSON.parse(posts(calls, CHECK)[0]?.body ?? '')).toEqual({ invite: LINK });
  });

  it('renders the inviter fields as plain text (I-5)', async () => {
    await paste({
      [`POST ${CHECK}`]: {
        ...CHECKED,
        contact: { ...CHECKED.contact, name: '<img src=x onerror=alert(1)>' },
      },
    });
    await click(P.go);
    expect(document.querySelector('img')).toBeNull();
  });

  it('asks for presence only on Accept and posts the invite once as the operation input', async () => {
    const calls = await paste({
      [`POST ${ACCEPT}`]: { status: 'pending', contact: CHECKED.contact, sent: true },
    });
    await click(P.go);
    expect(document.querySelector('input[name="owner-code"]')).toBeNull();
    await click('Accept with your backup code');
    await type(document.querySelector('input[name="owner-code"]') as HTMLInputElement, 'ABCD-EFGH');
    await click(S.confirm);
    const accepts = posts(calls, ACCEPT);
    expect(accepts.length).toBe(1);
    const [accept] = accepts;
    expect(accept?.headers.get('content-type')).toBe('application/octet-stream');
    expect(accept?.body).toBe('ABCD-EFGH');
    expect(inputOf(accept as Call)).toEqual({ invite: LINK });
    // The check came first.
    expect(calls.findIndex((c) => c.url === CHECK)).toBeLessThan(
      calls.findIndex((c) => c.url === ACCEPT),
    );
    // Done: the Invite screen closes, the pasted text is gone and the list reloads.
    expect(document.body.querySelector('h1')?.textContent).not.toBe('Invite someone');
    expect(document.querySelector('textarea[name="invite-link"]')).toBeNull();
    expect(calls.filter((c) => c.url === LIST).length).toBeGreaterThanOrEqual(2);
    expect(attributesWithLink()).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(PAYLOAD);
  });

  it('Not now goes back without asking for presence', async () => {
    const calls = await paste();
    await click(P.go);
    await click('Not now');
    expect(posts(calls, ACCEPT)).toEqual([]);
    expect(text()).not.toContain('invites you to connect your AIs');
  });

  it.each([
    [new Answer(400, { error: 'expired' }), 'expired'],
    [new Answer(400, { error: 'own_invite' }), 'own'],
    [new Answer(400, { error: 'invalid_invite' }), 'damaged'],
    [new Answer(400, { error: 'invalid' }), 'damaged'],
  ] as const)('explains a refused invite in one sentence (%#)', async (answer, kind) => {
    await paste({ [`POST ${CHECK}`]: answer });
    await click(P.go);
    const sentence = { expired: P.expired, own: P.own, damaged: P.damaged }[kind];
    expect(text()).toContain(sentence);
    expect(text()).toContain(P.askForNew);
    expect(buttons('Accept with your backup code')).toEqual([]);
  });

  it('keeps the pasted text when AgentLink cannot be reached', async () => {
    await paste({ [`POST ${CHECK}`]: new TypeError('offline') });
    await click(P.go);
    expect(text()).toContain(P.offline);
    expect(field(P.label).value).toBe(LINK);
  });
});
