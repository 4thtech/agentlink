// @vitest-environment jsdom
// HOTFIX-045-TOUCHID: the presence sheet says why it asks for the master code instead of Touch ID,
// and an owner without a passkey on this computer switches once inside the sheet; the operation is
// then confirmed with its own touch (the switch signs nothing and submits nothing for the caller).
// readPasskeyStatus parses exactly the answers of the real server (packages/node
// app-host-welcome.test.ts "HOTFIX-045-TOUCHID", owner-passkey.test.ts other_owner).
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPasskeyStatus, type PasskeyStatus, type PresenceProof } from './owner.js';
import type { PasskeySwitchOutcome } from './passkey-switch.js';
import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR } from '../first-run/strings.js';
import { PresencePrompt } from './presence-prompt.js';
import { CONTACTS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const SWITCH_TO = { rpId: 'localhost', userId: 'dXNlcg', prfSalt: 'c2FsdA' } as const;
const READY: PasskeyStatus = {
  kind: 'ready',
  info: { credentialId: 'Y3JlZA', prfSalt: 'c2FsdA' },
};

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function buttons(): string[] {
  return [...host.querySelectorAll('button')].map((b) => b.textContent ?? '');
}

function button(text: RegExp | string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) =>
    typeof text === 'string' ? b.textContent === text : text.test(b.textContent ?? ''),
  );
  if (found === undefined) throw new Error(`no button ${String(text)}: ${buttons().join(' | ')}`);
  return found;
}

