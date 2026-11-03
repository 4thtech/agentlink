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
import { PASSKEY_WHY } from '../contacts/strings.js';
import type { AppsApi } from '../first-run/apps-api.js';
import { NAME, UPGRADE } from '../first-run/strings.js';
import { parseStatement, type CreateAgentApi, type CreateFinish } from './create-agent-api.js';
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
  it('no passkey here (F49): the backup code confirms (primary), the switch is a quiet link', async () => {
    await mount(NO_PASSKEY);
    const confirm = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === NAME.confirmCode,
    );
    expect(confirm?.className).toContain('al-btn-primary');
    const sw = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === UPGRADE.bannerAction('mac'),
    );
    expect(sw?.className).toContain('al-btn-ghost');
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(labels()).not.toContain('Connect with Touch ID');
  });

  it('with a passkey here: the one Touch ID button, no switch', async () => {
    await mount(READY);
    expect(labels()).toContain('Connect with Touch ID');
    expect(labels()).not.toContain(UPGRADE.bannerAction('mac'));
  });

  it('the switch: the backup code once, then the ID is created with its own touch', async () => {
    const { api, onDone, switches } = await mount(NO_PASSKEY);
    await click(UPGRADE.bannerAction('mac'));
    expect((host.textContent ?? '').split(NAME.codeWhat).length - 1).toBe(1);
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

  it('no passkey here and no switch values (no ID open): the code form at once, with why', async () => {
    const { api } = await mount({ kind: 'unavailable', reason: 'not_set_up_here' });
    expect(labels()).not.toContain('Connect with Touch ID');
    expect(labels()).not.toContain(UPGRADE.bannerAction('mac'));
    expect(labels()).toContain(NAME.confirmCode);
    const form = host.querySelector('form')?.textContent ?? '';
    expect(form).toContain(PASSKEY_WHY.not_set_up_here('Touch ID'));
    expect(form).toContain(NAME.codeWhat);
    expect(api.begun).toBe(0);
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
    const text = host.querySelector('form')?.textContent ?? '';
    // Once only: the field's hint, not also a line above it.
    expect(text.split(NAME.codeWhat).length - 1).toBe(1);
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

// W8-S5 (F7; 04 §2.8 Begin; 11 §5.8 "Move to a removed ID"): an AI app whose entry names another
// ID is a move. The gate begins the plan as soon as such an app is the one to connect and shows the
// replacement line from begin's statement (the server's words, bound by the challenge); the one
// gesture then approves exactly that plan (no second begin).
describe('W8-S5 (F7): the replacement is shown before the gesture', () => {
  const used = (agent: string) =>
    ({
      id: 'claude-code',
      name: 'Claude Code',
      path: '~/.claude.json',
      state: 'connected',
      agent,
      quitFirst: false,
    }) as const;
  function moveApi(oldLabel: string | null, oldGone: boolean): ReturnType<typeof fakeApi> {
    const api = fakeApi(() => true);
    const begin = api.begin.bind(api);
    api.begin = ((label: string, app?: string) =>
      begin(label, app).then((b) =>
        b.kind === 'ready'
          ? {
              ...b,
              statement: {
                ...b.statement,
                app: { id: 'claude-code', name: 'Claude Code', kind: 'move', oldLabel, oldGone },
              },
            }
          : b,
      )) as typeof api.begin;
    return api;
  }
  async function mountUsed(api: ReturnType<typeof fakeApi>, agent: string): Promise<void> {
    await act(async () => {
      root.render(
        createElement(CreateAgentGate, {
          label: 'Side',
          summary: '',
          app: used(agent),
          goLabel: 'Connect with Touch ID',
          platform: 'mac',
          api,
          appsApi: noApps,
          onDone: vi.fn(),
          passkeyStatus: () => Promise.resolve(READY),
        }),
      );
    });
    await flush();
  }

  it('another ID: "{app} will use {label} instead of {oldLabel}", then one gesture with that plan', async () => {
    const api = moveApi('Work', false);
    await mountUsed(api, 'work');
    expect(host.textContent).toContain('Claude Code will use Side instead of Work');
    expect(api.begun).toBe(1);
    await click('Connect with Touch ID');
    expect(api.begun).toBe(1);
    expect(api.withPasskey).toEqual(['N'.repeat(43)]);
  });

  it('a removed ID: "{app} will use {label} instead of an ID that was removed"', async () => {
    const api = moveApi(null, true);
    await mountUsed(api, 'ag-test');
    expect(host.textContent).toContain(
      'Claude Code will use Side instead of an ID that was removed',
    );
  });

  it('parseStatement keeps the replaced ID (oldLabel, oldGone) and refuses a bad one', () => {
    const base = {
      label: 'Side',
      agentFingerprint: '1111·2222',
      ownerFingerprint: '3333·4444',
      folder: 'side',
    };
    const app = { app: 'claude-code', name: 'Claude Code', kind: 'move' };
    expect(
      parseStatement({ ...base, app: { ...app, oldLabel: 'Work', oldGone: false } })?.app,
    ).toEqual({
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'move',
      oldLabel: 'Work',
      oldGone: false,
    });
    expect(
      parseStatement({ ...base, app: { ...app, oldLabel: null, oldGone: true } })?.app,
    ).toMatchObject({ oldLabel: null, oldGone: true });
    expect(
      parseStatement({ ...base, app: { ...app, oldLabel: 7, oldGone: false } }),
    ).toBeUndefined();
    expect(
      parseStatement({ ...base, app: { ...app, oldLabel: 'x'.repeat(300), oldGone: false } }),
    ).toBeUndefined();
  });
});

// W8-S5 (IR L1, L3): what is shown is what is approved. When the plan begun to show a move has
// aged out and the gesture's own begin answers another statement, the screen shows the new one and
// waits for a fresh click; a long label from the server is shortened for display, never refused.
describe('W8-S5: shown = approved', () => {
  it('an aged-out preview: the new begin replaces the line and the gesture waits for a fresh click', async () => {
    let n = 0;
    const withPasskey: string[] = [];
    const statements = [
      { kind: 'move', oldLabel: 'Work', oldGone: false },
      undefined, // the entry changed meanwhile: a plain connect
    ] as const;
    const api = {
      begin: () => {
        const app = statements[Math.min(n, 1)];
        n += 1;
        return Promise.resolve({
          kind: 'ready',
          nonce: String(n).repeat(43),
          statement: {
            label: 'Side',
            agentFingerprint: '1111·2222',
            ownerFingerprint: '3333·4444',
            folder: 'side',
            ...(app === undefined
              ? { app: { id: 'claude-code', name: 'Claude Code', kind: 'connect' } }
              : { app: { id: 'claude-code', name: 'Claude Code', ...app } }),
          },
          publicKey: {
            rpId: 'localhost',
            challenge: 'AQID',
            allowCredentials: ['Y3JlZA'],
            prfSalt: 'c2FsdA',
            timeoutMs: 120_000,
          },
        } as const);
      },
      finishPasskey: (nonce: string) => {
        withPasskey.push(nonce);
        return Promise.resolve(DONE);
      },
      finishCode: () => Promise.resolve(DONE),
    } as unknown as CreateAgentApi;
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    await act(async () => {
      root.render(
        createElement(CreateAgentGate, {
          label: 'Side',
          summary: '',
          app: {
            id: 'claude-code',
            name: 'Claude Code',
            path: '~/.claude.json',
            state: 'connected',
            agent: 'work',
            quitFirst: false,
          },
          goLabel: 'Connect with Touch ID',
          platform: 'mac',
          api,
          appsApi: noApps,
          onDone: vi.fn(),
          passkeyStatus: () => Promise.resolve(READY),
        }),
      );
    });
    await flush();
    expect(host.textContent).toContain('Claude Code will use Side instead of Work');
    clock.mockReturnValue(start + 100_000);
    await click('Connect with Touch ID');
    // A new plan was begun; its statement is shown and nothing was approved yet.
    expect(n).toBe(2);
    expect(withPasskey).toEqual([]);
    expect(host.textContent).not.toContain('instead of Work');
    await click('Connect with Touch ID');
    expect(withPasskey).toEqual(['2'.repeat(43)]);
    expect(n).toBe(2);
    clock.mockRestore();
  });

  it('a long replaced label is shortened for display; an absurd one is refused', () => {
    const base = {
      label: 'Side',
      agentFingerprint: '1111·2222',
      ownerFingerprint: '3333·4444',
      folder: 'side',
    };
    const app = { app: 'claude-code', name: 'Claude Code', kind: 'move', oldGone: false };
    const long = parseStatement({ ...base, app: { ...app, oldLabel: 'x'.repeat(40) } });
    expect(long?.app?.oldLabel).toBe(`${'x'.repeat(32)}…`);
    expect(parseStatement({ ...base, app: { ...app, oldLabel: 'x'.repeat(300) } })).toBeUndefined();
  });
});
