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
import { registerNative, replaceNative } from './native-api.js';
import {
  NativeWaitNotice,
  cancelNativeWait,
  isNativePresenceRequest,
  nativeWaitFetch,
  nativeWaiting,
} from './native-wait.js';
import { NATIVE_STRINGS, nativeOutcomeText } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/39.0 ${DESKTOP_MARKER}`;
const WIN_APP = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/39.0 ${DESKTOP_MARKER}`;
const ORIGIN = location.origin;

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
  const calls: { input: RequestInfo | URL; url: string; method: string }[] = [];
  const base = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      input,
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method:
        init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET'),
    });
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
  return { base, seen, pending, calls };
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

  it('Cancel asks the server to cancel and never aborts or answers the request itself', async () => {
    const held = heldFetch();
    const f = nativeWaitFetch(held.base, ORIGIN);
    const p = f('/api/owner/native/replace', { method: 'POST' });
    cancelNativeWait(held.base);
    // The second call is the cancel request; the original one is still waiting for the server.
    expect(held.seen).toHaveLength(2);
    expect(held.seen[0]?.signal).toBeUndefined();
    expect(held.calls[1]).toMatchObject({ url: '/api/owner/native/cancel', method: 'POST' });
    expect(nativeWaiting()).toBe(true);
    held.pending[1]?.resolve(new Response('{"status":"cancelling"}'));
    // The server's own answer (here: it had already finished) is what the caller gets.
    const answer = new Response('{"status":"registered"}', { status: 200 });
    held.pending[0]?.resolve(answer);
    expect(await p).toBe(answer);
    expect(nativeWaiting()).toBe(false);
  });

  it("keeps a Request's own signal and tracks every request in flight", async () => {
    const held = heldFetch();
    const f = nativeWaitFetch(held.base, ORIGIN);
    const own = new AbortController();
    const req = new Request(`${ORIGIN}/api/owner/native`, { method: 'POST', signal: own.signal });
    const a = f(req);
    const b = f('/api/approvals/x/approve', {
      method: 'POST',
      headers: { 'X-AgentLink-Presence': 'native' },
    });
    expect(held.seen[0]?.signal).toBeUndefined();
    expect(held.calls[0]?.input).toBe(req);
    held.pending[0]?.resolve(new Response('{}'));
    await a;
    expect(nativeWaiting()).toBe(true);
    held.pending[1]?.resolve(new Response('{}'));
    await b;
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
    expect(held.calls[1]?.url).toBe('/api/owner/native/cancel');
    held.pending[1]?.resolve(new Response('{"status":"cancelling"}'));
    held.pending[0]?.resolve(
      new Response('{"status":"presence_rejected","native":"cancelled"}', { status: 403 }),
    );
    expect((await p).status).toBe(403);
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

// Fable review L-2 / L-1: honest wording when turning it on again failed after the old one was
// removed (`nowOff`), and when a keychain write may still have landed (`keychain_unsure`).
describe('honest answers of turning it on (again)', () => {
  const answering = (status: number, body: unknown) => () =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  it('on again that failed after removing the old one says it is now off', async () => {
    const out = await replaceNative(
      'CODE',
      answering(403, { status: 'presence_rejected', native: 'timeout', nowOff: true }),
      't',
    );
    expect(out).toEqual({ kind: 'native', state: 'timeout', nowOff: true });
    const text = nativeOutcomeText(out, 'mac');
    expect(text).toBe(NATIVE_STRINGS.nowOff('mac'));
    expect(text).not.toContain('Nothing was changed');
  });
  it('a keychain write that may have landed says so', async () => {
    const out = await registerNative(
      'CODE',
      answering(503, { status: 'failed', native: 'keychain_unsure' }),
      't',
    );
    expect(out).toEqual({ kind: 'native', state: 'keychain_unsure' });
    expect(nativeOutcomeText(out, 'mac')).toBe(NATIVE_STRINGS.state.keychain_unsure);
    expect(NATIVE_STRINGS.state.keychain_unsure).not.toContain('Nothing was changed');
  });
});
