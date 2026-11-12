// @vitest-environment jsdom
// DESK-D12c (S2; D-145 phase 2; 04 §2.5 "Desktop app owner presence"; 11 §5): in the desktop app
// (user-agent marker `AgentLinkDesktop/1`) the presence screens offer "Use Touch ID" (macOS) or "Use
// Windows Hello" (Windows) as the primary confirm, once this computer's native presence is turned on;
// "Use your backup code instead" stays. First-time setup offers "Turn on Touch ID for approvals"
// (one gesture). In a browser nothing changes. The page never runs the helper: it sends the native
// presence kind (empty body) and the server does the rest.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PresencePrompt } from '../pages/contacts/presence-prompt.js';
import type { PasskeyStatus, PresenceProof } from '../pages/contacts/owner.js';
import {
  DESKTOP_MARKER,
  desktopPlatform,
  nativeConfirmLabel,
  nativeSetupLabel,
} from './desktop.js';
import { readNativeStatus, registerNative, type NativeStatus } from './native-api.js';
import { NativeSetupOffer } from './native-setup.js';
import { NATIVE_STRINGS } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UNAVAILABLE: PasskeyStatus = { kind: 'unavailable', reason: 'not_set_up_here' };

const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0 Electron/39.0 Safari/537.36 ${DESKTOP_MARKER}`;
const WIN_APP = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Electron/39.0 Safari/537.36 ${DESKTOP_MARKER}`;
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
const WIN_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36';

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
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}
const buttons = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  if (found === undefined) throw new Error(`no button ${text}: ${buttons().join(' | ')}`);
  return found;
}
async function click(text: string): Promise<void> {
  await act(async () => {
    button(text).click();
  });
  await flush();
}

describe('the desktop marker and the platform words', () => {
  it('only the desktop app, on macOS or Windows, gets a native platform', () => {
    expect(DESKTOP_MARKER).toBe('AgentLinkDesktop/1');
    expect(desktopPlatform(MAC_APP)).toBe('mac');
    expect(desktopPlatform(WIN_APP)).toBe('windows');
    expect(desktopPlatform(MAC_SAFARI)).toBeUndefined();
    expect(desktopPlatform(WIN_CHROME)).toBeUndefined();
    expect(desktopPlatform(`Mozilla/5.0 (X11; Linux x86_64) ${DESKTOP_MARKER}`)).toBeUndefined();
    expect(desktopPlatform(`${MAC_SAFARI} AgentLinkDesktop/2`)).toBeUndefined();
  });

  it('says Use Touch ID / Use Windows Hello, and Turn on … for approvals (11 §5 plain words)', () => {
    expect(nativeConfirmLabel('mac')).toBe('Use Touch ID');
    expect(nativeConfirmLabel('windows')).toBe('Use Windows Hello');
    expect(nativeSetupLabel('mac')).toBe('Turn on Touch ID for approvals');
    expect(nativeSetupLabel('windows')).toBe('Turn on Windows Hello for approvals');
    for (const text of Object.values(NATIVE_STRINGS).map(String)) {
      expect(text).not.toMatch(/wallet|seed phrase|gas|transaction|secure enclave|tpm/i);
    }
  });
});

describe('the status and registration calls (GET / POST /api/owner/native)', () => {
  it('reads the server answer strictly; anything else is not available', async () => {
    const answer =
      (body: unknown, status = 200) =>
      () =>
        Promise.resolve(new Response(JSON.stringify(body), { status }));
    expect(
      await readNativeStatus(
        answer({ native: { available: true, registered: true, platform: 'mac' } }),
      ),
    ).toEqual({
      available: true,
      registered: true,
    });
    for (const bad of [{}, { native: { available: 'yes' } }, { native: null }]) {
      expect(await readNativeStatus(answer(bad))).toEqual({ available: false, registered: false });
    }
    expect(await readNativeStatus(answer({}, 500))).toEqual({
      available: false,
      registered: false,
    });
  });

  it('registers with the backup code as the body and maps the fixed answers', async () => {
    const seen: { url: string; body: string; headers: Headers }[] = [];
    const fetcher =
      (status: number, body: unknown) => (url: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(url),
          body: new TextDecoder().decode(init?.body as Uint8Array),
          headers: new Headers(init?.headers),
        });
        return Promise.resolve(new Response(JSON.stringify(body), { status }));
      };
    expect(await registerNative('ABCD', fetcher(200, { status: 'registered' }), 'tok')).toEqual({
      kind: 'registered',
    });
    expect(seen[0]?.url).toBe('/api/owner/native');
    expect(seen[0]?.body).toBe('ABCD');
    expect(seen[0]?.headers.get('X-AgentLink-CSRF')).toBe('tok');
    expect(seen[0]?.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(
      await registerNative(
        'x',
        fetcher(403, { status: 'presence_rejected', native: 'cancelled' }),
        't',
      ),
    ).toEqual({ kind: 'native', state: 'cancelled' });
    expect(await registerNative('x', fetcher(403, { status: 'presence_rejected' }), 't')).toEqual({
      kind: 'rejected',
    });
    expect(await registerNative('x', fetcher(409, { status: 'native_exists' }), 't')).toEqual({
      kind: 'registered',
    });
    expect(await registerNative('x', fetcher(409, { status: 'native_unavailable' }), 't')).toEqual({
      kind: 'native',
      state: 'unavailable',
    });
  });
});

