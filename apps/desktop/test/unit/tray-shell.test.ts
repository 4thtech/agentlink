// TRAY-SHELL (D-155; 08 §8; b11 §25.4): the menu bar icon, the popover and the icon switch wired
// into runShell (src/main/main.ts) with a fake Electron. The tray-state / tray-pulse / shell-prefs
// pipe messages drive the icon; the left click toggles the popover; the right click pops the
// minimal menu; the popover's requests go through the session's popover backstop.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ElectronModule, IpcMainInvokeEvent } from '../../src/main/electron-api.js';
import {
  menuBarIconFromSettings,
  readMenuBarIconPref,
  runShell,
  type ShellProcess,
} from '../../src/main/main.js';
import { popoverFallbackUrl } from '../../src/main/popover-page.js';
import { WINDOW_PARTITION } from '../../src/main/security.js';
import { statusPageUrl } from '../../src/main/status-page.js';
import { TRAY_COPY } from '../../src/main/tray.js';
import type { TrayFrames } from '../../src/main/tray-frames.js';
import { WIDGET_CHANNEL } from '../../src/main/widget-ipc.js';
import {
  FakeBrowserWindow,
  FakeEvent,
  FakeTimers,
  FakeTray,
  TOKEN,
  fakeElectron,
  fakeSpawn,
  readyLine,
  type FakeElectron,
  type FakeMenu,
} from './fakes.js';

const EXE = '/Applications/AgentLink.app/Contents/MacOS/AgentLink';
const RES = '/Applications/AgentLink.app/Contents/Resources';
const ORIGIN = 'http://localhost:4567';
const WIDGET = `${ORIGIN}/settings/widget`;

