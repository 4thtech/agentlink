// @vitest-environment jsdom
// W4-WIRE: the shell's "Switch to Touch ID" next step leaves the moment a passkey is registered (in
// any page that registers one), not on the next page change, so Home never moves when it opens
// (CLS; journey ch.3 counts from Home's first load).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  announcePasskeyRegistered,
  resetPasskeyRegisteredForTests,
} from '../pages/first-run/setup-api.js';
import {
  SWITCH_UNSUPPORTED_KEY,
  rememberSwitchUnsupported,
  resetSwitchUnsupportedForTests,
} from '../pages/first-run/passkey-nudge.js';
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
    resetPasskeyRegisteredForTests();
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

  it('stays gone when a read that started before registration answers after it (slow CI)', async () => {
    resetPasskeyRegisteredForTests();
    let answer: (needed: boolean) => void = () => undefined;
    await act(async () => {
      root.render(
        h(
          Layout,
          {
            path: '/contacts',
            nextStep: () => new Promise<boolean>((r) => (answer = r)),
            unseenMessages: async () => 0,
            readHealth: () => new Promise<never>(() => undefined),
          },
          h('p', null, 'page'),
        ),
      );
    });
    act(() => announcePasskeyRegistered());
    await act(async () => {
      answer(true);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(banner()).toBeNull();
    resetPasskeyRegisteredForTests();
  });
});

describe('F49: the next step leaves once a switch failed here for lack of PRF', () => {
  const mountShell = async (): Promise<void> => {
    await act(async () => {
      root.render(
        h(
          Layout,
          {
            path: '/agents',
            nextStep: () => Promise.resolve(true),
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
  };

  it('leaves at once when a switch fails on this page', async () => {
    resetPasskeyRegisteredForTests();
    resetSwitchUnsupportedForTests();
    await mountShell();
    expect(banner()).not.toBeNull();
    act(() => rememberSwitchUnsupported());
    expect(banner()).toBeNull();
    resetSwitchUnsupportedForTests();
  });

  it('is not shown in a browser that remembers the failed switch', async () => {
    resetPasskeyRegisteredForTests();
    resetSwitchUnsupportedForTests();
    window.localStorage.setItem(SWITCH_UNSUPPORTED_KEY, '1');
    await mountShell();
    expect(banner()).toBeNull();
  });
});
