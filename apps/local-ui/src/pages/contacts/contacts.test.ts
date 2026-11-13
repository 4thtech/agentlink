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
  // The detail opens in a side sheet when a row is chosen (UI-REFRESH-i); choose the first one.
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('.ct-row')?.click();
  });
  await settle();
  return s.calls;
}

const text = (): string => document.body.textContent ?? '';

/** W4-PEOPLE-INVITE: Rename and Remove sit in the person ⋯ menu. */
async function openMenu(): Promise<void> {
  await act(async () => {
    document.body.querySelector<HTMLButtonElement>('button[aria-label^="More for"]')?.click();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
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

/** UX1113-N2: the name is checked while typing (debounced), before the one button can go. */
async function checked(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  await settle();
}

async function type(selector: string, value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(selector);
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
  await click(S.confirmWithCode);
}

describe('ContactsPage: the list', () => {
  it('shows one next step when there are no contacts', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [] } });
    expect(document.body.querySelector('h1')?.textContent).toBe('People');
    const empty = document.body.querySelector('.al-empty');
    expect(empty?.textContent).toContain(S.emptyTitle);
    expect(empty?.textContent).toContain(`Try: ${S.emptyPrompt}`);
  });

  it('D-141 (08 §1 C2): a renamed contact shows "(was {old})" as plain text in <bdi>', async () => {
    const renamed = { ...marko, name: 'Marko Studio', formerName: '<b>Marko</b>' };
    await mount({ [LIST]: { status: 'ok', contacts: [renamed, ana] } });
    const bdi = document.body.querySelector('.ct-former bdi');
    expect(bdi?.textContent).toBe('(was <b>Marko</b>)');
    expect(document.body.querySelector('.ct-former b')).toBeNull();
    expect(text()).toMatch(/Marko Studio.*\(was /);
    expect(document.body.querySelectorAll('.ct-former').length).toBe(1);
  });

  it('shows names as text and never an ID or key', async () => {
    const evil = { ...marko, name: '<img src=x onerror=alert(1)>' };
    await mount({ [LIST]: { status: 'ok', contacts: [evil, ana] } });
    expect(document.body.querySelector('img')).toBeNull();
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
    expect(text()).toContain('Marko Novak');
    expect(text()).toContain('Not checked yet');
    expect(text()).toContain('Contact checked');
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

describe('ContactsPage: the 12 digits (04 §3.6.1)', () => {
  const routes = (extra: Routes = {}): Routes => ({
    [LIST]: { status: 'ok', contacts: [marko] },
    [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
    ...extra,
  });

  it('nudges with the code and three choices on an unchecked contact', async () => {
    await mount(routes());
    expect(document.body.querySelector('.al-sc-code')?.textContent?.replace(/\s/g, '')).toBe(
      CODE.replace(/\s/g, ''),
    );
    expect(text()).toContain('Want to be sure it’s really Marko Novak?');
    expect(button(S.matchWithCode)).toBeDefined();
    expect(button(S.theyDontMatch)).toBeDefined();
    expect(button(S.skip)).toBeDefined();
  });

  it('UX-031-QUICKWINS: explains the 12 digits in one line', async () => {
    await mount(routes());
    expect(text()).toContain(
      'Compare these 12 digits with the other person by call or in person; if they match, it’s really them.',
    );
  });

  it('Skip hides the nudge and keeps the label Not checked yet; it can come back', async () => {
    const calls = await mount(routes());
    await click(S.skip);
    expect(document.body.querySelector('.al-sc-code')).toBeNull();
    expect(text()).toContain('Not checked yet');
    expect(posts(calls)).toHaveLength(0);
    await click(S.compareCode);
    expect(document.body.querySelector('.al-sc-code')).not.toBeNull();
  });

  it('They match: asks for presence, then posts the shown code for the server to sign', async () => {
    const calls = await mount(
      routes({ [`POST /api/ui/contacts/${MARKO}/check`]: { status: 'done' } }),
    );
    await click(S.matchWithCode);
    expect(posts(calls)).toHaveLength(0);
    expect(document.body.querySelector('input[name="owner-code"]')).not.toBeNull();
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
    await click(S.removeWithCode);
    await confirmWithCode();
    const sent = posts(calls);
    expect(sent.map((c) => c.url)).toEqual([`/api/ui/contacts/${MARKO}/remove`]);
    expect(inputOf(sent[0] as Call)).toBeUndefined();
  });

  it('a wrong master code changes nothing and says so', async () => {
    await mount(
      routes({
        [`POST /api/ui/contacts/${MARKO}/check`]: new Answer(403, {
          status: 'presence_rejected',
        }),
      }),
    );
    await click(S.matchWithCode);
    await confirmWithCode('WRONG');
    expect(text()).toContain(S.presenceRejected);
    expect(text()).not.toContain(S.matched);
  });

  it('a code that changed meanwhile is refused and the owner compares again', async () => {
    await mount(
      routes({ [`POST /api/ui/contacts/${MARKO}/check`]: new Answer(409, { status: 'refused' }) }),
    );
    await click(S.matchWithCode);
    await confirmWithCode();
    expect(text()).toContain(S.refused);
  });

  it('shows no code while the other agent has not answered', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [{ ...marko, pairing: 'pending' }] } });
    expect(document.body.querySelector('.al-sc-code')).toBeNull();
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
    await openMenu();
    await click(S.rename);
    await type('input[name="alias"]', 'Ana K');
    await checked();
    await click(S.renameWithCode);
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
    await openMenu();
    await click(S.rename);
    await type('input[name="alias"]', 'Marko');
    await checked();
    expect(text()).toContain(S.aliasTaken);
    expect(button(S.renameWithCode).disabled).toBe(true);
    expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
    expect(posts(calls)).toHaveLength(0);
  });

  it('Remove confirms first, then asks for presence', async () => {
    const calls = await mount({
      [LIST]: { status: 'ok', contacts: [ana] },
      [`POST /api/ui/contacts/${ANA}/remove`]: { status: 'done' },
    });
    await openMenu();
    await click(S.remove);
    expect(posts(calls)).toHaveLength(0);
    expect(text()).toContain(S.removeExplain);
    await click(S.removeWithCode);
    await confirmWithCode();
    expect(posts(calls).map((c) => c.url)).toEqual([`/api/ui/contacts/${ANA}/remove`]);
  });

  it('Cancel at the presence step sends nothing', async () => {
    const calls = await mount({ [LIST]: { status: 'ok', contacts: [ana] } });
    await openMenu();
    await click(S.remove);
    await click(S.removeWithCode);
    await click(S.cancel);
    expect(posts(calls)).toHaveLength(0);
    expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
  });
});

// WP-12 (F-2; D-72; 04 §2.5.1 `contact.block`, `contact.unblock`): Block and Unblock in the person
// ⋯ menu. Block explains first, then asks for owner presence; Unblock asks for presence. Each is one
// POST to a presence route; the page never signs.
describe('ContactsPage: block and unblock (WP-12)', () => {
  it('Block explains first, then asks for presence, then posts /block and says Blocked', async () => {
    const calls = await mount({
      [LIST]: { status: 'ok', contacts: [ana] },
      [`POST /api/ui/contacts/${ANA}/block`]: { status: 'done' },
    });
    await openMenu();
    await click(S.block);
    expect(posts(calls)).toHaveLength(0);
    expect(text()).toContain(S.blockExplain);
    await click(S.blockWithCode);
    expect(text()).toContain('Block Ana.');
    await confirmWithCode();
    const sent = posts(calls);
    expect(sent.map((c) => c.url)).toEqual([`/api/ui/contacts/${ANA}/block`]);
    expect(inputOf(sent[0] as Call)).toBeUndefined();
    expect(text()).toContain(S.blockedNow);
  });

  it('a blocked contact offers one Unblock button (no Block); it asks for the master code and posts /unblock', async () => {
    const calls = await mount({
      [LIST]: { status: 'ok', contacts: [{ ...ana, status: 'blocked' }] },
      [`POST /api/ui/contacts/${ANA}/unblock`]: { status: 'done' },
    });
    expect(text()).toContain(S.blockedDetail);
    await openMenu();
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map(
      (i) => i.textContent,
    );
    // UX1113-N2: Unblock is one button in the detail, not a menu step.
    expect(items).not.toContain(S.unblock);
    expect(items).not.toContain(S.block);
    await click(S.unblockWithCode);
    expect(text()).toContain('Unblock Ana.');
    await confirmWithCode();
    expect(posts(calls).map((c) => c.url)).toEqual([`/api/ui/contacts/${ANA}/unblock`]);
    expect(text()).toContain(S.unblocked);
  });

  it('a revoked contact offers neither Block nor Unblock', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [{ ...ana, status: 'revoked' }] } });
    await openMenu();
    const items = [...document.body.querySelectorAll('[role="menuitem"]')].map(
      (i) => i.textContent,
    );
    expect(items).not.toContain(S.block);
    expect(items).not.toContain(S.unblock);
  });

  it('Cancel at the explain step or the presence step sends nothing', async () => {
    const calls = await mount({ [LIST]: { status: 'ok', contacts: [ana] } });
    await openMenu();
    await click(S.block);
    await click(S.cancel);
    expect(text()).not.toContain(S.blockExplain);
    await openMenu();
    await click(S.block);
    await click(S.blockWithCode);
    await click(S.cancel);
    expect(posts(calls)).toHaveLength(0);
    expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
  });

  it('the copy follows 11 §5: plain words, no wallet, key or address', () => {
    for (const line of [
      S.block,
      S.unblock,
      S.blockContact,
      S.blockExplain,
      S.blockedNow,
      S.unblocked,
    ]) {
      expect(line).not.toMatch(/wallet|gas|seed|transaction|key|address|0x/i);
    }
  });
});

