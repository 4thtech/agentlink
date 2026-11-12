// @vitest-environment jsdom
// DESK-D12c (Fable review M1): Settings "Use Touch ID for approvals" in the desktop app. On, off and
// on again after a fingerprint change are each confirmed with the backup code; the reregister state
// leads to a working "Turn on again". Nothing in a browser.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESKTOP_MARKER } from './desktop.js';
import type { NativeRegistration, NativeStatus } from './native-api.js';
import { NativeSettings } from './native-settings.js';
import { NATIVE_STRINGS } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAC_APP = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/39.0 ${DESKTOP_MARKER}`;
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15';

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
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}
const toggle = (): HTMLInputElement | null => host.querySelector('input[role="switch"]');
async function clickButton(text: string): Promise<void> {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  await act(async () => b.click());
  await flush();
}
async function typeCode(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) throw new Error('no code field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function render(ua: string, statuses: NativeStatus[]) {
  const calls: string[] = [];
  let at = 0;
  const answer = (kind: 'registered' | 'off') => (code: string) => {
    calls.push(`${kind}:${code}`);
    return Promise.resolve({ kind } as NativeRegistration);
  };
  await act(async () => {
    root.render(
      createElement(NativeSettings, {
        userAgent: ua,
        nativeStatus: () =>
          Promise.resolve(statuses[Math.min(at++, statuses.length - 1)] as NativeStatus),
        ops: {
          on: answer('registered'),
          off: answer('off'),
          again: (code: string) => {
            calls.push(`again:${code}`);
            return Promise.resolve<NativeRegistration>({ kind: 'registered' });
          },
        },
      }),
    );
  });
  await flush();
  return calls;
}

describe('Settings: Use Touch ID for approvals', () => {
  it('turns it off with the backup code', async () => {
    const calls = await render(MAC_APP, [
      { available: true, registered: true },
      { available: true, registered: false },
    ]);
    expect(host.textContent).toContain('Use Touch ID for approvals');
    expect(toggle()?.checked).toBe(true);
    await act(async () => toggle()?.click());
    await flush();
    await typeCode('ABCD EFGH');
    await clickButton(NATIVE_STRINGS.confirmCode);
    expect(calls).toEqual(['off:ABCD EFGH']);
    expect(host.textContent).toContain(NATIVE_STRINGS.turnedOff('mac'));
    expect(toggle()?.checked).toBe(false);
  });

  it('a fingerprint change shows the reregister state; Turn on again works with the backup code', async () => {
    const calls = await render(MAC_APP, [
      { available: true, registered: true, reason: 'reregister' },
      { available: true, registered: true },
    ]);
    expect(host.textContent).toContain(NATIVE_STRINGS.state.reregister);
    await clickButton(NATIVE_STRINGS.turnOnAgain);
    await typeCode('ABCD EFGH');
    await clickButton(NATIVE_STRINGS.confirmCode);
    expect(calls).toEqual(['again:ABCD EFGH']);
    expect(toggle()?.checked).toBe(true);
  });

  it('nothing in a browser, and nothing where Touch ID is not available', async () => {
    await render(MAC_SAFARI, [{ available: true, registered: true }]);
    expect(toggle()).toBeNull();
    await render(MAC_APP, [{ available: false, registered: false }]);
    expect(toggle()).toBeNull();
  });
});
