// @vitest-environment jsdom
// SEC-INVITE-CAPS (D-156; 08 §1; 11 §5): a contact your AI connected through its own invite waits for
// you. People marks the row ("New via your AI") and, on the person, says what it means with Keep
// (owner presence, `POST /api/ui/contacts/:ref/keep`; the page never signs) and Remove. Home shows a
// count and links to People; the widget lists it under Needs you. Never the contact's name in Home's
// banner (I-5).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { ViaAiBanner } from '../home/home-screen.js';
import { HOME_STRINGS as HS } from '../home/people-strings.js';
import { newViaAi } from '../widget/strings.js';
import { parseList, type ContactRow } from './data.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { createInviteApi } from './invite-api.js';
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

const ANA = `0x${'a1'.repeat(20)}`;
const listRow = (waiting: boolean): Record<string, unknown> => ({
  ref: ANA,
  name: 'Ana',
  nameSource: 'counterparty',
  fingerprint: '7F3A·19C2',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_760_000_000,
  ...(waiting ? { waitingForOwner: true } : {}),
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

function server(routes: Record<string, { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: new Headers(init?.headers) });
    const answer = routes[`${method} ${url}`] ?? { status: 404, body: {} };
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

const buttons = (label: string): HTMLButtonElement[] =>
  [...document.body.querySelectorAll('button')].filter(
    (b) => (b.textContent ?? '').trim() === label,
  );

async function click(label: string): Promise<void> {
  const [found] = buttons(label);
  if (found === undefined) throw new Error(`no button "${label}" in: ${host.textContent ?? ''}`);
  await act(async () => {
    found.click();
  });
  await settle();
}

describe('the list row (data)', () => {
  it('carries waitingForOwner only when the server says exactly true', () => {
    const list = parseList({ status: 'ok', contacts: [listRow(true)] });
    if (list.kind !== 'ok') throw new Error('test: not parsed');
    expect(list.contacts[0]?.waitingForOwner).toBe(true);
    const other = parseList({
      status: 'ok',
      contacts: [{ ...listRow(false), waitingForOwner: 'yes' }],
    });
    if (other.kind !== 'ok') throw new Error('test: not parsed');
    expect(other.contacts[0]?.waitingForOwner).toBeUndefined();
  });
});

describe('People: a contact your AI connected', () => {
  async function mount(extra: Record<string, { status: number; body: unknown }> = {}) {
    const s = server({
      'GET /api/owner/passkey': {
        status: 200,
        body: { passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' } },
      },
      'GET /api/ui/contacts': { status: 200, body: { status: 'ok', contacts: [listRow(true)] } },
      'GET /api/ui/invites': { status: 200, body: { invites: [], connecting: [] } },
      ...extra,
    });
    const api = createApiClient({ fetch: s.fetch, token: 't' });
    const owner = createOwnerClient({ fetch: s.fetch, token: 't' });
    const invites = createInviteApi({ fetch: s.fetch, token: 't' });
    await act(async () => {
      root.render(h<ContactsPageProps>(ContactsPage, { api, owner, invites, pollMs: 60_000 }));
      await Promise.resolve();
    });
    await settle();
    return s.calls;
  }

  it('marks the row, explains it, and Keep asks for presence and posts /keep', async () => {
    const calls = await mount({
      [`POST /api/ui/contacts/${ANA}/keep`]: { status: 200, body: { status: 'done' } },
    });
    expect(host.textContent).toContain(S.viaAiChip);
    const row = host.querySelector<HTMLButtonElement>('button.ct-row');
    if (row === null) throw new Error('no person row');
    await act(async () => {
      row.click();
    });
    await settle();
    expect(document.body.textContent).toContain(S.viaAiTitle);
    expect(document.body.textContent).toContain(S.viaAiDetail);
    expect(buttons(S.remove).length).toBeGreaterThan(0);
    await click(S.keepWithCode);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    const input = document.body.querySelector<HTMLInputElement>('input[name="owner-code"]');
    if (input === null) throw new Error('no master code field');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'ABCD-EFGH',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(S.confirmWithCode);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual([`/api/ui/contacts/${ANA}/keep`]);
    expect(document.body.textContent).toContain(S.keptNow);
  });
});

describe('Home and the widget', () => {
  it('Home says how many wait and links to People, never a name', () => {
    const one = new Map<string, ContactRow>([
      [ANA, { ...(parseListRow(listRow(true)) as ContactRow) }],
    ]);
    act(() => root.render(h(ViaAiBanner, { contacts: one })));
    expect(host.textContent).toContain(HS.viaAiOne);
    expect(host.textContent).not.toContain('Ana');
    expect(host.querySelector('a[data-via-ai-open]')?.getAttribute('href')).toBe('/people');
    act(() =>
      root.render(
        h(ViaAiBanner, { contacts: new Map([[ANA, parseListRow(listRow(false)) as ContactRow]]) }),
      ),
    );
    expect(host.textContent).toBe('');
  });

  it('the widget line', () => {
    expect(newViaAi(1)).toBe('New contact via your AI');
    expect(newViaAi(2)).toBe('2 new contacts via your AI');
  });
});

function parseListRow(raw: Record<string, unknown>): ContactRow | undefined {
  const list = parseList({ status: 'ok', contacts: [raw] });
  return list.kind === 'ok' ? list.contacts[0] : undefined;
}
