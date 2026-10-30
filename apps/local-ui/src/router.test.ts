// @vitest-environment jsdom
// M1-11s-a: every route renders its page inside the shared layout, the menu marks the current
// section and a click changes the page without a reload.
// W4-SHELL-V2 (Decisions 49–51): the sections Home (`/`), Agents (`/agents`, `/agents/<name>`),
// Activity (`/activity`, `/activity/live`) and Settings (`/settings/<page>`); Advanced
// (`/advanced/<page>`) while Under the hood is on; Get started (`/start/<step>`) in the focused shell.
// Same routes in both layers. Old paths redirect. All routes point at today's pages; the section
// builders replace the page bodies in their own folders and never touch the router or the menu.
import { createElement as h, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConnectionState } from './layout/index.js';
import {
  ADVANCED_SECTIONS,
  REDIRECTS,
  SECTIONS,
  SETTINGS_PAGES,
  goToEntries,
  sectionOf,
  titleOf,
} from './nav.js';
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

const rail = (): Element | null => host.querySelector('nav.al-rail');
const currentSection = (): string | null | undefined =>
  host.querySelector('nav.al-rail a[aria-current="page"]')?.getAttribute('aria-label');

/** Path, the page's own heading (today's page), and the section marked current. */
const EXPECTED: ReadonlyArray<readonly [string, string, string | null]> = [
  ['/', 'Approvals', 'Home'],
  ['/agents', 'Agents', 'Agents'],
  ['/activity', 'Activity', 'Activity'],
  ['/activity/live', 'Live activity stream', null],
  ['/inbox', 'Inbox', 'Home'],
  ['/contacts', 'Contacts', 'Home'],
  ['/settings', 'Settings', 'Settings'],
  ['/settings/backup', 'Backup & Touch ID', 'Settings'],
  ['/settings/apps', 'AI apps', 'Settings'],
  ['/settings/files', 'Files', 'Settings'],
  ['/settings/appearance', 'Appearance', 'Settings'],
  ['/settings/notifications', 'Notifications', 'Settings'],
  ['/settings/rules', 'Rules', 'Settings'],
  ['/settings/proofs', 'Proofs & credits', 'Settings'],
  ['/advanced/rules', 'Rules', null],
  ['/advanced/proofs', 'Proofs & credits', null],
  ['/advanced/network', 'Relays & network', null],
  ['/advanced/diagnostics', 'Diagnostics', null],
  ['/advanced/map', 'Connections map', null],
];
const FOCUSED = [
  '/start/app',
  '/start/connect',
  '/start/connected',
  '/start/invite',
  '/settings/join',
];

describe('routes', () => {
  it('declares exactly the shell routes', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(
      [...EXPECTED.map(([p]) => p), ...FOCUSED].sort(),
    );
  });

  it.each(EXPECTED)('%s renders its page inside the layout', (path, heading, section) => {
    mountAt(path);
    expect(rail()).not.toBeNull();
    expect(host.querySelector('header.al-top')).not.toBeNull();
    expect(host.querySelector('footer.al-statusbar')).not.toBeNull();
    expect(host.querySelector('main h1')?.textContent).toBe(heading);
    if (section !== null) expect(currentSection()).toBe(section);
  });

  it.each(FOCUSED)('%s renders in the focused shell: no top bar, menu or status bar', (path) => {
    mountAt(path);
    expect(rail()).toBeNull();
    expect(host.querySelector('header.al-top')).toBeNull();
    expect(host.querySelector('main.al-first-run')).not.toBeNull();
  });

  it('shows one agent at /agents/<name> on the Agents page (W4-AGENTS: its own page)', () => {
    mountAt('/agents/work');
    expect(location.pathname).toBe('/agents/work');
    // The Agents page draws the agent's page (its heading is the agent's label once read).
    expect(host.querySelector('main.ag-page')).not.toBeNull();
    expect(currentSection()).toBe('Agents');
  });

  it('shows the not-found state for an unknown path, still in the layout', () => {
    mountAt('/settings/nope');
    expect(rail()).not.toBeNull();
    expect(host.querySelector('main .al-empty')).not.toBeNull();
    mountAt('/agents/Not_A_Name');
    expect(host.querySelector('main .al-empty')).not.toBeNull();
  });

  it('keeps / on the waiting approvals (every approval link points there), with Home current', () => {
    mountAt('/');
    expect(location.pathname).toBe('/');
    expect(host.querySelector('main h1')?.textContent).toBe('Approvals');
    expect(currentSection()).toBe('Home');
  });

  it('keeps /approve/<id> unchanged, with Home current', () => {
    mountAt(`/approve/apr_${'A'.repeat(22)}`);
    expect(location.pathname).toBe(`/approve/apr_${'A'.repeat(22)}`);
    expect(currentSection()).toBe('Home');
  });

  it('shows not-found for an /approve path that is not an approval ID', () => {
    mountAt('/approve/nope');
    expect(host.querySelector('main .al-empty')).not.toBeNull();
  });

  it.each([
    ['/first-run', '/start/app'],
    ['/start', '/start/app'],
    ['/settings/home', '/'],
    ['/settings/agents', '/agents'],
    ['/settings/activity', '/activity'],
    ['/settings/advanced', '/advanced/network'],
    ['/settings/about', '/advanced/diagnostics'],
    ['/settings/messages', '/inbox'],
    ['/settings/contacts', '/contacts'],
    ['/settings/storage', '/settings/files'],
    ['/settings/passkeys', '/settings/backup'],
    ['/advanced', '/advanced/network'],
  ])('keeps the old path %s working: it goes to %s', (from, to) => {
    expect(REDIRECTS[from]).toBe(to);
    mountAt(from);
    expect(location.pathname).toBe(to);
  });
});

