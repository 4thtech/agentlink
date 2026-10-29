// @vitest-environment jsdom
// U3-g (b11 §28): first run has no sidebar, top bar or status bar; every other page keeps them.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPrefsForTests } from '../prefs/index.js';
import { Layout } from './index.js';

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
  resetPrefsForTests();
});

function render(path: string): void {
  act(() =>
    root.render(
      h(
        Layout,
        {
          path,
          nextStep: () => Promise.resolve(false),
          unseenMessages: () => Promise.resolve(0),
          waitingApprovals: () => Promise.resolve(0),
          readHealth: () => new Promise<never>(() => undefined),
        },
        h('p', null, 'page'),
      ),
    ),
  );
}

describe('U3-g: the shell on first run', () => {
  it('shows only the page: no navigation, no top bar, no status bar', () => {
    render('/first-run');
    expect(host.textContent).toContain('page');
    expect(host.querySelector('nav')).toBeNull();
    expect(host.querySelector('header')).toBeNull();
    expect(host.querySelector('main#al-main')).not.toBeNull();
    expect(host.textContent).not.toContain('Approvals');
  });

  it('other pages keep the sidebar', () => {
    render('/settings/home');
    expect(host.querySelector('nav')).not.toBeNull();
    expect(host.textContent).toContain('Approvals');
  });
});
