// @vitest-environment jsdom
// U3-g acceptance (b11 §28; 08 §1 "First run v3"; D-137, D-138): Welcome, pick your AI app, one
// screen that names the agent and protects it (one gesture), the backup code, then "Connect your AI
// app" as its own signed step that "Later" skips; the end lands on Home.
//
// The server shapes used by the fakes of `GET /api/ui/apps`, `/preview` and `/apply` are the ones
// packages/node/src/local-ui/api/apps.ts (U3-f) answers; the setup calls, the label check and the
// headers are checked against the real server in packages/node/src/local-ui-first-run-browser.test.ts
// and packages/node/src/local-ui/first-run-v3-reads.test.ts.
import { lintVocabulary } from '@4thtech-io/ui';
import axe from 'axe-core';
import { act, createElement as h, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_KIT_LATER_KEY } from '../../states/index.js';
import type { PresenceProof } from '../contacts/owner.js';
import {
  createAppsApi,
  type AppChange,
  type AppsApi,
  type AppsListResult,
  type ApplyResult,
  type DetectedApp,
  type PreviewResult,
} from './apps-api.js';
import { FirstRunPage, type FirstRunPageProps } from './index.js';
import { CONNECT, NAME, PICK, SETUP_MESSAGES, WELCOME } from './strings.js';
import { resetAutoShown, resetWizard } from '../start/store.js';
import { CONNECTED_STEP, CONNECT_STEP, PICK_STEP } from '../start/strings.js';
import { encodeRegistration } from './passkey.js';
import {
  createSetupApi,
  type BeginResult,
  type CreationValues,
  type FinishResult,
  type SetupApi,
  type StatusResult,
} from './setup-api.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VALUES: CreationValues = {
  rpId: 'localhost',
  rpName: 'AgentLink',
  userId: 'AQID',
  userName: 'AgentLink owner',
  challenge: 'BAUG',
  prfSalt: 'BwgJ',
};
const FINISHED: FinishResult = {
  kind: 'done',
  confirmed: true,
  passkey: true,
  ownerCode: 'ABCD EFGH IJKL MNOP QRST UVWX',
  fingerprint: '7F3A·19C2',
  sendFolder: 'allowed',
  computerName: 'Talis-MacBook-Pro',
};
const BODY = encodeRegistration([
  new Uint8Array([1, 2]),
  new Uint8Array(55),
  new Uint8Array([123, 125]),
  new Uint8Array(32).fill(9),
]);

const app = (id: string, name: string, extra: Partial<DetectedApp> = {}): DetectedApp => ({
  id,
  name,
  path: `~/.${id}.json`,
  state: 'not_connected',
  quitFirst: false,
  ...extra,
});
const CODE_APP = app('claude-code', 'Claude Code', { path: '~/.claude.json' });
const DESKTOP = app('claude-desktop', 'Claude Desktop', { quitFirst: false });
const CODEX = app('codex', 'Codex');

const CHANGE: AppChange = {
  kind: 'connect',
  app: 'claude-code',
  name: 'Claude Code',
  path: '~/.claude.json',
  folder: 'default',
  oldEntry: null,
  newEntry: { command: 'npx', args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'default'] },
  oldAgent: null,
  newAgent: 'default',
  changeId: 'a'.repeat(64),
};

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

interface SetupCalls {
  begun: string[];
  /** W4-ONE-TOUCH: the app each begin carried (undefined: none, "Not now"). */
  apps: (string | undefined)[];
  finished: { nonce: string; body: Uint8Array }[];
  checked: string[];
}

/** W4-ONE-TOUCH: the begin nonce the fake server answers. */
const NONCE = 'N'.repeat(43);

