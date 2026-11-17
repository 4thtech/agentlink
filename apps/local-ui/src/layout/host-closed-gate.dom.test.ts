// @vitest-environment jsdom
// DESK-QUIT-ORDER: in the desktop app the gate never shows the browser steps (reload this page, a
// terminal command). The app quitting shows nothing; the core restarting (requests failing) shows
// the app's own plain "Restarting AgentLink…". A browser keeps the steps.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_CLOSED_TEXT,
  markHostClosed,
  noteHostReached,
  noteHostUnreachable,
  resetHostClosedForTests,
} from '../api/host-closed.js';
import { DESKTOP_RESTART_FALLBACK_MS, HostClosedGate } from './host-closed-gate.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156 Electron/45.1.0 AgentLinkDesktop/1 (passkey=native)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156';

let ua = BROWSER;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetHostClosedForTests();
  Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetHostClosedForTests();
  ua = BROWSER;
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(h(HostClosedGate, null, h('p', null, 'the app')));
  });
  expect(host.textContent).toBe('the app');
}

const browserSteps = (text: string): boolean => /terminal|npx|reload/i.test(text);

describe('HostClosedGate in the desktop app (DESK-QUIT-ORDER)', () => {
  it('quitting (the "closing" event) shows nothing at all', async () => {
    ua = DESKTOP;
    await render();
    await act(async () => markHostClosed());
    expect(host.textContent).toBe('');
    expect(host.innerHTML).not.toMatch(/npx|terminal/i);
  });

  it('a restart (requests failing) shows "Restarting AgentLink…", never browser steps', async () => {
    ua = DESKTOP;
    await render();
    await act(async () => {
      noteHostReached();
      noteHostUnreachable();
      noteHostUnreachable();
    });
    const text = host.textContent ?? '';
    expect(text).toContain('Restarting AgentLink…');
    expect(text).not.toContain('the app');
    expect(text).not.toContain(HOST_CLOSED_TEXT);
    expect(browserSteps(text)).toBe(false);
  });

  it('a restart that takes too long falls back to "AgentLink stopped" (no terminal text)', async () => {
    vi.useFakeTimers();
    try {
      ua = DESKTOP;
      await render();
      await act(async () => {
        noteHostReached();
        noteHostUnreachable();
        noteHostUnreachable();
      });
      expect(host.textContent).toContain('Restarting AgentLink…');
      await act(async () => {
        vi.advanceTimersByTime(DESKTOP_RESTART_FALLBACK_MS);
      });
      const text = host.textContent ?? '';
      expect(text).toContain('AgentLink stopped');
      expect(text).toContain('Try again');
      expect(browserSteps(text)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a browser keeps the closed line and the steps to open it again', async () => {
    await render();
    await act(async () => markHostClosed());
    const text = host.textContent ?? '';
    expect(text).toContain(HOST_CLOSED_TEXT);
    expect(text).toMatch(/terminal/i);
    expect(text).toContain('npx');
  });
});
