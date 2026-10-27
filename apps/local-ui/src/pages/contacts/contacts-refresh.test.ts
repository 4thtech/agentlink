// @vitest-environment jsdom
// UI-REFRESH-i (B-11 §16 Contacts, §6 rows 4 and 9, §13.1): rows on level 1, the contact in a level-3
// Sheet, "Waiting for {name}", the codes-match moment, the duplicate notice as a level-3 banner, the
// Skeleton on first load and the Under the hood fields. Names from other parties stay plain text
// (I-5). The older contacts.test.ts stays as it is.
import { HoodProvider } from '@4thtech-io/ui';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from '../../api/client.js';
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
  document.documentElement.removeAttribute('data-motion');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const MARKO = '0x7f3a19c200000000000000000000000000000001';
const ANA = '0x4c21a0f700000000000000000000000000000002';
const CODE = '4821 0937 5512';
const LIST = '/api/ui/contacts';

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

type Routes = Record<string, unknown>;

function fetchFor(routes: Routes): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const found = routes[`${method} ${url}`] ?? (method === 'GET' ? routes[url] : undefined);
    if (found === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(found), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

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

async function mount(routes: Routes, hood = false, open = true): Promise<void> {
  const f = fetchFor({ 'GET /api/owner/passkey': NO_PASSKEY, ...routes });
  const api = createApiClient({ fetch: f, token: 't' });
  const owner = createOwnerClient({ fetch: f, token: 't' });
  const page = createElement<ContactsPageProps>(ContactsPage, { api, owner });
  await act(async () => {
    root.render(hood ? createElement(HoodProvider, { value: true }, page) : page);
    await Promise.resolve();
  });
  await settle();
  if (open) {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.ct-row')?.click();
    });
    await settle();
  }
}

const text = (): string => host.textContent ?? '';

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}" in: ${text()}`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await settle();
}

describe('UI-REFRESH-i: first load', () => {
  it('shows the Skeleton, not a "Loading…" line, while the list is on its way', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const api = { get: () => never, post: () => never } as unknown as ApiClient;
    await act(async () => {
      root.render(createElement<ContactsPageProps>(ContactsPage, { api }));
      await Promise.resolve();
    });
    expect(host.querySelector('h1')?.textContent).toBe('Contacts');
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(host.querySelector('.al-skeleton')).not.toBeNull();
    expect(host.querySelector('p[aria-busy]')).toBeNull();
  });
});

