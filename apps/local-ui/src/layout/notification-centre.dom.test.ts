// @vitest-environment jsdom
// N5/N6 (PLAN-NOTIFY §3.1, §4.1, §4.4; D2, D4): the bell, its centre, the tab title and favicon, and
// Settings › Notifications. One test per state:
// - empty: a plain bell, no number, the empty sentence; axe clean;
// - items: the number ("9+" above nine), groups Needs you · New · Earlier, names only from the
//   owner's contact list (bold), "a contact" for an unknown ref, unread dots; axe clean;
// - keyboard: arrows move, Escape closes and returns focus to the bell;
// - a row opens its page and marks it read; an approval is never marked read; Mark all read;
// - the tab title carries the number and the favicon shows a dot while approvals wait;
// - the phone sheet rule (390 px) exists;
// - Settings › Notifications: the D2 defaults, a change is saved as `notify`, a failed save
//   goes back and says so; axe clean; plain words (11 §5).
import { lintVocabulary } from '@4thtech-io/ui';
import axe from 'axe-core';
import shellCss from './shell.css?raw';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationList } from '../api/notifications.js';
import { REDIRECTS, SETTINGS_PAGES } from '../nav.js';
import { NotificationsPage } from '../pages/notifications/index.js';
import { countPrefix, resetAttentionForTests, setPageTitle } from './attention.js';
import { ago, NotificationBell } from './notification-centre.js';
import { NOTIFY_SETTINGS_STRINGS, NOTIFY_STRINGS as S } from './notification-strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const NOW = 1_800_000_000;

let host: HTMLElement;
let root: Root;
let calls: { url: string; method: string; headers: Record<string, string> }[];

beforeEach(() => {
  document.head.innerHTML =
    '<meta name="agentlink-csrf" content="tok"><link rel="icon" href="/assets/favicon-abc.svg">';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resetAttentionForTests();
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      });
      return Promise.resolve(new Response('{"status":"done"}', { status: 200 }));
    }),
  );
  history.replaceState(null, '', '/settings');
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const list = (items: NotificationList['items']): NotificationList => {
  let unread = 0;
  let approvals = 0;
  for (const i of items) {
    if (i.kind === 'approvals') {
      unread += i.count;
      approvals = i.count;
    } else if (!i.read) unread += 1;
  }
  return { items, unread, approvals };
};

const FULL = list([
  { id: 'approvals', kind: 'approvals', count: 2, at: NOW - 30, read: false },
  { id: `messages-${A}`, kind: 'messages', ref: A, count: 3, at: NOW - 120, read: false },
  { id: `files-${B}`, kind: 'files', ref: B, count: 1, at: NOW - 7_200, read: false },
  { id: 'update', kind: 'update', count: 1, at: NOW - 90_000, read: true },
]);

async function mount(answer: NotificationList, names = new Map([[A, 'Ana']])): Promise<void> {
  await act(async () => {
    root.render(
      h(NotificationBell, {
        path: '/settings',
        read: () => Promise.resolve(answer),
        names: () => Promise.resolve(names),
        now: () => NOW,
      }),
    );
  });
}

const bell = (): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>('.al-nc-bell') as HTMLButtonElement;

async function openPanel(): Promise<HTMLElement> {
  await act(async () => {
    bell().click();
  });
  return host.querySelector<HTMLElement>('[role="menu"]') as HTMLElement;
}

const AXE = { rules: { 'color-contrast': { enabled: false } } };