async function type(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) throw new Error('no code field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

interface Rendered {
  readonly submitted: PresenceProof[];
  readonly switches: [unknown, string][];
}

async function render(
  status: () => Promise<PasskeyStatus>,
  switchOutcome: () => Promise<PasskeySwitchOutcome> = () => Promise.resolve({ kind: 'switched' }),
): Promise<Rendered> {
  const submitted: PresenceProof[] = [];
  const switches: [unknown, string][] = [];
  await act(async () => {
    root.render(
      createElement(PresencePrompt, {
        summary: "Accept Marko's invite",
        passkey: undefined,
        busy: false,
        error: undefined,
        onSubmit: (proof) => void submitted.push(proof),
        onCancel: () => undefined,
        passkeyStatus: status,
        switchPasskey: (values, code) => {
          switches.push([values, code]);
          return switchOutcome();
        },
      }),
    );
  });
  await flush();
  return { submitted, switches };
}

describe('REL051-UF3 (R1-UI-06): one sensor question per press', () => {
  // REL051-SF1: the sensor is asked inside the ceremony, by the caller's request (the proof carries
  // the gesture). A real caller (contacts, join, paste invite, person menu, name contact) sets `busy`
  // in the same callback that receives the proof and runs the gesture with the server's challenge.
  // Single flight holds across that hand-over: one press, one proof, one sensor question.
  const PUBLIC_KEY = {
    challenge: 'Y2hhbGxlbmdl',
    allowCredentials: ['Y3JlZA'],
    prfSalt: 'c2FsdA',
    timeoutMs: 60_000,
  } as const;

  function Caller({
    onProof,
    ceremony,
  }: {
    onProof: () => void;
    ceremony: (run: () => Promise<Uint8Array | undefined>) => Promise<void>;
  }): ReturnType<typeof createElement> {
    const [busy, setBusy] = useState(false);
    return createElement(PresencePrompt, {
      summary: "Accept Marko's invite",
      passkey: undefined,
      busy,
      error: undefined,
      onSubmit: (proof) => {
        onProof();
        setBusy(true);
        const run = (): Promise<Uint8Array | undefined> =>
          proof.kind === 'passkey' ? proof.gesture(PUBLIC_KEY) : Promise.resolve(undefined);
        void ceremony(run).finally(() => setBusy(false));
      },
      onCancel: () => undefined,
      passkeyStatus: () => Promise.resolve(READY),
    });
  }

  it('a double click on "Confirm with …" hands over one proof and asks the sensor once, held until the request settles', async () => {
    let asked = 0;
    let proofs = 0;
    let finish: ((value: null) => void) | undefined;
    let settle: (() => void) | undefined;
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        get: () => {
          asked += 1;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    try {
      await act(async () => {
        root.render(
          createElement(Caller, {
            onProof: () => {
              proofs += 1;
            },
            // The ceremony: the challenge answer comes first, then the gesture, then the request.
            ceremony: async (run) => {
              await Promise.resolve();
              await run();
              await new Promise<void>((resolve) => {
                settle = resolve;
              });
            },
          }),
        );
      });
      await flush();
      const confirm = button(S.usePasskeyOn(SENSOR[detectPlatform()]));
      // Both clicks land before React draws the held button (the ref guard), then a late third.
      await act(async () => {
        confirm.click();
        confirm.click();
      });
      await flush();
      await act(async () => confirm.click());
      expect(proofs).toBe(1);
      expect(asked).toBe(1);
      expect(confirm.disabled).toBe(true);
      // Cancelled at the sensor: still held while the request answers (nothing was sent).
      await act(async () => finish?.(null));
      await flush();
      await act(async () => confirm.click());
      expect(asked).toBe(1);
      expect(confirm.disabled).toBe(true);
      // The request settled: the button opens again, and the next press asks once more.
      await act(async () => settle?.());
      await flush();
      expect(confirm.disabled).toBe(false);
      await act(async () => confirm.click());
      await flush();
      expect(proofs).toBe(2);
      expect(asked).toBe(2);
    } finally {
      Reflect.deleteProperty(navigator, 'credentials');
    }
  });
});

describe('HOTFIX-045-TOUCHID: the presence sheet says why and offers the switch', () => {
  it('a passkey the caller missed is still offered (owner store answered after all)', async () => {
    await render(() => Promise.resolve(READY));
    expect(buttons()).toContain(S.usePasskeyOn(SENSOR[detectPlatform()]));
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it('no passkey here: says so in plain words and offers "Switch to …" next to the code', async () => {
    await render(() =>
      Promise.resolve({ kind: 'unavailable', reason: 'not_set_up_here', switchTo: SWITCH_TO }),
    );
    const status = host.querySelector('[role="status"]')?.textContent ?? '';
    expect(status).toMatch(/isn't set up for AgentLink on this computer yet/);
    expect(status).toMatch(/master code/);
    expect(status).not.toMatch(/wallet|gas|seed phrase|transaction/i);
    expect(button(/^Switch to /)).toBeDefined();
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('the switch: master code once, then the operation is confirmed with its own touch', async () => {
    let reads = 0;
    const r = await render(() => {
      reads += 1;
      return Promise.resolve(
        reads === 1
          ? { kind: 'unavailable', reason: 'not_set_up_here', switchTo: SWITCH_TO }
          : READY,
      );
    });
    await act(async () => button(/^Switch to /).click());
    // The switch's code field invites no autofill (11 §5, as the approval card).
    const field = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(field?.getAttribute('autocomplete')).toBe('off');
    expect(field?.closest('form')?.getAttribute('autocomplete')).toBe('off');
    await type('ABCD-EFGH-IJKL');
    await act(async () => button(/^Switch to /).click());
    await flush();
    expect(r.switches).toEqual([[SWITCH_TO, 'ABCD-EFGH-IJKL']]);
    // The switch submitted nothing for the operation: it still needs its own gesture.
    expect(r.submitted).toEqual([]);
    expect(host.textContent).toMatch(/ is on\. Now confirm with /);
    expect(buttons()).toContain(S.usePasskeyOn(SENSOR[detectPlatform()]));
    expect(host.querySelector('input[type="password"]')).toBeNull();
  });

  it('F24: the passkey button uses the platform word (Touch ID on a Mac, Windows Hello, else passkey)', async () => {
    const ua = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    try {
      for (const [agent, label] of [
        ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'Confirm with Touch ID'],
        ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Confirm with Windows Hello'],
        ['Mozilla/5.0 (X11; Linux x86_64)', 'Confirm with your passkey'],
      ] as const) {
        Object.defineProperty(navigator, 'userAgent', { value: agent, configurable: true });
        await render(() => Promise.resolve(READY));
        expect(buttons()).toContain(label);
      }
    } finally {
      if (ua === undefined) delete (navigator as { userAgent?: string }).userAgent;
      else Object.defineProperty(navigator, 'userAgent', ua);
    }
  });

  it('a wrong master code in the switch says so and changes nothing', async () => {
    const r = await render(
      () =>
        Promise.resolve({ kind: 'unavailable', reason: 'not_set_up_here', switchTo: SWITCH_TO }),
      () => Promise.resolve({ kind: 'error', problem: 'presence_rejected' }),
    );
    await act(async () => button(/^Switch to /).click());
    await type('WRONG');
    await act(async () => button(/^Switch to /).click());
    await flush();
    expect(r.switches.length).toBe(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/didn't work/);
    expect(buttons()).not.toContain(S.usePasskeyOn(SENSOR[detectPlatform()]));
  });

  it("another owner's passkey: says why, and no switch is offered (a second one is refused)", async () => {
    await render(() => Promise.resolve({ kind: 'unavailable', reason: 'other_owner' }));
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/different owner/);
    expect(buttons().some((b) => b.startsWith('Switch to'))).toBe(false);
  });

  it('no switch without the values (no agent open): the reason only', async () => {
    await render(() => Promise.resolve({ kind: 'unavailable', reason: 'not_set_up_here' }));
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/on this computer yet/);
    expect(buttons().some((b) => b.startsWith('Switch to'))).toBe(false);
  });
});

describe('HOTFIX-045-TOUCHID: readPasskeyStatus reads the server answers', () => {
  const answer =
    (status: number, body: unknown): typeof fetch =>
    () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

  beforeEach(() => {
    (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    Object.defineProperty(navigator, 'credentials', { value: {}, configurable: true });
  });
  afterEach(() => {
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  });

  it('registered (also with no agent open) is ready', async () => {
    const fetch = answer(200, {
      passkey: {
        registered: true,
        rpId: 'localhost',
        userId: 'dXNlcg',
        prfSalt: 'c2FsdA',
        credentialId: 'Y3JlZA',
      },
    });
    expect(await readPasskeyStatus({ fetch, token: 't' })).toEqual(READY);
  });

  it('not_set_up_here with userId can switch; without it (no agent open) it cannot', async () => {
    const withAgent = answer(200, {
      passkey: {
        registered: false,
        rpId: 'localhost',
        userId: 'dXNlcg',
        prfSalt: 'c2FsdA',
        reason: 'not_set_up_here',
      },
    });
    expect(await readPasskeyStatus({ fetch: withAgent, token: 't' })).toEqual({
      kind: 'unavailable',
      reason: 'not_set_up_here',
      switchTo: SWITCH_TO,
    });
    const noAgent = answer(200, {
      passkey: {
        registered: false,
        rpId: 'localhost',
        prfSalt: 'c2FsdA',
        reason: 'not_set_up_here',
      },
    });
    expect(await readPasskeyStatus({ fetch: noAgent, token: 't' })).toEqual({
      kind: 'unavailable',
      reason: 'not_set_up_here',
    });
  });

  it('other_owner never offers the switch; refusals and odd answers are unknown', async () => {
    const other = answer(200, {
      passkey: {
        registered: false,
        rpId: 'localhost',
        userId: 'dXNlcg',
        prfSalt: 'c2FsdA',
        reason: 'other_owner',
      },
    });
    expect(await readPasskeyStatus({ fetch: other, token: 't' })).toEqual({
      kind: 'unavailable',
      reason: 'other_owner',
    });
    expect(
      await readPasskeyStatus({ fetch: answer(409, { status: 'no_agent' }), token: 't' }),
    ).toEqual({ kind: 'unavailable', reason: 'unknown' });
    const odd = answer(200, {
      passkey: { registered: false, rpId: 'localhost', prfSalt: 'c2FsdA', reason: '<b>x</b>' },
    });
    expect(await readPasskeyStatus({ fetch: odd, token: 't' })).toEqual({
      kind: 'unavailable',
      reason: 'unknown',
    });
  });
});
