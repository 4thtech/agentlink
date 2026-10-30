// W4-SHELL (b11 §34.1, d2 console/home 1280 and 360): the agent switcher sits top-left. On a wide
// screen it is the first thing in the sidebar under the mark; at 360 the sidebar is the bottom bar,
// so the app puts it at the start of the top bar instead. AppShell gives the two places as slots.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppShell } from './shell.js';

describe('AppShell slots (W4-SHELL)', () => {
  it('puts sideTop under the mark, before the nav list', () => {
    const out = renderToStaticMarkup(
      h(AppShell, {
        nav: [{ icon: 'inbox', label: 'Inbox', href: '/inbox' }],
        sideTop: h('button', { id: 'sw' }, 'Agent'),
      }),
    );
    const brand = out.indexOf('al-side-brand');
    const slot = out.indexOf('al-side-top');
    const button = out.indexOf('id="sw"');
    const list = out.indexOf('al-nav-wrap');
    expect(brand).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(brand);
    expect(button).toBeGreaterThan(slot);
    expect(list).toBeGreaterThan(button);
  });

  it('puts topBarStart before the page title in the top bar', () => {
    const out = renderToStaticMarkup(
      h(AppShell, {
        pageTitle: 'Inbox',
        topBarStart: h('button', { id: 'sw' }, 'Agent'),
        topBarEnd: h('button', { id: 'me' }, 'Me'),
      }),
    );
    const start = out.indexOf('al-topbar-start');
    const title = out.indexOf('al-topbar-title');
    expect(start).toBeGreaterThan(out.indexOf('al-topbar'));
    expect(out.indexOf('id="sw"')).toBeGreaterThan(start);
    expect(title).toBeGreaterThan(out.indexOf('id="sw"'));
    expect(out.indexOf('id="me"')).toBeGreaterThan(title);
  });

  it('draws neither slot when none is given', () => {
    const out = renderToStaticMarkup(h(AppShell, { pageTitle: 'Inbox' }));
    expect(out).not.toContain('al-side-top');
    expect(out).not.toContain('al-topbar-start');
  });
});
