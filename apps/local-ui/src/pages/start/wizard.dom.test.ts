// @vitest-environment jsdom
// W4-WIZARD acceptance (W4 UX v2 layer 1; artboards A1 to A3; D-140): Get started is four steps,
// each its own route (`/start/app` → `/start/connect` → `/start/connected` → `/start/invite`), with
// a progress bar and "Skip to Home" on every step. One Touch ID creates the agent and connects the
// picked app; the backup code is still shown once; Connected ✓ (or E1: the agent kept, Connect
// offered); the invite step is optional. The same steps serve "Add agent" and "Connect another AI
// app". The page mounts again on every step in the app, so these tests remount it per step too.
import { lintVocabulary } from '@4thtech-io/ui';
import axe from 'axe-core';
import { act, createElement as h, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateAgentApi, CreateFinish } from '../apps/create-agent-api.js';
import type { AppsApi, AppsListResult, ApplyResult, DetectedApp } from '../first-run/apps-api.js';
import { FirstRunPage, type FirstRunPageProps } from '../first-run/index.js';
import { encodeRegistration } from '../first-run/passkey.js';
import type { FinishResult, SetupApi, StatusResult } from '../first-run/setup-api.js';
import { rememberWizard, resetAutoShown, resetWizard, wasAutoShown } from './store.js';
import { RECOVERY_KIT_LATER_KEY } from '../../states/index.js';
import {
  CONNECTED_STEP,
  CONNECT_STEP,
  INVITE_STEP,
  PICK_STEP,
  WIZARD,
  type StepId,
} from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BODY = encodeRegistration([
  new Uint8Array([1, 2]),
  new Uint8Array(55),
  new Uint8Array([123, 125]),
  new Uint8Array(32).fill(9),
]);
const VALUES = {
  rpId: 'localhost',
  rpName: 'AgentLink',
  userId: 'AQID',
  userName: 'AgentLink owner',
  challenge: 'BAUG',
  prfSalt: 'BwgJ',
};
const CODE = 'ABCD EFGH IJKL MNOP QRST UVWX';
const app = (id: string, name: string, extra: Partial<DetectedApp> = {}): DetectedApp => ({
  id,
  name,
  path: `~/.${id}.json`,
  state: 'not_connected',
  quitFirst: false,
  ...extra,
});
const CLAUDE_CODE = app('claude-code', 'Claude Code');
const CURSOR = app('cursor', 'Cursor');

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  resetWizard();
  resetAutoShown();
  history.replaceState(null, '', '/start/app');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

interface Calls {
  begun: { label: string; app: string | undefined }[];
  finished: string[];
}

function fakeSetup(o: { status?: StatusResult; connected?: boolean } = {}): SetupApi & Calls {
  const calls: Calls = { begun: [], finished: [] };
  let picked: string | undefined;
  return Object.assign(calls, {
    status: () => Promise.resolve(o.status ?? ({ kind: 'ok', owner: 'missing' } as StatusResult)),
    labelCheck: () => Promise.resolve({ kind: 'ok' } as const),
    begin: (label: string, appId?: string) => {
      calls.begun.push({ label, app: appId });
      picked = appId;
      return Promise.resolve({ kind: 'ready', publicKey: VALUES, nonce: 'N'.repeat(43) } as const);
    },
    finish: (_body: Uint8Array, nonce: string): Promise<FinishResult> => {
      calls.finished.push(nonce);
      return Promise.resolve({
        kind: 'done',
        confirmed: true,
        passkey: true,
        ownerCode: CODE,
        fingerprint: '7F3A·19C2',
        sendFolder: 'allowed',
        computerName: 'Mac',
        ...(picked === undefined ? {} : { app: picked, connected: o.connected ?? true }),
      } as FinishResult);
    },
  }) as SetupApi & Calls;
}

