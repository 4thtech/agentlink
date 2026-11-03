// @vitest-environment jsdom
// W8-F11/F12/F13: the New ID presence gate (create-agent-gate.tsx).
// - F13: an owner without a passkey on this computer is offered the switch to Touch ID inside the
//   gate: the backup code once (passkey-switch.ts, the same switch as the presence sheet), then the
//   new ID is created with its own touch. An owner with a passkey sees the one Touch ID button.
// - F12: the backup-code form says in one plain line what the backup code is.
// - F11: the form spaces its field and buttons (a flex column with a gap) and shows one Back; inside
//   Get started (no onCancel) the wizard's own Back is the only one.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import agentsCss from '../agents/agents.css?raw';
import type { PasskeyStatus } from '../contacts/owner.js';
import type { PasskeySwitchOutcome } from '../contacts/passkey-switch.js';
import type { AppsApi } from '../first-run/apps-api.js';
import { NAME, UPGRADE } from '../first-run/strings.js';
import type { CreateAgentApi, CreateFinish } from './create-agent-api.js';
import { CreateAgentGate } from './create-agent-gate.js';

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
const NO_PASSKEY: PasskeyStatus = {
  kind: 'unavailable',
  reason: 'not_set_up_here',
  switchTo: SWITCH_TO,
};
const READY: PasskeyStatus = { kind: 'ready', info: { credentialId: 'Y3JlZA', prfSalt: 'c2FsdA' } };
const DONE: CreateFinish = { kind: 'done', name: 'side', label: 'Side', app: 'opencode' };

const noApps: AppsApi = {
  list: () => Promise.resolve({ kind: 'ok', apps: [], desktopRunning: false }),
} as unknown as AppsApi;

