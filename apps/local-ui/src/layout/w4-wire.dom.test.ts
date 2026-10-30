// @vitest-environment jsdom
// W4-WIRE: the shell's "Switch to Touch ID" next step leaves the moment a passkey is registered (in
// any page that registers one), not on the next page change, so Home never moves when it opens
// (CLS; journey ch.3 counts from Home's first load).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { announcePasskeyRegistered } from '../pages/first-run/setup-api.js';
import { resetPrefsForTests } from '../prefs/index.js';
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

const banner = (): Element | null => host.querySelector('main a[href="/first-run"]');

describe('W4-WIRE: the "Switch to Touch ID" next step', () => {
  it('leaves at registration, on the same page, with no re-read', async () => {
    let reads = 0;
    await act(async () => {
      root.render(
        h(
          Layout,
          {
            path: '/contacts',
            nextStep: () => {
              reads += 1;
              return Promise.resolve(true);
            },
            unseenMessages: async () => 0,
            readHealth: () => new Promise<never>(() => undefined),
          },
          h('p', null, 'page'),
        ),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(banner()).not.toBeNull();
    const before = reads;
    act(() => announcePasskeyRegistered());
    expect(banner()).toBeNull();
    expect(reads).toBe(before);
  });
});
