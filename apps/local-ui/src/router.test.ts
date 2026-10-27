// @vitest-environment jsdom
// M1-11s-a: every route renders its stub inside the shared layout, the nav marks the active item
// and a nav click changes the page without a reload.
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConnectionState } from './layout/index.js';
import { NAV_ITEMS } from './nav.js';
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

const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['/', 'Approvals'],
  ['/first-run', 'Set up AgentLink'],
  ['/settings/activity', 'Activity'],
  ['/settings/messages', 'Messages'],
  ['/settings/contacts', 'Contacts'],
  ['/settings/files', 'Files'],
  ['/settings/proofs', 'Proofs & credits'],
  ['/settings/rules', 'Rules'],
  ['/settings/backup', 'Backup'],
  ['/settings/passkeys', 'Passkeys'],
  ['/settings/advanced', 'Advanced'],
  // UI-REFRESH-f: Home (at /settings/home until M1-11b-2 moves it to /, D-135) and Appearance.
  ['/settings/home', 'Home'],
  ['/settings/appearance', 'Appearance'],
  // UI-REFRESH-n: About.
  ['/settings/about', 'About'],
];

describe('routes', () => {
  it('declares exactly the shell routes', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(EXPECTED.map(([p]) => p).sort());
  });

  // Built pages test their own content (pages/<page>/*.test.tsx).
  // M1-11b-1: /first-run is a real page now (pages/first-run/first-run.test.ts).
  // M1-11b-2: Approvals (`/`) is a real page now (pages/approvals/approvals.test.ts).
  const BUILT: ReadonlySet<string> = new Set([
    '/',
    '/settings/activity',
    '/settings/messages',
    '/settings/contacts',
    '/settings/files',
    '/settings/proofs',
    '/settings/rules',
    '/settings/appearance',
    '/settings/about',
  ]);
  const STUBS = EXPECTED.filter(([p]) => p !== '/first-run');
  it.each(STUBS)('%s renders its page inside the layout', (path, title) => {
    mountAt(path);
    expect(host.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    expect(host.querySelector('footer.al-statusbar')).not.toBeNull();
    const main = host.querySelector('main');
    expect(main?.querySelector('h1')?.textContent).toBe(title);
    if (!BUILT.has(path)) {
      expect(main?.querySelector('.al-empty')?.textContent).toContain('available yet');
    }
  });

  it('shows the not-found state for an unknown path, still in the layout', () => {
    mountAt('/settings/nope');
    expect(host.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    expect(host.querySelector('main .al-empty')).not.toBeNull();
  });

  it('sends /settings to Activity', () => {
    mountAt('/settings');
    expect(location.pathname).toBe('/settings/activity');
    expect(host.querySelector('main h1')?.textContent).toBe('Activity');
  });
});

describe('nav', () => {
  it('lists Home first, then Approvals and the settings pages', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Home',
      'Approvals',
      'Activity',
      'Messages',
      'Contacts',
      'Files',
      'Proofs & credits',
      'Rules',
      'Settings',
    ]);
    expect(NAV_ITEMS).toHaveLength(9);
  });

  it('keeps every nav label in plain words', () => {
    // 11 §5: no wallet, gas, seed phrase or transaction words in the default UI.
    const text = [
      ...NAV_ITEMS.map((i) => i.label),
      'Backup',
      'Passkeys',
      'Appearance',
      'Advanced',
      'About',
    ].join(' ');
    expect(text).not.toMatch(/wallet|gas|seed|transaction|chain|address|hash/i);
  });

  it('redirects the old storage path to Files', () => {
    mountAt('/settings/storage');
    expect(location.pathname).toBe('/settings/files');
    expect(host.querySelector('main h1')?.textContent).toBe('Files');
  });

  it('shows a Settings sub-navigation with Backup, Passkeys, Appearance, Advanced and About', () => {
    mountAt('/settings/passkeys');
    const sub = host.querySelector('nav[aria-label="Settings"]');
    expect(sub).not.toBeNull();
    expect([...(sub?.querySelectorAll('a') ?? [])].map((a) => a.textContent)).toEqual([
      'Backup',
      'Passkeys',
      'Appearance',
      'Advanced',
      'About',
    ]);
    expect(sub?.querySelector('a[aria-current="page"]')?.textContent).toBe('Passkeys');
    expect(
      host.querySelector('nav[aria-label="Main"] a[aria-current="page"]')?.textContent,
    ).toContain('Settings');
  });

  it('has no Settings sub-navigation on other pages', () => {
    mountAt('/settings/rules');
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
    mountAt('/settings/rules');
    const current = host.querySelectorAll('nav a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Rules');
    expect(host.querySelectorAll('nav a.is-active')).toHaveLength(1);
  });

  it('changes page on a click without a reload and moves the active mark', () => {
    mountAt('/settings/activity');
    const link = host.querySelector<HTMLAnchorElement>('nav a[href="/settings/files"]');
    expect(link).not.toBeNull();
    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(location.pathname).toBe('/settings/files');
    expect(host.querySelector('main h1')?.textContent).toBe('Files');
    expect(host.querySelector('nav a[aria-current="page"]')?.textContent).toContain('Files');
  });

  it('follows the browser back button', () => {
    mountAt('/settings/activity');
    act(() => {
      history.pushState(null, '', '/settings/backup');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.querySelector('main h1')?.textContent).toBe('Backup');
  });

  // M1-11b-2: Approvals lives in this app now; `/approve/<id>` renders inside the same layout.
  it('routes the Approvals link inside the app, Approvals current', () => {
    mountAt('/settings/activity');
    const link = host.querySelector<HTMLAnchorElement>('nav a[href="/"]');
    expect(link?.textContent).toContain('Approvals');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      link?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(location.pathname).toBe('/');
    expect(host.querySelector('nav a[aria-current="page"]')?.textContent).toContain('Approvals');
  });

  it('marks Approvals current on a deep link to one request', () => {
    mountAt(`/approve/apr_${'A'.repeat(22)}`);
    expect(host.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    expect(host.querySelector('nav a[aria-current="page"]')?.textContent).toContain('Approvals');
    expect(host.querySelector('main h1')?.textContent).toBe('Approvals');
  });

  it('shows not-found for an /approve path that is not an approval ID', () => {
    mountAt('/approve/nope');
    expect(host.querySelector('main .al-empty')).not.toBeNull();
  });
});
