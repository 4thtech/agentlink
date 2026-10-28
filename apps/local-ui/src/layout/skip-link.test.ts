// @vitest-environment jsdom
// UI-REFRESH-t (e): a "skip to content" link is the first Tab stop in the shell (the UI-REFRESH-q
// audit counted 11 chrome stops before the page). It is hidden until it has focus, uses plain words
// (11 §5), and moves focus to the page content.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import appCss from '../app.css?raw';
import { resetPrefsForTests } from '../prefs/index.js';
import { SHELL_STRINGS } from '../strings.js';
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
  act(() =>
    root.render(
      h(
        Layout,
        {
          path: '/settings/home',
          nextStep: async () => false,
          unseenMessages: async () => 0,
          readHealth: () => new Promise<never>(() => undefined),
        },
        h('p', null, 'page'),
      ),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  act(() => setConnectionState('unknown'));
  window.localStorage.clear();
  resetPrefsForTests();
});

const TABBABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex="0"]';
const skip = (): HTMLAnchorElement => host.querySelector('a.al-skip') as HTMLAnchorElement;

describe('skip to content', () => {
  it('says "Skip to content" in plain words', () => {
    expect(SHELL_STRINGS.skipToContent).toBe('Skip to content');
    expect(skip()?.textContent).toBe('Skip to content');
  });

  it('is the first tab stop, before the sidebar', () => {
    const first = host.querySelector(TABBABLE);
    expect(first).toBe(skip());
    const side = host.querySelector('nav.al-side') as HTMLElement;
    expect(skip().compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('points at an element that exists: the page content', () => {
    const target = skip().getAttribute('href');
    expect(target).toBe('#al-main');
    const found = document.getElementById('al-main');
    expect(found).not.toBeNull();
    expect(found).toBe(host.querySelector('main.al-shell-content'));
  });

  it('moves focus to the page content', () => {
    const main = host.querySelector('main.al-shell-content') as HTMLElement;
    expect(main).not.toBeNull();
    act(() => skip().click());
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  it('is hidden until focused, with tokens only and no motion', () => {
    const css = appCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.al-skip\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.al-skip rule').not.toBeNull();
    expect(rule?.[1]).toMatch(/position:\s*absolute/);
    expect(css).toMatch(/\.al-skip:focus[^{]*\{[^}]*transform:\s*translateY\(0\)/);
    expect(css).not.toMatch(/\.al-skip[^{]*\{[^}]*(transition|animation)/);
    expect(rule?.[1]).not.toMatch(/#[0-9a-f]{3,8}\b|\d+ms/i);
  });
});