describe('the page markup', () => {
  it('has no inline style and no raw HTML', async () => {
    await mount({
      [LIST]: { status: 'ok', contacts: [marko, ana] },
      [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
    });
    expect(document.body.querySelector('[style]')).toBeNull();
  });
});

describe('ContactsPage: same names (UX 2026-11-12 §5)', () => {
  const SAME = 'Another person has the same name.';

  it('lists two active people with the same name and no warning, told apart by the date', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        contacts: [
          { ...ana, name: 'oc-test' },
          { ...ana, ref: MARKO, name: 'oc-test', since: 1_759_536_000 },
        ],
      },
    });
    expect(document.body.querySelectorAll('.ct-row').length).toBe(2);
    expect(text()).not.toContain(SAME);
    const lines = [...document.body.querySelectorAll('.ct-line')].map((l) => l.textContent);
    expect(new Set(lines).size).toBe(2);
    expect(document.body.querySelector('.ct-row bdi')?.textContent).toBe('oc-test');
  });

  it('moves a removed person to Archived with the removed copy; no same-name text anywhere', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        contacts: [
          { ...ana, name: 'oc-test', status: 'revoked', since: 1_759_536_000 },
          { ...ana, ref: MARKO, name: 'oc-test', since: 1_762_000_000 },
        ],
      },
    });
    expect(document.body.querySelectorAll('.ct-list:not(.ct-list-archived) .ct-row').length).toBe(
      1,
    );
    const archived = document.body.querySelector('details.ct-archived');
    expect(archived?.hasAttribute('open')).toBe(false);
    expect(archived?.querySelector('summary')?.textContent).toBe('Archived (1)');
    expect(archived?.querySelectorAll('.ct-row').length).toBe(1);
    const line = archived?.querySelector('.ct-line')?.textContent ?? '';
    expect(line).toContain('They removed this connection.');
    expect(line).toContain('You connected again on');
    expect(line).toContain('The old conversation stays here.');
    expect(text()).not.toContain(SAME);
    expect(text()).not.toContain('No longer active');
    expect(text()).toContain('1 person');
  });

  it('shows no Archived group when nobody was removed', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [marko, ana] } });
    expect(document.body.querySelector('.ct-archived')).toBeNull();
    expect(text()).not.toContain(SAME);
  });
});