describe('UI-REFRESH-i: rows and the detail sheet', () => {
  const routes = {
    [LIST]: { status: 'ok', contacts: [marko, ana] },
    [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
  };

  it('puts the rows on a level 1 surface', async () => {
    await mount(routes);
    const list = host.querySelector('ul.ct-list');
    expect(list?.getAttribute('data-level')).toBe('1');
    expect(list?.classList.contains('al-surface')).toBe(true);
  });

  it('opens no sheet at load, so the page and the navigation stay usable', async () => {
    await mount(routes, false, false);
    expect(host.querySelector('aside.al-sheet')).toBeNull();
    expect(host.querySelectorAll('.ct-row')).toHaveLength(2);
  });

  it('shows the selected contact in a level 3 sheet with a named close button', async () => {
    await mount(routes);
    const sheet = host.querySelector('aside.al-sheet');
    expect(sheet?.getAttribute('data-level')).toBe('3');
    expect(sheet?.getAttribute('role')).toBe('dialog');
    expect(sheet?.querySelector('.ct-detail')).not.toBeNull();
    expect(sheet?.querySelector('.al-sheet-close')?.getAttribute('aria-label')).toBe(S.closeSheet);
    expect(host.querySelector('.ct-layout > .ct-detail')).toBeNull();
  });

  it('closing the sheet keeps the list; choosing a row opens it again', async () => {
    await mount(routes);
    await click(host.querySelector('.al-sheet-close') as HTMLElement);
    expect(host.querySelector('aside.al-sheet')).toBeNull();
    expect(host.querySelectorAll('.ct-row')).toHaveLength(2);
    await click(host.querySelectorAll<HTMLElement>('.ct-row')[1] as HTMLElement);
    const sheet = host.querySelector('aside.al-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain('Ana');
    expect(host.querySelectorAll('.ct-row')[1]?.getAttribute('aria-current')).toBe('true');
  });

  it('every button has a name and the sheet is named by its heading', async () => {
    await mount(routes);
    for (const b of host.querySelectorAll('button')) {
      expect((b.textContent ?? '').trim() !== '' || b.hasAttribute('aria-label')).toBe(true);
    }
    const sheet = host.querySelector('aside.al-sheet') as HTMLElement;
    const heading = document.getElementById(sheet.getAttribute('aria-labelledby') ?? '');
    expect(heading?.textContent?.trim()).not.toBe('');
  });
});

describe('UI-REFRESH-i: waiting, codes match, duplicate notice', () => {
  const waiting = { ...marko, pairing: 'pending' };

  it('says "Waiting for {name}" in plain text, with the name only as text', async () => {
    await mount({ [LIST]: { status: 'ok', contacts: [waiting] } });
    const line = host.querySelector('.ct-waiting');
    expect(line?.textContent).toContain('Waiting for');
    expect(line?.textContent).toContain('Marko Novak');
    expect(text()).toContain(S.waitingDetail);
  });

  it('a hostile name in the waiting line never becomes markup', async () => {
    const evil = { ...waiting, name: '<b id="x">hi</b>' };
    await mount({ [LIST]: { status: 'ok', contacts: [evil] } });
    expect(host.querySelector('.ct-waiting')).not.toBeNull();
    expect(host.querySelector('.ct-waiting b, #x')).toBeNull();
  });

  it('plays the codes-match moment once after "They match", with its text line', async () => {
    const f = {
      [LIST]: { status: 'ok', contacts: [marko] },
      [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
      [`POST /api/ui/contacts/${MARKO}/check`]: { status: 'done' },
    };
    await mount(f);
    expect(host.querySelector('.al-moment')).toBeNull();
    await click(button(S.theyMatch));
    const field = host.querySelector<HTMLInputElement>(
      'input[name="owner-code"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        field,
        'ABCD-EFGH',
      );
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(S.confirm));
    expect(host.querySelectorAll('.al-moment[data-kind="codes"]')).toHaveLength(1);
    expect(text()).toContain(S.matched);
  });

  it('the safety code is three groups, never one element per letter', async () => {
    await mount({
      [LIST]: { status: 'ok', contacts: [marko] },
      [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
    });
    const groups = [...host.querySelectorAll('.al-sc-code > *')];
    expect(groups.map((g) => g.textContent)).toEqual(['4821', '0937', '5512']);
    expect(host.querySelector('.al-sc-code span span')).toBeNull();
  });

  it('shows the duplicate notice in a level 3 banner', async () => {
    const OLD = { ...ana, name: 'oc-test', label: 'self-declared', since: 1_761_350_400 };
    const NEW = { ...OLD, ref: MARKO, since: 1_761_523_200, olderSameOwner: ANA };
    await mount({ [LIST]: { status: 'ok', contacts: [OLD, NEW] } });
    await click(host.querySelectorAll<HTMLElement>('.ct-row')[1] as HTMLElement);
    const notice = host.querySelector('.ct-dup');
    expect(notice?.getAttribute('data-level')).toBe('3');
    expect(notice?.querySelector('.al-banner')).not.toBeNull();
    expect(notice?.textContent).toContain('oc-test');
  });
});

describe('UI-REFRESH-i: reduced motion', () => {
  const pending = { [LIST]: { status: 'ok', contacts: [{ ...marko, pairing: 'pending' }] } };

  it('marks the waiting line as still when the app setting is reduced', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    await mount(pending);
    expect(host.querySelector('.ct-waiting')?.getAttribute('data-motion')).toBe('reduced');
  });

  it('marks the waiting line as still when the system setting is reduced', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    await mount(pending);
    expect(host.querySelector('.ct-waiting')?.getAttribute('data-motion')).toBe('reduced');
  });
});

const sheets = import.meta.glob<string>('./contacts.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('UI-REFRESH-i: the stylesheet', () => {
  it('animates only behind both reduced-motion rules, with tokens and no blur', () => {
    const css = sheets['./contacts.css'] ?? '';
    expect(css).toMatch(/@keyframes\s+ct-breathe/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/\[data-motion='reduced'\]/);
    expect(css).not.toMatch(/backdrop-filter/);
    expect(css).not.toMatch(/style=/);
  });
});

describe('UI-REFRESH-i: Under the hood', () => {
  const routes = (contacts: unknown[]): Routes => ({
    [LIST]: { status: 'ok', contacts },
    [`/api/ui/contacts/${MARKO}/safety-code`]: { status: 'ok', code: CODE },
  });

  it('shows the fingerprint, identity level and pairing date of the selected contact', async () => {
    await mount(routes([marko, ana]), true);
    const hood = host.querySelector('.al-hood');
    expect(hood).not.toBeNull();
    const rows = [...(hood?.querySelectorAll('.al-hood-row') ?? [])].map((r) => [
      r.querySelector('dt')?.textContent,
      r.querySelector('dd')?.textContent,
    ]);
    expect(rows).toEqual([
      ['Fingerprint', '7F3A·19C2'],
      ['Identity level', 'Self-declared'],
      ['Paired', '2025-10-03'],
    ]);
  });

  it('leaves out the fingerprint when the server did not send one, and never shows an ID', async () => {
    await mount(routes([ana]), true);
    const hood = host.querySelector('.al-hood') as HTMLElement;
    expect(hood.textContent).not.toContain('Fingerprint');
    expect(hood.textContent).toContain('Safety code checked');
    expect(hood.textContent).not.toMatch(/0x[0-9a-f]{6}/i);
    expect(hood.textContent).not.toContain(CODE);
  });

  it('is absent while the switch is off', async () => {
    await mount(routes([marko]));
    expect(host.querySelector('.al-hood')).toBeNull();
  });
});