describe('the presence prompt in the desktop app', () => {
  async function render(ua: string, status: NativeStatus): Promise<PresenceProof[]> {
    const submitted: PresenceProof[] = [];
    await act(async () => {
      root.render(
        createElement(PresencePrompt, {
          summary: 'Mark the safety code as checked',
          passkey: undefined,
          busy: false,
          error: undefined,
          onSubmit: (proof: PresenceProof) => void submitted.push(proof),
          onCancel: () => undefined,
          passkeyStatus: () => Promise.resolve(UNAVAILABLE),
          nativeStatus: () => Promise.resolve(status),
          userAgent: ua,
        }),
      );
    });
    await flush();
    return submitted;
  }

  it('macOS app: "Use Touch ID" is the primary confirm and sends the native kind; the code link stays', async () => {
    const submitted = await render(MAC_APP, { available: true, registered: true });
    expect(buttons()).toContain('Use Touch ID');
    expect(buttons()).toContain('Use your backup code instead');
    expect(button('Use Touch ID').className).toMatch(/primary/);
    await click('Use Touch ID');
    expect(submitted).toEqual([{ kind: 'native' }]);
  });

  it('Windows app: "Use Windows Hello"; the backup code instead opens the code field', async () => {
    await render(WIN_APP, { available: true, registered: true });
    expect(buttons()).toContain('Use Windows Hello');
    await click('Use your backup code instead');
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(buttons()).not.toContain('Use Windows Hello');
  });

  it('not turned on yet, or not available: the existing screens, no native button', async () => {
    await render(MAC_APP, { available: true, registered: false });
    expect(buttons()).not.toContain('Use Touch ID');
    await render(WIN_APP, { available: false, registered: false });
    expect(buttons()).not.toContain('Use Windows Hello');
  });

  it('in a browser nothing changes: the status is not even read', async () => {
    let read = 0;
    await act(async () => {
      root.render(
        createElement(PresencePrompt, {
          summary: 'x',
          passkey: undefined,
          busy: false,
          error: undefined,
          onSubmit: () => undefined,
          onCancel: () => undefined,
          passkeyStatus: () => Promise.resolve(UNAVAILABLE),
          nativeStatus: () => {
            read += 1;
            return Promise.resolve({ available: true, registered: true });
          },
          userAgent: MAC_SAFARI,
        }),
      );
    });
    await flush();
    expect(read).toBe(0);
    expect(buttons()).not.toContain('Use Touch ID');
  });
});

describe('first-time setup offers "Turn on Touch ID for approvals"', () => {
  async function renderOffer(ua: string, outcome: Awaited<ReturnType<typeof registerNative>>) {
    const calls: string[] = [];
    await act(async () => {
      root.render(
        createElement(NativeSetupOffer, {
          backupCode: 'ABCD EFGH',
          userAgent: ua,
          nativeStatus: () => Promise.resolve({ available: true, registered: false }),
          register: (code: string) => {
            calls.push(code);
            return Promise.resolve(outcome);
          },
        }),
      );
    });
    await flush();
    return calls;
  }

  it('macOS app: one button sends the backup code from setup once and says it is on', async () => {
    const calls = await renderOffer(MAC_APP, { kind: 'registered' });
    await click('Turn on Touch ID for approvals');
    expect(calls).toEqual(['ABCD EFGH']);
    expect(host.textContent).toContain(NATIVE_STRINGS.turnedOn('mac'));
  });

  it('Windows app: "Turn on Windows Hello for approvals"; a cancel says so and can be tried again', async () => {
    const calls = await renderOffer(WIN_APP, { kind: 'native', state: 'cancelled' });
    await click('Turn on Windows Hello for approvals');
    expect(host.textContent).toContain(NATIVE_STRINGS.state.cancelled);
    expect(buttons()).toContain('Turn on Windows Hello for approvals');
    expect(calls).toHaveLength(1);
  });

  it('not on a computer that cannot (unavailable), and never in a browser', async () => {
    await renderOffer(MAC_SAFARI, { kind: 'registered' });
    expect(buttons()).toEqual([]);
    await act(async () => {
      root.render(
        createElement(NativeSetupOffer, {
          backupCode: 'x',
          userAgent: MAC_APP,
          nativeStatus: () => Promise.resolve({ available: false, registered: false }),
          register: () => Promise.resolve({ kind: 'registered' as const }),
        }),
      );
    });
    await flush();
    expect(buttons()).toEqual([]);
  });

  it('fixed messages for each helper state (cancel, lockout, re-register, not available)', () => {
    expect(NATIVE_STRINGS.state.cancelled).toMatch(/cancel/i);
    expect(NATIVE_STRINGS.state.lockout).toMatch(/backup code/i);
    expect(NATIVE_STRINGS.state.reregister).toMatch(/turn .* on again/i);
    expect(NATIVE_STRINGS.state.unavailable).toMatch(/backup code/i);
  });
});