function fakeApps(
  o: { list?: AppsListResult; agent?: string | null; apply?: ApplyResult } = {},
): AppsApi & { applied: string[]; previews: string[] } {
  const applied: string[] = [];
  const previews: string[] = [];
  return {
    applied,
    previews,
    list: () =>
      Promise.resolve(
        o.list ?? ({ kind: 'ok', apps: [CLAUDE_CODE, CURSOR], desktopRunning: false } as const),
      ),
    currentAgent: () =>
      Promise.resolve(
        o.agent === null || o.agent === undefined
          ? ({ kind: 'none' } as const)
          : ({ kind: 'ok', folder: o.agent } as const),
      ),
    preview: (appId: string) => {
      previews.push(appId);
      return Promise.resolve({
        kind: 'change',
        change: {
          kind: 'connect',
          app: appId,
          name: 'Cursor',
          path: '~/.cursor/mcp.json',
          folder: 'work',
          oldEntry: null,
          newEntry: { command: 'npx', args: ['-y', '@4thtech-io/agentlink', 'mcp'] },
          oldAgent: null,
          newAgent: 'work',
          changeId: 'a'.repeat(64),
        },
      } as const);
    },
    passkey: () => Promise.resolve({ credentialId: 'AQID', prfSalt: 'BwgJ' }),
    apply: (changeId: string) => {
      applied.push(changeId);
      return Promise.resolve(o.apply ?? ({ kind: 'done' } as const));
    },
  };
}

function fakeCreate(
  finish: CreateFinish,
): CreateAgentApi & { begun: (string | undefined)[]; labels: string[] } {
  const begun: (string | undefined)[] = [];
  const labels: string[] = [];
  return {
    begun,
    labels,
    begin: (label: string, appId?: string) => {
      begun.push(appId);
      labels.push(label);
      return Promise.resolve({
        kind: 'ready',
        nonce: 'M'.repeat(43),
        statement: {
          label: 'Cursor agent',
          agentFingerprint: '1111·2222',
          ownerFingerprint: '3333·4444',
          folder: 'cursor-agent',
        },
        publicKey: {
          rpId: 'localhost',
          challenge: 'AQID',
          allowCredentials: ['AQID'],
          prfSalt: 'BwgJ',
          timeoutMs: 120_000,
        },
      } as const);
    },
    finishPasskey: () => Promise.resolve(finish),
    finishCode: () => Promise.resolve(finish),
  };
}

const text = (): string => host.textContent ?? '';
const h1 = (): string => host.querySelector('h1')?.textContent ?? '';
/** A step change the page asked for, done once the current act is over (as the router does). */
let pending: (() => Promise<void>) | undefined;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const next = pending;
    pending = undefined;
    if (next !== undefined) await next();
  }
}
function button(name: string | RegExp): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => {
    const t = b.textContent?.trim() ?? '';
    return typeof name === 'string' ? t === name : name.test(t);
  });
  if (found === undefined) throw new Error(`no button ${String(name)}: ${text()}`);
  return found;
}
async function click(name: string | RegExp): Promise<void> {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
  await settle();
}

interface Mounted {
  readonly home: ReturnType<typeof vi.fn>;
  readonly skip: ReturnType<typeof vi.fn>;
  readonly went: string[];
}

/**
 * Renders the page for the path's step, as the router does: a step change mounts it again (the
 * `go` seam moves the path and remounts, like `navigate` does through the router's key).
 */
async function mount(extra: Partial<FirstRunPageProps> = {}): Promise<Mounted> {
  const home = vi.fn();
  const skip = vi.fn();
  const went: string[] = [];
  pending = undefined;
  const render = async (): Promise<void> => {
    const step = location.pathname.replace('/start/', '') as StepId;
    const props: FirstRunPageProps = {
      api: fakeSetup(),
      appsApi: fakeApps(),
      createPasskey: () => Promise.resolve({ kind: 'ok', body: BODY.slice() }),
      passkeysAvailable: () => true,
      platform: 'mac',
      prfSupport: () => Promise.resolve('yes'),
      passkeyProof: () => Promise.resolve({ kind: 'passkey', body: new Uint8Array([1, 2, 3]) }),
      goHome: home,
      onSkip: skip,
      readSignal: () => Promise.resolve(undefined),
      readJoin: () => Promise.resolve({ kind: 'failed' } as const),
      ...extra,
      go: (path: string, replace?: boolean) => {
        went.push(replace === true ? `${path} (replace)` : path);
        history.pushState(null, '', path);
        pending = async () => {
          act(() => root.unmount());
          root = createRoot(host);
          await render();
        };
      },
    };
    await act(async () => {
      root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, { key: step, ...props }));
    });
    await settle();
  };
  await render();
  return { home, skip, went };
}

