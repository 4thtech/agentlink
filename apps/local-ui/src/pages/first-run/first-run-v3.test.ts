// @vitest-environment jsdom
// U3-g acceptance (b11 §28; 08 §1 "First run v3"; D-137, D-138): Welcome, pick your AI app, one
// screen that names the agent and protects it (one gesture), the backup code, then "Connect your AI
// app" as its own signed step that "Later" skips; the end lands on Home.
//
// The server shapes used by the fakes of `GET /api/ui/apps`, `/preview` and `/apply` are the ones
// packages/node/src/local-ui/api/apps.ts (U3-f) answers; the setup calls, the label check and the
// headers are checked against the real server in packages/node/src/local-ui-first-run-browser.test.ts
// and packages/node/src/local-ui/first-run-v3-reads.test.ts.
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
  finished: { label: string; body: Uint8Array }[];
  checked: string[];
}

function fakeSetup(
  o: { check?: (label: string) => 'ok' | 'refused'; status?: StatusResult; finish?: FinishResult } = {},
): SetupApi & SetupCalls {
  const calls: SetupCalls = { begun: [], finished: [], checked: [] };
  return Object.assign(calls, {
    status: () => Promise.resolve(o.status ?? ({ kind: 'ok', owner: 'missing' } as StatusResult)),
    labelCheck: (label: string) => {
      calls.checked.push(label);
      return Promise.resolve({ kind: o.check?.(label) ?? 'ok' } as const);
    },
    begin: (label: string): Promise<BeginResult> => {
      calls.begun.push(label);
      return Promise.resolve({ kind: 'ready', publicKey: VALUES });
    },
    finish: (body: Uint8Array, label: string): Promise<FinishResult> => {
      calls.finished.push({ label, body: body.slice() });
      return Promise.resolve(o.finish ?? FINISHED);
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
        o.list ?? ({ kind: 'ok', apps: [CODE_APP, DESKTOP, CODEX], desktopRunning: false } as const),
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
      Promise.resolve(
        o.passkey === false ? undefined : { credentialId: 'AQID', prfSalt: 'BwgJ' },
      ),
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
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
async function pickRadio(name: string): Promise<void> {
  const label = [...host.querySelectorAll('label')].find((l) => l.textContent?.includes(name));
  const radio = label?.querySelector<HTMLInputElement>('input[type="radio"]');
  if (radio === undefined || radio === null) throw new Error(`no radio ${name}`);
  await act(async () => {
    radio.click();
  });
}

describe('U3-g: Welcome (b11 §28.1)', () => {
  it('shows one sentence and one primary button while no owner exists, and calls nothing yet', async () => {
    const setup = fakeSetup();
    const apps = fakeApps();
    await mount(setup, apps);
    expect(host.querySelector('h1')?.textContent).toBe(
      'Private messages between AI agents. Only you and your contact can read them.',
    );
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(button('Get started').className).toContain('al-btn-primary');
    expect(setup.begun).toEqual([]);
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === "What's AgentLink?");
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('href')).toMatch(/^https:\/\//);
  });

  it('is not shown when an owner exists', async () => {
    await mount(fakeSetup({ status: { kind: 'ok', owner: 'set_up' } }), fakeApps());
    expect(h1()).not.toContain('Private messages');
    expect(buttonNames()).not.toContain('Get started');
  });
});

describe('U3-g: pick your AI app (b11 §28.2)', () => {
  it('lists the found apps as a radio group, the first preselected, "I\'ll choose later" last', async () => {
    await mount(fakeSetup(), fakeApps());
    await click('Get started');
    await settle();
    expect(h1()).toBe('Which AI app will you use?');
    const group = host.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    const radios = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.closest('label')?.textContent?.replace(/Found/g, '').trim())).toEqual(
      ['Claude Code', 'Claude Desktop', 'Codex', "I'll choose later"].map((t) =>
        t === "I'll choose later" ? t : t,
      ),
    );
    expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]);
    expect(text().match(/Found/g)).toHaveLength(3);
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(button('Continue').className).toContain('al-btn-primary');
  });

  it('says so when none is found and still goes on', async () => {
    await mount(fakeSetup(), fakeApps({ list: { kind: 'ok', apps: [], desktopRunning: false } }));
    await click('Get started');
    await settle();
    expect(text()).toContain('No AI app found yet. You can connect one later.');
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    await click('Continue');
    expect(h1()).toBe('Set up your agent');
    expect(field().value).toBe('My agent');
  });

  it('handles the look being unavailable or failing: a plain line and Continue enabled', async () => {
    for (const list of [{ kind: 'not_available' }, { kind: 'failed' }] as const) {
      await mount(fakeSetup(), fakeApps({ list }));
      await click('Get started');
      await settle();
      expect(text()).toContain("Couldn't look for AI apps. You can connect one later.");
      expect(button('Continue').disabled).toBe(false);
      await click('Continue');
      expect(field().value).toBe('My agent');
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
    await click('Get started');
    await settle();
    expect(host.querySelector('img')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('Back returns to Welcome', async () => {
    await mount(fakeSetup(), fakeApps());
    await click('Get started');
    await settle();
    await click('Back');
    expect(button('Get started')).toBeDefined();
  });
});

describe('U3-g: name and protect on one screen (b11 §28.3)', () => {
  const toName = async (setup = fakeSetup(), apps = fakeApps(), extra = {}): Promise<{
    setup: ReturnType<typeof fakeSetup>;
    apps: ReturnType<typeof fakeApps>;
    home: ReturnType<typeof vi.fn>;
  }> => {
    const { home } = await mount(setup, apps, extra);
    await click('Get started');
    await settle();
    await click('Continue');
    return { setup, apps, home };
  };

  it('prefills "{App} agent" from the chosen app, selected, with Touch ID as the one primary', async () => {
    await toName();
    expect(h1()).toBe('Set up your agent');
    expect(field().value).toBe('Claude Code agent');
    expect(host.querySelector('label')?.textContent).toBe('Name your agent');
    expect(text()).toContain('Shown to you and your contacts.');
    expect(text()).toContain('Claude Code');
    expect(host.querySelectorAll('.al-btn-primary')).toHaveLength(1);
    expect(button('Use Touch ID').className).toContain('al-btn-primary');
    expect(buttonNames()).toContain('Use a backup code instead');
    expect(buttonNames()).toContain('Change');
  });

  it('follows the app until the person edits the name; an edited name is never overwritten', async () => {
    await toName();
    await click('Change');
    await pickRadio('Codex');
    await click('Continue');
    expect(field().value).toBe('Codex agent');
    await type('Work agent');
    await click('Change');
    await pickRadio('Claude Desktop');
    await click('Continue');
    expect(field().value).toBe('Work agent');
  });

  it('"I\'ll choose later" suggests "My agent"', async () => {
    await mount(fakeSetup(), fakeApps());
    await click('Get started');
    await settle();
    await pickRadio("I'll choose later");
    await click('Continue');
    expect(field().value).toBe('My agent');
  });

  it('Back keeps the typed name', async () => {
    await toName();
    await type('Home base');
    await click('Back');
    await click('Continue');
    expect(field().value).toBe('Home base');
  });

  it('refuses an empty name inline and starts nothing', async () => {
    const { setup } = await toName();
    await type('   ');
    await click('Use Touch ID');
    expect(text()).toContain('Give your agent a name.');
    expect(setup.checked).toEqual([]);
    expect(setup.begun).toEqual([]);
  });

  it('refuses more than 32 code points before asking the server', async () => {
    const { setup } = await toName();
    await type('a'.repeat(33));
    await click('Use Touch ID');
    expect(setup.begun).toEqual([]);
    expect(host.querySelector('[role="alert"], .is-error')).not.toBeNull();
    // 32 code points (emoji count once) pass the local check.
    await type('😀'.repeat(32));
    await click('Use Touch ID');
    expect(setup.checked).toEqual(['😀'.repeat(32)]);
  });

  it('asks the server to check the label before Touch ID; a refusal keeps the text and starts no setup', async () => {
    const created = vi.fn(() => Promise.resolve({ kind: 'cancelled' } as const));
    const { setup } = await toName(fakeSetup({ check: () => 'refused' }), fakeApps(), {
      createPasskey: created,
    });
    await type('Work  agent');
    await click('Use Touch ID');
    expect(setup.checked).toEqual(['Work  agent']);
    expect(setup.begun).toEqual([]);
    expect(created).not.toHaveBeenCalled();
    expect(field().value).toBe('Work  agent');
    expect(text()).toContain("That name can't be used.");
  });

  it('one gesture: check, begin and finish carry the same trimmed label; the browser sends the creation response only', async () => {
    const { setup } = await toName();
    await type('  Personal  ');
    await click('Use Touch ID');
    expect(setup.checked).toEqual(['Personal']);
    expect(setup.begun).toEqual(['Personal']);
    expect(setup.finished).toHaveLength(1);
    expect(setup.finished[0]?.label).toBe('Personal');
    expect(setup.finished[0]?.body).toEqual(BODY);
    expect(h1()).toBe('Your backup code');
  });

  it('Enter in the field does not submit; focus moves to the button', async () => {
    const { setup } = await toName();
    const input = field();
    await act(async () => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(setup.begun).toEqual([]);
    expect(document.activeElement).toBe(button('Use Touch ID'));
  });

  it('a cancelled Touch ID says "Not protected yet. Try again." and keeps the text', async () => {
    const { setup } = await toName(fakeSetup(), fakeApps(), {
      createPasskey: () => Promise.resolve({ kind: 'cancelled' }),
    });
    await type('Mine');
    await click('Use Touch ID');
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

describe('U3-g: the end of first run (b11 §28.3, §28.4)', () => {
  async function toBackupCode(apps: AppsApi, setup = fakeSetup(), extra = {}) {
    const { home } = await mount(setup, apps, extra);
    await click('Get started');
    await settle();
    await click('Continue');
    await click('Use Touch ID');
    expect(h1()).toBe('Your backup code');
    return { home, setup };
  }

  it('with no app chosen, "I saved it" lands on Home and remembers the kit as later', async () => {
    const { home } = await mount(fakeSetup(), fakeApps({ list: { kind: 'ok', apps: [], desktopRunning: false } }));
    await click('Get started');
    await settle();
    await click('Continue');
    await click('Use Touch ID');
    await click('I saved it');
    expect(home).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(RECOVERY_KIT_LATER_KEY)).toMatch(/^[0-9]+$/);
  });

  it('with an app chosen, "I saved it" opens "Connect your AI app" with the exact entry', async () => {
    const apps = fakeApps();
    const { home } = await toBackupCode(apps);
    await click('I saved it');
    await settle();
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

  it('Apply with Touch ID is its own signed step: one apply with the change ID and the proof', async () => {
    const apps = fakeApps();
    await toBackupCode(apps);
    await click('I saved it');
    await settle();
    await click('Apply with Touch ID');
    await settle();
    expect(apps.applied).toEqual([CHANGE.changeId]);
    expect(apps.proofs[0]?.kind).toBe('passkey');
    expect(text()).toContain('Restart Claude Code to finish');
  });

  it('after applying, Go to Home lands on Home', async () => {
    const apps = fakeApps();
    const { home } = await toBackupCode(apps);
    await click('I saved it');
    await settle();
    await click('Apply with Touch ID');
    await settle();
    await click('Go to Home');
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('Later writes nothing and lands on Home', async () => {
    const apps = fakeApps();
    const { home } = await toBackupCode(apps);
    await click('I saved it');
    await settle();
    await click('Later');
    expect(apps.applied).toEqual([]);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('a cancelled Touch ID keeps the card open: "Not connected yet. Try again."', async () => {
    const apps = fakeApps();
    await toBackupCode(apps, fakeSetup(), { passkeyProof: () => Promise.resolve(undefined) });
    await click('I saved it');
    await settle();
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
      list: { kind: 'ok', apps: [app('claude-desktop', 'Claude Desktop', { quitFirst: true })], desktopRunning: true },
      preview: () => {
        calls += 1;
        return calls === 1
          ? quit
          : { kind: 'change', change: { ...CHANGE, app: 'claude-desktop', name: 'Claude Desktop' } };
      },
    });
    await toBackupCode(apps);
    await click('I saved it');
    await settle();
    expect(text()).toContain('Quit Claude Desktop first.');
    expect(buttonNames()).not.toContain('Apply with Touch ID');
    expect(buttonNames()).toContain('Later');
    await click('Check again');
    await settle();
    expect(button('Apply with Touch ID')).toBeDefined();
    expect(text()).not.toContain('Quit Claude Desktop first.');
  });

  it('an entry we did not write is never overwritten', async () => {
    const apps = fakeApps({ preview: { kind: 'status', status: 'conflict' } });
    await toBackupCode(apps);
    await click('I saved it');
    await settle();
    expect(text()).toContain("This app already has an AgentLink entry we didn't write.");
    expect(buttonNames()).not.toContain('Apply with Touch ID');
    expect(buttonNames()).toContain('Later');
  });

  it('a refused write says nothing was changed', async () => {
    const apps = fakeApps({ apply: { kind: 'refused', reason: 'write_failed' } });
    await toBackupCode(apps);
    await click('I saved it');
    await settle();
    await click('Apply with Touch ID');
    await settle();
    expect(text()).toContain("Couldn't change Claude Code's settings. Nothing was changed.");
    expect(buttonNames()).toContain('Try again');
    expect(buttonNames()).toContain('Later');
  });

  it('the connect step is skipped (Home) when the preview is not available yet', async () => {
    const apps = fakeApps({ preview: { kind: 'not_available' } });
    const { home } = await toBackupCode(apps);
    await click('I saved it');
    await settle();
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('there is no connect step without an open agent folder (outside the app host)', async () => {
    const apps = fakeApps({ agent: undefined });
    const { home } = await toBackupCode(apps);
    await click('I saved it');
    await settle();
    expect(apps.previews).toEqual([]);
    expect(home).toHaveBeenCalledTimes(1);
  });

  it('uses no wallet, key, seed or chain words on any screen', async () => {
    const BANNED = /\b(wallet|gas|seed|transaction|chain|blockchain|private key|0x[0-9a-f]+)\b/i;
    await mount(fakeSetup(), fakeApps());
    const seen = [text()];
    await click('Get started');
    await settle();
    seen.push(text());
    await click('Continue');
    seen.push(text());
    await click('Use Touch ID');
    seen.push(text());
    await click('I saved it');
    await settle();
    seen.push(text());
    for (const screen of seen) expect(screen).not.toMatch(BANNED);
  });
});

describe('U3-g: accessibility', () => {
  async function violations(): Promise<string[]> {
    const result = await axe.run(host, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });
    return result.violations.map((v) => v.id);
  }

  it('axe finds nothing on Welcome, Pick, Name, Backup code and Connect', async () => {
    await mount(fakeSetup(), fakeApps());
    expect(await violations()).toEqual([]);
    await click('Get started');
    await settle();
    expect(await violations()).toEqual([]);
    await click('Continue');
    expect(await violations()).toEqual([]);
    await click('Use Touch ID');
    expect(await violations()).toEqual([]);
    await click('I saved it');
    await settle();
    expect(h1()).toBe('Connect Claude Code to Claude Code agent');
    expect(await violations()).toEqual([]);
  });

  it('moves focus to the title on each screen', async () => {
    await mount(fakeSetup(), fakeApps());
    await click('Get started');
    await settle();
    expect(document.activeElement).toBe(host.querySelector('h1'));
    await click('Continue');
    expect(document.activeElement).toBe(host.querySelector('h1'));
  });

  it('has a reduced-motion rule for the Welcome fade', async () => {
    const css = (await import('../welcome/welcome.css?raw')).default;
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{[\s\S]*?animation:\s*none/,
    );
    expect(css).toMatch(/\[data-motion='reduced'\]/);
  });
});

// The two clients against a fake fetch: the headers and bodies the real server parses
// (packages/node/src/approval-server.ts setupLabel, operationInput; ownerGate).
describe('U3-g: the clients speak what the server parses', () => {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('begin and finish carry {label} as base64url JSON in X-AgentLink-Input; the body stays octet-stream', async () => {
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
            ? json(200, { status: 'ready', publicKey: VALUES })
            : json(400, { status: 'label_invalid' }),
        );
      },
    });
    await api.begin('Claude Code agent');
    const refused = await api.finish(BODY.slice(), 'Claude Code agent');
    const expected = btoa(JSON.stringify({ label: 'Claude Code agent' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(seen.map((s) => s.input)).toEqual([expected, expected]);
    expect(seen.every((s) => s.type === 'application/octet-stream')).toBe(true);
    expect(refused).toEqual({ kind: 'error', problem: 'label_invalid' });
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
          { app: 'claude-code', name: 'Claude Code', path: '~/.claude.json', state: 'not_connected', quitFirst: false },
          { app: 'nope', name: 'x', path: 'y', state: 'bogus', quitFirst: false },
        ],
      }),
    };
    const apps = createAppsApi({
      token: 't',
      fetch: (path) => Promise.resolve(answers[String(path)] ?? json(501, { error: 'not_available' })),
    });
    const listed = await apps.list();
    expect(listed).toEqual({
      kind: 'ok',
      desktopRunning: false,
      apps: [
        { id: 'claude-code', name: 'Claude Code', path: '~/.claude.json', state: 'not_connected', quitFirst: false },
      ],
    });
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
    expect(await apps.apply('b'.repeat(64), { kind: 'code', code: 'x' })).toEqual({ kind: 'rejected' });
  });
});
