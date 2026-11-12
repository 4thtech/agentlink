// @vitest-environment jsdom
// WP-P2 (design-1112 spec §5, third bullet): People across all IDs.
//
// - With one ID nothing changes: no ID filter, no "with {ID}".
// - With 2+ IDs: the open ID's people with "with {ID}" on each row, the "All my IDs" filter and the
//   "Find a person" search. Another ID's names stay sealed in its own store until it is opened
//   (04 §2.5), so it shows as "{n} people with {ID}" and Open {ID}, which runs the existing switch
//   (no Touch ID) with "Opening {ID}…". An ID that cannot be read is missing with a plain note.
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
  other: number | 'unavailable' = 1,
  otherLabel = 'macbook-agent-1',
  own: unknown[] = [natasa, marko],
) => ({
  status: 'ok',
  switchable: true,
  ids: [
    { name: 'default', label: 'Tali', current: true, status: 'ok', contacts: own },
    other === 'unavailable'
      ? { name: 'mac', label: otherLabel, current: false, status: 'unavailable' }
      : { name: 'mac', label: otherLabel, current: false, status: 'ok', count: other },
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
  ...host.querySelectorAll<HTMLButtonElement>('.ct-list:not(.ct-list-archived) button.ct-row'),
];
const idRows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.ct-idrow')];
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

  it('with two IDs: "with {ID}" on each row, the other ID as a count with Open, the filter and the total', async () => {
    await mount(twoIds(2));
    expect(rows().map((r) => r.querySelector('.ct-with')?.textContent)).toEqual([
      'with Tali',
      'with Tali',
    ]);
    expect(idRows()).toHaveLength(1);
    expect(idRows()[0]?.querySelector('.al-contact-name')?.textContent).toBe('2 people');
    expect(idRows()[0]?.querySelector('.ct-with bdi')?.textContent).toBe('macbook-agent-1');
    expect(idRows()[0]?.querySelector('button')?.textContent).toBe('Open');
    expect(idRows()[0]?.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Open macbook-agent-1',
    );
    const options = [...(filter()?.options ?? [])].map((o) => o.textContent);
    expect(options).toEqual([ALL_IDS.allIds, 'Tali', 'macbook-agent-1']);
    expect(host.querySelector('.ct-count')?.textContent).toBe('4 people');
  });

  it('the filter shows one ID; the search narrows the open ID’s people by name', async () => {
    await mount(twoIds());
    setValue(filter() as HTMLSelectElement, 'mac');
    await settle();
    expect(rows()).toHaveLength(0);
    expect(idRows()).toHaveLength(1);
    setValue(filter() as HTMLSelectElement, 'default');
    await settle();
    expect(rows()).toHaveLength(2);
    expect(idRows()).toHaveLength(0);
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
    expect(idRows()).toHaveLength(0);
    expect(host.querySelector('.ct-missing')?.textContent).toBe(
      ALL_IDS.missing(['macbook-agent-1']),
    );
    expect(text()).not.toMatch(/error|unavailable|failed/i);
  });

  it('hostile person and ID names stay text inside <bdi>', async () => {
    await mount(twoIds(1, HOSTILE_ID, [person(MARKO, HOSTILE)]), [person(MARKO, HOSTILE)]);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.ct-row b, .ct-idrow b')).toBeNull();
    expect(rows()[0]?.querySelector('.al-contact-name bdi')?.textContent).toBe(HOSTILE);
    expect(idRows()[0]?.querySelector('.ct-with bdi')?.textContent).toBe(HOSTILE_ID);
    expect([...(filter()?.options ?? [])].map((o) => o.textContent)).toContain(HOSTILE_ID);
  });

  it('a person of the open ID opens its panel; no switch', async () => {
    await mount(twoIds());
    await act(async () => rows()[1]?.click());
    await settle();
    expect(switchAgent).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('Open {ID} runs the existing switch with "Opening {ID}…"', async () => {
    switchAgent.mockResolvedValue({ kind: 'done' });
    await mount(twoIds());
    await act(async () => idRows()[0]?.querySelector('button')?.click());
    await settle();
    expect(switchAgent).toHaveBeenCalledWith('mac');
    expect(text()).toContain(ALL_IDS.opening('macbook-agent-1'));
  });

  it('a switch that fails says so in plain words', async () => {
    switchAgent.mockResolvedValue({ kind: 'failed' });
    await mount(twoIds());
    await act(async () => idRows()[0]?.querySelector('button')?.click());
    await settle();
    expect(text()).toContain(ALL_IDS.openFailed);
  });

  it('with no people on the open ID, another ID’s people still show', async () => {
    await mount(twoIds(3, 'macbook-agent-1', []), []);
    expect(idRows()).toHaveLength(1);
    expect(host.querySelector('.ct-count')?.textContent).toBe('3 people');
  });
});

describe('parsePeopleAll (WP-P2)', () => {
  it('keeps checked IDs, rows for the open ID and counts for the others', () => {
    const out = parsePeopleAll({
      status: 'ok',
      ids: [
        { name: '../x', label: 'bad', current: false, status: 'ok', count: 1 },
        { name: 'ok', label: '', current: true, status: 'ok', contacts: [marko, { ref: 'nope' }] },
        { name: 'ok', label: 'dup', current: false, status: 'ok', count: 1 },
        { name: 'two', label: 'Two', current: false, status: 'ok', count: 2 },
        { name: 'neg', label: 'Neg', current: false, status: 'ok', count: -1 },
        { name: 'gone', label: 'Gone', current: false, status: 'unavailable' },
      ],
    });
    expect(out?.map((i) => [i.name, i.label, i.current, i.contacts?.length, i.count])).toEqual([
      ['ok', 'ok', true, 1, undefined],
      ['two', 'Two', false, undefined, 2],
      ['neg', 'Neg', false, undefined, undefined],
      ['gone', 'Gone', false, undefined, undefined],
    ]);
    expect(parsePeopleAll({ status: 'error' })).toBeUndefined();
  });
});