describe('ContactsPage: a second connection with the same owner (M1-UX3-DUP-CONTACTS)', () => {
  const OLD = { ...ana, name: 'oc-test', label: 'self-declared', since: 1_761_350_400 };
  const NEW = { ...OLD, ref: MARKO, since: 1_761_523_200, olderSameOwner: ANA };
  const NOTICE_START = 'Looks like a second connection with ';
  const KEY = 'agentlink.contacts.duplicates-kept.v1';
  const paired = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(
    new Date(OLD.since * 1000),
  );

  beforeEach(() => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // no storage in this environment
    }
  });

  async function selectNewer(): Promise<void> {
    const rows = document.body.querySelectorAll<HTMLButtonElement>('.ct-row');
    await act(async () => {
      rows[1]?.click();
    });
    await settle();
  }

  it('shows one calm notice on the newer contact, naming the older one and its date', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [OLD, NEW] } });
    expect(text()).not.toContain(NOTICE_START); // the older one is selected first
    await selectNewer();
    expect(text()).toContain(
      `${NOTICE_START}oc-test (paired ${paired}). Keep both, or remove the older one?`,
    );
    expect(document.body.querySelectorAll('.ct-dup')).toHaveLength(1);
    button(S.keepBoth);
    button(S.removeOlder);
  });

  it('Remove older uses the existing remove route and asks for presence first', async () => {
    const calls = await mount({
      [LIST]: { status: 'ok', contacts: [OLD, NEW] },
      [`POST /api/ui/contacts/${ANA}/remove`]: { status: 'done' },
    });
    await selectNewer();
    await click(S.removeOlder);
    // PRE-031-FIXES: the same confirm step as Remove comes first, then presence.
    expect(posts(calls)).toHaveLength(0);
    expect(document.body.querySelector('.ct-confirm')?.textContent).toContain(S.removeExplain);
    expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
    await click(S.removeWithCode);
    expect(posts(calls)).toHaveLength(0);
    expect(document.body.querySelector('input[name="owner-code"]')).not.toBeNull();
    await confirmWithCode();
    expect(posts(calls).map((c) => c.url)).toEqual([`/api/ui/contacts/${ANA}/remove`]);
  });

  it('Cancel at the presence step removes nothing', async () => {
    const calls = await mount({ [LIST]: { status: 'ok', contacts: [OLD, NEW] } });
    await selectNewer();
    await click(S.removeOlder);
    await click(S.removeWithCode);
    expect(document.body.querySelector('input[name="owner-code"]')).not.toBeNull();
    await click(S.cancel);
    expect(posts(calls)).toHaveLength(0);
  });

  it('PRE-031-FIXES: Remove older asks "Remove this contact?" first; Cancel there asks for nothing', async () => {
    const calls = await mount({ [LIST]: { status: 'ok', contacts: [OLD, NEW] } });
    await selectNewer();
    await click(S.removeOlder);
    expect(text()).toContain(S.removeExplain);
    expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
    expect(document.body.querySelector('.ct-dup')).toBeNull(); // one step at a time
    await click(S.cancel);
    expect(text()).not.toContain(S.removeExplain);
    expect(document.body.querySelector('input[name="owner-code"]')).toBeNull();
    expect(text()).toContain(NOTICE_START); // back to the notice
    expect(posts(calls)).toHaveLength(0);
  });

  it('PRE-031-FIXES: the Remove older button is described by the notice text', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [OLD, NEW] } });
    await selectNewer();
    const id = button(S.removeOlder).getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    const described = document.body.querySelector(`[id="${id ?? ''}"]`);
    expect(described?.textContent).toContain(NOTICE_START);
    expect(document.body.querySelector('.ct-dup')?.contains(described ?? null)).toBe(true);
  });

  it('Keep both hides the notice and remembers it in this browser only', async () => {
    const calls = await mount({ [LIST]: { status: 'ok', contacts: [OLD, NEW] } });
    await selectNewer();
    await click(S.keepBoth);
    expect(text()).not.toContain(NOTICE_START);
    expect(posts(calls)).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ [LIST]: { status: 'ok', contacts: [OLD, NEW] } });
    await selectNewer();
    expect(text()).not.toContain(NOTICE_START);
  });

  it('still works when browser storage is blocked', async () => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    Storage.prototype.setItem = () => {
      throw new Error('blocked');
    };
    try {
      await mount({ [LIST]: { status: 'ok', contacts: [OLD, NEW] } });
      await selectNewer();
      expect(text()).toContain(NOTICE_START);
      await click(S.keepBoth);
      expect(text()).not.toContain(NOTICE_START);
    } finally {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    }
  });

  it('same name but a different owner: no removal suggestion', async () => {
    await mount({
      [LIST]: { status: 'ok', contacts: [OLD, { ...OLD, ref: MARKO, since: NEW.since }] },
    });
    await selectNewer();
    expect(text()).not.toContain('Another person has the same name.');
    expect(text()).not.toContain(NOTICE_START);
    expect(document.body.querySelector('.ct-dup')).toBeNull();
  });

  it('ignores a link to a contact that is not in the list, or of the wrong shape', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        contacts: [OLD, { ...NEW, olderSameOwner: `0x${'9'.repeat(40)}` }],
      },
    });
    await selectNewer();
    expect(text()).not.toContain(NOTICE_START);
    act(() => root.unmount());
    root = createRoot(host);
    await mount({
      [LIST]: { status: 'ok', contacts: [OLD, { ...NEW, olderSameOwner: 'ANA' }] },
    });
    await selectNewer();
    expect(text()).not.toContain(NOTICE_START);
  });

  it('renders the older contact’s name as text, never as markup', async () => {
    await mount({
      [LIST]: {
        status: 'ok',
        contacts: [{ ...OLD, nameSource: 'counterparty', name: '<img src=x>' }, NEW],
      },
    });
    await selectNewer();
    expect(document.body.querySelector('.ct-dup')).not.toBeNull();
    expect(document.body.querySelector('.ct-dup img')).toBeNull();
  });
});