describe('the sections (nav.ts)', () => {
  it('Home, Agents, Activity, Settings; Advanced holds six pages', () => {
    expect(SECTIONS.map((s) => [s.label, s.path])).toEqual([
      ['Home', '/'],
      ['Agents', '/agents'],
      ['Activity', '/activity'],
      ['Settings', '/settings'],
    ]);
    expect(ADVANCED_SECTIONS.map((s) => [s.label, s.path])).toEqual([
      ['Live activity', '/activity/live'],
      ['Rules', '/advanced/rules'],
      ['Proofs & credits', '/advanced/proofs'],
      ['Relays & network', '/advanced/network'],
      ['Diagnostics', '/advanced/diagnostics'],
      ['Connections map', '/advanced/map'],
    ]);
  });

  it('Settings (A9) in order, ending with Advanced', () => {
    expect(SETTINGS_PAGES.map((p) => p.label)).toEqual([
      'Backup & Touch ID',
      'AI apps',
      'Files folder',
      'Appearance',
      'Notifications',
      'Rules',
      'Proofs & credits',
      'Advanced',
    ]);
  });

  it('keeps every label in plain words (11 §5)', () => {
    const text = [
      ...SECTIONS.map((s) => s.label),
      ...ADVANCED_SECTIONS.map((s) => s.label),
      ...SETTINGS_PAGES.map((p) => p.label),
      ...goToEntries(true).map((e) => e.label),
    ].join(' ');
    expect(text).not.toMatch(/wallet|gas|seed|transaction|chain|address|hash/i);
  });

  it('names the section of a path, and its title', () => {
    expect(sectionOf('/')).toBe('home');
    expect(sectionOf('/agents/work')).toBe('agents');
    expect(sectionOf('/activity/live')).toBe('live');
    expect(sectionOf('/settings/rules')).toBe('settings');
    expect(sectionOf('/advanced/network')).toBe('network');
    expect(titleOf('/settings/rules')).toBe('Rules');
    expect(titleOf('/start/connect')).toBe('Get started');
    expect(titleOf('/agents/work')).toBe('Agents');
  });

  it('shows the Settings sub-navigation on a Settings page only', () => {
    mountAt('/settings/rules');
    const sub = host.querySelector('nav[aria-label="Settings"]');
    expect([...(sub?.querySelectorAll('a') ?? [])].map((a) => a.textContent)).toEqual(
      SETTINGS_PAGES.map((p) => p.label),
    );
    expect(sub?.querySelector('a[aria-current="page"]')?.textContent).toBe('Rules');
    mountAt('/agents');
    expect(host.querySelector('nav[aria-label="Settings"]')).toBeNull();
  });

  it('changes page on a click without a reload and moves the current mark', () => {
    mountAt('/');
    const link = host.querySelector<HTMLAnchorElement>('nav.al-rail a[href="/activity"]');
    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    expect(location.pathname).toBe('/activity');
    expect(host.querySelector('main h1')?.textContent).toBe('Activity');
    expect(currentSection()).toBe('Activity');
    expect(host.querySelectorAll('nav.al-rail [aria-current="page"]')).toHaveLength(1);
  });

  it('follows the browser back button', () => {
    mountAt('/activity');
    act(() => {
      history.pushState(null, '', '/settings/backup');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(host.querySelector('main h1')?.textContent).toBe('Backup & Touch ID');
  });
});

describe('the status bar (kept)', () => {
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
});

describe('compact view route (UX2-h)', () => {
  it('serves /settings/compact without the shell, so a small window has no menu', () => {
    mountAt('/settings/compact');
    expect(rail()).toBeNull();
    expect(host.querySelector('footer.al-statusbar')).toBeNull();
  });

  it('adds no route to the shell list or the menu', () => {
    expect(ROUTES.some((r) => r.path.includes('compact'))).toBe(false);
    expect(SECTIONS.some((s) => s.path.includes('compact'))).toBe(false);
  });
});
