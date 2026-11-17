// @vitest-environment jsdom
// SEC-RECEIPTS-DEFAULT (11 §5.10): the one-time notice that received receipts are now on. It shows
// until dismissed, the dismissal is kept (notices/index.ts), and "Open Settings" goes to the rule.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISMISSED_KEY, isDismissed, resetNoticesForTests } from '../notices/index.js';
import {
  RECEIPTS_NOTICE_KEY,
  RECEIPTS_NOTICE_STRINGS as S,
  RECEIPTS_SETTING_PATH,
  ReceiptsNotice,
} from './receipts-notice.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  resetNoticesForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  resetNoticesForTests();
});

const render = (): void => act(() => root.render(h(ReceiptsNotice)));
const button = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

describe('received receipts notice', () => {
  it('says the 11 §5.10 words, without wallet, gas, seed phrase or transaction', () => {
    render();
    expect(host.textContent).toContain(`${S.title}`);
    expect(`${S.title} ${S.body}`).toBe(
      'AgentLink now tells your contacts when your AI app has received their message. This also shows them that your AI app was open at about that time. You can turn this off in Settings.',
    );
    expect(button(S.gotIt)).toBeDefined();
    expect(button(S.openSettings)).toBeDefined();
    expect(host.textContent).not.toMatch(/wallet|gas|seed phrase|transaction/i);
  });

  it('Got it closes it for good: the dismissal is kept and it does not come back', () => {
    render();
    act(() => button(S.gotIt)?.click());
    expect(host.querySelector('[data-notice]')).toBeNull();
    expect(isDismissed(RECEIPTS_NOTICE_KEY)).toBe(true);
    expect(localStorage.getItem(DISMISSED_KEY)).toContain(RECEIPTS_NOTICE_KEY);
    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(host.querySelector('[data-notice]')).toBeNull();
  });

  it('Open Settings closes it and opens the rule', () => {
    render();
    act(() => button(S.openSettings)?.click());
    expect(window.location.pathname).toBe(RECEIPTS_SETTING_PATH);
    expect(isDismissed(RECEIPTS_NOTICE_KEY)).toBe(true);
  });
});
