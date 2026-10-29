// @vitest-environment jsdom
// UX2-d2: the Add contact sheet (b11 §21; owner decisions 1.1 and 2.1; 11 §5, §6.1; I-5).
//
// - One Add contact button on Contacts opens a level-3 side sheet, a labelled region (not a modal),
//   with two tabs: Invite someone and I have an invite. Focus goes to the first field; Esc and Close
//   close it and focus goes back to the button. The address bar and the page title do not change.
// - Invite someone: POST /api/ui/invites (no presence; octet-stream JSON body). The ready text is
//   only text in the well; it leaves only through Copy, the system share sheet or the QR code. No
//   element attribute ever holds the link, no toast, no console line, no mailto and no email button.
// - The safety line claims nothing more than 11 §5 allows: "Send it only to ... Anyone with this
//   link can connect once."
// - I have an invite: POST /api/ui/invites/check first (no presence), then "Is this who you
//   expected?" with the name under the name rule, its label and the short owner fingerprint; only
//   Connect asks for presence and posts once to /api/ui/invites/accept.
import axe from 'axe-core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ADD_CONTACT_HREF } from './add-contact-link.js';
import {
  ADD_STRINGS as A,
  expiresIn,
  inviteReady,
  safetyLine,
  waitingToAccept,
} from './add-strings.js';
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
  stubShare(undefined);
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

const sheet = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[role="region"][aria-label="Add contact"]');

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

function stubClipboard(): string[] {
  const written: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (t: string) => {
        written.push(t);
        return Promise.resolve();
      },
    },
  });
  return written;
}

function stubShare(
  share: ((data: ShareData) => Promise<void>) | undefined,
  canShare?: (data: ShareData) => boolean,
): void {
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
}

async function openSheet(routes: Routes = {}): Promise<Call[]> {
  const calls = await mount(routes);
  await click(A.addContact);
  return calls;
}

async function createFor(name: string | undefined, routes: Routes = {}): Promise<Call[]> {
  const calls = await openSheet({
    [`POST ${CREATE}`]: (c: Call) => {
      const label = (JSON.parse(c.body) as { label?: string }).label ?? null;
      open = [{ inviteId: `id${String(open.length)}`.padEnd(22, 'A'), name: label, expiresAt: CREATED.expiresAt }, ...open];
      return CREATED;
    },
    ...routes,
  });
  if (name !== undefined) await type(field(A.whoFor), name);
  await click(A.createInvite);
  return calls;
}

describe('UX2-d2: where the sheet opens', () => {
  it('puts Add contact in the title row: secondary with contacts, primary when the list is empty', async () => {
    await mount();
    const add = button(A.addContact);
    expect(add.closest('.ct-title-row')).not.toBeNull();
    expect(add.className).toContain('al-btn-secondary');
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ [`GET ${LIST}`]: { status: 'ok', contacts: [] } });
    expect(button(A.addContact).className).toContain('al-btn-primary');
  });

  it('opens a labelled region, not a modal, and focuses its first field', async () => {
    await openSheet();
    const region = sheet();
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-modal')).toBeNull();
    expect(region?.getAttribute('role')).toBe('region');
    expect(document.activeElement).toBe(field(A.whoFor));
    // Two tabs: Invite someone (selected) and I have an invite.
    const tabs = [...(region?.querySelectorAll('[role="tab"]') ?? [])];
    expect(tabs.map((t) => (t.textContent ?? '').trim())).toEqual([A.inviteSomeone, A.haveInvite]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(region?.querySelector('[role="tabpanel"]')).not.toBeNull();
    expect(location.pathname + location.search + location.hash).toBe('/settings/contacts');
    expect(document.title).toBe('Contacts · AgentLink');
  });

  it('closes on Esc and on Close, and gives the focus back to Add contact', async () => {
    await openSheet();
    await act(async () => {
      sheet()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(button(A.addContact));
    await click(A.addContact);
    const close = sheet()?.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    expect(close).not.toBeNull();
    await click(close as HTMLButtonElement);
    expect(sheet()).toBeNull();
  });

  it('opens from the fixed address marker and drops the marker at once', async () => {
    expect(ADD_CONTACT_HREF).toBe('/settings/contacts?add-contact');
    history.replaceState(null, '', ADD_CONTACT_HREF);
    await mount();
    expect(sheet()).not.toBeNull();
    expect(location.search).toBe('');
    expect(location.pathname).toBe('/settings/contacts');
  });

  it('marks the sheet still when motion is reduced', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    await openSheet();
    expect(sheet()?.getAttribute('data-motion')).toBe('reduced');
  });
});