const logDirs: string[] = [];
afterEach(() => {
  for (const dir of logDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const seq = (frames: string[], loop = false) => ({ frames, frameMs: 40, loop });
/** Fake frames: the image is the frame id itself, so the test reads what the icon shows. */
const FRAMES = {
  sequences: {
    'msg-in': seq(['in-1', 'in-2', 'in-3']),
    'msg-out': seq(['out-1', 'out-2', 'out-3']),
    approval: seq(['grow-1', 'grow-2', 'grow-3']),
    connecting: seq(['tray-connecting-01', 'tray-connecting-02'], true),
    fades: {},
  },
  isMac: true,
  image: (id: string) => ({ id, isEmpty: () => false, setTemplateImage: () => undefined }),
} as unknown as TrayFrames;

interface Setup {
  electron: FakeElectron;
  children: ReturnType<typeof fakeSpawn>['children'];
  proc: ShellProcess;
  timers: FakeTimers;
  handlers: Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>;
}

function setup(over: Partial<ShellProcess> = {}, platform = 'darwin'): Setup {
  const logDir = join(mkdtempSync(join(tmpdir(), 'agentlink-tray-shell-')), 'Logs');
  logDirs.push(join(logDir, '..'));
  const electron = fakeElectron();
  const handlers: Setup['handlers'] = new Map();
  const display = {
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 25, width: 1440, height: 800 },
  };
  Object.assign(electron as unknown as Record<string, unknown>, {
    ipcMain: {
      handle: (
        channel: string,
        listener: Setup['handlers'] extends Map<string, infer L> ? L : never,
      ) => handlers.set(channel, listener),
    },
    screen: {
      getDisplayMatching: () => display,
      getDisplayNearestPoint: () => display,
      getPrimaryDisplay: () => display,
      getCursorScreenPoint: () => ({ x: 700, y: 400 }),
    },
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
  });
  const { spawn, children } = fakeSpawn();
  const timers = new FakeTimers();
  const proc: ShellProcess = {
    argv: [EXE],
    execArgv: [],
    env: { HOME: '/Users/x', PATH: '/usr/bin' },
    platform,
    execPath: EXE,
    resourcesPath: RES,
    homeDir: '/Users/x',
    tmpDir: '/var/folders/ab/T',
    writable: () => true,
    exists: () => true,
    spawn,
    timers,
    preview: null,
    logDir,
    trayFrames: () => FRAMES,
    ...over,
  };
  return { electron, children, proc, timers, handlers };
}

const tray = (): FakeTray => {
  const live = FakeTray.created.filter((t) => !t.destroyed);
  const last = live.at(-1);
  if (last === undefined) throw new Error('no tray');
  return last;
};
/** The frame id the icon shows now. */
const icon = (): string | undefined => (tray().images.at(-1) as { id?: string } | undefined)?.id;
const mainWindow = (): FakeBrowserWindow => FakeBrowserWindow.created[0] as FakeBrowserWindow;
const popoverWindow = (): FakeBrowserWindow | undefined => FakeBrowserWindow.created[1];
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const state = (link: string, unread = 0, approvals = 0): string =>
  line({ v: 1, type: 'tray-state', link, unread, approvals });
const pulse = (kind: string): string => line({ v: 1, type: 'tray-pulse', kind });
const prefs = (menuBarIcon: boolean, motion = 'system'): string =>
  line({ v: 1, type: 'shell-prefs', menuBarIcon, motion });

/** Starts the shell, sends `ready` and lets the main window finish loading the session link. */
async function started(s: Setup): Promise<void> {
  await runShell(s.electron as unknown as ElectronModule, s.proc);
  s.children[0]?.stream.push(readyLine());
  await flush();
}

describe('TRAY-SHELL clicks', () => {
  it('left click toggles the popover (fixed page before ready); right click pops Open / Quit', async () => {
    const s = setup();
    await runShell(s.electron, s.proc);
    expect(tray().menu).toBeNull();
    tray().emit('click');
    expect(popoverWindow()?.visible).toBe(true);
    expect(popoverWindow()?.loaded.at(-1)).toBe(popoverFallbackUrl());
    tray().emit('click');
    expect(popoverWindow()?.visible).toBe(false);
    tray().emit('right-click');
    const menu = tray().popped.at(-1) as FakeMenu;
    expect(menu.template.map((i) => i.label ?? i.type)).toEqual([
      TRAY_COPY.open,
      'separator',
      TRAY_COPY.quit,
    ]);
  });

  it('Linux keeps the native menu (Open, Try again, Quit) and no popover', async () => {
    const s = setup({}, 'linux');
    await runShell(s.electron, s.proc);
    const menu = tray().menu as FakeMenu;
    expect(menu.template.map((i) => i.label ?? i.type)).toEqual([
      TRAY_COPY.open,
      TRAY_COPY.retry,
      'separator',
      TRAY_COPY.quit,
    ]);
    tray().emit('click');
    expect(popoverWindow()).toBeUndefined();
  });

  it('with the core failed a click opens the main window’s status page, not the popover', async () => {
    const s = setup();
    await runShell(s.electron, s.proc);
    s.children[0]?.stream.push('{"v":1,"type":"stopped","reason":"keychain"}\n');
    s.children[0]?.exit(1);
    mainWindow().hide();
    tray().emit('click');
    expect(popoverWindow()?.visible ?? false).toBe(false);
    expect(mainWindow().visible).toBe(true);
    expect(mainWindow().loaded.at(-1)).toBe(statusPageUrl('keychain'));
  });

  it('registers the widget IPC channel', async () => {
    const s = setup();
    await runShell(s.electron, s.proc);
    expect(s.handlers.has(WIDGET_CHANNEL)).toBe(true);
  });
});

describe('TRAY-SHELL popover session', () => {
  it('a POST from the popover’s web contents is cancelled; the main window’s passes', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    const session = s.electron.sessions.get(WINDOW_PARTITION);
    const send = (webContentsId: number): boolean | undefined => {
      let cancel: boolean | undefined;
      session?.beforeSendHeaders?.(
        {
          method: 'POST',
          url: `${ORIGIN}/api/ui/approvals/apr_1/approve`,
          requestHeaders: {},
          webContentsId,
        } as never,
        (r) => {
          cancel = r.cancel === true;
        },
      );
      return cancel;
    };
    expect(send(popoverWindow()?.webContents.id ?? -1)).toBe(true);
    expect(send(mainWindow().webContents.id)).toBe(false);
  });

  it('loads the widget once the main window loaded a session link; a new core → the fixed page', async () => {
    const s = setup();
    await runShell(s.electron, s.proc);
    tray().emit('click');
    expect(popoverWindow()?.loaded.at(-1)).toBe(popoverFallbackUrl());
    s.children[0]?.stream.push(readyLine());
    await flush();
    expect(popoverWindow()?.loaded.at(-1)).toBe(WIDGET);
    s.children[0]?.exit(1);
    s.timers.advance(30_000);
    expect(s.children).toHaveLength(2);
    expect(popoverWindow()?.loaded.at(-1)).toBe(popoverFallbackUrl());
  });

  it('a blocked redirect (ERR_ABORTED) or a failed load of the widget → the fixed page', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    const contents = popoverWindow()?.webContents;
    expect(popoverWindow()?.loaded.at(-1)).toBe(WIDGET);
    expect(contents?.navigate('will-redirect', `${ORIGIN}/first-run`)).toBe(true);
    contents?.emit('did-fail-load', new FakeEvent(), -3, 'ERR_ABORTED', WIDGET, true);
    expect(popoverWindow()?.loaded.at(-1)).toBe(popoverFallbackUrl());

    // A fresh session link brings the widget back; then a plain failed load.
    s.children[0]?.stream.push(readyLine());
    await flush();
    expect(popoverWindow()?.loaded.at(-1)).toBe(WIDGET);
    contents?.emit('did-fail-load', new FakeEvent(), -102, 'ERR_CONNECTION_REFUSED', WIDGET, true);
    expect(popoverWindow()?.loaded.at(-1)).toBe(popoverFallbackUrl());
  });

  it('a plain ERR_ABORTED (a newer load replaced it) keeps the widget', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    popoverWindow()?.webContents.emit('did-fail-load', new FakeEvent(), -3, 'x', WIDGET, true);
    expect(popoverWindow()?.loaded.at(-1)).toBe(WIDGET);
  });

  it('the popover hides when the main window is shown or focused', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    expect(popoverWindow()?.visible).toBe(true);
    mainWindow().emit('focus');
    expect(popoverWindow()?.visible).toBe(false);
    tray().emit('click');
    expect(popoverWindow()?.visible).toBe(true);
    s.electron.app.emit('activate');
    expect(popoverWindow()?.visible).toBe(false);
  });

  it('Cmd+Q (exactly) in the popover quits; every other Cmd / Ctrl combination is swallowed', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    const press = (input: Record<string, unknown>): boolean => {
      const event = new FakeEvent();
      popoverWindow()?.webContents.emit('before-input-event', event, { type: 'keyDown', ...input });
      return event.defaultPrevented;
    };
    // Menu accelerators never act in the popover: reload, zoom, close, Ctrl variants.
    expect(press({ key: 'r', meta: true })).toBe(true);
    expect(press({ key: '=', meta: true })).toBe(true);
    expect(press({ key: 'w', meta: true })).toBe(true);
    expect(press({ key: 'r', control: true })).toBe(true);
    // Cmd+Shift+Q and Cmd+Alt+Q are swallowed, not a quit.
    expect(press({ key: 'Q', meta: true, shift: true })).toBe(true);
    expect(press({ key: 'q', meta: true, alt: true })).toBe(true);
    expect(s.electron.app.quitCalls).toBe(0);
    // Plain keys pass (Escape is the popover's own and hides it).
    expect(press({ key: 'q' })).toBe(false);
    expect(press({ key: 'q', meta: true })).toBe(true);
    expect(s.electron.app.quitCalls).toBe(1);
  });

  it('Windows: Ctrl combinations are swallowed and never quit', async () => {
    const s = setup({}, 'win32');
    await started(s);
    tray().emit('click');
    const event = new FakeEvent();
    popoverWindow()?.webContents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'q',
      control: true,
    });
    expect(event.defaultPrevented).toBe(true);
    expect(s.electron.app.quitCalls).toBe(0);
  });

  it('a blocked redirect ending in did-fail-provisional-load → the fixed page', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    const contents = popoverWindow()?.webContents;
    expect(contents?.navigate('will-redirect', `${ORIGIN}/first-run`)).toBe(true);
    contents?.emit('did-fail-provisional-load', new FakeEvent(), -3, 'ERR_ABORTED', WIDGET, true);
    expect(popoverWindow()?.loaded.at(-1)).toBe(popoverFallbackUrl());
  });

  it('a blocked redirect ending only in a rejected load → the fixed page', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    const win = popoverWindow() as FakeBrowserWindow;
    expect(win.webContents.navigate('will-redirect', `${ORIGIN}/first-run`)).toBe(true);
    // No fail event at all: the widget's (re)load is rejected (cancelled).
    win.loadError = new Error('ERR_ABORTED (-3)');
    s.children[0]?.stream.push(readyLine());
    await flush();
    await flush();
    expect(win.loaded.at(-1)).toBe(popoverFallbackUrl());
  });

  it('a rejected load without a blocked redirect keeps the widget', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    const win = popoverWindow() as FakeBrowserWindow;
    win.loadError = new Error('ERR_ABORTED (-3)');
    s.children[0]?.stream.push(readyLine());
    await flush();
    await flush();
    expect(win.loaded.at(-1)).toBe(WIDGET);
  });
});

