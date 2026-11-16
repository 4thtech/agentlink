// TRAY-POPOVER (D-155): the popover's one IPC channel. The preload exposes only
// `agentlinkWidget.{open({route, target?}), quit(), close()}`, each on a fresh user activation; the
// main process answers only the popover's own web contents, its top frame, on the locked origin at
// `/settings/widget`, while it is visible; the route is from a fixed list and the target follows the
// pipe's notify-target rules. Nothing else is reachable and nothing comes back but a boolean.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from '../../src/main/electron-api.js';
import { OriginLock } from '../../src/main/security.js';
import {
  WIDGET_CHANNEL,
  WIDGET_PRELOAD_FILE,
  WIDGET_ROUTES,
  createWidgetHandler,
  parseWidgetRequest,
  registerWidgetIpc,
  widgetPreloadPath,
  type WidgetRoute,
} from '../../src/main/widget-ipc.js';
import { SESSION_URL } from './fakes.js';

const ORIGIN = 'http://localhost:4567';
const WIDGET = `${ORIGIN}/settings/widget`;
const PERSON = `0x${'ab'.repeat(20)}`;
const APPROVAL = `apr_${'A'.repeat(22)}`;
const PRELOAD = new URL('../../src/main/widget-preload.js', import.meta.url);

const event = (
  url = WIDGET,
  opts: { senderId?: number; top?: boolean; frame?: null } = {},
): IpcMainInvokeEvent => ({
  sender: { id: opts.senderId ?? 41 },
  senderFrame:
    opts.frame === null
      ? null
      : { url, parent: opts.top === false ? { url: WIDGET, parent: null } : null },
});

function setup(contentsId: number | null = 41) {
  const lock = new OriginLock();
  expect(lock.acceptSessionUrl(SESSION_URL)).toBe(true);
  const calls: string[] = [];
  const handler = createWidgetHandler({
    lock,
    widgetContentsId: () => contentsId,
    openPage: (route: WidgetRoute, target?: string) => {
      calls.push(target === undefined ? `open ${route}` : `open ${route} ${target}`);
    },
    quit: () => calls.push('quit'),
    close: () => calls.push('close'),
  });
  return { handler, calls, lock };
}

describe('parseWidgetRequest', () => {
  it('accepts exactly the three actions', () => {
    expect(parseWidgetRequest({ action: 'quit' })).toEqual({ action: 'quit' });
    expect(parseWidgetRequest({ action: 'close' })).toEqual({ action: 'close' });
    for (const route of WIDGET_ROUTES) {
      expect(parseWidgetRequest({ action: 'open', route })).toEqual({ action: 'open', route });
    }
    expect(parseWidgetRequest({ action: 'open', route: 'inbox', target: PERSON })).toEqual({
      action: 'open',
      route: 'inbox',
      target: PERSON,
    });
    expect(parseWidgetRequest({ action: 'open', route: 'approvals', target: APPROVAL })).toEqual({
      action: 'open',
      route: 'approvals',
      target: APPROVAL,
    });
  });

  it('the route list is fixed', () => {
    expect([...WIDGET_ROUTES]).toEqual(['home', 'inbox', 'approvals', 'updates']);
  });

  it.each([
    undefined,
    null,
    'quit',
    [],
    {},
    { action: 'quit', extra: 1 },
    { action: 'close', route: 'home' },
    { action: 'approve' },
    { action: 'resume' },
    { action: 'open' },
    { action: 'open', route: 'join' },
    { action: 'open', route: 'settings' },
    { action: 'open', route: 'home', target: PERSON },
    { action: 'open', route: 'updates', target: PERSON },
    { action: 'open', route: 'inbox', target: APPROVAL },
    { action: 'open', route: 'approvals', target: PERSON },
    { action: 'open', route: 'inbox', target: PERSON.toUpperCase() },
    { action: 'open', route: 'inbox', target: `${PERSON}0` },
    { action: 'open', route: 'inbox', target: 42 },
    { action: 'open', route: 'inbox', target: undefined },
    { action: 'open', route: 'home', url: 'https://evil.example/' },
  ])('refuses %j', (input) => {
    expect(parseWidgetRequest(input)).toBeUndefined();
  });

  it('refuses inherited and prototype tricks', () => {
    const proto = Object.create({ action: 'quit' }) as object;
    expect(parseWidgetRequest(proto)).toBeUndefined();
  });
});