describe('UX2-d2: Invite someone', () => {
  it('creates without presence: one octet-stream POST with the name only', async () => {
    const calls = await createFor('Marko');
    const [call, ...more] = posts(calls, CREATE);
    expect(more).toEqual([]);
    expect(call?.headers.get('content-type')).toBe('application/octet-stream');
    expect(call?.headers.get('x-agentlink-csrf')).toBe('t');
    expect(call?.headers.get('x-agentlink-input')).toBeNull();
    expect(call?.headers.get('x-agentlink-presence')).toBeNull();
    expect(JSON.parse(call?.body ?? '')).toEqual({ label: 'Marko' });
  });

  it('sends an empty body without a name', async () => {
    const calls = await createFor(undefined);
    expect(JSON.parse(posts(calls, CREATE)[0]?.body ?? '')).toEqual({});
    expect(text()).toContain(A.inviteReadyPlain);
    expect(text()).toContain(safetyLine(undefined));
  });

  it('shows the ready text in the well, the expiry, the safety line and three ways out in order', async () => {
    await createFor('Marko');
    const region = sheet() as HTMLElement;
    expect(region.textContent).toContain(inviteReady('Marko'));
    expect(region.querySelector('.ct-invite-well')?.textContent).toBe(SHARE);
    expect(region.textContent).toContain('Works once, until');
    expect(region.textContent).toContain(safetyLine('Marko'));
    expect(safetyLine('Marko')).toContain(
      'Send it only to Marko. Anyone with this link can connect once.',
    );
    // 11 §5: the sheet never says the link is safe, secure or encrypted.
    expect(region.textContent ?? '').not.toMatch(/\b(secure|safe|encrypted)\b/i);
    const ways = [...region.querySelectorAll('.ct-invite-ways button')].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(ways).toEqual([A.copyInvite, A.showQr]);
    expect(button(A.copyInvite).className).toContain('al-btn-primary');
    expect(buttons(A.done).length).toBe(1);
  });

  it('never puts the link in an attribute, the address, the title or the console', async () => {
    stubClipboard();
    stubShare(
      () => Promise.resolve(),
      () => true,
    );
    await createFor('Marko');
    expect(attributesWithLink()).toEqual([]);
    await click(A.showQr);
    expect(attributesWithLink()).toEqual([]);
    await click(A.copyInvite);
    expect(attributesWithLink()).toEqual([]);
    expect(location.href).not.toContain(PAYLOAD);
    expect(document.title).not.toContain(PAYLOAD);
    expect(JSON.stringify(logs)).not.toContain(PAYLOAD);
    expect(document.querySelector('.al-toast')).toBeNull();
  });

  it('has no email button and no mailto anywhere', async () => {
    stubShare(
      () => Promise.resolve(),
      () => true,
    );
    await createFor('Marko');
    expect(document.querySelector('a[href^="mailto:" i]')).toBeNull();
    expect(text()).not.toMatch(/\bemail it\b|\bsend by email\b/i);
    expect(
      [...document.querySelectorAll('button')].filter((b) => /e-?mail/i.test(b.textContent ?? '')),
    ).toEqual([]);
  });

  it('Copy copies the share text, says Copied and announces it, with no toast', async () => {
    const written = stubClipboard();
    await createFor('Marko');
    await click(A.copyInvite);
    expect(written).toEqual([SHARE]);
    expect(buttons(A.copied).length).toBe(1);
    const live = [...document.querySelectorAll('[aria-live="polite"]')].map((n) => n.textContent);
    expect(live).toContain(A.inviteCopied);
    expect(document.querySelector('.al-toast')).toBeNull();
  });

  it('hides Share where the browser has no share sheet, or cannot share text', async () => {
    stubShare(undefined);
    await createFor('Marko');
    expect(buttons(A.share)).toEqual([]);
    act(() => root.unmount());
    root = createRoot(host);
    stubShare(
      () => Promise.resolve(),
      () => false,
    );
    await createFor('Marko');
    expect(buttons(A.share)).toEqual([]);
  });

  it('Share sends the share text with the fixed title; a cancel does nothing, a failure says so', async () => {
    const shared: ShareData[] = [];
    let fail: Error | undefined;
    stubShare(
      (data) => {
        shared.push(data);
        return fail === undefined ? Promise.resolve() : Promise.reject(fail);
      },
      () => true,
    );
    await createFor('Marko');
    const ways = [...(sheet()?.querySelectorAll('.ct-invite-ways button') ?? [])].map((b) =>
      (b.textContent ?? '').trim(),
    );
    expect(ways).toEqual([A.copyInvite, A.share, A.showQr]);
    await click(A.share);
    expect(shared).toEqual([{ title: A.shareTitle, text: SHARE }]);
    fail = new DOMException('cancelled', 'AbortError');
    await click(A.share);
    expect(text()).not.toContain(A.shareFailed);
    fail = new Error('nope');
    await click(A.share);
    expect(text()).toContain(A.shareFailed);
  });

  it('shows the QR code of the link only on request, named without the link', async () => {
    await createFor('Marko');
    expect(sheet()?.querySelector('svg[role="img"]')).toBeNull();
    await click(A.showQr);
    const qr = sheet()?.querySelector('svg[role="img"]');
    expect(qr?.getAttribute('aria-label')).toBe('QR code of the invite for Marko');
    expect(qr?.hasAttribute('data-value')).toBe(false);
    expect(text()).toContain(A.qrCaption);
    expect(buttons(A.hideQr).length).toBe(1);
    await click(A.hideQr);
    expect(sheet()?.querySelector('svg[role="img"]')).toBeNull();
  });

  it('asks before closing an invite that was not sent, then closes into the pending row', async () => {
    await createFor('Marko');
    await click(A.done);
    expect(text()).toContain(A.notSentYet);
    await click(A.keepOpen);
    expect(sheet()?.textContent).toContain(SHARE);
    await click(A.done);
    await click(A.closeAnyway);
    expect(sheet()).toBeNull();
    expect(text()).not.toContain(PAYLOAD);
    const row = document.querySelector('.ct-invites');
    expect(row?.textContent).toContain(waitingToAccept('Marko'));
    expect(row?.textContent).not.toContain(PAYLOAD);
    expect(attributesWithLink()).toEqual([]);
  });

  it('closes at once after Copy, Share or Show QR code', async () => {
    stubClipboard();
    await createFor('Marko');
    await click(A.copyInvite);
    await click(A.done);
    expect(sheet()).toBeNull();
    expect(text()).toContain(waitingToAccept('Marko'));
  });

  it('keeps the pending row when the list is empty, instead of the empty state', async () => {
    stubClipboard();
    await createFor('Marko', { [`GET ${LIST}`]: { status: 'ok', contacts: [] } });
    await click(A.copyInvite);
    await click(A.done);
    expect(text()).toContain(waitingToAccept('Marko'));
  });

  it('says it once when it cannot create, keeps the name and offers Try again', async () => {
    await createFor('Marko', { [`POST ${CREATE}`]: new Answer(503, { error: 'unavailable' }) });
    expect(sheet()?.querySelector('[role="alert"]')?.textContent).toContain(A.cantCreate);
    expect(field(A.whoFor).value).toBe('Marko');
    expect(buttons(A.tryAgain).length).toBe(1);
  });

  it('renders a hostile name as text', async () => {
    await createFor('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('W4-SHORT-INVITE: the long link under Advanced', () => {
  const advanced = (): HTMLDetailsElement | null =>
    sheet()?.querySelector<HTMLDetailsElement>('details') ?? null;
  const SHORT = 'https://agentlink.4thtech.io/i#2.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

  it('keeps the long-link option under a closed Advanced disclosure', async () => {
    await openSheet();
    const d = advanced();
    expect(d).not.toBeNull();
    expect(d?.open).toBe(false);
    expect(d?.querySelector('summary')?.textContent?.trim()).toBe(A.advanced);
    expect(d?.textContent).toContain(A.longLink);
    expect(d?.textContent).toContain(A.longLinkHint);
  });

  it('sends {long: true} (with the name) only when the option is on', async () => {
    const calls = await openSheet({ [`POST ${CREATE}`]: CREATED });
    await type(field(A.whoFor), 'Marko');
    const toggle = advanced()?.querySelector<HTMLElement>(
      '[role="switch"], input[type="checkbox"]',
    );
    expect(toggle).not.toBeNull();
    await click(toggle as HTMLElement);
    await click(A.createInvite);
    const [call] = posts(calls, CREATE);
    expect(JSON.parse(call?.body ?? '')).toEqual({ label: 'Marko', long: true });
    expect(sheet()?.textContent).toContain(SHARE);
  });

  it('sends no long field when the option stays off', async () => {
    const calls = await createFor(undefined);
    const [call] = posts(calls, CREATE);
    expect(JSON.parse(call?.body ?? '')).toEqual({});
  });

  it('works the same for a short link and for the automatic long fallback', async () => {
    await createFor('Marko', {
      [`POST ${CREATE}`]: {
        ...CREATED,
        inviteUrl: SHORT,
        shareText: `Add my AI agent on AgentLink: ${SHORT}`,
        format: 'short',
      },
    });
    expect(sheet()?.textContent).toContain(SHORT);
    expect(sheet()?.querySelector('[role="alert"]')).toBeNull();
    expect(attributesWithLink()).toEqual([]);
  });

  it('says a short link that is gone cannot be used', async () => {
    await openSheet({ [`POST ${CHECK}`]: new Answer(400, { error: 'unavailable_invite' }) });
    await click(A.haveInvite);
    await type(field(A.pasteLabel), SHORT);
    await click(A.checkInvite);
    expect(sheet()?.textContent).toContain("can't be used");
    expect(sheet()?.textContent).toContain(A.unavailableInvite);
  });

  it('asks to try again, without a refusal, when the service was busy', async () => {
    await openSheet({ [`POST ${CHECK}`]: new Answer(503, { error: 'try_again' }) });
    await click(A.haveInvite);
    await type(field(A.pasteLabel), SHORT);
    await click(A.checkInvite);
    expect(sheet()?.textContent).toContain(A.busyTryAgain);
    expect(sheet()?.textContent).not.toContain(A.unavailableInvite);
  });
});

describe('W4-INVITES-LIST: open invites from the server', () => {
  const rowsEl = (): HTMLElement | null => document.querySelector('.ct-invites');
  const BO = { inviteId: 'AQEBAQEBAQEBAQEBAQEBAQ', name: 'Bo', expiresAt: '2999-01-01T00:00:00Z' };
  const NONE = { inviteId: 'BwcHBwcHBwcHBwcHBwcHBw', name: null, expiresAt: '2999-01-01T00:00:00Z' };

  it('shows the server rows on load: name or a neutral line, expiry, a Cancel each', async () => {
    open = [BO, NONE];
    await mount();
    const el = rowsEl();
    expect(el?.querySelectorAll('li').length).toBe(2);
    expect(el?.textContent).toContain(waitingToAccept('Bo'));
    expect(el?.textContent).toContain(waitingToAccept(undefined));
    expect(el?.textContent).toMatch(/Expires in [\d,]+ days/);
    const cancels = [...(el?.querySelectorAll('button') ?? [])].filter(
      (b) => (b.textContent ?? '').trim() === 'Cancel',
    );
    expect(cancels.length).toBe(2);
    expect(A.cancelInvite).toBe('Cancel');
  });

  it('shows nothing when there are none, and when the list cannot be read', async () => {
    await mount();
    expect(rowsEl()).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ [`GET ${CREATE}`]: new Answer(500, {}) });
    expect(rowsEl()).toBeNull();
  });

  it('re-reads the list after create, so the row comes from the server', async () => {
    stubClipboard();
    const calls = await createFor('Marko');
    await click(A.copyInvite);
    await click(A.done);
    expect(calls.filter((c) => c.method === 'GET' && c.url === CREATE).length).toBeGreaterThan(1);
    expect(rowsEl()?.textContent).toContain(waitingToAccept('Marko'));
    expect(rowsEl()?.textContent).not.toContain(PAYLOAD);
    expect(attributesWithLink()).toEqual([]);
  });

  it('keeps the rows across a reload (a fresh page reads the server)', async () => {
    stubClipboard();
    await createFor('Marko');
    await click(A.copyInvite);
    await click(A.done);
    act(() => root.unmount());
    root = createRoot(host);
    await mount();
    expect(rowsEl()?.textContent).toContain(waitingToAccept('Marko'));
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
    expect(rowsEl()?.querySelectorAll('li').length).toBe(1);
    expect(rowsEl()?.textContent).not.toContain('Bo');
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
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(A.cantCancel);
  });

  it('keeps the rows when there are no contacts, instead of the empty state', async () => {
    open = [BO];
    await mount({ [`GET ${LIST}`]: { status: 'ok', contacts: [] } });
    expect(text()).toContain(waitingToAccept('Bo'));
  });
});

describe('UX2-d2: I have an invite', () => {
  async function paste(routes: Routes = {}, value = LINK): Promise<Call[]> {
    const calls = await openSheet({ [`POST ${CHECK}`]: CHECKED, ...routes });
    await click(A.haveInvite);
    await type(field(A.pasteLabel), value);
    return calls;
  }

  it('keeps Check invite disabled while the field is empty', async () => {
    await openSheet();
    await click(A.haveInvite);
    expect(button(A.checkInvite).disabled).toBe(true);
    await type(field(A.pasteLabel), LINK);
    expect(button(A.checkInvite).disabled).toBe(false);
  });

  it('uses a multi-line field, so the link is never an input value attribute', async () => {
    await paste();
    expect(field(A.pasteLabel)).toBeInstanceOf(HTMLTextAreaElement);
    expect(attributesWithLink()).toEqual([]);
  });

  it('checks first without presence, then asks "Is this who you expected?" with name, label and fingerprint', async () => {
    const calls = await paste();
    await click(A.checkInvite);
    const [call] = posts(calls, CHECK);
    expect(call?.headers.get('content-type')).toBe('application/octet-stream');
    expect(call?.headers.get('x-agentlink-presence')).toBeNull();
    expect(JSON.parse(call?.body ?? '')).toEqual({ invite: LINK });
    expect(posts(calls, ACCEPT)).toEqual([]);
    const region = sheet() as HTMLElement;
    expect(region.textContent).toContain(A.isThisWho);
    expect(region.textContent).toContain('“Marko Novak”');
    expect(region.textContent).toContain('Self-declared');
    expect(region.textContent).toContain('7F3A·19C2');
    expect(buttons(A.connect).length).toBe(1);
    expect(buttons(A.cancel).length).toBeGreaterThan(0);
    expect(attributesWithLink()).toEqual([]);
  });

  it('renders the inviter fields as plain text (I-5)', async () => {
    await paste({
      [`POST ${CHECK}`]: {
        ...CHECKED,
        contact: { ...CHECKED.contact, name: '<img src=x onerror=alert(1)>' },
      },
    });
    await click(A.checkInvite);
    expect(document.querySelector('img')).toBeNull();
    expect(text()).not.toContain('onerror');
  });

  it('asks for presence only on Connect and posts the invite once as the operation input', async () => {
    const calls = await paste({
      [`POST ${ACCEPT}`]: {
        status: 'pending',
        contact: CHECKED.contact,
        sent: true,
      },
    });
    await click(A.checkInvite);
    expect(document.querySelector('input[name="owner-code"]')).toBeNull();
    await click(A.connect);
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
    // Done: the sheet closes, the pasted text is gone and the list reloads.
    expect(sheet()).toBeNull();
    expect(calls.filter((c) => c.url === LIST).length).toBe(2);
    expect(attributesWithLink()).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(PAYLOAD);
  });

  it('Cancel goes back without asking for presence', async () => {
    const calls = await paste();
    await click(A.checkInvite);
    await click(buttons(A.cancel)[0] as HTMLButtonElement);
    expect(posts(calls, ACCEPT)).toEqual([]);
    expect(text()).not.toContain(A.isThisWho);
  });

  it.each([
    [new Answer(400, { error: 'expired' }), 'expired'],
    [new Answer(400, { error: 'own_invite' }), 'own'],
    [new Answer(400, { error: 'invalid_invite' }), 'damaged'],
    [new Answer(400, { error: 'invalid' }), 'damaged'],
  ] as const)('explains a refused invite in one sentence (%#)', async (answer, kind) => {
    await paste({ [`POST ${CHECK}`]: answer });
    await click(A.checkInvite);
    const sentence = {
      expired: A.inviteExpired,
      own: A.ownInvite,
      damaged: A.inviteDamaged,
    }[kind];
    expect(sheet()?.textContent).toContain(sentence);
    expect(sheet()?.textContent).toContain(A.askForNew);
    expect(buttons(A.connect)).toEqual([]);
  });

  it('keeps the pasted text when AgentLink cannot be reached', async () => {
    await paste({ [`POST ${CHECK}`]: new TypeError('offline') });
    await click(A.checkInvite);
    expect(sheet()?.textContent).toContain(A.offline);
    expect(field(A.pasteLabel).value).toBe(LINK);
  });
});

const run = (): Promise<axe.AxeResults> =>
  axe.run(document.body, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    rules: { 'color-contrast': { enabled: false } },
  });

