// @vitest-environment jsdom
// UX 2026-11-12 (notices; docs/design/notices.md): the one notice system in the local app. The
// "Protect your approvals" page notice in its three contexts (browser, desktop, desktop with its
// own sensor), its close remembered per ID, the toast bus and the shell's one stack, and the
// remembered-dismissal store's limits (fixed keys only; blocked storage is fine).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_UA_MARKER, inDesktopApp } from '../desktop.js';
import { ContactToasts } from '../layout/contact-toasts.js';
import { OwnerPanel } from '../pages/approvals/index.js';
import { APPROVAL_STRINGS as A } from '../pages/approvals/strings.js';
import {
  DISMISSED_KEY,
  dismissNotice,
  isDismissed,
  noticeKey,
  notify,
  resetNoticesForTests,
} from './index.js';

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
  vi.restoreAllMocks();
});

const READY = { ready: true, offered: false } as const;
const text = (): string => host.textContent ?? '';
const render = (el: ReturnType<typeof h>): void => act(() => root.render(el));

describe('the desktop marker', () => {
  it('is found in the desktop app user agent only', () => {
    expect(inDesktopApp(`Mozilla/5.0 Chrome/140 ${DESKTOP_UA_MARKER}`)).toBe(true);
    expect(inDesktopApp('Mozilla/5.0 Chrome/140 Safari/537.36')).toBe(false);
  });
});

describe('Protect your approvals (page notice)', () => {
  it('in a browser without passkeys: a styled card, the master code, a close', () => {
    render(h(OwnerPanel, { owner: READY, canPasskey: false, desktop: false }));
    const notice = host.querySelector('section.al-notice');
    expect(notice).not.toBeNull();
    expect(text()).toContain(A.firstRunTitle);
    expect(text()).toContain(A.noPasskeys);
    expect(host.querySelector(`[aria-label="${A.hideNotice}"]`)).not.toBeNull();
  });

  it('in the desktop app it never says "this browser" or that the desktop app is stronger', () => {
    render(h(OwnerPanel, { owner: READY, canPasskey: false, desktop: true }));
    expect(text()).toContain(A.protectedTitle);
    expect(text()).toContain(A.protectedBody);
    expect(text()).not.toMatch(/this browser/i);
    expect(text()).not.toContain(A.desktopNote);
    expect(text()).not.toMatch(/more strongly/i);
  });

  it('in the desktop app with its own sensor: "Turn on Touch ID for approvals" and its action', () => {
    const turnOn = vi.fn();
    render(
      h(OwnerPanel, {
        owner: READY,
        canPasskey: false,
        desktop: true,
        nativePresence: { sensor: 'Touch ID', turnOn },
      }),
    );
    expect(text()).toContain('Turn on Touch ID for approvals');
    expect(text()).not.toMatch(/this browser/i);
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Turn on Touch ID',
    );
    act(() => button?.click());
    expect(turnOn).toHaveBeenCalledTimes(1);
  });

  it('a close is remembered for this ID only', () => {
    render(h(OwnerPanel, { owner: READY, canPasskey: false, desktop: true }));
    act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${A.hideNotice}"]`)?.click());
    expect(host.querySelector('section.al-notice')).toBeNull();
    // Without an open ID the key is the bare word; an ID's key is its own.
    expect(isDismissed(noticeKey('protect-approvals'))).toBe(true);
    expect(isDismissed(noticeKey('protect-approvals', 'tali-work'))).toBe(false);
    expect(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')).toEqual(['protect-approvals']);
  });

  it('before the owner is set up it is a warning that cannot be closed', () => {
    render(h(OwnerPanel, { owner: { ready: false, offered: false }, canPasskey: false }));
    expect(text()).toContain(A.needsOwnerTitle);
    expect(host.querySelector('.al-notice-x')).toBeNull();
    expect(host.querySelector('.al-notice')?.className).toContain('al-tone-warning');
  });

  it('shows nothing once a passkey is registered', () => {
    render(
      h(OwnerPanel, {
        owner: { ready: true, offered: true, passkey: { credentialId: 'x' } as never },
        canPasskey: true,
        desktop: true,
      }),
    );
    expect(host.innerHTML).toBe('');
  });
});

describe('remembered dismissals', () => {
  it('accept fixed keys only and survive blocked storage', () => {
    dismissNotice('<script>');
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    dismissNotice('tidy-up');
    // Kept for this page while it is open.
    expect(isDismissed('tidy-up')).toBe(true);
  });
});

describe('the shell toast stack', () => {
  it('shows a toast any page raises, as text, and closes it', async () => {
    render(h(ContactToasts, { subscribe: () => () => undefined, ms: 0 }));
    await act(async () => {
      notify({ text: '<img src=x> Renamed.' });
    });
    expect(text()).toContain('<img src=x> Renamed.');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('[role="region"]')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')?.click());
    expect(text()).not.toContain('Renamed.');
  });

  it('keeps at most three, newest last', async () => {
    render(h(ContactToasts, { subscribe: () => () => undefined, ms: 0 }));
    await act(async () => {
      for (const n of [1, 2, 3, 4]) notify({ text: `T${n}` });
    });
    const shown = [...host.querySelectorAll('.al-toast')].map((t) => t.textContent);
    expect(shown.map((s) => s?.slice(0, 2))).toEqual(['T2', 'T3', 'T4']);
  });
});
