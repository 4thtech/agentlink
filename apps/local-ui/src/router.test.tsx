// @vitest-environment jsdom
// M1-11s-a: every route renders its stub inside the shared layout, the nav marks the active item
// and a nav click changes the page without a reload.
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  ['/first-run', 'Set up AgentLink'],
  ['/settings/activity', 'Activity'],
  ['/settings/contacts', 'Contacts'],
  ['/settings/files', 'Files'],
  ['/settings/storage', 'Storage'],
  ['/settings/proofs', 'Proofs & credits'],
  ['/settings/rules', 'Rules'],
  ['/settings/backup', 'Backup'],
  ['/settings/advanced', 'Advanced'],
];

describe('routes', () => {
  it('declares exactly the shell routes', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(EXPECTED.map(([p]) => p).sort());
  });

  // M1-11b-1: /first-run is a real page now (pages/first-run/first-run.test.tsx).
  const STUBS = EXPECTED.filter(([p]) => p !== '/first-run');
  it.each(STUBS)('%s renders its stub inside the layout', (path, title) => {
    mountAt(path);
    expect(host.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    expect(host.querySelector('footer.al-statusbar')).not.toBeNull();
    const main = host.querySelector('main');
    expect(main?.querySelector('h1')?.textContent).toBe(title);
    expect(main?.querySelector('.al-empty')?.textContent).toContain('available yet');
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
  it('lists Approvals first, then the settings pages', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Approvals',
      'Activity',
      'Contacts',
      'Files',
      'Storage',
      'Proofs & credits',
      'Rules',
      'Backup',
      'Advanced',
    ]);
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

  it('leaves the Approvals link to the browser (the approvals page is not in this app yet)', () => {
    mountAt('/settings/activity');
    const link = host.querySelector<HTMLAnchorElement>('nav a[href="/"]');
    expect(link?.textContent).toContain('Approvals');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => {
      link?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });
});
