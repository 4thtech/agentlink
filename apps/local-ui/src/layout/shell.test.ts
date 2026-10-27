// @vitest-environment jsdom
// UI-REFRESH-f (S1): the app shell (B-11 §3, §16 Settings; plan §5): one top bar row with the page
// title, the Under the hood switch, the live status chip and the theme control; Home and Appearance
// in the nav; the Settings sub-navigation on the chrome material; the status bar unchanged.
import { UnderTheHood } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPrefs, resetPrefsForTests } from '../prefs/index.js';
import { Layout, setConnectionState } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  resetPrefsForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => setConnectionState('unknown'));
  window.localStorage.clear();
  resetPrefsForTests();
});

function mount(path: string, children?: unknown): void {
  act(() =>
    root.render(
      h(
        Layout,
        {
          path,
          nextStep: async () => false,
          unseenMessages: async () => 0,
          readHealth: () => new Promise(() => undefined),
        },
        (children ?? h('p', null, 'page')) as never,
      ),
    ),
  );
}
const bar = (): HTMLElement => host.querySelector('header.al-topbar') as HTMLElement;

describe('top bar', () => {
  it.each([
    ['/', 'Approvals'],
    ['/settings/home', 'Home'],
    ['/settings/activity', 'Activity'],
    ['/settings/proofs', 'Proofs & credits'],
    ['/settings/passkeys', 'Passkeys'],
    ['/settings/appearance', 'Appearance'],
    ['/first-run', 'Set up AgentLink'],
  ])('shows the page title for %s', (path, title) => {
    mount(path);
    expect(bar().querySelector('.al-topbar-title')?.textContent).toBe(title);
  });

  it('falls back to the app name on an unknown path', () => {
    mount('/settings/nope');
    expect(bar().querySelector('.al-topbar-title')?.textContent).toBe('AgentLink');
  });

  it('keeps the order: title, then Under the hood, status chip, theme', () => {
    mount('/settings/home');
    const end = bar().querySelector('.al-topbar-end') as HTMLElement;
    const parts = [
      end.querySelector('[role="switch"]'),
      end.querySelector('.al-livedot'),
      end.querySelector('button[aria-label^="Theme"]'),
    ];
    for (const p of parts) expect(p).not.toBeNull();
    const [a, b, c] = parts as Element[];
    expect((a as Element).compareDocumentPosition(b as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((b as Element).compareDocumentPosition(c as Element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the top bar is chrome and has no second heading', () => {
    mount('/settings/home');
    expect(bar().classList.contains('al-chrome')).toBe(true);
    expect(bar().querySelector('h1, h2, h3')).toBeNull();
  });
});

describe('Under the hood switch', () => {
  const sw = (): HTMLElement => bar().querySelector('[role="switch"]') as HTMLElement;

  it('is named, off by default and has a tooltip', () => {
    mount('/settings/home');
    expect(sw().getAttribute('aria-checked')).toBe('false');
    expect(bar().textContent).toContain('Under the hood');
    expect(bar().querySelector('[title]')?.getAttribute('title')).toContain('technical details');
  });

  it('turns the preference on and the panels below it appear', () => {
    mount('/settings/home', h(UnderTheHood, { fields: [] }));
    expect(host.querySelector('section.al-hood')).toBeNull();
    act(() => sw().click());
    expect(getPrefs().hood).toBe(true);
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(host.querySelector('section.al-hood')).not.toBeNull();
    act(() => sw().click());
    expect(host.querySelector('section.al-hood')).toBeNull();
  });

  it('is remembered across a fresh load', () => {
    mount('/settings/home');
    act(() => sw().click());
    act(() => root.render(null));
    resetPrefsForTests();
    mount('/settings/home');
    expect(sw().getAttribute('aria-checked')).toBe('true');
  });
});

describe('live status chip', () => {
  const chip = (): HTMLElement => bar().querySelector('.al-livedot') as HTMLElement;

  it('starts as Checking…', () => {
    mount('/settings/home');
    expect(chip().dataset['state']).toBe('checking');
    expect(chip().textContent).toContain('Checking…');
  });

  it.each([
    ['connected', 'connected', 'Connected'],
    ['paused', 'paused', 'Paused'],
    ['not_running', 'not-running', 'Not running'],
    ['needs_setup', 'needs-setup', 'Needs setup'],
    ['offline', 'not-running', 'Not connected'],
  ] as const)('shows %s with its shape and word', (state, dot, word) => {
    mount('/settings/home');
    act(() => setConnectionState(state));
    expect(chip().dataset['state']).toBe(dot);
    expect(chip().textContent).toContain(word);
    expect(chip().querySelector('svg')).not.toBeNull();
  });

  it('is not a second live region (the status bar announces changes)', () => {
    mount('/settings/home');
    act(() => setConnectionState('connected'));
    expect(bar().querySelector('[aria-live], [role="status"]')).toBeNull();
    expect(host.querySelectorAll('footer.al-statusbar [aria-live]').length).toBe(1);
  });
});

describe('theme control', () => {
  const btn = (): HTMLElement => bar().querySelector('button[aria-label^="Theme"]') as HTMLElement;

  it('names the current choice and cycles system, light, dark', () => {
    mount('/settings/home');
    expect(btn().getAttribute('aria-label')).toContain('System');
    act(() => btn().click());
    expect(getPrefs().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(btn().getAttribute('aria-label')).toContain('Light');
    act(() => btn().click());
    expect(getPrefs().theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => btn().click());
    expect(getPrefs().theme).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('shows the choice in words', () => {
    mount('/settings/home');
    expect(btn().textContent).toContain('System');
  });
});

describe('navigation', () => {
  it('lists Home first, linking to /settings/home, and marks it current there', () => {
    mount('/settings/home');
    const first = host.querySelector('nav[aria-label="Main"] a.al-nav') as HTMLAnchorElement;
    expect(first.textContent).toContain('Home');
    expect(first.getAttribute('href')).toBe('/settings/home');
    expect(first.getAttribute('aria-current')).toBe('page');
    expect(host.querySelectorAll('nav[aria-label="Main"] a[aria-current="page"]').length).toBe(1);
  });

  it('slides one highlight: the active index follows the page', () => {
    mount('/settings/home');
    const wrap = (): HTMLElement => host.querySelector('.al-nav-wrap') as HTMLElement;
    expect(wrap().dataset['active']).toBe('0');
    mount('/');
    expect(wrap().dataset['active']).toBe('1');
    mount('/settings/rules');
    expect(wrap().dataset['active']).toBe('7');
  });

  it('has Appearance in the Settings sub-navigation, which is sticky chrome', () => {
    mount('/settings/appearance');
    const sub = host.querySelector('nav[aria-label="Settings"]') as HTMLElement;
    expect([...sub.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Backup',
      'Passkeys',
      'Appearance',
      'Advanced',
    ]);
    expect(sub.classList.contains('al-chrome')).toBe(true);
    expect(sub.classList.contains('al-subnav')).toBe(true);
    expect(sub.querySelector('a[aria-current="page"]')?.textContent).toBe('Appearance');
    expect(host.querySelector('nav[aria-label="Main"] a[aria-current="page"]')?.textContent).toContain(
      'Settings',
    );
  });

  it('keeps the status bar: Connected and the version live in the footer', () => {
    mount('/settings/home');
    act(() => setConnectionState('connected'));
    expect(host.querySelector('footer.al-statusbar')?.textContent).toContain('Connected');
    expect(host.querySelector('footer.al-statusbar')?.classList.contains('al-chrome')).toBe(true);
  });
});
