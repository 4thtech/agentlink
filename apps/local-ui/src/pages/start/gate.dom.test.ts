// @vitest-environment jsdom
// IR-W4-WIZARD-1: the open-on-launch check decides before Home shows (no Home flash; a skeleton
// after ~300 ms while it reads), and a load that Get started itself ended on Home never loops back.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { endFirstRun } from '../first-run/index.js';
import { StartGate } from './gate.js';
import { START_LEAVING_KEY } from './guard.js';
import { resetAutoShown } from './store.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  resetAutoShown();
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const wait = (ms: number): Promise<void> =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

describe('StartGate: Home waits for the open-on-launch check', () => {
  it('shows no Home while the check runs, a skeleton after ~300 ms, then the app', async () => {
    let decide: (opened: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((r) => {
      decide = r;
    });
    await act(async () => {
      root.render(h(StartGate, { decide: () => pending }, h('p', { id: 'home' }, 'Home')));
    });
    expect(host.querySelector('#home')).toBeNull();
    await wait(450);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.querySelector('#home')).toBeNull();
    await act(async () => {
      decide(false);
      await pending;
    });
    await wait(600);
    expect(host.querySelector('#home')).not.toBeNull();
  });

  it('a check that fails still shows the app', async () => {
    await act(async () => {
      root.render(
        h(StartGate, { decide: () => Promise.reject(new Error('x')) }, h('p', { id: 'home' }, 'H')),
      );
    });
    await wait(10);
    expect(host.querySelector('#home')).not.toBeNull();
  });
});

describe('the end of first run marks its own load', () => {
  it('endFirstRun ("Go to Home", a full load) leaves the mark that keeps Home', async () => {
    await endFirstRun(() => Promise.resolve({ kind: 'failed' }));
    expect(sessionStorage.getItem(START_LEAVING_KEY)).not.toBeNull();
  });

  it('W4-WIRE (U2 low): an ending on the waiting invite (/settings/join) leaves no mark', async () => {
    sessionStorage.removeItem(START_LEAVING_KEY);
    await endFirstRun(() => Promise.resolve({ kind: 'ok', state: 'waiting' }));
    expect(sessionStorage.getItem(START_LEAVING_KEY)).toBeNull();
  });
});
