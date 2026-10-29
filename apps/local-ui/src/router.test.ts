// @vitest-environment jsdom
// M1-11s-a: every route renders its page inside the shared layout, the nav marks the active item
// and a nav click changes the page without a reload.
// W4-SHELL (Decision 40, b11 §34.1): two destinations only, Inbox (the home) and Contacts; every
// other page sits under Settings (and its Advanced group), reached from the avatar menu and Cmd+K.
// All routes land here, pointing at today's pages; the Inbox, Contacts and Settings builders replace
// the page bodies in their own folders and never touch the router or the nav.
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConnectionState } from './layout/index.js';
import { NAV_ITEMS, REDIRECTS, SETTINGS_GROUPS } from './nav.js';
import { AppRoutes, ROUTES } from './router.js';

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

function mountAt(path: string): void {
  history.replaceState(null, '', path);
  act(() => root.render(h(AppRoutes)));
}

/** Path, the page's own heading (today's page), and the title in the top bar. */
const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
  ['/inbox', 'Messages', 'Inbox'],
  ['/contacts', 'Contacts', 'Contacts'],
  ['/', 'Approvals', 'Approvals'],
  ['/first-run', 'Set up AgentLink', 'Set up AgentLink'],
  ['/settings/home', 'Home', 'Home'],
  ['/settings/agents', 'Agents', 'Agents'],
  ['/settings/files', 'Files', 'Files & storage'],
  ['/settings/apps', 'AI apps', 'AI apps'],
  ['/settings/backup', 'Backup', 'Backup & Touch ID'],
  ['/settings/appearance', 'Appearance', 'Appearance'],
  ['/settings/proofs', 'Proofs & credits', 'Proofs & credits'],
  ['/settings/rules', 'Rules', 'Default rules'],
  ['/settings/notifications', 'Notifications', 'Notifications'],
  ['/settings/activity', 'Activity', 'Activity log'],
  ['/settings/advanced', 'Advanced', 'Network & relays'],
  ['/settings/about', 'About', 'Diagnostics'],
  // U3-invite: the join screen, in the first-run shell (no sidebar).
  ['/settings/join', 'AgentLink', 'AgentLink'],
];