function fakeSetup(
  o: {
    check?: (label: string) => 'ok' | 'refused';
    status?: StatusResult;
    finish?: FinishResult;
    /** W4-ONE-TOUCH: whether the app's entry is written (false: created_not_connected). */
    connected?: boolean;
  } = {},
): SetupApi & SetupCalls {
  const calls: SetupCalls = { begun: [], apps: [], finished: [], checked: [] };
  let picked: string | undefined;
  return Object.assign(calls, {
    status: () => Promise.resolve(o.status ?? ({ kind: 'ok', owner: 'missing' } as StatusResult)),
    labelCheck: (label: string) => {
      calls.checked.push(label);
      return Promise.resolve({ kind: o.check?.(label) ?? 'ok' } as const);
    },
    begin: (label: string, app?: string): Promise<BeginResult> => {
      calls.begun.push(label);
      calls.apps.push(app);
      picked = app;
      return Promise.resolve({ kind: 'ready', publicKey: VALUES, nonce: NONCE });
    },
    finish: (body: Uint8Array, nonce: string): Promise<FinishResult> => {
      calls.finished.push({ nonce, body: body.slice() });
      const done = o.finish ?? FINISHED;
      return Promise.resolve(
        picked === undefined || done.kind !== 'done'
          ? done
          : { ...done, app: picked, connected: o.connected ?? true },
      );
    },
  });
}

interface AppsCalls {
  previews: [string, string][];
  applied: string[];
  proofs: PresenceProof[];
}

function fakeApps(
  o: {
    list?: AppsListResult;
    agent?: string | undefined;
    preview?: PreviewResult | (() => PreviewResult);
    apply?: ApplyResult;
    passkey?: boolean;
  } = {},
): AppsApi & AppsCalls {
  const calls: AppsCalls = { previews: [], applied: [], proofs: [] };
  return Object.assign(calls, {
    list: () =>
      Promise.resolve(
        o.list ??
          ({ kind: 'ok', apps: [CODE_APP, DESKTOP, CODEX], desktopRunning: false } as const),
      ),
    currentAgent: () =>
      Promise.resolve(
        'agent' in o && o.agent === undefined
          ? ({ kind: 'none' } as const)
          : ({ kind: 'ok', folder: o.agent ?? 'default' } as const),
      ),
    preview: (appId: string, agent: string) => {
      calls.previews.push([appId, agent]);
      const p = o.preview ?? ({ kind: 'change', change: CHANGE } as PreviewResult);
      return Promise.resolve(typeof p === 'function' ? p() : p);
    },
    passkey: () =>
      Promise.resolve(o.passkey === false ? undefined : { credentialId: 'AQID', prfSalt: 'BwgJ' }),
    apply: (changeId: string, proof: PresenceProof) => {
      calls.applied.push(changeId);
      calls.proofs.push(proof);
      return Promise.resolve(o.apply ?? ({ kind: 'done' } as ApplyResult));
    },
  });
}

async function mount(
  setup: SetupApi,
  apps: AppsApi,
  extra: Partial<FirstRunPageProps> = {},
): Promise<{ home: ReturnType<typeof vi.fn> }> {
  const home = vi.fn();
  resetWizard();
  resetAutoShown();
  history.replaceState(null, '', '/start/app');
  await act(async () => {
    const props: FirstRunPageProps = {
      api: setup,
      appsApi: apps,
      createPasskey: () => Promise.resolve({ kind: 'ok', body: BODY.slice() }),
      passkeysAvailable: () => true,
      platform: 'mac',
      prfSupport: () => Promise.resolve('yes'),
      passkeyProof: () => Promise.resolve({ kind: 'passkey', body: new Uint8Array([1, 2, 3]) }),
      goHome: home,
      readJoin: () => Promise.resolve({ kind: 'failed' }),
      ...extra,
    };
    root.render(h(FirstRunPage as ComponentType<FirstRunPageProps>, props));
  });
  return { home };
}

