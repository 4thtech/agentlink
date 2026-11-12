// @vitest-environment jsdom
// WP-P2 (design-1112 spec §5, third bullet): People across all IDs.
//
// - With one ID nothing changes: no ID filter, no "with {ID}".
// - With 2+ IDs: one list of every ID's people, "with {ID}" on each row, the "All my IDs" filter
//   and the "Find a person" search; an ID that cannot be read is missing with a plain note.
// - Opening a person of another ID runs the existing switch (no Touch ID) with "Opening {ID}…" and
//   asks the shell to open that person's panel afterwards (`?check=<ref>`).
// - Names (people and IDs) are text only, inside <bdi> (I-5): hostile names never become markup.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { parsePeopleAll } from './data.js';
import { ContactsPage, type ContactsPageProps } from './index.js';
import { createOwnerClient } from './owner.js';
import { ALL_IDS } from './strings.js';

const switchAgent = vi.fn<(name: string) => Promise<{ kind: string }>>();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  switchAgent.mockReset();
  history.replaceState(null, '', '/people');
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const MARKO = '0x7f3a19c200000000000000000000000000000001';
const ANA = '0x4c21a0f700000000000000000000000000000002';
const OC = '0x9d0000000000000000000000000000000000000c';
const HOSTILE = '<img src=x onerror="alert(1)">';
const HOSTILE_ID = '<b>evil</b>‮id';

const person = (ref: string, name: string, over: Record<string, unknown> = {}) => ({
  ref,
  name,
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1_762_000_000,
  ...over,
});
const marko = person(MARKO, 'Marko Novak');
const natasa = person(ANA, 'Natasa', { label: 'safety-code-checked' });
const oc = person(OC, 'oc-test');

