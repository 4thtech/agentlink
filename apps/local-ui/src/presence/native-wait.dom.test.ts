// @vitest-environment jsdom
// DESK-TOUCHID-FIX: every request that starts the desktop app's presence helper (the native
// presence kind on any owner route, and turning Touch ID on or on again) first takes focus off the
// focused field, so a focused master-code field cannot keep macOS secure input on while the Touch ID
// sheet wants to become key. While it waits, the app says "Rest your finger on the Touch ID key"
// with a Cancel that ends the request (the server then stops the helper). Other requests are
// untouched.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESKTOP_MARKER } from './desktop.js';
import {
  NativeWaitNotice,
  cancelNativeWait,
  isNativePresenceRequest,
  nativeWaitFetch,
  nativeWaiting,
} from './native-wait.js';
import { NATIVE_STRINGS } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/39.0 ${DESKTOP_MARKER}`;
const WIN_APP = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/39.0 ${DESKTOP_MARKER}`;
const ORIGIN = 'http://localhost';

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
  cancelNativeWait();
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** A fetch that holds every request until released, and records what it saw. */
function heldFetch() {
  const seen: { focused: string | null; signal: AbortSignal | null | undefined }[] = [];
  const pending: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  const base = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    void input;
    seen.push({
      focused: (document.activeElement as HTMLElement | null)?.id ?? null,
      signal: init?.signal,
    });
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
  };
  return { base, seen, pending };
}

function focusCodeField(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'password';
  input.id = 'master-code';
  document.body.append(input);
  input.focus();
  expect(document.activeElement).toBe(input);
  return input;
}

describe('which requests start the helper', () => {
  it('the native kind on any owner route, and turning it on or on again; nothing else', () => {
    const native = { 'X-AgentLink-Presence': 'native' };
    expect(isNativePresenceRequest('POST', `${ORIGIN}/api/approvals/a/approve`, native)).toBe(true);
    expect(isNativePresenceRequest('POST', `${ORIGIN}/api/owner/native`, {})).toBe(true);
    expect(isNativePresenceRequest('POST', `${ORIGIN}/api/owner/native/replace`, {})).toBe(true);
    expect(isNativePresenceRequest('POST', `${ORIGIN}/api/owner/native/off`, {})).toBe(false);
    expect(isNativePresenceRequest('GET', `${ORIGIN}/api/owner/native`, {})).toBe(false);
    expect(
      isNativePresenceRequest('POST', `${ORIGIN}/api/rules`, { 'X-AgentLink-Presence': 'passkey' }),
    ).toBe(false);
    expect(isNativePresenceRequest('POST', `${ORIGIN}/api/rules`, new Headers(native))).toBe(true);
    expect(isNativePresenceRequest('POST', 'https://example.com/api/owner/native', {})).toBe(false);
  });
});

describe('the wrapped fetch', () => {
  it('blurs the focused master-code field before the request is sent', async () => {
    const input = focusCodeField();
    const held = heldFetch();
    const f = nativeWaitFetch(held.base, ORIGIN);
    const p = f(`${ORIGIN}/api/rules`, {
      method: 'POST',
      headers: { 'X-AgentLink-Presence': 'native' },
    });
    expect(held.seen[0]?.focused).not.toBe('master-code');
    expect(document.activeElement).not.toBe(input);
    expect(nativeWaiting()).toBe(true);
    held.pending[0]?.resolve(new Response('{}', { status: 200 }));
    await p;
    expect(nativeWaiting()).toBe(false);
    input.remove();
  });

  it('turning Touch ID on (master code in the body) also blurs the field first', async () => {
    const input = focusCodeField();
    const held = heldFetch();
    const p = nativeWaitFetch(held.base, ORIGIN)('/api/owner/native', { method: 'POST' });
    expect(held.seen[0]?.focused).not.toBe('master-code');
    held.pending[0]?.resolve(new Response('{}'));
    await p;
    input.remove();
  });

  it('leaves every other request alone (focus, signal, no waiting state)', async () => {
    const input = focusCodeField();
    const held = heldFetch();
    const p = nativeWaitFetch(held.base, ORIGIN)('/api/rules', {
      method: 'POST',
      headers: { 'X-AgentLink-Presence': 'passkey' },
    });
    expect(held.seen[0]?.focused).toBe('master-code');
    expect(held.seen[0]?.signal).toBeUndefined();
    expect(nativeWaiting()).toBe(false);
    held.pending[0]?.resolve(new Response('{}'));
    await p;
    input.remove();
  });

  it("Cancel aborts the request; the caller's own abort still works", async () => {
    const held = heldFetch();
    const f = nativeWaitFetch(held.base, ORIGIN);
    const p = f('/api/owner/native/replace', { method: 'POST' });
    cancelNativeWait();
    await expect(p).rejects.toThrow();
    expect(nativeWaiting()).toBe(false);

    const own = new AbortController();
    const q = f('/api/owner/native', { method: 'POST', signal: own.signal });
    own.abort();
    await expect(q).rejects.toThrow();
    expect(nativeWaiting()).toBe(false);
  });
});

describe('the waiting notice', () => {
  it('says "Rest your finger on the Touch ID key" with a Cancel that ends the request', async () => {
    expect(NATIVE_STRINGS.waiting('mac')).toBe('Rest your finger on the Touch ID key.');
    await act(async () => root.render(createElement(NativeWaitNotice, { userAgent: MAC_APP })));
    expect(host.querySelector('[data-native-waiting]')).toBeNull();
    const held = heldFetch();
    const p = nativeWaitFetch(held.base, ORIGIN)('/api/approvals/a/approve', {
      method: 'POST',
      headers: { 'X-AgentLink-Presence': 'native' },
    });
    await flush();
    const notice = host.querySelector('[data-native-waiting]');
    expect(notice?.textContent).toContain('Rest your finger on the Touch ID key.');
    const cancel = host.querySelector<HTMLButtonElement>('[data-native-cancel]');
    expect(cancel?.textContent).toBe(NATIVE_STRINGS.cancel);
    await act(async () => cancel?.click());
    await expect(p).rejects.toThrow();
    await flush();
    expect(host.querySelector('[data-native-waiting]')).toBeNull();
  });

  it('uses the Windows Hello words on Windows, and shows nothing in a browser', async () => {
    await act(async () => root.render(createElement(NativeWaitNotice, { userAgent: WIN_APP })));
    const held = heldFetch();
    const p = nativeWaitFetch(held.base, ORIGIN)('/api/owner/native', { method: 'POST' });
    await flush();
    expect(host.querySelector('[data-native-waiting]')?.textContent).toContain(
      NATIVE_STRINGS.waiting('windows'),
    );
    await act(async () =>
      root.render(createElement(NativeWaitNotice, { userAgent: 'Mozilla/5.0 Safari/605.1.15' })),
    );
    expect(host.querySelector('[data-native-waiting]')).toBeNull();
    held.pending[0]?.resolve(new Response('{}'));
    await p;
  });
});