const text = (): string => host.textContent ?? '';
const h1 = (): string => host.querySelector('h1')?.textContent ?? '';
const buttonNames = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no button ${name}: ${text()}`);
  return found;
}
async function click(name: string): Promise<void> {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
}
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
function field(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('input[type="text"]');
  if (input === null) throw new Error('no name field');
  return input;
}
async function type(value: string): Promise<void> {
  await act(async () => {
    const input = field();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
// W4-WIZARD: first run is Get started (pages/start). Step 1 picks the app with tiles (no Welcome
// screen, no radio list); step 2 is "Confirm it's you" with the name behind "Change name"; step 3 is
// Connected. start/wizard.dom.test.ts covers the frame and the steps; these keep the U3-g and
// W4-ONE-TOUCH rules on the new screens.
describe('W4-WIZARD (was U3-g Welcome and pick): step 1', () => {
  it('opens on the app pick while no owner exists, and calls nothing yet', async () => {
    const setup = fakeSetup();
    await mount(setup, fakeApps());
    await settle();
    expect(h1()).toBe(PICK_STEP.title);
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(setup.begun).toEqual([]);
    expect(setup.checked).toEqual([]);
  });

  it('lists the found apps first ("Found on this Mac"), then the known ones not found yet', async () => {
    await mount(fakeSetup(), fakeApps());
    await settle();
    const names = [...host.querySelectorAll('.st-tile-name')].map((n) => n.textContent);
    expect(names).toEqual(['Claude Code', 'Claude Desktop', 'Codex', 'Cursor']);
    expect(text().match(/Found on this Mac/g)).toHaveLength(3);
    expect(button(PICK_STEP.next('Claude Code')).className).toContain('al-btn-primary');
  });

  it('handles the look being unavailable or failing: a plain line, and the tiles still work', async () => {
    for (const list of [{ kind: 'not_available' }, { kind: 'failed' }] as const) {
      resetWizard();
      await mount(fakeSetup(), fakeApps({ list }));
      await settle();
      expect(text()).toContain(PICK_STEP.lookFailed);
      expect(button(PICK_STEP.next('Claude Code')).disabled).toBe(false);
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('shows an app name from the server as text only', async () => {
    const hostile = app('codex', '<img src=x onerror=alert(1)>');
    await mount(
      fakeSetup(),
      fakeApps({ list: { kind: 'ok', apps: [hostile], desktopRunning: false } }),
    );
    await settle();
    expect(host.querySelector('img')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('W4-WIZARD (was U3-g name and protect): step 2', () => {
  const toName = async (
    setup = fakeSetup(),
    apps = fakeApps(),
    extra = {},
  ): Promise<{
    setup: ReturnType<typeof fakeSetup>;
    apps: ReturnType<typeof fakeApps>;
    home: ReturnType<typeof vi.fn>;
  }> => {
    const { home } = await mount(setup, apps, extra);
    await settle();
    await click(PICK_STEP.next('Claude Code'));
    await settle();
    await click(CONNECT_STEP.rename);
    return { setup, apps, home };
  };
  const GO = CONNECT_STEP.connect('Touch ID');

  it('suggests "{App} agent" from the chosen app, with Touch ID as the one primary', async () => {
    await toName();
    expect(h1()).toBe(CONNECT_STEP.title);
    expect(field().value).toBe('Claude Code agent');
    expect([...host.querySelectorAll('label')].map((l) => l.textContent)).toContain(
      'Name your agent',
    );
    expect(text()).toContain('Shown to you and your contacts.');
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(button(GO).className).toContain('al-btn-primary');
    expect(buttonNames()).toContain('Use a backup code instead');
  });

  it('Back keeps the typed name', async () => {
    await toName();
    await type('Home base');
    await click(CONNECT_STEP.back);
    await settle();
    await click(PICK_STEP.next('Claude Code'));
    await settle();
    expect(text()).toContain('Home base');
  });

  it('refuses more than 32 code points before asking the server', async () => {
    const { setup } = await toName();
    await type('a'.repeat(33));
    await click(GO);
    expect(setup.begun).toEqual([]);
    expect(host.querySelector('[role="alert"], .is-error')).not.toBeNull();
    // 32 code points (emoji count once) pass the local check.
    await type('😀'.repeat(32));
    await click(GO);
    expect(setup.checked).toEqual(['😀'.repeat(32)]);
  });

  it('asks the server to check the label before Touch ID; a refusal keeps the text and starts no setup', async () => {
    const created = vi.fn(() => Promise.resolve({ kind: 'cancelled' } as const));
    const { setup } = await toName(fakeSetup({ check: () => 'refused' }), fakeApps(), {
      createPasskey: created,
    });
    await type('Work  agent');
    await click(GO);
    expect(setup.checked).toEqual(['Work  agent']);
    expect(setup.begun).toEqual([]);
    expect(created).not.toHaveBeenCalled();
    expect(field().value).toBe('Work  agent');
    expect(text()).toContain("That name can't be used.");
  });

  it('one gesture: check and begin carry the trimmed label and the app; finish only the nonce and the creation response', async () => {
    const { setup } = await toName();
    await type('  Personal  ');
    await click(GO);
    expect(setup.checked).toEqual(['Personal']);
    expect(setup.begun).toEqual(['Personal']);
    expect(setup.apps).toEqual(['claude-code']);
    expect(setup.finished).toHaveLength(1);
    expect(setup.finished[0]?.nonce).toBe(NONCE);
    expect(setup.finished[0]?.body).toEqual(BODY);
    expect(h1()).toBe('Your backup code');
  });

  it('W4-ONE-TOUCH: Claude Desktop running refuses before the gesture, in plain words; nothing is created', async () => {
    const setup = fakeSetup();
    setup.begin = (label: string, appId?: string): Promise<BeginResult> => {
      setup.begun.push(label);
      setup.apps.push(appId);
      return Promise.resolve({ kind: 'error', problem: 'quit_first' });
    };
    const created = vi.fn<() => Promise<{ kind: 'cancelled' }>>();
    await toName(setup, fakeApps(), { createPasskey: created });
    await click(GO);
    expect(text()).toContain('Quit Claude Desktop first.');
    expect(created).not.toHaveBeenCalled();
    expect(setup.finished).toHaveLength(0);
    expect(buttonNames()).toContain('Try again');
  });

  it('Enter in the field does not submit; focus moves to the button', async () => {
    const { setup } = await toName();
    const input = field();
    await act(async () => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(setup.begun).toEqual([]);
    expect(document.activeElement).toBe(button(GO));
  });

  it('a cancelled Touch ID says "Not protected yet. Try again." and keeps the text', async () => {
    const { setup } = await toName(fakeSetup(), fakeApps(), {
      createPasskey: () => Promise.resolve({ kind: 'cancelled' }),
    });
    await type('Mine');
    await click(GO);
    expect(text()).toContain('Not protected yet. Try again.');
    expect(field().value).toBe('Mine');
    expect(setup.finished).toHaveLength(0);
    expect(buttonNames()).toContain('Try again');
  });

  it('the name is shown as text only', async () => {
    await toName();
    await type('<b>x</b>');
    expect(host.querySelector('b')).toBeNull();
    expect(field().value).toBe('<b>x</b>');
  });
});

describe('W4-WIZARD (was U3-g the end of first run): step 3 and E1', () => {
  const GO = CONNECT_STEP.connect('Touch ID');
  async function toBackupCode(apps: AppsApi, setup = fakeSetup({ connected: false }), extra = {}) {
    const { home } = await mount(setup, apps, extra);
    await settle();
    await click(PICK_STEP.next('Claude Code'));
    await settle();
    await click(GO);
    expect(h1()).toBe('Your backup code');
    return { home, setup };
  }
  /** E1: the not-connected step, then Connect (the signed AI apps step). */
  async function toConnect(apps: AppsApi, extra = {}): Promise<ReturnType<typeof vi.fn>> {
    const { home } = await toBackupCode(apps, fakeSetup({ connected: false }), extra);
    await click('I saved it');
    await settle();
    await click(CONNECTED_STEP.connect('Claude Code'));
    await settle();
    return home;
  }

  it('W4-ONE-TOUCH: connected in the same gesture: Connected to Claude Code, no second signed step', async () => {
    const apps = fakeApps();
    const { home } = await toBackupCode(apps, fakeSetup());
    await click('I saved it');
    await settle();
    expect(h1()).toBe(CONNECTED_STEP.title('Claude Code'));
    expect(text()).toContain(CONNECTED_STEP.restart('Claude Code'));
    expect(apps.previews).toEqual([]);
    expect(apps.applied).toEqual([]);
    await click(CONNECTED_STEP.home);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('E1 created_not_connected: "{label} is ready", Connect, and Go to Home writes nothing', async () => {
    const apps = fakeApps();
    const { home } = await toBackupCode(apps);
    await click('I saved it');
    await settle();
    expect(h1()).toBe(CONNECTED_STEP.notConnectedTitle('Claude Code agent'));
    expect(buttonNames()).toContain(CONNECTED_STEP.connect('Claude Code'));
    await click(CONNECTED_STEP.home);
    expect(apps.applied).toEqual([]);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('"I saved it" remembers the kit as later', async () => {
    await toBackupCode(fakeApps());
    await click('I saved it');
    expect(localStorage.getItem(RECOVERY_KIT_LATER_KEY)).toMatch(/^[0-9]+$/);
  });

  it('E1 Connect shows the exact entry before anything is written', async () => {
    const apps = fakeApps();
    const home = await toConnect(apps);
    expect(apps.previews).toEqual([['claude-code', 'default']]);
    expect(h1()).toBe('Connect Claude Code to Claude Code agent');
    expect(text()).toContain("This adds one entry to Claude Code's settings.");
    expect(text()).toContain('~/.claude.json');
    const entry = host.querySelector('[aria-label="The entry that will be added"]');
    expect(entry?.textContent).toContain('"agentlink"');
    expect(entry?.textContent).toContain('"--agent"');
    expect(entry?.textContent).toContain('"default"');
    expect(text()).toContain(
      'Agent folder: default. A backup of the file is saved first. Nothing else in it changes.',
    );
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(button('Apply with Touch ID').className).toContain('al-btn-primary');
    expect(buttonNames()).toContain('Later');
    expect(apps.applied).toEqual([]);
    expect(home).not.toHaveBeenCalled();
  });

  it('Apply with Touch ID is its own signed step: one apply with the change ID and the proof, then Connected', async () => {
    const apps = fakeApps();
    await toConnect(apps);
    await click('Apply with Touch ID');
    await settle();
    expect(apps.applied).toEqual([CHANGE.changeId]);
    expect(apps.proofs[0]?.kind).toBe('passkey');
    expect(h1()).toBe(CONNECTED_STEP.title('Claude Code'));
  });

  it('Later writes nothing and lands on Home', async () => {
    const apps = fakeApps();
    const home = await toConnect(apps);
    await click('Later');
    expect(apps.applied).toEqual([]);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('a cancelled Touch ID keeps the card open: "Not connected yet. Try again."', async () => {
    const apps = fakeApps();
    await toConnect(apps, { passkeyProof: () => Promise.resolve(undefined) });
    await click('Apply with Touch ID');
    await settle();
    expect(text()).toContain('Not connected yet. Try again.');
    expect(apps.applied).toEqual([]);
    expect(buttonNames()).toContain('Apply with Touch ID');
  });

  it('Claude Desktop running: "Quit Claude Desktop first." with Check again; Apply is off; Later stays', async () => {
    const quit = { kind: 'status', status: 'quit_first' } as const;
    let calls = 0;
    const apps = fakeApps({
      preview: () => {
        calls += 1;
        return calls === 1 ? quit : { kind: 'change', change: CHANGE };
      },
    });
    await toConnect(apps);
    expect(text()).toContain('Quit Claude Code first.');
    expect(buttonNames()).not.toContain('Apply with Touch ID');
    expect(buttonNames()).toContain('Later');
    await click('Check again');
    await settle();
    expect(button('Apply with Touch ID')).toBeDefined();
  });

  it('an entry we did not write is never overwritten', async () => {
    const apps = fakeApps({ preview: { kind: 'status', status: 'conflict' } });
    await toConnect(apps);
    expect(text()).toContain("This app already has an AgentLink entry we didn't write.");
    expect(buttonNames()).not.toContain('Apply with Touch ID');
    expect(buttonNames()).toContain('Later');
  });

  it('a refused write says nothing was changed', async () => {
    const apps = fakeApps({ apply: { kind: 'refused', reason: 'write_failed' } });
    await toConnect(apps);
    await click('Apply with Touch ID');
    await settle();
    expect(text()).toContain("Couldn't change Claude Code's settings. Nothing was changed.");
    expect(buttonNames()).toContain('Try again');
    expect(buttonNames()).toContain('Later');
  });

  it('the connect step is skipped (Home) when the preview is not available yet', async () => {
    const home = await toConnect(fakeApps({ preview: { kind: 'not_available' } }));
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('there is no connect step without an open agent folder (outside the app host)', async () => {
    const apps = fakeApps({ agent: undefined });
    const home = await toConnect(apps);
    expect(apps.previews).toEqual([]);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('uses no wallet, key, seed or chain words on any screen', async () => {
    const BANNED = /\b(wallet|gas|seed|transaction|chain|blockchain|private key|0x[0-9a-f]+)\b/i;
    await mount(fakeSetup({ connected: false }), fakeApps());
    await settle();
    const seen = [text()];
    await click(PICK_STEP.next('Claude Code'));
    await settle();
    seen.push(text());
    await click(GO);
    seen.push(text());
    await click('I saved it');
    await settle();
    seen.push(text());
    await click(CONNECTED_STEP.connect('Claude Code'));
    await settle();
    seen.push(text());
    for (const screen of seen) expect(screen).not.toMatch(BANNED);
  });
});

describe('W4-WIZARD (was U3-g): accessibility', () => {
  async function violations(): Promise<string[]> {
    const result = await axe.run(host, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    return result.violations.map((v) => v.id);
  }

  it('axe finds nothing on Pick, Confirm, Backup code, Connected and Connect', async () => {
    await mount(fakeSetup({ connected: false }), fakeApps());
    await settle();
    expect(await violations()).toEqual([]);
    await click(PICK_STEP.next('Claude Code'));
    await settle();
    expect(await violations()).toEqual([]);
    await click(CONNECT_STEP.connect('Touch ID'));
    expect(await violations()).toEqual([]);
    await click('I saved it');
    await settle();
    expect(await violations()).toEqual([]);
    await click(CONNECTED_STEP.connect('Claude Code'));
    await settle();
    expect(h1()).toBe('Connect Claude Code to Claude Code agent');
    expect(await violations()).toEqual([]);
  });

  it('moves focus to the title on each screen', async () => {
    await mount(fakeSetup(), fakeApps());
    await settle();
    expect(document.activeElement).toBe(host.querySelector('h1'));
    await click(PICK_STEP.next('Claude Code'));
    await settle();
    expect(document.activeElement).toBe(host.querySelector('h1'));
  });
});

// The two clients against a fake fetch: the headers and bodies the real server parses
// (packages/node/src/approval-server.ts setupLabel, operationInput; ownerGate).
describe('U3-g: the clients speak what the server parses', () => {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('W4-ONE-TOUCH: begin carries {label, app}, finish only {nonce}, as base64url JSON in X-AgentLink-Input; bodies stay octet-stream', async () => {
    const seen: { path: string; input: string | null; type: string | null }[] = [];
    const api = createSetupApi({
      token: 't',
      fetch: (path, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          path: String(path),
          input: headers.get('X-AgentLink-Input'),
          type: headers.get('content-type'),
        });
        return Promise.resolve(
          String(path).endsWith('begin')
            ? json(200, {
                status: 'ready',
                publicKey: VALUES,
                nonce: NONCE,
                statement: { app: { app: 'claude-code', name: 'Claude Code', kind: 'connect' } },
              })
            : json(409, { status: 'changed' }),
        );
      },
    });
    const begun = await api.begin('Claude Code agent', 'claude-code');
    expect(begun).toMatchObject({
      kind: 'ready',
      nonce: NONCE,
      app: { id: 'claude-code', name: 'Claude Code', kind: 'connect' },
    });
    const refused = await api.finish(BODY.slice(), NONCE);
    const b64 = (value: unknown): string =>
      btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(seen.map((s) => s.input)).toEqual([
      b64({ label: 'Claude Code agent', app: 'claude-code' }),
      b64({ nonce: NONCE }),
    ]);
    expect(seen.every((s) => s.type === 'application/octet-stream')).toBe(true);
    expect(refused).toEqual({ kind: 'error', problem: 'changed' });
  });

  it('W4-ONE-TOUCH: finish reads created_not_connected as done with the app not connected', async () => {
    const api = createSetupApi({
      token: 't',
      fetch: () =>
        Promise.resolve(
          json(200, {
            status: 'created_not_connected',
            ownerCode: 'ABCD EFGH IJKL MNOP QRST UVWX',
            fingerprint: '7F3A·19C2',
            passkey: true,
            app: 'claude-code',
          }),
        ),
    });
    expect(await api.finish(BODY.slice(), NONCE)).toMatchObject({
      kind: 'done',
      confirmed: true,
      app: 'claude-code',
      connected: false,
    });
  });

  it('labelCheck sends the label as the one query parameter and reads ok or refused', async () => {
    const urls: string[] = [];
    const api = createSetupApi({
      token: 't',
      fetch: (path) => {
        urls.push(String(path));
        return Promise.resolve(
          urls.length === 1
            ? json(200, { status: 'ok' })
            : json(200, { status: 'refused', reason: 'label_invalid' }),
        );
      },
    });
    expect(await api.labelCheck('My agent & more')).toEqual({ kind: 'ok' });
    expect(await api.labelCheck('Work  agent')).toEqual({ kind: 'refused' });
    expect(urls[0]).toBe('/api/ui/agents/label-check?label=My%20agent%20%26%20more');
  });

  it('the apps client reads the U3-f shapes and a stub as not_available', async () => {
    const answers: Record<string, Response> = {
      '/api/ui/apps': json(200, {
        desktopRunning: false,
        apps: [
          {
            app: 'claude-code',
            name: 'Claude Code',
            path: '~/.claude.json',
            state: 'not_connected',
            quitFirst: false,
          },
          { app: 'nope', name: 'x', path: 'y', state: 'bogus', quitFirst: false },
        ],
      }),
    };
    const apps = createAppsApi({
      token: 't',
      fetch: (path) =>
        Promise.resolve(answers[String(path)] ?? json(501, { error: 'not_available' })),
    });
    const listed = await apps.list();
    expect(listed).toEqual({
      kind: 'ok',
      desktopRunning: false,
      apps: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          path: '~/.claude.json',
          state: 'not_connected',
          quitFirst: false,
        },
      ],
    });
    expect(await apps.preview('claude-code', 'default')).toEqual({ kind: 'not_available' });
  });

  it('a 409 no_agent is a plain "Set up your agent first." and a stay, never unknown or failed', async () => {
    const fetch = (): Promise<Response> => Promise.resolve(json(409, { error: 'no_agent' }));
    expect(await createSetupApi({ token: 't', fetch }).labelCheck('x')).toEqual({
      kind: 'error',
      problem: 'no_agent',
    });
    const apps = createAppsApi({ token: 't', fetch });
    expect(await apps.list()).toEqual({ kind: 'not_available' });
    expect(await apps.preview('claude-code', 'default')).toEqual({ kind: 'not_available' });
  });

  it('apply sends only {changeId} in X-AgentLink-Input, the proof as the body, and maps the fixed answers', async () => {
    const seen: Headers[] = [];
    let status = 200;
    let body: unknown = { status: 'done', app: 'claude-code' };
    const apps = createAppsApi({
      token: 't',
      fetch: (_path, init) => {
        seen.push(new Headers(init?.headers));
        return Promise.resolve(json(status, body));
      },
    });
    const proof: PresenceProof = { kind: 'passkey', body: new Uint8Array([1, 2, 3]) };
    expect(await apps.apply('b'.repeat(64), proof)).toEqual({ kind: 'done' });
    const sent = seen[0];
    expect(sent?.get('X-AgentLink-Presence')).toBe('passkey');
    expect(sent?.get('content-type')).toBe('application/octet-stream');
    expect(atob((sent?.get('X-AgentLink-Input') ?? '').replace(/-/g, '+').replace(/_/g, '/'))).toBe(
      JSON.stringify({ changeId: 'b'.repeat(64) }),
    );
    for (const [code, reason] of [
      ['changed', 'changed'],
      ['quit_first', 'quit_first'],
      ['write_failed', 'write_failed'],
      ['agent_changed', 'agent_changed'],
    ] as const) {
      status = 409;
      body = { error: code };
      expect(await apps.apply('b'.repeat(64), { kind: 'code', code: 'x' })).toEqual({
        kind: 'refused',
        reason,
      });
    }
    status = 403;
    body = { status: 'presence_rejected' };
    expect(await apps.apply('b'.repeat(64), { kind: 'code', code: 'x' })).toEqual({
      kind: 'rejected',
    });
  });
});

describe('U3-g: the new copy passes lintVocabulary (11 §5.1)', () => {
  it('every Welcome, pick, name and connect string, filled in', () => {
    const texts: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') texts.push(value);
      else if (typeof value === 'function') {
        texts.push(
          String(
            (value as (a: string, b: string, c: string) => string)('Claude Code', 'Work', 'Home'),
          ),
        );
      } else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
    };
    for (const group of [WELCOME, PICK, NAME, CONNECT]) walk(group);
    texts.push(SETUP_MESSAGES.label_invalid, SETUP_MESSAGES.cancelled);
    for (const t of texts) expect([t, lintVocabulary(t)]).toEqual([t, []]);
  });
});
