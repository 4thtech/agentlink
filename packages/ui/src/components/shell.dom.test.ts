// @vitest-environment jsdom
// UI-REFRESH-f (S1): the shell frame (B-11 §3, §13.2; plan §5). One top bar row (page title, then the
// app's controls), every chrome part wears the al-chrome material class, the nav highlight is one
// element that slides (the position is a data attribute, so no inline style), and the sidebar stays
// in the DOM at every width (at 360 px it is the bottom bar, drawn by the stylesheet).
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppShell, type NavItem } from './index.js';

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
const render = (node: ReactNode): void => {
  act(() => root.render(node));
};

const NAV: NavItem[] = [
  { icon: 'agent', label: 'Home', href: '/settings/home' },
  { icon: 'approval', label: 'Approvals', href: '/', active: true },
  { icon: 'activity', label: 'Activity', href: '/settings/activity' },
];

describe('AppShell top bar', () => {
  it('renders one top bar row with the page title and the end controls', () => {
    render(
      h(
        AppShell,
        { nav: NAV, pageTitle: 'Approvals', topBarEnd: h('button', { id: 'ctl' }, 'Theme') },
        h('p', null, 'page'),
      ),
    );
    const bar = host.querySelector('header.al-topbar') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('.al-topbar-title')?.textContent).toBe('Approvals');
    expect(bar.querySelector('.al-topbar-end #ctl')).not.toBeNull();
    // The page keeps the only heading: the bar's title is not a second h1.
    expect(bar.querySelector('h1, h2, [role="heading"]')).toBeNull();
    expect(host.querySelectorAll('header.al-topbar').length).toBe(1);
  });

  it('draws no top bar when no title is given (older callers keep their frame)', () => {
    render(h(AppShell, { nav: NAV }, h('p', null, 'page')));
    expect(host.querySelector('header.al-topbar')).toBeNull();
  });

  it('keeps the page inside main, after the top bar', () => {
    render(h(AppShell, { nav: NAV, pageTitle: 'Approvals' }, h('p', { id: 'page' }, 'page')));
    const main = host.querySelector('main') as HTMLElement;
    expect(main.querySelector('#page')).not.toBeNull();
    expect(main.querySelector('.al-topbar')).toBeNull();
    const bar = host.querySelector('.al-topbar') as HTMLElement;
    expect(bar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('AppShell chrome material', () => {
  it('puts the al-chrome class on the sidebar, the top bar and the status bar', () => {
    render(h(AppShell, { nav: NAV, pageTitle: 'Approvals' }));
    for (const sel of ['nav.al-side', 'header.al-topbar', 'footer.al-statusbar']) {
      expect(host.querySelector(sel)?.classList.contains('al-chrome'), sel).toBe(true);
    }
  });

  it('never puts it on the content', () => {
    render(h(AppShell, { nav: NAV, pageTitle: 'Approvals' }));
    expect(host.querySelector('main')?.classList.contains('al-chrome')).toBe(false);
  });

  it('keeps the main navigation in the DOM (the 360 px bottom bar is the same nav)', () => {
    render(h(AppShell, { nav: NAV, pageTitle: 'Approvals' }));
    const side = host.querySelector('nav[aria-label="Main"]') as HTMLElement;
    expect(side.querySelectorAll('a.al-nav').length).toBe(3);
    expect(side.hidden).toBe(false);
  });
});

describe('AppShell nav highlight', () => {
  it('has one slider element, hidden from assistive technology', () => {
    render(h(AppShell, { nav: NAV, pageTitle: 'Approvals' }));
    const sliders = host.querySelectorAll('.al-nav-slider');
    expect(sliders.length).toBe(1);
    expect(sliders[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(sliders[0]?.hasAttribute('style')).toBe(false);
  });

  it('says where the slider rests with a data attribute (the active index)', () => {
    render(h(AppShell, { nav: NAV, pageTitle: 'Approvals' }));
    expect((host.querySelector('.al-nav-wrap') as HTMLElement).dataset['active']).toBe('1');
    render(
      h(AppShell, {
        nav: NAV.map((n, i) => ({ ...n, active: i === 2 })),
        pageTitle: 'Activity',
      }),
    );
    expect((host.querySelector('.al-nav-wrap') as HTMLElement).dataset['active']).toBe('2');
  });

  it('moves the same slider element when the page changes (it is not remounted)', () => {
    render(h(AppShell, { nav: NAV, pageTitle: 'Approvals' }));
    const before = host.querySelector('.al-nav-slider');
    render(
      h(AppShell, {
        nav: NAV.map((n, i) => ({ ...n, active: i === 0 })),
        pageTitle: 'Home',
      }),
    );
    expect(host.querySelector('.al-nav-slider')).toBe(before);
  });

  it('has no active index when nothing is current, and keeps aria-current on the link only', () => {
    render(h(AppShell, { nav: NAV.map((n) => ({ ...n, active: false })), pageTitle: 'Not found' }));
    expect((host.querySelector('.al-nav-wrap') as HTMLElement).dataset['active']).toBeUndefined();
    expect(host.querySelectorAll('[aria-current="page"]').length).toBe(0);
    render(h(AppShell, { nav: NAV, pageTitle: 'Approvals' }));
    expect(host.querySelectorAll('[aria-current="page"]').length).toBe(1);
  });
});

describe('AppShell nav count (UI-REFRESH-o-b)', () => {
  it('a count with a label is the shared tick badge, named for screen readers', () => {
    render(
      h(AppShell, {
        nav: NAV.map((n, i) => (i === 1 ? { ...n, count: 3, countLabel: 'waiting for you' } : n)),
        pageTitle: 'Approvals',
      }),
    );
    const badge = host.querySelector('.al-nav .al-count') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.classList.contains('al-nav-count')).toBe(true);
    expect(badge.querySelector('.al-count-in')?.textContent).toBe('3');
    expect(badge.querySelector('.al-visually-hidden')?.textContent).toBe('3 waiting for you');
    render(
      h(AppShell, {
        nav: NAV.map((n, i) => (i === 1 ? { ...n, count: 120, countLabel: 'waiting for you' } : n)),
        pageTitle: 'Approvals',
      }),
    );
    expect(host.querySelector('.al-nav .al-count-in')?.textContent).toBe('99+');
  });

  it('a count without a label keeps the plain badge', () => {
    render(
      h(AppShell, {
        nav: NAV.map((n, i) => (i === 2 ? { ...n, count: 2 } : n)),
        pageTitle: 'Approvals',
      }),
    );
    const plain = host.querySelector('.al-nav .al-nav-count') as HTMLElement;
    expect(plain.textContent).toBe('2');
    expect(plain.classList.contains('al-count')).toBe(false);
  });
});