describe('TRAY-SHELL icon', () => {
  it('tray-state drives the engine; the update variant comes from the shell’s release check', async () => {
    let onChange: ((view: never) => void) | undefined;
    const checker = {
      view: () => ({ state: 'current', current: '0.5.9', latest: '', download: '' }),
      start: () => Promise.resolve(),
      check: () => Promise.resolve(),
    };
    const s = setup({
      releaseChecker: (_e, change) => {
        onChange = change as (view: never) => void;
        return checker as never;
      },
    });
    await started(s);
    expect(icon()).toBe('tray-connecting-01');
    s.children[0]?.stream.push(state('connected', 2, 0));
    expect(icon()).toBe('tray-connected-unread');
    s.children[0]?.stream.push(state('connected', 2, 1));
    expect(icon()).toBe('tray-approvals');
    s.children[0]?.stream.push(state('paused', 0, 0));
    expect(icon()).toBe('tray-paused');
    s.children[0]?.stream.push(state('connected', 0, 0));
    expect(icon()).toBe('tray-connected');
    onChange?.({
      state: 'available',
      current: '0.5.9',
      latest: '0.6.0',
      download:
        'https://github.com/4thtech/agentlink/releases/download/v0.6.0/AgentLink-mac-arm64.dmg',
    } as never);
    expect(icon()).toBe('tray-update');
  });

  it('re-applies the last full tray-state after a pulse settles', async () => {
    const s = setup();
    await started(s);
    s.children[0]?.stream.push(state('connected', 0, 0));
    s.children[0]?.stream.push(pulse('approval'));
    expect(icon()).toBe('grow-1');
    s.timers.advance(2_000);
    // The engine's own pulse sets the approvals variant; the core said none are waiting.
    expect(icon()).toBe('tray-connected');
    s.children[0]?.stream.push(pulse('ai_sent'));
    expect(icon()).toBe('out-1');
    s.timers.advance(2_000);
    expect(icon()).toBe('tray-connected');
  });

  it('opening the popover clears the ring until more messages come in', async () => {
    const s = setup();
    await started(s);
    s.children[0]?.stream.push(state('connected', 2, 0));
    expect(icon()).toBe('tray-connected-unread');
    tray().emit('click');
    expect(icon()).toBe('tray-connected');
    // Another signal re-applies the state: the ring stays off for the same unread count.
    s.children[0]?.stream.push(pulse('ai_sent'));
    s.timers.advance(2_000);
    expect(icon()).toBe('tray-connected');
    s.children[0]?.stream.push(state('connected', 3, 0));
    expect(icon()).toBe('tray-connected-unread');
  });

  it('a new core resets the feed: the same state after a restart is applied again', async () => {
    const s = setup();
    await started(s);
    s.children[0]?.stream.push(state('connected', 0, 1));
    expect(icon()).toBe('tray-approvals');
    s.children[0]?.exit(1);
    s.timers.advance(30_000);
    expect(icon()).toMatch(/^tray-connecting-/);
    s.children[1]?.stream.push(readyLine());
    s.children[1]?.stream.push(state('connected', 0, 1));
    expect(icon()).toBe('tray-approvals');
  });

  it('motion off: a pulse shows the end frame only', async () => {
    const s = setup();
    await started(s);
    s.children[0]?.stream.push(prefs(true, 'off'));
    s.children[0]?.stream.push(state('connected', 0, 0));
    const before = tray().images.length;
    s.children[0]?.stream.push(pulse('message_in'));
    const shown = tray()
      .images.slice(before)
      .map((i) => (i as { id: string }).id);
    expect(shown.some((id) => id.startsWith('in-'))).toBe(false);
  });
});

