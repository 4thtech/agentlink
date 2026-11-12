// @vitest-environment jsdom
// F49 (Windows 11, Chrome: Windows Hello gives no PRF): an owner with only the master code confirms
// every owner approval with it as the one primary action; "Switch to …" is a quiet link. After a
// switch fails for lack of PRF, the sheet goes back to the code (nothing changed), stops offering
// the switch in this browser, and never tells someone in Chrome or Edge to open Chrome or Edge.
// With a passkey, the sheet is unchanged.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PasskeyStatus, PresenceProof } from './owner.js';
import type { PasskeySwitchOutcome } from './passkey-switch.js';
import { detectPlatform } from '../first-run/passkey.js';
import {
  SWITCH_UNSUPPORTED_KEY,
  resetSwitchUnsupportedForTests,
  switchUnsupportedHere,
} from '../first-run/passkey-nudge.js';
import { SENSOR } from '../first-run/strings.js';
import { PresencePrompt } from './presence-prompt.js';
import { CONTACTS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetSwitchUnsupportedForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  resetSwitchUnsupportedForTests();
});

const SWITCH_TO = { rpId: 'localhost', userId: 'dXNlcg', prfSalt: 'c2FsdA' } as const;
const NONE_HERE: PasskeyStatus = {
  kind: 'unavailable',
  reason: 'not_set_up_here',
  switchTo: SWITCH_TO,
};
const READY: PasskeyStatus = {
  kind: 'ready',
  info: { credentialId: 'Y3JlZA', prfSalt: 'c2FsdA' },
};
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

const all = (): HTMLButtonElement[] => [...host.querySelectorAll('button')];
const find = (text: string | RegExp): HTMLButtonElement | undefined =>
  all().find((b) =>
    typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? ''),
  );

async function type(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[name="owner-code"]');
  if (input === null) throw new Error('no code field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function render(
  status: PasskeyStatus,
  passkey?: { credentialId: string; prfSalt: string },
  switchOutcome: PasskeySwitchOutcome = { kind: 'unsupported' },
): Promise<{ submitted: PresenceProof[]; switches: number }> {
  const out = { submitted: [] as PresenceProof[], switches: 0 };
  await act(async () => {
    root.render(
      createElement(PresencePrompt, {
        summary: 'Remove Work',
        passkey,
        busy: false,
        error: undefined,
        onSubmit: (proof) => void out.submitted.push(proof),
        onCancel: () => undefined,
        passkeyStatus: () => Promise.resolve(status),
        switchPasskey: () => {
          out.switches += 1;
          return Promise.resolve(switchOutcome);
        },
      }),
    );
  });
  await flush();
  return out;
}

describe('F49: no passkey here, the master code confirms', () => {
  it('one primary action "Confirm with your master code"; the switch is a ghost link', async () => {
    await render(NONE_HERE);
    const primary = host.querySelectorAll('.al-btn-primary');
    expect(primary).toHaveLength(1);
    expect(primary[0]?.textContent).toBe(S.confirmWithCode);
    expect((primary[0] as HTMLButtonElement).disabled).toBe(false);
    expect(find(/^Switch to /)?.className).toContain('al-btn-ghost');
  });

  it('confirms with the typed code through the same presence proof (no new path)', async () => {
    const r = await render(NONE_HERE);
    await type('abcd efgh ijkl mnop qrst uvwx');
    await act(async () => find(S.confirmWithCode)?.click());
    expect(r.submitted).toEqual([{ kind: 'code', code: 'abcd efgh ijkl mnop qrst uvwx' }]);
    expect(r.switches).toBe(0);
  });

  it('an empty code says what to do instead of doing nothing', async () => {
    const r = await render(NONE_HERE);
    await act(async () => find(S.confirmWithCode)?.click());
    expect(r.submitted).toEqual([]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Enter your master code first.');
  });

  it('a switch without PRF goes back to the code, is remembered, and is not offered again', async () => {
    const r = await render(NONE_HERE);
    await act(async () => find(/^Switch to /)?.click());
    await type('ABCDEFGHIJKLMNOPQRSTUVWX');
    await act(async () => find(/^Switch to /)?.click());
    await flush();
    expect(r.switches).toBe(1);
    expect(r.submitted).toEqual([]);
    expect(switchUnsupportedHere()).toBe(true);
    expect(localStorage.getItem(SWITCH_UNSUPPORTED_KEY)).toBe('1');
    expect(find(S.confirmWithCode)).toBeDefined();
    expect(find(/^Switch to /)).toBeUndefined();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Nothing changed/);
    // The code field is back, ready to confirm this operation now.
    await type('ABCDEFGHIJKLMNOPQRSTUVWX');
    await act(async () => find(S.confirmWithCode)?.click());
    expect(r.submitted).toEqual([{ kind: 'code', code: 'ABCDEFGHIJKLMNOPQRSTUVWX' }]);
  });

  it('remembered in this browser: a new sheet offers the code alone and says why plainly', async () => {
    localStorage.setItem(SWITCH_UNSUPPORTED_KEY, '1');
    await render(NONE_HERE);
    expect(find(/^Switch to /)).toBeUndefined();
    expect(host.textContent).toContain(PASSKEY_SENSOR_LINE());
  });

  it('in Chrome on Windows the copy never says "open … in Chrome or Edge"', async () => {
    const ua = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', { value: CHROME_WIN, configurable: true });
    try {
      await render(NONE_HERE);
      await act(async () => find(/^Switch to /)?.click());
      await type('ABCDEFGHIJKLMNOPQRSTUVWX');
      await act(async () => find(/^Switch to /)?.click());
      await flush();
      expect(host.textContent).not.toMatch(/Chrome or Edge/);
      expect(host.textContent).toMatch(
        /can't protect approvals yet, so AgentLink uses your master code/,
      );
    } finally {
      delete (navigator as { userAgent?: string }).userAgent;
      if (ua !== undefined) Object.defineProperty(Navigator.prototype, 'userAgent', ua);
    }
  });
});

describe('F49: with a passkey, the sheet is unchanged', () => {
  it('the passkey is the primary action, the code is the other way, no switch', async () => {
    await render(READY, { credentialId: 'Y3JlZA', prfSalt: 'c2FsdA' });
    const primary = host.querySelectorAll('.al-btn-primary');
    expect(primary).toHaveLength(1);
    expect(primary[0]?.textContent).toBe(S.usePasskeyOn(SENSOR[detectPlatform()]));
    expect(find(S.useCode)).toBeDefined();
    expect(find(/^Switch to /)).toBeUndefined();
    expect(host.querySelector('input[name="owner-code"]')).toBeNull();
  });
});

function PASSKEY_SENSOR_LINE(): string {
  const sensor = SENSOR[detectPlatform()];
  return `${sensor.charAt(0).toUpperCase()}${sensor.slice(1)} on this computer can't protect approvals yet, so this asks for your master code.`;
}
