// @vitest-environment jsdom
// DESK-D12c (Fable review M1): Settings "Use Touch ID for approvals" in the desktop app. On, off and
// on again after a fingerprint change are each confirmed with the master code; the reregister state
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
const toggle = (): HTMLButtonElement | null => host.querySelector('[role="switch"]');
/** The switch's state, as assistive technology reads it. */
const checked = (): boolean | undefined =>
  toggle() === null ? undefined : toggle()?.getAttribute('aria-checked') === 'true';
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
  it('turns it off with the master code', async () => {
    const calls = await render(MAC_APP, [
      { available: true, registered: true },
      { available: true, registered: false },
    ]);
    expect(host.textContent).toContain('Use Touch ID for approvals');
    expect(checked()).toBe(true);
    await act(async () => toggle()?.click());
    await flush();
    await typeCode('ABCD EFGH');
    await clickButton(NATIVE_STRINGS.confirmCode);
    expect(calls).toEqual(['off:ABCD EFGH']);
    expect(host.textContent).toContain(NATIVE_STRINGS.turnedOff('mac'));
    expect(checked()).toBe(false);
  });

  it('a fingerprint change shows the reregister state; Turn on again works with the master code', async () => {
    const calls = await render(MAC_APP, [
      { available: true, registered: true, reason: 'reregister' },
      { available: true, registered: true },
    ]);
    expect(host.textContent).toContain(NATIVE_STRINGS.state.reregister);
    await clickButton(NATIVE_STRINGS.turnOnAgain);
    await typeCode('ABCD EFGH');
    await clickButton(NATIVE_STRINGS.confirmCode);
    expect(calls).toEqual(['again:ABCD EFGH']);
    expect(checked()).toBe(true);
  });

  it('nothing in a browser, and nothing where Touch ID is not available', async () => {
    await render(MAC_SAFARI, [{ available: true, registered: true }]);
    expect(toggle()).toBeNull();
    await render(MAC_APP, [{ available: false, registered: false }]);
    expect(toggle()).toBeNull();
  });
});

// DESK-NATIVE-DEBUG: no outcome ends silently. While the OS prompt is up the card says it is
// waiting; every answer (each helper state, the keychain, busy, wait, a dropped or too-slow
// request) shows its own fixed message, errors are announced, and the status is read again.
describe('Settings: every outcome is visible (DESK-NATIVE-DEBUG)', () => {
  async function renderWith(
    outcome: () => Promise<NativeRegistration>,
    statuses: NativeStatus[] = [{ available: true, registered: false }],
  ): Promise<{ reads: () => number }> {
    let at = 0;
    await act(async () => {
      root.render(
        createElement(NativeSettings, {
          userAgent: MAC_APP,
          nativeStatus: () =>
            Promise.resolve(statuses[Math.min(at++, statuses.length - 1)] as NativeStatus),
          ops: { on: outcome, off: outcome, again: outcome },
        }),
      );
    });
    await flush();
    return { reads: () => at };
  }
  async function confirm(): Promise<void> {
    await act(async () => toggle()?.click());
    await flush();
    await typeCode('ABCD EFGH');
    await clickButton(NATIVE_STRINGS.confirmCode);
  }

  it('says it is waiting for Touch ID while the prompt is up', async () => {
    let answer: (r: NativeRegistration) => void = () => undefined;
    await renderWith(() => new Promise<NativeRegistration>((resolve) => (answer = resolve)));
    await confirm();
    expect(host.querySelector('[data-native-waiting]')?.textContent).toBe(
      NATIVE_STRINGS.waiting('mac'),
    );
    await act(async () => answer({ kind: 'native', state: 'cancelled' }));
    await flush();
    expect(host.querySelector('[data-native-waiting]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(NATIVE_STRINGS.state.cancelled);
  });

  const cases: [NativeRegistration, string][] = [
    [{ kind: 'native', state: 'cancelled' }, NATIVE_STRINGS.state.cancelled],
    [{ kind: 'native', state: 'failed' }, NATIVE_STRINGS.state.failed],
    [{ kind: 'native', state: 'lockout' }, NATIVE_STRINGS.state.lockout],
    [{ kind: 'native', state: 'unavailable' }, NATIVE_STRINGS.unavailableNow('mac')],
    [{ kind: 'native', state: 'timeout' }, NATIVE_STRINGS.state.timeout],
    [{ kind: 'native', state: 'keychain' }, NATIVE_STRINGS.state.keychain],
    [{ kind: 'native', state: 'error' }, NATIVE_STRINGS.state.error],
    [{ kind: 'rejected' }, NATIVE_STRINGS.wrongCode],
    [{ kind: 'busy' }, NATIVE_STRINGS.busy],
    [{ kind: 'wait' }, NATIVE_STRINGS.wait],
    [{ kind: 'needs_setup' }, NATIVE_STRINGS.needsSetup],
    [{ kind: 'timeout' }, NATIVE_STRINGS.pageTimeout],
    [{ kind: 'failed' }, NATIVE_STRINGS.state.error],
  ];
  for (const [outcome, text] of cases) {
    it(`${outcome.kind}${'state' in outcome ? `/${outcome.state}` : ''}: its own message, announced`, async () => {
      const r = await renderWith(() => Promise.resolve(outcome));
      await confirm();
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(text);
      // Read again after the answer, so the switch shows what is stored.
      expect(r.reads()).toBe(2);
      expect(checked()).toBe(false);
    });
  }

  it('a thrown operation is a message too, never silence', async () => {
    await renderWith(() => Promise.reject(new Error('boom')));
    await confirm();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(NATIVE_STRINGS.state.error);
  });

  it('the switch sits in its own settings row, with the prompt beneath it', async () => {
    await renderWith(() => Promise.resolve({ kind: 'registered' }));
    const card = host.querySelector('section.st-native');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.st-native-row [role="switch"]')).not.toBeNull();
    expect(card?.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => toggle()?.click());
    await flush();
    const form = card?.querySelector('form.st-native-body');
    expect(form?.previousElementSibling?.classList.contains('st-native-row')).toBe(true);
  });
});