describe('W4-WIZARD: the frame of every step (A1–A3)', () => {
  it('shows the four-segment progress with "Step 1 of 4 · Pick your AI app" and Skip to Home', async () => {
    const { skip } = await mount();
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('1');
    expect(bar?.getAttribute('aria-valuemax')).toBe('4');
    expect(text()).toContain(WIZARD.stepLabel(1, WIZARD.stepNames.app));
    const segs = [...host.querySelectorAll('.st-seg')].map((s) => s.getAttribute('data-state'));
    expect(segs).toEqual(['current', 'todo', 'todo', 'todo']);
    const skipLink = [...host.querySelectorAll('a')].find((a) => a.textContent === WIZARD.skip);
    expect(skipLink).toBeDefined();
    await act(async () => {
      skipLink?.click();
      await Promise.resolve();
    });
    expect(skip).toHaveBeenCalledTimes(1);
  });

  it('opening Get started stops it from opening by itself again in this page life', async () => {
    expect(wasAutoShown()).toBe(false);
    await mount();
    expect(wasAutoShown()).toBe(true);
  });
});

describe('W4-WIZARD step 1: pick your AI app (A1)', () => {
  it('one tile per app: found ones say "Found on this Mac", the others "Not found yet"; the first found is picked', async () => {
    await mount();
    expect(h1()).toBe(PICK_STEP.title);
    expect(text()).toContain(PICK_STEP.eyebrow);
    const tiles = [...host.querySelectorAll<HTMLButtonElement>('.st-tile')];
    expect(tiles.map((t) => t.querySelector('.st-tile-name')?.textContent)).toEqual([
      'Claude Code',
      'Cursor',
      'Claude Desktop',
      'Codex',
    ]);
    expect(tiles[0]?.textContent).toContain(PICK_STEP.found);
    expect(tiles[2]?.textContent).toContain(PICK_STEP.notFound);
    expect(tiles[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(button(PICK_STEP.next('Claude Code'))).toBeDefined();
  });

  it('picking another tile changes the one primary button; nothing is sent', async () => {
    const setup = fakeSetup();
    await mount({ api: setup });
    await click(/^CursorFound/);
    expect(button(PICK_STEP.next('Cursor'))).toBeDefined();
    expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(setup.begun).toHaveLength(0);
  });
});

describe('W4-WIZARD step 2 → 3: one Touch ID, the backup code once, Connected ✓ (A1, A2; D-140)', () => {
  it('Continue opens /start/connect: "Confirm it\'s you", the agent card, Connect with Touch ID', async () => {
    const { went } = await mount();
    await click(PICK_STEP.next('Claude Code'));
    expect(went).toEqual(['/start/connect']);
    expect(h1()).toBe(CONNECT_STEP.title);
    expect(text()).toContain(CONNECT_STEP.eyebrow('Claude Code'));
    expect(text()).toContain('Claude Code agent');
    expect(text()).toContain(CONNECT_STEP.worksIn('Claude Code'));
    expect(text()).toContain(WIZARD.stepLabel(2, WIZARD.stepNames.connect));
    expect(button(CONNECT_STEP.connect('Touch ID')).className).toContain('al-btn-primary');
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
  });

  it('one gesture carries the label and the app; the code is shown once, then Connected to Claude Code', async () => {
    const setup = fakeSetup();
    const { went } = await mount({ api: setup });
    await click(PICK_STEP.next('Claude Code'));
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(setup.begun).toEqual([{ label: 'Claude Code agent', app: 'claude-code' }]);
    expect(setup.finished).toHaveLength(1);
    expect(h1()).toBe('Your backup code');
    expect(host.querySelector('.al-secret-val')?.textContent?.replace(/\s/g, '')).toBe(
      CODE.replace(/\s/g, ''),
    );
    await click('I saved it');
    expect(went.at(-1)).toBe('/start/connected');
    expect(h1()).toBe(CONNECTED_STEP.title('Claude Code'));
    // The code left the page with the step.
    expect(text()).not.toContain('UVWX');
    expect(text()).toContain(WIZARD.stepLabel(3, WIZARD.stepNames.connected));
    // Connected ✓ is the U0 moment (pop + draw; fades under reduced motion, in the kit).
    expect(host.querySelector('.st-done.al-pop')).not.toBeNull();
    expect(host.querySelector('.al-draw path')).not.toBeNull();
    expect(text()).toContain(CONNECTED_STEP.restart('Claude Code'));
    // IR-W4-WIZARD-1 L: the focused title is not inside a live region too (one announcement).
    expect(host.querySelector('[role="status"] h1')).toBeNull();
  });

  it('an invite left waiting by `agentlink join` opens its screen after the backup code (U3-invite)', async () => {
    const openJoin = vi.fn();
    const { went } = await mount({
      readJoin: () => Promise.resolve({ kind: 'ok', state: 'waiting' } as never),
      openJoin,
    });
    await click(PICK_STEP.next('Claude Code'));
    await click(CONNECT_STEP.connect('Touch ID'));
    await click('I saved it');
    expect(openJoin).toHaveBeenCalledTimes(1);
    expect(went).not.toContain('/start/connected');
  });

  it('"Change name" opens the field; the typed name is the one begin carries', async () => {
    const setup = fakeSetup();
    await mount({ api: setup });
    await click(PICK_STEP.next('Claude Code'));
    await click(CONNECT_STEP.rename);
    const input = host.querySelector<HTMLInputElement>('input[name="agent-name"]');
    expect(input).not.toBeNull();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, 'Home base');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(setup.begun[0]?.label).toBe('Home base');
  });

  it('a "Not found yet" pick creates the agent alone (begin carries no app)', async () => {
    const setup = fakeSetup();
    await mount({ api: setup });
    await click(/^CodexNot found yet/);
    await click(PICK_STEP.next('Codex'));
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(setup.begun).toEqual([{ label: 'Codex agent', app: undefined }]);
  });

  it('E1: created_not_connected keeps the agent: "{agent} is ready" and Connect Claude Code', async () => {
    await mount({ api: fakeSetup({ connected: false }) });
    await click(PICK_STEP.next('Claude Code'));
    await click(CONNECT_STEP.connect('Touch ID'));
    await click('I saved it');
    expect(h1()).toBe(CONNECTED_STEP.notConnectedTitle('Claude Code agent'));
    expect(text()).toContain(CONNECTED_STEP.notConnectedBody('Claude Code'));
    expect(button(CONNECTED_STEP.connect('Claude Code'))).toBeDefined();
    expect(host.querySelector('.al-draw')).toBeNull();
  });

  it('Back returns to step 1 with the pick kept', async () => {
    await mount();
    await click(/^CursorFound/);
    await click(PICK_STEP.next('Cursor'));
    await click(CONNECT_STEP.back);
    expect(h1()).toBe(PICK_STEP.title);
    expect(button(PICK_STEP.next('Cursor'))).toBeDefined();
  });

  it('a direct visit to /start/connect without a pick goes back to step 1', async () => {
    history.replaceState(null, '', '/start/connect');
    const { went } = await mount();
    expect(went[0]).toBe('/start/app (replace)');
  });
});

describe('IR-W4-WIZARD-SEC-1 L1: leaving the backup code without "I saved it"', () => {
  it('a path change away from step 2 drops the code (and records the kit as later), never hides it', async () => {
    // One mount followed by in-place path changes (Back/Forward, a typed address).
    const props: FirstRunPageProps = {
      api: fakeSetup(),
      appsApi: fakeApps(),
      createPasskey: () => Promise.resolve({ kind: 'ok', body: BODY.slice() }),
      passkeysAvailable: () => true,
      platform: 'mac',
      prfSupport: () => Promise.resolve('yes'),
      goHome: vi.fn(),
      readSignal: () => Promise.resolve(undefined),
      readJoin: () => Promise.resolve({ kind: 'failed' } as const),
      go: (path: string) => {
        history.pushState(null, '', path);
        window.dispatchEvent(new Event('agentlink:navigate'));
      },
    };
    await act(async () => {
      root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, props));
    });
    await settle();
    await click(PICK_STEP.next('Claude Code'));
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(h1()).toBe('Your backup code');
    await act(async () => {
      history.pushState(null, '', '/start/connected');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await Promise.resolve();
    });
    await settle();
    expect(document.body.innerHTML).not.toContain('UVWX');
    expect(localStorage.getItem(RECOVERY_KIT_LATER_KEY)).toMatch(/^[0-9]+$/);
    // Back to step 2: the code does not come back.
    await act(async () => {
      history.pushState(null, '', '/start/connect');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await Promise.resolve();
    });
    await settle();
    expect(document.body.innerHTML).not.toContain('UVWX');
  });
});