/** The server's begin: offers the passkey only once one is registered (the switch registers it). */
function fakeApi(registered: () => boolean): CreateAgentApi & {
  begun: number;
  withPasskey: string[];
  withCode: string[];
} {
  const out = {
    begun: 0,
    withPasskey: [] as string[],
    withCode: [] as string[],
    begin: () => {
      out.begun += 1;
      return Promise.resolve({
        kind: 'ready',
        nonce: 'N'.repeat(43),
        statement: {
          label: 'Side',
          agentFingerprint: '1111·2222',
          ownerFingerprint: '3333·4444',
          folder: 'side',
        },
        publicKey: {
          rpId: 'localhost',
          challenge: 'AQID',
          allowCredentials: registered() ? ['Y3JlZA'] : [],
          prfSalt: 'c2FsdA',
          timeoutMs: 120_000,
        },
      } as const);
    },
    finishPasskey: (nonce: string) => {
      out.withPasskey.push(nonce);
      return Promise.resolve(DONE);
    },
    finishCode: (_nonce: string, code: string) => {
      out.withCode.push(code);
      return Promise.resolve(DONE);
    },
  };
  return out as unknown as ReturnType<typeof fakeApi>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
const labels = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no button ${name}: ${labels().join(' | ')}`);
  return found;
}
async function click(name: string): Promise<void> {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
  await flush();
}
async function type(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]');
  if (input === null) throw new Error('no code field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(): Promise<void> {
  const form = host.querySelector('form');
  if (form === null) throw new Error('no form');
  await act(async () => {
    form.requestSubmit();
    await Promise.resolve();
  });
  await flush();
}

interface Mounted {
  readonly api: ReturnType<typeof fakeApi>;
  readonly onDone: ReturnType<typeof vi.fn>;
  readonly switches: [unknown, string][];
}
async function mount(
  status: PasskeyStatus,
  o: { onCancel?: () => void; outcome?: PasskeySwitchOutcome } = {},
): Promise<Mounted> {
  let registered = status.kind === 'ready';
  const api = fakeApi(() => registered);
  const onDone = vi.fn();
  const switches: [unknown, string][] = [];
  await act(async () => {
    root.render(
      createElement(CreateAgentGate, {
        label: 'Side',
        summary: '',
        app: null,
        goLabel: 'Connect with Touch ID',
        platform: 'mac',
        api,
        appsApi: noApps,
        onDone,
        ...(o.onCancel === undefined ? {} : { onCancel: o.onCancel }),
        passkeyStatus: () => Promise.resolve(registered ? READY : status),
        switchPasskey: (values, code) => {
          switches.push([values, code]);
          const outcome = o.outcome ?? { kind: 'switched' };
          if (outcome.kind === 'switched') registered = true;
          return Promise.resolve(outcome);
        },
      }),
    );
  });
  await flush();
  return { api, onDone, switches };
}

describe('W8-F13: the New ID gate offers Touch ID to an owner without one here', () => {
  it('no passkey here: "Switch to Touch ID" first, the backup code as the other way', async () => {
    await mount(NO_PASSKEY);
    expect(labels()).toContain(UPGRADE.bannerAction('mac'));
    expect(labels()).toContain(NAME.backupInstead);
    expect(labels()).not.toContain('Connect with Touch ID');
    expect(host.textContent).toContain(UPGRADE.bannerBody);
  });

  it('with a passkey here: the one Touch ID button, no switch', async () => {
    await mount(READY);
    expect(labels()).toContain('Connect with Touch ID');
    expect(labels()).not.toContain(UPGRADE.bannerAction('mac'));
  });

  it('the switch: the backup code once, then the ID is created with its own touch', async () => {
    const { api, onDone, switches } = await mount(NO_PASSKEY);
    await click(UPGRADE.bannerAction('mac'));
    expect(host.textContent).toContain(NAME.codeWhat);
    await type('ABCD-EFGH');
    await submit();
    expect(switches).toEqual([[SWITCH_TO, 'ABCD-EFGH']]);
    // The switch signs nothing and creates nothing.
    expect(api.begun).toBe(0);
    expect(onDone).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Touch ID is on. Now confirm with Touch ID.');
    await click('Connect with Touch ID');
    expect(api.begun).toBe(1);
    expect(api.withPasskey).toHaveLength(1);
    expect(api.withCode).toEqual([]);
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ label: 'Side' }));
  });

  it('a switch that does not happen changes nothing and keeps the backup code way', async () => {
    const { api, onDone } = await mount(NO_PASSKEY, { outcome: { kind: 'cancelled' } });
    await click(UPGRADE.bannerAction('mac'));
    await type('ABCD-EFGH');
    await submit();
    expect(host.textContent).toContain("The switch didn't happen.");
    expect(api.begun).toBe(0);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('W8-F12/F11: the backup-code form', () => {
  it('says what the backup code is, in one plain line', async () => {
    await mount(READY);
    await click(NAME.backupInstead);
    expect(host.querySelector('form')?.textContent).toContain(NAME.codeWhat);
  });

  it('spaces the field and the buttons (a flex column with a gap)', async () => {
    await mount(READY);
    await click(NAME.backupInstead);
    expect(host.querySelector('form')?.classList.contains('ag-code-form')).toBe(true);
    const squashed = agentsCss.replace(/\s+/g, ' ');
    const block = /([^{}]*\.ag-code-form[^{}]*)\{([^}]*)\}/.exec(squashed);
    expect(block?.[2]).toMatch(/display: flex/);
    expect(block?.[2]).toMatch(/flex-direction: column/);
    expect(block?.[2]).toMatch(/gap: var\(--al-space-/);
  });

  it('inside Get started (no onCancel) it shows no Back of its own', async () => {
    await mount(READY);
    expect(labels()).not.toContain(NAME.back);
    await click(NAME.backupInstead);
    expect(labels()).not.toContain(NAME.back);
  });

  it('in a sheet (onCancel) it shows exactly one Back', async () => {
    const onCancel = vi.fn();
    await mount(READY, { onCancel });
    await click(NAME.backupInstead);
    expect(labels().filter((l) => l === NAME.back)).toHaveLength(1);
    await click(NAME.back);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