describe('ContactsPage: the Home link to the 12 digits (W5-SAFETY-STEP)', () => {
  const open = async (search: string): Promise<void> => {
    history.replaceState(null, '', `/contacts${search}`);
    const s = server({
      'GET /api/owner/passkey': NO_PASSKEY,
      [LIST]: { status: 'ok', contacts: [ana, marko] },
      [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
    });
    const api = createApiClient({ fetch: s.fetch, token: 't' });
    const owner = createOwnerClient({ fetch: s.fetch, token: 't' });
    await act(async () => {
      root.render(createElement<ContactsPageProps>(ContactsPage, { api, owner }));
      await Promise.resolve();
    });
    await settle();
  };
  afterEach(() => history.replaceState(null, '', '/'));

  it('?check=<ref> opens that contact panel at the code, and cleans the address', async () => {
    await open(`?check=${MARKO}`);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.querySelector('.al-sc-code')?.textContent?.replace(/\s/g, '')).toBe(
      CODE.replace(/\s/g, ''),
    );
    expect(location.search).toBe('');
    // Completion is still the signed "They match"; nothing here marks it done.
    expect(button(S.matchWithCode)).toBeDefined();
  });

  it('without the marker, or with a stranger ref, no panel opens by itself', async () => {
    await open('');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    await open('?check=0x0000000000000000000000000000000000000009');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
