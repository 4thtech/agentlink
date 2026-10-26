// @vitest-environment jsdom
// M1-11c-a2: the Contacts page (d1 Local-contacts with DESIGN-ADJ-1 CO-4, CO-5, X-7, X-11; 04
// §3.6.1; 11 §5.2, §6.2; UX audit 3b, 10a).
//
// - The list shows names, never keys: the owner's alias, or the contact's own name under the name
//   rule, as text. No ID, address or fingerprint in the default view (the short fingerprint appears
//   only as the name rule's fallback).
// - An unchecked, paired contact gets the safety-code nudge with "They match", "They don't match"
//   and "Skip". "They match" asks for owner presence and posts the code it showed; the server signs.
//   "They don't match" signs nothing by itself: it says what happened and offers Remove.
// - Rename and Remove ask for owner presence; every change is one POST with an octet-stream body
//   (the presence proof) and the operation input in X-AgentLink-Input. The page never signs.
// - Empty: one next step, what to ask the AI.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { createOwnerClient } from './owner.js';
import { CONTACTS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const MARKO = '0x7f3a19c200000000000000000000000000000001';
const ANA = '0x4c21a0f700000000000000000000000000000002';
const CODE = '4821 0937 5512';
const LIST = '/api/ui/contacts';

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
    calls.push({ url, method, headers: new Headers(init?.headers), body });
    const found = routes[`${method} ${url}`] ?? (method === 'GET' ? routes[url] : undefined);
    const value = typeof found === 'function' ? (found as () => unknown)() : found;
    if (value === undefined) return new Response('{}', { status: 404 });
    const answer = value instanceof Answer ? value : new Answer(200, value);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const marko = {
  ref: MARKO,
  name: 'Marko Novak',
  nameSource: 'counterparty',
  fingerprint: '7F3A·19C2',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
};
const ana = {
  ref: ANA,
  name: 'Ana',
  nameSource: 'owner',
  label: 'safety-code-checked',
  status: 'active',
  pairing: 'complete',
  since: 1_759_449_600,
};

const NO_PASSKEY = {
  passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
};

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(routes: Routes): Promise<Call[]> {
  const s = server({ 'GET /api/owner/passkey': NO_PASSKEY, ...routes });
  const api = createApiClient({ fetch: s.fetch, token: 't' });
  const owner = createOwnerClient({ fetch: s.fetch, token: 't' });
  await act(async () => {
    root.render(createElement<ContactsPageProps>(ContactsPage, { api, owner }));
    await Promise.resolve();
  });
  await settle();
  return s.calls;
}

const text = (): string => host.textContent ?? '';

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
  await settle();
}