describe('routes', () => {
  it('declares exactly the shell routes', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(EXPECTED.map(([p]) => p).sort());
  });

  // Built pages test their own content (pages/<page>/*.test.tsx).
  const STUBS: ReadonlySet<string> = new Set([
    '/settings/backup',
    '/settings/notifications',
    '/settings/advanced',
  ]);
  const SHELL = EXPECTED.filter(([p]) => p !== '/first-run' && p !== '/settings/join');
  it('U3-invite: /settings/join renders in the focused first-run shell, with no sidebar', () => {
    mountAt('/settings/join');
    expect(host.querySelector('nav[aria-label="Main"]')).toBeNull();
    expect(host.querySelector('main.al-first-run')).not.toBeNull();
  });
  it.each(SHELL)('%s renders its page inside the layout', (path, heading, title) => {
    mountAt(path);
    expect(host.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    expect(host.querySelector('footer.al-statusbar')).not.toBeNull();
    const main = host.querySelector('main');
    expect(main?.querySelector('h1')?.textContent).toBe(heading);
    expect(host.querySelector('header.al-topbar .al-topbar-title')?.textContent).toBe(title);
    if (STUBS.has(path)) {
      expect(main?.querySelector('.al-empty')?.textContent).toContain('available yet');
    }
  });

  it('shows the not-found state for an unknown path, still in the layout', () => {
    mountAt('/settings/nope');
    expect(host.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    expect(host.querySelector('main .al-empty')).not.toBeNull();
  });

  it('keeps / on the waiting approvals (every approval link points there), inside the Inbox item', () => {
    mountAt('/');
    expect(location.pathname).toBe('/');
    expect(host.querySelector('main h1')?.textContent).toBe('Approvals');
    expect(host.querySelector('nav a[aria-current="page"]')?.textContent).toContain('Inbox');
  });

  it('sends /settings to its first page, AI apps', () => {
    mountAt('/settings');
    expect(location.pathname).toBe('/settings/apps');
    expect(host.querySelector('main h1')?.textContent).toBe('AI apps');
  });

  it.each([
    ['/settings/messages', '/inbox'],
    ['/settings/contacts', '/contacts'],
    ['/settings/storage', '/settings/files'],
    ['/settings/passkeys', '/settings/backup'],
  ])('keeps the old path %s working: it goes to %s', (from, to) => {
    expect(REDIRECTS[from]).toBe(to);
    mountAt(from);
    expect(location.pathname).toBe(to);
  });
});

describe('nav', () => {
  it('has two destinations only: Inbox, then Contacts', () => {
    expect(NAV_ITEMS.map((i) => [i.label, i.path])).toEqual([
      ['Inbox', '/inbox'],
      ['Contacts', '/contacts'],
    ]);
  });

  it('groups Settings and Advanced (b11 §34.6)', () => {
    expect(SETTINGS_GROUPS.map((g) => [g.label, g.pages.map((p) => p.label)])).toEqual([
      [
        'Settings',
        [
          'AI apps',
          'Backup & Touch ID',
          'Appearance',
          'Proofs & credits',
          'Default rules',
          'Notifications',
        ],
      ],
      ['Advanced', ['Activity log', 'Files & storage', 'Network & relays', 'Diagnostics']],
    ]);
  });

  it('keeps every nav and Settings label in plain words', () => {
    // 11 §5: no wallet, gas, seed phrase or transaction words in the default UI.
    const text = [
      ...NAV_ITEMS.map((i) => i.label),
      ...SETTINGS_GROUPS.flatMap((g) => [g.label, ...g.pages.map((p) => p.label)]),
    ].join(' ');
    expect(text).not.toMatch(/wallet|gas|seed|transaction|chain|address|hash/i);
  });

  it('shows the grouped Settings sub-navigation on a Settings page; Main marks nothing', () => {
    mountAt('/settings/rules');
    const sub = host.querySelector('nav[aria-label="Settings"]');
    expect(sub).not.toBeNull();
    expect([...(sub?.querySelectorAll('a') ?? [])].map((a) => a.textContent)).toEqual([
      'AI apps',
      'Backup & Touch ID',
      'Appearance',
      'Proofs & credits',
      'Default rules',
      'Notifications',
      'Activity log',
      'Files & storage',
      'Network & relays',
      'Diagnostics',
    ]);
    expect(sub?.querySelector('a[aria-current="page"]')?.textContent).toBe('Default rules');
    expect(host.querySelector('nav[aria-label="Main"] a[aria-current="page"]')).toBeNull();
  });

  it('has no Settings sub-navigation on the Inbox or Contacts', () => {
    mountAt('/inbox');
    expect(host.querySelector('nav[aria-label="Settings"]')).toBeNull();
    mountAt('/contacts');
    expect(host.querySelector('nav[aria-label="Settings"]')).toBeNull();
  });

  it('shows Checking… (never Connected or Paused) before the server reports', () => {
    mountAt('/settings/rules');
    const bar = host.querySelector('footer.al-statusbar')?.textContent ?? '';
    expect(bar).toContain('Checking…');
    expect(bar).not.toContain('Connected');
    expect(bar).not.toContain('Paused');
  });

  it('shows Not connected after offline and does not turn Connected on the online event', () => {
    mountAt('/settings/rules');
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(host.querySelector('footer.al-statusbar')?.textContent).toContain('Not connected');
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    const bar = host.querySelector('footer.al-statusbar')?.textContent ?? '';
    expect(bar).toContain('Checking…');
    expect(bar).not.toContain('Connected');
  });

  it('shows Connected only when the server reports healthy', () => {
    mountAt('/settings/rules');
    act(() => setConnectionState('connected'));
    expect(host.querySelector('footer.al-statusbar')?.textContent).toContain('Connected');
    act(() => setConnectionState('unknown'));
  });

  it('marks only the active item with aria-current', () => {
    mountAt('/contacts');
    const current = host.querySelectorAll('nav[aria-label="Main"] a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Contacts');
    expect(host.querySelectorAll('nav[aria-label="Main"] a.is-active')).toHaveLength(1);
  });

  it('changes page on a click without a reload and moves the active mark', () => {
    mountAt('/inbox');
    const link = host.querySelector<HTMLAnchorElement>('nav a[href="/contacts"]');
    expect(link).not.toBeNull();
    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(location.pathname).toBe('/contacts');
    expect(host.querySelector('main h1')?.textContent).toBe('Contacts');
    expect(host.querySelector('nav a[aria-current="page"]')?.textContent).toContain('Contacts');
  });

  it('follows the browser back button', () => {
    mountAt('/settings/activity');
    act(() => {
      history.pushState(null, '', '/settings/backup');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.querySelector('main h1')?.textContent).toBe('Backup');
  });

  // Approvals fold into the Inbox (b11 §34.4): the waiting list and one request mark the Inbox.
  it.each(['/', `/approve/apr_${'A'.repeat(22)}`])('marks the Inbox current on %s', (path) => {
    mountAt(path);
    expect(host.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    expect(host.querySelector('nav a[aria-current="page"]')?.textContent).toContain('Inbox');
    expect(host.querySelector('main h1')?.textContent).toBe('Approvals');
  });

  it('shows not-found for an /approve path that is not an approval ID', () => {
    mountAt('/approve/nope');
    expect(host.querySelector('main .al-empty')).not.toBeNull();
  });
});

describe('compact view route (UX2-h)', () => {
  it('serves /settings/compact without the shell, so a small window has no sidebar', () => {
    mountAt('/settings/compact');
    expect(host.querySelector('nav[aria-label="Main"]')).toBeNull();
    expect(host.querySelector('footer.al-statusbar')).toBeNull();
  });

  it('adds no route to the shell list or the navigation', () => {
    expect(ROUTES.some((r) => r.path.includes('compact'))).toBe(false);
    expect(NAV_ITEMS.some((i) => i.path.includes('compact'))).toBe(false);
  });
});