describe('W4-WIZARD step 3 opened from the real state, and step 4 (A2, A3)', () => {
  it('/start/connected without an outcome reads the open agent: connected shows Connected to its app', async () => {
    history.replaceState(null, '', '/start/connected');
    await mount({
      readSignal: () =>
        Promise.resolve({ named: true, connected: true, appName: 'Cursor', running: false }),
    });
    expect(h1()).toBe(CONNECTED_STEP.title('Cursor'));
  });

  it('/start/connected with nothing connected goes back to step 1', async () => {
    history.replaceState(null, '', '/start/connected');
    const { went } = await mount({
      readSignal: () =>
        Promise.resolve({ named: true, connected: false, appName: null, running: false }),
    });
    expect(went[0]).toBe('/start/app (replace)');
  });

  it('Invite someone opens step 4; Skip for now and Done go Home', async () => {
    const { home, went } = await mount();
    await click(PICK_STEP.next('Claude Code'));
    await click(CONNECT_STEP.connect('Touch ID'));
    await click('I saved it');
    await click(CONNECTED_STEP.invite);
    expect(went.at(-1)).toBe('/start/invite');
    expect(h1()).toBe(INVITE_STEP.title);
    expect(text()).toContain(WIZARD.stepLabel(4, WIZARD.stepNames.invite));
    await click(INVITE_STEP.skip);
    await click(INVITE_STEP.done);
    expect(home).toHaveBeenCalledTimes(2);
  });

  it("step 4 shows U4's invite panel when one is given", async () => {
    history.replaceState(null, '', '/start/invite');
    await mount({ invitePanel: h('div', { id: 'u4-panel' }, 'panel') });
    expect(host.querySelector('#u4-panel')).not.toBeNull();
  });

  it("W4-WIRE: step 4 is U4's invite panel by default (no link away to People)", async () => {
    history.replaceState(null, '', '/start/invite');
    await mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(host.querySelector('.inv-panel')).not.toBeNull();
    expect(host.querySelector('a[href="/contacts"]')).toBeNull();
  });
});