describe('the handler checks the caller', () => {
  it('open goes to the main window, then the popover closes', async () => {
    const { handler, calls } = setup();
    await expect(handler(event(), { action: 'open', route: 'inbox', target: PERSON })).resolves.toBe(
      true,
    );
    await expect(handler(event(), { action: 'open', route: 'home' })).resolves.toBe(true);
    expect(calls).toEqual([`open inbox ${PERSON}`, 'close', 'open home', 'close']);
  });

  it('quit and close', async () => {
    const { handler, calls } = setup();
    await expect(handler(event(), { action: 'close' })).resolves.toBe(true);
    await expect(handler(event(), { action: 'quit' })).resolves.toBe(true);
    expect(calls).toEqual(['close', 'quit']);
  });

  it('refuses another web contents (the main window, any other)', async () => {
    const { handler, calls } = setup();
    await expect(handler(event(WIDGET, { senderId: 7 }), { action: 'quit' })).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses while the popover is hidden or not on the widget page', async () => {
    const { handler, calls } = setup(null);
    await expect(handler(event(), { action: 'quit' })).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('refuses a sub-frame, a missing frame and any other origin or page', async () => {
    const { handler, calls } = setup();
    for (const e of [
      event(WIDGET, { top: false }),
      event(WIDGET, { frame: null }),
      event('http://localhost:9999/settings/widget'),
      event('http://127.0.0.1:4567/settings/widget'),
      event(`${ORIGIN}/settings/home`),
      event(`${ORIGIN}/settings/widget/x`),
      event(`${ORIGIN}/settings/widget?t=x`),
      event('data:text/html,hi'),
      event('https://evil.example/settings/widget'),
    ]) {
      await expect(handler(e, { action: 'quit' })).resolves.toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('refuses a bad request', async () => {
    const { handler, calls } = setup();
    await expect(handler(event(), { action: 'open', route: 'join' })).resolves.toBe(false);
    await expect(handler(event(), { action: 'approve', id: APPROVAL })).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('a throwing action answers false, never throws', async () => {
    const lock = new OriginLock();
    lock.acceptSessionUrl(SESSION_URL);
    const handler = createWidgetHandler({
      lock,
      widgetContentsId: () => 41,
      openPage: () => {
        throw new Error('x');
      },
      quit: () => undefined,
      close: () => undefined,
    });
    await expect(handler(event(), { action: 'open', route: 'home' })).resolves.toBe(false);
  });

  it('registers exactly one channel', () => {
    const channels: string[] = [];
    registerWidgetIpc(
      {
        handle: (channel) => {
          channels.push(channel);
        },
      },
      {
        lock: new OriginLock(),
        widgetContentsId: () => null,
        openPage: () => undefined,
        quit: () => undefined,
        close: () => undefined,
      },
    );
    expect(channels).toEqual([WIDGET_CHANNEL]);
    expect(WIDGET_CHANNEL).toBe('agentlink:widget');
  });

  it('finds the bundled preload next to the main bundle', () => {
    expect(WIDGET_PRELOAD_FILE).toBe('widget-preload.cjs');
    expect(widgetPreloadPath('file:///app/main/entry.js', () => true)).toBe(
      '/app/main/widget-preload.cjs',
    );
    expect(widgetPreloadPath('file:///app/main/entry.js', () => false)).toBeUndefined();
  });

  it('the release bundle emits the second preload next to entry.js', () => {
    const config = readFileSync(new URL('../../bundle.config.mjs', import.meta.url), 'utf8');
    expect(config).toContain("'./src/main/widget-preload.js'");
    expect(config).toContain(`fileName: '${WIDGET_PRELOAD_FILE}'`);
  });
});

function loadPreload(active: { value: boolean }, answer: unknown = true) {
  const exposed: Record<string, unknown> = {};
  const invoked: { channel: string; message: unknown }[] = [];
  let release: (() => void) | null = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name: string, api: unknown) => {
        exposed[name] = api;
      },
    },
    ipcRenderer: {
      invoke: (channel: string, message: unknown) => {
        invoked.push({ channel, message });
        if (answer === 'hold') {
          return new Promise((resolve) => {
            release = () => resolve(true);
          });
        }
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
  const navigator = {
    userActivation: {
      get isActive() {
        return active.value;
      },
    },
  };
  runInNewContext(readFileSync(PRELOAD, 'utf8'), {
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`no ${id}`);
      return electron;
    },
    navigator,
    globalThis: { navigator },
    Promise,
    Object,
    Boolean,
  });
  const api = exposed['agentlinkWidget'] as {
    open: (r: unknown) => Promise<boolean>;
    quit: () => Promise<boolean>;
    close: () => Promise<boolean>;
  };
  return { api, exposed, invoked, release: () => release?.() };
}

describe('widget preload', () => {
  it('exposes exactly agentlinkWidget.{open, quit, close}, frozen', () => {
    const { api, exposed } = loadPreload({ value: true });
    expect(Object.keys(exposed)).toEqual(['agentlinkWidget']);
    expect(Object.keys(api).sort()).toEqual(['close', 'open', 'quit']);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it('nothing is sent without a user activation', async () => {
    const { api, invoked } = loadPreload({ value: false });
    await expect(api.open({ route: 'home' })).resolves.toBe(false);
    await expect(api.quit()).resolves.toBe(false);
    await expect(api.close()).resolves.toBe(false);
    expect(invoked).toEqual([]);
  });

  it('sends only the fixed shapes on the one channel', async () => {
    const { api, invoked } = loadPreload({ value: true });
    await expect(api.open({ route: 'inbox', target: PERSON, extra: 'x' })).resolves.toBe(true);
    await api.open({ route: 'home' });
    await api.quit();
    await api.close();
    expect(invoked).toEqual([
      { channel: WIDGET_CHANNEL, message: { action: 'open', route: 'inbox', target: PERSON } },
      { channel: WIDGET_CHANNEL, message: { action: 'open', route: 'home' } },
      { channel: WIDGET_CHANNEL, message: { action: 'quit' } },
      { channel: WIDGET_CHANNEL, message: { action: 'close' } },
    ]);
  });

  it('refuses unknown routes and odd targets without asking', async () => {
    const { api, invoked } = loadPreload({ value: true });
    await expect(api.open({ route: 'join' })).resolves.toBe(false);
    await expect(api.open(null)).resolves.toBe(false);
    await expect(api.open({ route: 'inbox', target: 'x'.repeat(200) })).resolves.toBe(false);
    await expect(api.open({ route: 'inbox', target: 5 })).resolves.toBe(false);
    expect(invoked).toEqual([]);
  });

  it('answers only booleans, never rejects', async () => {
    const odd = loadPreload({ value: true }, { secret: 1 });
    await expect(odd.api.quit()).resolves.toBe(false);
    const failing = loadPreload({ value: true }, new Error('no'));
    await expect(failing.api.close()).resolves.toBe(false);
  });

  it('one call at a time', async () => {
    const held = loadPreload({ value: true }, 'hold');
    const first = held.api.close();
    await expect(held.api.quit()).resolves.toBe(false);
    held.release();
    await expect(first).resolves.toBe(true);
    expect(held.invoked).toHaveLength(1);
  });
});