function server(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const value = routes[`${method} ${url}`] ?? routes[url];
    if (value === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const twoIds = (
  otherContacts: unknown[] | 'unavailable' = [oc],
  otherLabel = 'macbook-agent-1',
) => ({
  status: 'ok',
  switchable: true,
  ids: [
    { name: 'default', label: 'Tali', current: true, status: 'ok', contacts: [natasa, marko] },
    otherContacts === 'unavailable'
      ? { name: 'mac', label: otherLabel, current: false, status: 'unavailable' }
      : { name: 'mac', label: otherLabel, current: false, status: 'ok', contacts: otherContacts },
  ],
});

async function mount(people: unknown, own: unknown[] = [natasa, marko]): Promise<void> {
  const fetchFn = server({
    'GET /api/owner/passkey': {
      passkey: { registered: false, rpId: 'localhost', userId: 'AA', prfSalt: 'AA' },
    },
    '/api/ui/contacts': { status: 'ok', contacts: own },
    ...(people === undefined ? {} : { '/api/ui/people': people }),
  });
  const api = createApiClient({ fetch: fetchFn, token: 't' });
  const owner = createOwnerClient({ fetch: fetchFn, token: 't' });
  await act(async () => {
    root.render(
      createElement<ContactsPageProps>(ContactsPage, { api, owner, switchTo: switchAgent }),
    );
    await Promise.resolve();
  });
  await settle();
}

const text = (): string => host.textContent ?? '';
const rows = (): HTMLButtonElement[] => [
  ...host.querySelectorAll<HTMLButtonElement>('.ct-list:not(.ct-list-archived) .ct-row'),
];
const filter = (): HTMLSelectElement | null =>
  host.querySelector<HTMLSelectElement>('.ct-idfilter select');
const search = (): HTMLInputElement | null =>
  host.querySelector<HTMLInputElement>('.ct-search input');

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

describe('People across all IDs (WP-P2)', () => {
  it('with one ID: no filter and no "with {ID}"; the search is there', async () => {
    await mount({
      status: 'ok',
      switchable: true,
      ids: [{ name: 'default', label: 'Tali', current: true, status: 'ok', contacts: [marko] }],
    });
    expect(filter()).toBeNull();
    expect(host.querySelector('.ct-with')).toBeNull();
    expect(search()?.placeholder).toBe(ALL_IDS.search);
    expect(rows()).toHaveLength(2);
  });

  it('when the all-IDs read is missing the page keeps the open ID’s list', async () => {
    await mount(undefined);
    expect(filter()).toBeNull();
    expect(rows().map((r) => r.querySelector('bdi')?.textContent)).toEqual([
      'Natasa',
      'Marko Novak',
    ]);
  });

  it('with two IDs: one list, "with {ID}" on each row, the filter and the count', async () => {
    await mount(twoIds());
    expect(rows()).toHaveLength(3);
    expect(rows().map((r) => r.querySelector('.ct-with')?.textContent)).toEqual([
      'with Tali',
      'with Tali',
      'with macbook-agent-1',
    ]);
    const options = [...(filter()?.options ?? [])].map((o) => o.textContent);
    expect(options).toEqual([ALL_IDS.allIds, 'Tali', 'macbook-agent-1']);
    expect(host.querySelector('.ct-count')?.textContent).toBe('3 people');
    // The ID label is its own isolated text.
    expect(rows()[2]?.querySelector('.ct-with bdi')?.textContent).toBe('macbook-agent-1');
  });

  it('the filter shows one ID’s people; the search narrows by name', async () => {
    await mount(twoIds());
    setValue(filter() as HTMLSelectElement, 'mac');
    await settle();
    expect(rows().map((r) => r.querySelector('bdi')?.textContent)).toEqual(['oc-test']);
    setValue(filter() as HTMLSelectElement, '');
    setValue(search() as HTMLInputElement, 'MARK');
    await settle();
    expect(rows().map((r) => r.querySelector('bdi')?.textContent)).toEqual(['Marko Novak']);
    setValue(search() as HTMLInputElement, 'zzz');
    await settle();
    expect(rows()).toHaveLength(0);
    expect(text()).toContain(ALL_IDS.noMatch);
  });

  it('an ID that cannot be read is missing, with a plain note', async () => {
    await mount(twoIds('unavailable'));
    expect(rows()).toHaveLength(2);
    expect(host.querySelector('.ct-missing')?.textContent).toBe(
      ALL_IDS.missing(['macbook-agent-1']),
    );
    expect(text()).not.toMatch(/error|unavailable|failed/i);
  });

  it('hostile person and ID names stay text inside <bdi>', async () => {
    await mount(twoIds([person(OC, HOSTILE)], HOSTILE_ID));
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.ct-row b')).toBeNull();
    const row = rows()[2];
    expect(row?.querySelector('.al-contact-name bdi')?.textContent).toBe(HOSTILE);
    expect(row?.querySelector('.ct-with bdi')?.textContent).toBe(HOSTILE_ID);
    expect([...(filter()?.options ?? [])].map((o) => o.textContent)).toContain(HOSTILE_ID);
  });

  it('a person of the open ID opens its panel; no switch', async () => {
    await mount(twoIds());
    await act(async () => rows()[1]?.click());
    await settle();
    expect(switchAgent).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('a person of another ID runs the existing switch with "Opening {ID}…" and asks for its panel', async () => {
    switchAgent.mockResolvedValue({ kind: 'done' });
    await mount(twoIds());
    await act(async () => rows()[2]?.click());
    await settle();
    expect(switchAgent).toHaveBeenCalledWith('mac');
    expect(text()).toContain(ALL_IDS.opening('macbook-agent-1'));
    expect(location.search).toBe(`?check=${OC}`);
  });

  it('a switch that fails says so in plain words and leaves the address clean', async () => {
    switchAgent.mockResolvedValue({ kind: 'failed' });
    await mount(twoIds());
    await act(async () => rows()[2]?.click());
    await settle();
    expect(text()).toContain(ALL_IDS.openFailed);
    expect(location.search).toBe('');
  });

  it('with no people on the open ID, another ID’s people still list', async () => {
    const people = twoIds();
    (people.ids[0] as { contacts: unknown[] }).contacts = [];
    await mount(people, []);
    expect(rows().map((r) => r.querySelector('bdi')?.textContent)).toEqual(['oc-test']);
  });
});

describe('parsePeopleAll (WP-P2)', () => {
  it('keeps checked IDs and rows only', () => {
    const out = parsePeopleAll({
      status: 'ok',
      ids: [
        { name: '../x', label: 'bad', current: false, status: 'ok', contacts: [] },
        { name: 'ok', label: '', current: 'yes', status: 'ok', contacts: [oc, { ref: 'nope' }] },
        { name: 'ok', label: 'dup', current: false, status: 'ok', contacts: [] },
        { name: 'gone', label: 'Gone', current: false, status: 'unavailable' },
      ],
    });
    expect(out?.map((i) => [i.name, i.label, i.current, i.contacts?.length])).toEqual([
      ['ok', 'ok', false, 1],
      ['gone', 'Gone', false, undefined],
    ]);
    expect(parsePeopleAll({ status: 'error' })).toBeUndefined();
  });
});