describe('TRAY-SHELL icon switch', () => {
  it('menuBarIcon false removes the tray and closes the popover; true brings it back with the state', async () => {
    const s = setup();
    await started(s);
    s.children[0]?.stream.push(state('connected', 0, 1));
    tray().emit('click');
    expect(popoverWindow()?.visible).toBe(true);
    s.children[0]?.stream.push(prefs(false));
    expect(FakeTray.created.every((t) => t.destroyed)).toBe(true);
    expect(popoverWindow()?.visible).toBe(false);
    s.children[0]?.stream.push(prefs(true));
    expect(FakeTray.created).toHaveLength(2);
    expect(icon()).toBe('tray-approvals');
  });

  it('Windows: while the icon is hidden, closing the window quits; otherwise it hides', async () => {
    const s = setup({}, 'win32');
    await started(s);
    const close = (): FakeEvent => {
      const event = new FakeEvent();
      mainWindow().emit('close', event);
      return event;
    };
    expect(close().defaultPrevented).toBe(true);
    expect(s.electron.app.quitCalls).toBe(0);
    s.children[0]?.stream.push(prefs(false));
    close();
    expect(s.electron.app.quitCalls).toBe(1);
  });

  it('Windows: turning the icon off while the window is hidden brings the window up', async () => {
    const s = setup({}, 'win32');
    await started(s);
    mainWindow().hide();
    s.children[0]?.stream.push(prefs(false));
    expect(mainWindow().visible).toBe(true);
  });

  it('macOS: turning the icon off leaves a hidden window hidden (the Dock is the way back)', async () => {
    const s = setup();
    await started(s);
    mainWindow().hide();
    s.children[0]?.stream.push(prefs(false));
    expect(mainWindow().visible).toBe(false);
  });

  it('quit clears the pending re-apply timer', async () => {
    const s = setup();
    await started(s);
    s.children[0]?.stream.push(state('connected', 0, 0));
    const before = new Set(s.timers.pending.keys());
    s.children[0]?.stream.push(pulse('ai_sent'));
    // The re-apply timer is the latest one the pulse added (the frame timers come first).
    const added = [...s.timers.pending.entries()].filter(([id]) => !before.has(id));
    const reapply = added.sort((a, b) => b[1].at - a[1].at)[0]?.[0];
    expect(reapply).toBeDefined();
    s.electron.app.emit('before-quit', new FakeEvent());
    expect(s.timers.pending.has(reapply as number)).toBe(false);
  });

  it('macOS: with the icon hidden, closing the window still only hides it (the Dock stays)', async () => {
    const s = setup();
    await started(s);
    s.children[0]?.stream.push(prefs(false));
    const event = new FakeEvent();
    mainWindow().emit('close', event);
    expect(event.defaultPrevented).toBe(true);
    expect(s.electron.app.quitCalls).toBe(0);
  });

  it('the last known switch read from disk at launch: no icon flash when it is off', async () => {
    const s = setup({ menuBarIconPref: () => false });
    await runShell(s.electron, s.proc);
    expect(FakeTray.created).toHaveLength(0);
    s.children[0]?.stream.push(readyLine());
    s.children[0]?.stream.push(prefs(true));
    expect(FakeTray.created).toHaveLength(1);
  });

  it('menuBarIconFromSettings reads only the one boolean, strictly', () => {
    expect(menuBarIconFromSettings('{"v":1,"settings":{"menuBarIcon":false}}')).toBe(false);
    expect(menuBarIconFromSettings('{"v":1,"settings":{"menuBarIcon":true}}')).toBe(true);
    expect(menuBarIconFromSettings('{"v":1,"settings":{}}')).toBe(true);
    expect(menuBarIconFromSettings('{"v":2,"settings":{"menuBarIcon":false}}')).toBeUndefined();
    expect(menuBarIconFromSettings('{"v":1,"settings":{"menuBarIcon":"no"}}')).toBeUndefined();
    expect(menuBarIconFromSettings('not json')).toBeUndefined();
    expect(menuBarIconFromSettings('[]')).toBeUndefined();
  });

  it('readMenuBarIconPref refuses a link on Windows, after the open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-pref-'));
    try {
      const path = join(dir, 'ui-settings.json');
      writeFileSync(path, '{"v":1,"settings":{"menuBarIcon":false}}');
      const link = { isSymbolicLink: () => true };
      const plain = { isSymbolicLink: () => false };
      expect(readMenuBarIconPref(path, 'win32', () => link)).toBeUndefined();
      expect(readMenuBarIconPref(path, 'win32', () => plain)).toBe(false);
      // Other systems rely on O_NOFOLLOW at the open and never consult lstat.
      expect(readMenuBarIconPref(path, 'darwin', () => link)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DESK-QUIT-ORDER and DESK-WIDGET-OPEN (main)', () => {
  const PERSON = `0x${'ab'.repeat(20)}`;
  const APPROVAL = `apr_${'A'.repeat(22)}`;
  /** Started, the popover up on the widget page, the main window hidden. */
  async function withWidget(): Promise<Setup> {
    const s = setup();
    await started(s);
    tray().emit('click');
    expect(popoverWindow()?.loaded.at(-1)).toBe(WIDGET);
    mainWindow().hide();
    return s;
  }
  const invoke = (s: Setup, input: unknown): Promise<unknown> | undefined =>
    s.handlers.get(WIDGET_CHANNEL)?.(
      {
        sender: { id: popoverWindow()?.webContents.id ?? -1 },
        senderFrame: { url: WIDGET, parent: null },
      } as IpcMainInvokeEvent,
      input,
    );
  const sent = (s: Setup): unknown[] =>
    (s.children[0]?.stream.written ?? []).map((l) => JSON.parse(l) as unknown);

  it('quit hides the popover and the main window before the core is stopped', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    expect(popoverWindow()?.visible).toBe(true);
    expect(mainWindow().visible).toBe(true);
    s.electron.app.emit('before-quit', new FakeEvent());
    // Synchronously, while the core is still stopping: nothing of the page is on screen.
    expect(s.children[0]?.exitCode).toBeNull();
    expect(mainWindow().visible).toBe(false);
    expect(popoverWindow()?.visible).toBe(false);
  });

  it('a main-window focus does not hide the popover; a main-window show does', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    mainWindow().emit('focus');
    expect(popoverWindow()?.visible).toBe(true);
    mainWindow().emit('show');
    expect(popoverWindow()?.visible).toBe(false);
  });

  it('showing the popover on macOS brings AgentLink forward', async () => {
    const s = setup();
    await started(s);
    tray().emit('click');
    expect(s.electron.app.focusCalls).toEqual([{ steal: true }]);
  });

  it('a targeted open shows the main window only once the new page loaded', async () => {
    const s = await withWidget();
    await expect(invoke(s, { action: 'open', route: 'inbox', target: PERSON })).resolves.toBe(true);
    expect(sent(s)).toContainEqual({ v: 1, type: 'show', route: 'inbox', target: PERSON });
    expect(mainWindow().visible).toBe(false);
    s.children[0]?.stream.push(readyLine(`${ORIGIN}/?t=${TOKEN}#person=${PERSON}`));
    expect(mainWindow().visible).toBe(false);
    await flush();
    expect(mainWindow().visible).toBe(true);
    expect(mainWindow().loaded.at(-1)).toBe(`${ORIGIN}/?t=${TOKEN}#person=${PERSON}`);
  });

  it('a targeted approval open waits for its page too', async () => {
    const s = await withWidget();
    await expect(invoke(s, { action: 'open', route: 'approvals', target: APPROVAL })).resolves.toBe(
      true,
    );
    // The core maps it to the existing /approve/<id> page.
    expect(sent(s)).toContainEqual({ v: 1, type: 'show', route: 'approvals', target: APPROVAL });
    expect(mainWindow().visible).toBe(false);
    s.children[0]?.stream.push(readyLine(`${ORIGIN}/approve/${APPROVAL}?t=${TOKEN}`));
    await flush();
    expect(mainWindow().visible).toBe(true);
  });

  it('a targeted open with no answer from the core still shows the window', async () => {
    const s = await withWidget();
    await invoke(s, { action: 'open', route: 'inbox', target: PERSON });
    expect(mainWindow().visible).toBe(false);
    s.timers.advance(5_000);
    expect(mainWindow().visible).toBe(true);
  });

  it('an untargeted open shows the main window at once (unchanged)', async () => {
    const s = await withWidget();
    await expect(invoke(s, { action: 'open', route: 'home' })).resolves.toBe(true);
    expect(mainWindow().visible).toBe(true);
  });

  it('bad target ids are refused and nothing opens', async () => {
    const s = await withWidget();
    for (const input of [
      { action: 'open', route: 'inbox', target: 'apr_x' },
      { action: 'open', route: 'approvals', target: PERSON },
      { action: 'open', route: 'approvals', target: `${APPROVAL}x` },
      { action: 'open', route: 'inbox', target: PERSON, file: 'abc.01' },
    ]) {
      await expect(invoke(s, input)).resolves.toBe(false);
    }
    expect(sent(s).filter((m) => (m as { type?: string }).type === 'show')).toEqual([]);
    expect(mainWindow().visible).toBe(false);
  });
});