describe('UX2-d2: axe', () => {
  it('finds no violation with the sheet open on the form', async () => {
    await openSheet();
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
  it('finds no violation on the ready invite with the QR code shown', async () => {
    stubShare(
      () => Promise.resolve(),
      () => true,
    );
    await createFor('Marko');
    await click(A.showQr);
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
  it('finds no violation on "Is this who you expected?"', async () => {
    await openSheet({ [`POST ${CHECK}`]: CHECKED });
    await click(A.haveInvite);
    await type(field(A.pasteLabel), LINK);
    await click(A.checkInvite);
    expect((await run()).violations.map((v) => v.id)).toEqual([]);
  });
});

const sheets = import.meta.glob<string>('./contacts.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('UX2-d2: the stylesheet', () => {
  it('stills the sheet and the highlight under both reduced-motion rules and stacks at 360', () => {
    const css = sheets['./contacts.css'] ?? '';
    expect(css).toMatch(/\.ct-add-sheet\[data-motion='reduced'\]/);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*\.ct-add-sheet/);
    expect(css).toMatch(/--al-size-control-lg/);
    expect(css).not.toMatch(/backdrop-filter/);
  });
});

describe('UX2-d2: the copy (11 §5)', () => {
  it('uses none of the never-say words', async () => {
    const { lintVocabulary } = await import('@4thtech-io/ui');
    const all = [
      ...(Object.values(A) as readonly string[]),
      inviteReady('Marko'),
      safetyLine('Marko'),
      safetyLine(undefined),
      waitingToAccept('Marko'),
      waitingToAccept(undefined),
      expiresIn(1),
      expiresIn(6),
    ];
    for (const line of all) expect([line, lintVocabulary(line)]).toEqual([line, []]);
  });
});