describe('the bell', () => {
  it('empty: no number, the plain name, the empty sentence; axe clean', async () => {
    await mount(list([]));
    expect(bell().getAttribute('aria-label')).toBe(S.bell);
    expect(host.querySelector('.al-nc-count')).toBeNull();
    const menu = await openPanel();
    expect(menu.getAttribute('aria-label')).toBe(S.title);
    expect(menu.textContent).toContain(S.empty);
    expect(menu.textContent).toContain(S.openActivity);
    expect((await axe.run(host, AXE)).violations).toEqual([]);
  });

  it('items: the number, the groups, names from the contact list only; axe clean', async () => {
    await mount(FULL);
    expect(host.querySelector('.al-nc-count')?.textContent).toBe('4');
    expect(bell().getAttribute('aria-label')).toBe(S.bellNew(4));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(S.announce(4));
    const menu = await openPanel();
    const groups = [...menu.querySelectorAll('[role="group"]')].map(
      (g) => g.querySelector('.al-menu-head')?.textContent,
    );
    expect(groups).toEqual([S.needsYou, S.fresh, S.earlier]);
    const rows = [...menu.querySelectorAll<HTMLElement>('.al-nc-row')];
    expect(rows.map((r) => r.dataset['kind'])).toEqual([
      'approvals',
      'messages',
      'files',
      'update',
    ]);
    expect(rows[0]?.textContent).toContain(S.approvals(2));
    // Ana is the owner's own name for A (bold); B is not in the list: "a contact".
    expect(rows[1]?.querySelector('b')?.textContent).toBe('Ana');
    expect(rows[1]?.textContent).toContain(S.messages(3));
    expect(rows[2]?.textContent).toContain(`${S.files(1)}${S.aContact}`);
    expect(rows[2]?.querySelector('b')).toBeNull();
    // Read rows have no dot; unread ones (and the waiting approval) do.
    expect(rows.map((r) => r.querySelector('.al-nc-dot') !== null)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    // Never a ref, a link or an address on screen.
    expect(menu.textContent).not.toContain('0x');
    expect(menu.querySelector('a[href^="http"]')).toBeNull();
    expect((await axe.run(host, AXE)).violations).toEqual([]);
  });

  it('caps the number at 9+', async () => {
    await mount(list([{ id: 'approvals', kind: 'approvals', count: 12, at: NOW, read: false }]));
    expect(host.querySelector('.al-nc-count')?.textContent).toBe('9+');
    expect(document.title.startsWith('(9+) ')).toBe(true);
  });

  it('keyboard: focus starts on the first item, arrows move, Escape returns focus to the bell', async () => {
    await mount(FULL);
    const menu = await openPanel();
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).toBe(items[1]);
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement?.textContent).toContain(S.openActivity);
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(bell());
    expect(bell().getAttribute('aria-expanded')).toBe('false');
  });

  it('a row opens its page and marks it read; an approval row is never marked read', async () => {
    await mount(FULL);
    let menu = await openPanel();
    await act(async () => {
      menu.querySelector<HTMLElement>('[data-kind="messages"]')?.click();
    });
    expect(location.pathname).toBe('/');
    const mark = calls.find((c) => c.method === 'POST');
    expect(mark?.url).toBe(`/api/ui/notifications/messages-${A}/read`);
    expect(mark?.headers['x-agentlink-csrf']).toBe('tok');
    expect(mark?.headers['content-type']).toBe('application/octet-stream');
    calls = [];
    menu = await openPanel();
    await act(async () => {
      menu.querySelector<HTMLElement>('[data-kind="approvals"]')?.click();
    });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('Mark all read posts read-all; the cog opens Settings › Notifications', async () => {
    await mount(FULL);
    let menu = await openPanel();
    await act(async () => {
      [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((e) => e.textContent === S.markAll)
        ?.click();
    });
    expect(
      calls.some((c) => c.method === 'POST' && c.url === '/api/ui/notifications/read-all'),
    ).toBe(true);
    menu = host.querySelector<HTMLElement>('[role="menu"]') ?? (await openPanel());
    await act(async () => {
      menu.querySelector<HTMLElement>(`[aria-label="${S.settings}"]`)?.click();
    });
    expect(location.pathname).toBe('/settings/notifications');
  });
});

describe('the tab title and the favicon (D4)', () => {
  it('puts the number in front of the page title and a dot on the icon while approvals wait', async () => {
    setPageTitle('Settings · AgentLink');
    expect(document.title).toBe('Settings · AgentLink');
    await mount(FULL);
    expect(document.title).toBe('(4) Settings · AgentLink');
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(icon?.dataset['attention']).toBe('approvals');
    expect(icon?.getAttribute('href')).not.toBe('/assets/favicon-abc.svg');
    // (The built file is a hashed asset, never a data: URL: build.test.ts.)
    act(() => root.render(h('div')));
    root.unmount();
    root = createRoot(host);
    await mount(list([{ id: 'update', kind: 'update', count: 1, at: NOW, read: true }]));
    expect(document.title).toBe('Settings · AgentLink');
    expect(icon?.getAttribute('href')).toBe('/assets/favicon-abc.svg');
    expect(countPrefix(0)).toBe('');
    expect(countPrefix(10)).toBe('(9+) ');
  });

  it('says how long ago in plain words', () => {
    expect(ago(NOW - 10, NOW)).toBe(S.justNow);
    expect(ago(NOW - 180, NOW)).toBe(S.minutes(3));
    expect(ago(NOW - 7_200, NOW)).toBe(S.hours(2));
    expect(ago(NOW - 86_400, NOW)).toBe('yesterday');
  });
});

describe('at 390 px', () => {
  it('the centre becomes a sheet across the width', () => {
    const css = shellCss;
    const phone = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
    expect(phone).toMatch(
      /\.al-nc-menu\s*\{[^}]*position:\s*fixed[^}]*left:\s*16px[^}]*right:\s*16px/,
    );
  });
});

describe('Settings › Notifications (N6)', () => {
  it('is a real page now, in the app group, no longer a redirect', () => {
    expect(REDIRECTS['/settings/notifications']).toBeUndefined();
    expect(SETTINGS_PAGES.some((p) => p.path === '/settings/notifications')).toBe(true);
  });

  const switches = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="switch"]')];

  it('shows the D2 defaults: approvals on, everything else off; axe clean', async () => {
    await act(async () => {
      root.render(h(NotificationsPage, { read: () => Promise.resolve({}), save: vi.fn() }));
    });
    expect(switches().map((s) => s.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      'false',
    ]);
    expect(host.textContent).toContain(NOTIFY_SETTINGS_STRINGS.showNames);
    expect((await axe.run(host, AXE)).violations).toEqual([]);
  });

  it('reads the stored choices and saves a change as `notify`', async () => {
    const save = vi.fn(() => Promise.resolve(true));
    await act(async () => {
      root.render(
        h(NotificationsPage, {
          read: () => Promise.resolve({ notify: { approvals: false } }),
          save,
        }),
      );
    });
    expect(switches()[0]?.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      switches()[1]?.click();
    });
    expect(save).toHaveBeenCalledWith({ notify: { messages: true } });
    expect(switches()[1]?.getAttribute('aria-checked')).toBe('true');
  });

  it('a failed save goes back and says so', async () => {
    await act(async () => {
      root.render(
        h(NotificationsPage, {
          read: () => Promise.resolve(undefined),
          save: () => Promise.resolve(false),
        }),
      );
    });
    await act(async () => {
      switches()[4]?.click();
    });
    expect(switches()[4]?.getAttribute('aria-checked')).toBe('false');
    expect(host.textContent).toContain(NOTIFY_SETTINGS_STRINGS.saveFailed);
  });

  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(JSON.stringify({ S, NOTIFY_SETTINGS_STRINGS }))).toEqual([]);
  });
});