async function type(selector: string, value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>(selector);
  if (input === null) throw new Error(`no input ${selector}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The operation input the page sent (X-AgentLink-Input, base64url JSON). */
function inputOf(call: Call): unknown {
  const raw = call.headers.get('x-agentlink-input');
  if (raw === null) return undefined;
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

const posts = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'POST');

async function confirmWithCode(code = 'ABCD-EFGH'): Promise<void> {
  await type('input[name="owner-code"]', code);
  await click(S.confirm);
}

describe('ContactsPage: the list', () => {
  it('shows one next step when there are no contacts', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [] } });
    expect(host.querySelector('h1')?.textContent).toBe('Contacts');
    const empty = host.querySelector('.al-empty');
    expect(empty?.textContent).toContain(S.emptyTitle);
    expect(empty?.textContent).toContain(`Try: ${S.emptyPrompt}`);
  });

  it('shows names as text and never an ID or key', async () => {
    const evil = { ...marko, name: '<img src=x onerror=alert(1)>' };
    await mount({ [LIST]: { status: 'ok', contacts: [evil, ana] } });
    expect(host.querySelector('img')).toBeNull();
    expect(text()).toContain('Ana');
    expect(text()).not.toContain(MARKO);
    expect(text()).not.toContain(ANA);
    expect(text()).not.toMatch(/0x[0-9a-f]{6}/i);
    // The unusable name falls back to the fingerprint (the name rule), never the raw text.
    expect(text()).toContain('Contact');
    expect(text()).not.toContain('onerror');
  });

  it('shows the label for a contact name and none of the web3 words', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [marko, ana] } });
    expect(text()).toContain('“Marko Novak”');
    expect(text()).toContain('Self-declared');
    expect(text()).toContain('Safety code checked');
    expect(text()).not.toMatch(/wallet|gas|seed phrase|transaction|address|hash|chain/i);
    // A paired contact never shows presence (X-11).
    expect(text()).not.toMatch(/online|last seen/i);
  });

  it('shows blocked and waiting contacts with a word, not only a colour', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        contacts: [
          { ...marko, status: 'blocked' },
          { ...ana, ref: ANA, pairing: 'pending', label: 'self-declared' },
        ],
      },
    });
    expect(text()).toContain(S.blocked);
    expect(text()).toContain(S.waiting);
  });

  it('says when AgentLink is not set up, and when contacts cannot load', async () => {
    await mount({ [LIST]: new Answer(409, { error: 'not_set_up' }) });
    expect(text()).toContain(S.notSetUp);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ [LIST]: new Answer(503, { error: 'unavailable' }) });
    expect(text()).toContain(S.listUnavailable);
  });
});

describe('ContactsPage: the safety code (04 §3.6.1)', () => {
  const routes = (extra: Routes = {}): Routes => ({
    [LIST]: { status: 'ok', contacts: [marko] },
    [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
    ...extra,
  });

  it('nudges with the code and three choices on an unchecked contact', async () => {
    await mount(routes());
    expect(host.querySelector('.al-sc-code')?.textContent?.replace(/\s/g, '')).toBe(
      CODE.replace(/\s/g, ''),
    );
    expect(text()).toContain('Want to be sure it’s really “Marko Novak”?');
    expect(button(S.theyMatch)).toBeDefined();
    expect(button(S.theyDontMatch)).toBeDefined();
    expect(button(S.skip)).toBeDefined();
  });

  it('UX-031-QUICKWINS: explains the safety code in one line', async () => {
    await mount(routes());
    expect(text()).toContain(
      'Compare these 12 digits with the other person by call or in person; if they match, it’s really them.',
    );
  });

  it('Skip hides the nudge and keeps the label Self-declared; it can come back', async () => {
    const calls = await mount(routes());
    await click(S.skip);
    expect(host.querySelector('.al-sc-code')).toBeNull();
    expect(text()).toContain('Self-declared');
    expect(posts(calls)).toHaveLength(0);
    await click(S.compareCode);
    expect(host.querySelector('.al-sc-code')).not.toBeNull();
  });

  it('They match: asks for presence, then posts the shown code for the server to sign', async () => {
    const calls = await mount(
      routes({ [`POST /api/ui/contacts/${MARKO}/check`]: { status: 'done' } }),
    );
    await click(S.theyMatch);
    expect(posts(calls)).toHaveLength(0);
    expect(host.querySelector('input[name="owner-code"]')).not.toBeNull();
    await confirmWithCode('ABCD-EFGH');
    const sent = posts(calls);
    expect(sent).toHaveLength(1);
    const post = sent[0] as Call;
    expect(post.url).toBe(`/api/ui/contacts/${MARKO}/check`);
    expect(post.headers.get('content-type')).toBe('application/octet-stream');
    expect(post.headers.get('x-agentlink-csrf')).toBe('t');
    expect(post.headers.get('x-agentlink-presence')).toBeNull();
    expect(post.body).toBe('ABCD-EFGH');
    expect(inputOf(post)).toEqual({ code: CODE });
    expect(text()).toContain(S.matched);
  });

  it("They don't match: signs nothing, explains, and offers Remove", async () => {
    const calls = await mount(
      routes({ [`POST /api/ui/contacts/${MARKO}/remove`]: { status: 'done' } }),
    );
    await click(S.theyDontMatch);
    expect(posts(calls)).toHaveLength(0);
    expect(text()).toContain(S.mismatchTitle);
    await click(S.removeContact);
    await confirmWithCode();
    const sent = posts(calls);
    expect(sent.map((c) => c.url)).toEqual([`/api/ui/contacts/${MARKO}/remove`]);
    expect(inputOf(sent[0] as Call)).toBeUndefined();
  });

  it('a wrong owner code changes nothing and says so', async () => {
    await mount(
      routes({
        [`POST /api/ui/contacts/${MARKO}/check`]: new Answer(403, {
          status: 'presence_rejected',
        }),
      }),
    );
    await click(S.theyMatch);
    await confirmWithCode('WRONG');
    expect(text()).toContain(S.presenceRejected);
    expect(text()).not.toContain(S.matched);
  });

  it('a code that changed meanwhile is refused and the owner compares again', async () => {
    await mount(
      routes({ [`POST /api/ui/contacts/${MARKO}/check`]: new Answer(409, { status: 'refused' }) }),
    );
    await click(S.theyMatch);
    await confirmWithCode();
    expect(text()).toContain(S.refused);
  });

  it('shows no code while the other agent has not answered', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [{ ...marko, pairing: 'pending' }] } });
    expect(host.querySelector('.al-sc-code')).toBeNull();
    expect(text()).toContain(S.waiting);
  });
});

describe('ContactsPage: rename and remove', () => {
  it('Rename checks the name first, then asks for presence and posts the alias', async () => {
    const calls = await mount({
      [LIST]: { status: 'ok', contacts: [ana] },
      [`/api/ui/contacts/${ANA}/rename-check?alias=Ana%20K`]: { status: 'ok' },
      [`POST /api/ui/contacts/${ANA}/rename`]: { status: 'done' },
    });
    await click(S.rename);
    await type('input[name="alias"]', 'Ana K');
    await click(S.saveName);
    await confirmWithCode();
    const sent = posts(calls);
    expect(sent.map((c) => c.url)).toEqual([`/api/ui/contacts/${ANA}/rename`]);
    expect(inputOf(sent[0] as Call)).toEqual({ alias: 'Ana K' });
  });

  it('Rename says why a name is refused and asks for nothing', async () => {
    const calls = await mount({
      [LIST]: { status: 'ok', contacts: [ana] },
      [`/api/ui/contacts/${ANA}/rename-check?alias=Marko`]: {
        status: 'refused',
        reason: 'alias_taken',
      },
    });
    await click(S.rename);
    await type('input[name="alias"]', 'Marko');
    await click(S.saveName);
    expect(text()).toContain(S.aliasTaken);
    expect(host.querySelector('input[name="owner-code"]')).toBeNull();
    expect(posts(calls)).toHaveLength(0);
  });

  it('Remove confirms first, then asks for presence', async () => {
    const calls = await mount({
      [LIST]: { status: 'ok', contacts: [ana] },
      [`POST /api/ui/contacts/${ANA}/remove`]: { status: 'done' },
    });
    await click(S.remove);
    expect(posts(calls)).toHaveLength(0);
    expect(text()).toContain(S.removeExplain);
    await click(S.removeContact);
    await confirmWithCode();
    expect(posts(calls).map((c) => c.url)).toEqual([`/api/ui/contacts/${ANA}/remove`]);
  });

  it('Cancel at the presence step sends nothing', async () => {
    const calls = await mount({ [LIST]: { status: 'ok', contacts: [ana] } });
    await click(S.remove);
    await click(S.removeContact);
    await click(S.cancel);
    expect(posts(calls)).toHaveLength(0);
    expect(host.querySelector('input[name="owner-code"]')).toBeNull();
  });
});

describe('the page markup', () => {
  it('has no inline style and no raw HTML', async () => {
    await mount({
      [LIST]: { status: 'ok', contacts: [marko, ana] },
      [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
    });
    expect(host.querySelector('[style]')).toBeNull();
  });
});

describe('ContactsPage: duplicate names (UX-031-QUICKWINS)', () => {
  const SAME = 'Another contact has the same name.';

  it('hints on both rows when two contacts show the same name', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        contacts: [
          { ...ana, name: 'oc-test' },
          { ...ana, ref: MARKO, name: 'oc-test', since: 1_759_536_000 },
        ],
      },
    });
    expect(host.querySelectorAll('.ct-row').length).toBe(2);
    expect(host.querySelector('.ct-list')?.textContent?.split(SAME).length).toBe(3);
  });

  it('shows no hint when names differ', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [marko, ana] } });
    expect(text()).not.toContain(SAME);
  });
});