describe('W4-WIZARD: the same steps for an owner who has one already', () => {
  const OWNER: StatusResult = { kind: 'ok', owner: 'set_up' };
  const registered = {
    info: () => Promise.resolve({ kind: 'ok', registered: true } as const),
    register: () => Promise.resolve({ kind: 'registered' } as const),
  } as unknown as NonNullable<FirstRunPageProps['upgradeApi']>;

  it('Connect another AI app: an open agent; its connected app is shown, not picked; the signed apps step follows', async () => {
    const apps = fakeApps({
      agent: 'work',
      list: {
        kind: 'ok',
        apps: [app('claude-code', 'Claude Code', { state: 'connected', agent: 'work' }), CURSOR],
        desktopRunning: false,
      },
    });
    const { went } = await mount({
      api: fakeSetup({ status: OWNER }),
      upgradeApi: registered,
      appsApi: apps,
    });
    expect(text()).toContain(PICK_STEP.eyebrowConnect);
    const first = host.querySelector<HTMLButtonElement>('.st-tile');
    expect(first?.disabled).toBe(true);
    expect(first?.textContent).toContain(PICK_STEP.connected);
    await click(PICK_STEP.next('Cursor'));
    expect(went).toEqual(['/start/connect']);
    expect(apps.previews).toEqual(['cursor']);
    await click('Apply with Touch ID');
    expect(apps.applied).toHaveLength(1);
    expect(went.at(-1)).toBe('/start/connected');
    expect(h1()).toBe(CONNECTED_STEP.title('Cursor'));
  });

  it("Add agent (no open agent): New agent's one gesture with the picked app", async () => {
    const create = fakeCreate({
      kind: 'done',
      name: 'cursor-agent',
      label: 'Cursor agent',
      app: 'cursor',
    });
    const { went } = await mount({
      api: fakeSetup({ status: OWNER }),
      upgradeApi: registered,
      appsApi: fakeApps({ agent: null }),
      createAgentApi: create,
      passkeysAvailable: () => true,
    });
    // W4-WIRE-2 (Decision 52 (2)): New agent names the agent first, then the pick.
    expect(h1()).toBe('Name your agent');
    await typeName('Cursor agent');
    await click('Continue');
    expect(text()).toContain(PICK_STEP.eyebrowAdd);
    await click(/^CursorFound/);
    await click(PICK_STEP.next('Cursor'));
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(create.begun).toEqual(['cursor']);
    expect(went.at(-1)).toBe('/start/connected');
    expect(h1()).toBe(CONNECTED_STEP.title('Cursor'));
  });
});

/** The agents the name step and "Open {name}" read: "Work" is taken; switches are recorded. */
function fakeAgents(): NonNullable<FirstRunPageProps['agentsApi']> & {
  switched: { name: string; generation: number }[];
} {
  const switched: { name: string; generation: number }[] = [];
  return {
    switched,
    list: () =>
      Promise.resolve({
        kind: 'ok',
        list: {
          switchable: true,
          generation: 3,
          current: 'work',
          label: 'Work',
          agents: [{ name: 'work', label: 'Work', current: true, apps: [] }],
        },
      } as unknown as Awaited<ReturnType<NonNullable<FirstRunPageProps['agentsApi']>['list']>>),
    switchTo: (name: string, generation: number) => {
      switched.push({ name, generation });
      return Promise.resolve({ kind: 'done' } as unknown as Awaited<
        ReturnType<NonNullable<FirstRunPageProps['agentsApi']>['switchTo']>
      >);
    },
  };
}

/** Types into the agent's name field as a person does (React sees an input event). */
async function typeName(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[name="agent-name"]');
  if (input === null) throw new Error(`no name field: ${text()}`);
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('W4-WIRE-2: Add agent names the agent first (Decision 52 (2))', () => {
  const OWNER: StatusResult = { kind: 'ok', owner: 'set_up' };
  const registered = {
    info: () => Promise.resolve({ kind: 'ok', registered: true } as const),
    register: () => Promise.resolve({ kind: 'registered' } as const),
  } as unknown as NonNullable<FirstRunPageProps['upgradeApi']>;
  const made = (): ReturnType<typeof fakeCreate> =>
    fakeCreate({ kind: 'done', name: 'side-project', label: 'Side project', app: 'cursor' });
  /** An owner with an open agent ("work") who chose Add agent. */
  const asAdd = (extra: Partial<FirstRunPageProps> = {}): Partial<FirstRunPageProps> => ({
    api: fakeSetup({ status: OWNER }),
    upgradeApi: registered,
    appsApi: fakeApps({ agent: 'work' }),
    ...extra,
  });

  beforeEach(() => {
    history.replaceState(null, '', '/start/app?add=agent');
  });

  it('/start/app?add=agent: "Name your agent" first, then the pick, then one Touch ID with that name and app', async () => {
    const create = made();
    const labelCheck = vi.fn(() => Promise.resolve({ kind: 'ok' } as const));
    const { went } = await mount(
      asAdd({
        api: Object.assign(fakeSetup({ status: OWNER }), { labelCheck }),
        createAgentApi: create,
      }),
    );
    expect(h1()).toBe('Name your agent');
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuetext')).toBe('Step 1 of 4 · Name your agent');
    const input = host.querySelector<HTMLInputElement>('input[name="agent-name"]');
    expect(input).not.toBeNull();
    expect(host.querySelector(`label[for="${input?.id ?? ''}"]`)?.textContent).toContain(
      'Agent name',
    );
    await typeName('Side project');
    await click('Continue');
    expect(labelCheck).toHaveBeenCalledWith('Side project');
    expect(h1()).toBe(PICK_STEP.title);
    expect(text()).toContain(PICK_STEP.eyebrowAdd);
    await click(/^CursorFound/);
    await click(PICK_STEP.next('Cursor'));
    // Add agent stays Add agent on every step (an open agent never turns it into Connect another).
    expect(went.at(-1)).toBe('/start/connect?add=agent');
    expect(text()).toContain('Side project');
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(create.labels).toEqual(['Side project']);
    expect(create.begun).toEqual(['cursor']);
    expect(went.at(-1)).toBe('/start/connected?add=agent');
    expect(h1()).toBe(CONNECTED_STEP.title('Cursor'));
  });

  it('the agent-name rules: empty, more than 32 characters and a refused name never move on', async () => {
    const labelCheck = vi.fn(() => Promise.resolve({ kind: 'refused' } as const));
    await mount(asAdd({ api: Object.assign(fakeSetup({ status: OWNER }), { labelCheck }) }));
    await typeName('   ');
    await click('Continue');
    expect(text()).toContain('Give your agent a name.');
    await typeName('x'.repeat(33));
    await click('Continue');
    expect(text()).toContain('Use up to 32 characters.');
    await typeName('Line\u0007break');
    await click('Continue');
    expect(labelCheck).not.toHaveBeenCalled();
    await typeName('Refused name');
    await click('Continue');
    expect(labelCheck).toHaveBeenCalledTimes(1);
    expect(h1()).toBe('Name your agent');
    expect(host.querySelector('[aria-invalid="true"]')).not.toBeNull();
  });

  it('Back on the pick returns to the name, kept', async () => {
    await mount(asAdd());
    await typeName('Side project');
    await click('Continue');
    await click(CONNECT_STEP.back);
    expect(h1()).toBe('Name your agent');
    expect(host.querySelector<HTMLInputElement>('input[name="agent-name"]')?.value).toBe(
      'Side project',
    );
  });

  it('a new Add agent starts with no name from an earlier run', async () => {
    rememberWizard({ name: 'Old name', choice: 'cursor', outcome: { label: 'Old name' } });
    await mount(asAdd());
    expect(h1()).toBe('Name your agent');
    expect(host.querySelector<HTMLInputElement>('input[name="agent-name"]')?.value).toBe('');
  });

  it('a direct visit to /start/connect?add=agent before a name goes back to the name', async () => {
    history.replaceState(null, '', '/start/connect?add=agent');
    const { went } = await mount(asAdd());
    expect(went[0]).toBe('/start/app?add=agent (replace)');
  });

  it('IR-W4-WIRE-2X-1: an abandoned Add agent (Skip to Home, or away) starts fresh next time', async () => {
    await mount(asAdd());
    await typeName('Side project');
    await click('Continue');
    expect(h1()).toBe(PICK_STEP.title);
    // The person leaves Get started (Skip to Home, a link, Back): the page goes.
    history.pushState(null, '', '/');
    act(() => root.unmount());
    root = createRoot(host);
    history.replaceState(null, '', '/start/app?add=agent');
    await mount(asAdd());
    expect(h1()).toBe('Name your agent');
    expect(host.querySelector<HTMLInputElement>('input[name="agent-name"]')?.value).toBe('');
  });

  it('IR-W4-WIRE-2X-1: a name another agent has says so (a hint; it may still be used)', async () => {
    const agentsApi = fakeAgents();
    await mount(asAdd({ agentsApi }));
    await typeName('Work');
    expect(text()).toContain('You already have an agent with this name.');
    await typeName('Side project');
    expect(text()).not.toContain('You already have an agent with this name.');
  });

  it('IR-W4-WIRE-2X-SEC-1: bidi and invisible format characters never reach the server', async () => {
    const labelCheck = vi.fn(() => Promise.resolve({ kind: 'ok' } as const));
    await mount(asAdd({ api: Object.assign(fakeSetup({ status: OWNER }), { labelCheck }) }));
    for (const bad of ['Evil\u202Ename', 'Zero\u200Bwidth', 'Iso\u2066late', 'B\uFEFFom']) {
      await typeName(bad);
      await click('Continue');
      expect(h1()).toBe('Name your agent');
    }
    expect(labelCheck).not.toHaveBeenCalled();
  });

  it('IR-W4-WIRE-2X-1: Connected offers "Open {name}" (never switches by itself)', async () => {
    const agentsApi = fakeAgents();
    const home = vi.fn();
    await mount(asAdd({ createAgentApi: made(), agentsApi, goHome: home }));
    await typeName('Side project');
    await click('Continue');
    await click(/^CursorFound/);
    await click(PICK_STEP.next('Cursor'));
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(h1()).toBe(CONNECTED_STEP.title('Cursor'));
    expect(agentsApi.switched).toEqual([]);
    await click('Open Side project');
    expect(agentsApi.switched).toEqual([{ name: 'side-project', generation: 3 }]);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('axe finds nothing on the name step; its words pass lintVocabulary', async () => {
    await mount(asAdd());
    const result = await axe.run(host, { rules: { region: { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
    expect(lintVocabulary(text())).toEqual([]);
    expect(host.querySelector('[style*="animation"]')).toBeNull();
  });
});

describe('W4-WIZARD: accessibility, motion and words', () => {
  it('axe finds nothing on steps 1 to 4', async () => {
    const seen: string[] = [];
    const check = async (): Promise<void> => {
      const result = await axe.run(host, { rules: { region: { enabled: false } } });
      seen.push(...result.violations.map((v) => v.id));
    };
    await mount();
    await check();
    await click(PICK_STEP.next('Claude Code'));
    await check();
    await click(CONNECT_STEP.connect('Touch ID'));
    await click('I saved it');
    await check();
    await click(CONNECTED_STEP.invite);
    await check();
    expect(seen).toEqual([]);
  });

  it('draws motion only with the U0 kit classes; no inline animation', async () => {
    await mount();
    expect(host.querySelector('[style*="animation"]')).toBeNull();
    expect(host.querySelector('.al-press')).not.toBeNull();
  });

  it('every step string passes lintVocabulary (11 §5.1)', () => {
    const words = [
      ...Object.values(WIZARD.stepNames),
      WIZARD.skip,
      PICK_STEP.title,
      PICK_STEP.body,
      PICK_STEP.found,
      PICK_STEP.notFound,
      PICK_STEP.next('Claude Code'),
      CONNECT_STEP.title,
      CONNECT_STEP.body('Claude Code'),
      CONNECT_STEP.restartNote('Claude Code'),
      CONNECTED_STEP.title('Claude Code'),
      CONNECTED_STEP.body,
      CONNECTED_STEP.notConnectedBody('Claude Code'),
      CONNECTED_STEP.restart('Claude Code'),
      INVITE_STEP.body,
    ];
    for (const w of words) expect(lintVocabulary(w)).toEqual([]);
  });
});
