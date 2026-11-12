// The minimal tray (src/main/tray.ts) and the main window (src/main/window.ts).
import { describe, expect, it } from 'vitest';
import {
  AppTray,
  BUILTIN_TRAY_PNG,
  TRAY_COPY,
  trayImage,
  trayTooltip,
} from '../../src/main/tray.js';
import { OriginLock } from '../../src/main/security.js';
import {
  STATUS_ACTION_URLS,
  statusPageUrl,
  type StatusAction,
} from '../../src/main/status-page.js';
import { MainWindow } from '../../src/main/window.js';
import {
  FakeBrowserWindow,
  FakeEvent,
  FakeNativeImage,
  FakeTray,
  SESSION_URL,
  TOKEN,
  fakeElectron,
  type FakeMenu,
} from './fakes.js';

describe('tray', () => {
  it('shows a state word and numbers only', () => {
    expect(trayTooltip('running', 0)).toBe('AgentLink: Running');
    expect(trayTooltip('running', 3)).toBe('AgentLink: Running · 3 waiting');
    expect(trayTooltip('failed', 0)).toBe('AgentLink: Not running');
    expect(trayTooltip('closing', Number.NaN)).toBe('AgentLink: Closing');
  });

  it('has Open, Try again and Quit only', () => {
    const electron = fakeElectron();
    let opened = 0;
    let quit = 0;
    let retried = 0;
    const tray = new AppTray(electron, '/icon.png', {
      open: () => {
        opened += 1;
      },
      retry: () => {
        retried += 1;
      },
      quit: () => {
        quit += 1;
      },
    });
    const fake = FakeTray.created[0];
    const menu = fake?.menu as FakeMenu;
    expect(menu.template.map((i) => i.label ?? i.type)).toEqual([
      TRAY_COPY.open,
      TRAY_COPY.retry,
      'separator',
      TRAY_COPY.quit,
    ]);
    menu.template[0]?.click?.();
    menu.template[1]?.click?.();
    menu.template[3]?.click?.();
    fake?.emit('click');
    expect([opened, retried, quit]).toEqual([2, 1, 1]);
    tray.update('running', 2);
    expect(fake?.tooltip).toBe('AgentLink: Running · 2 waiting');
  });
});

describe('trayImage', () => {
  it('uses the icon file when it exists', () => {
    const electron = fakeElectron();
    electron.imageFiles.add('/res/assets/trayTemplate.png');
    const image = trayImage(electron.nativeImage, '/res/assets/trayTemplate.png', 'darwin');
    expect((image as FakeNativeImage).source).toBe('/res/assets/trayTemplate.png');
    expect((image as FakeNativeImage).template).toBe(true);
  });

  it('falls back to the built-in template image when the file is missing or unreadable', () => {
    const electron = fakeElectron();
    const image = trayImage(electron.nativeImage, '/missing.png', 'darwin') as FakeNativeImage;
    expect(image.source).toBe(`buffer:${BUILTIN_TRAY_PNG.length}`);
    expect(image.scaleFactor).toBe(2);
    expect(image.template).toBe(true);
    expect(image.isEmpty()).toBe(false);
  });

  it('the built-in image is a PNG; template only on macOS', () => {
    expect([...BUILTIN_TRAY_PNG.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const electron = fakeElectron();
    const image = trayImage(electron.nativeImage, '/missing.ico', 'win32') as FakeNativeImage;
    expect(image.template).toBe(false);
  });

  it('a tray is created with the image', () => {
    const electron = fakeElectron();
    const image = trayImage(electron.nativeImage, '/missing.png', 'darwin');
    new AppTray(electron, image, {
      open: () => undefined,
      retry: () => undefined,
      quit: () => undefined,
    });
    expect(FakeTray.created[0]?.icon).toBe(image);
  });
});

describe('MainWindow', () => {
  const make = (
    quitting = false,
  ): { window: MainWindow; lock: OriginLock; actions: StatusAction[] } => {
    const electron = fakeElectron();
    const lock = new OriginLock();
    const actions: StatusAction[] = [];
    const window = new MainWindow({
      BrowserWindow: electron.BrowserWindow,
      shell: electron.shell,
      lock,
      platform: 'darwin',
      quitting: () => quitting,
      onStatusAction: (action) => actions.push(action),
    });
    return { window, lock, actions };
  };

  it('shows the local status page at once, without touching the origin lock', () => {
    const { window, lock } = make();
    window.showStatus('starting');
    const fake = FakeBrowserWindow.created[0];
    expect(fake?.loaded).toEqual([statusPageUrl('starting')]);
    expect(fake?.visible).toBe(true);
    expect(fake?.options.webPreferences.sandbox).toBe(true);
    expect(lock.origin).toBeNull();
    expect(window.page).toBe('status');
    expect(window.loaded).toBe(false);
    window.showStatus('starting');
    expect(fake?.loaded).toHaveLength(1);
  });

  it('puts the AgentLinkDesktop/1 marker on the window user agent once (Touch ID UI)', () => {
    const { window } = make();
    window.showStatus('starting');
    const fake = FakeBrowserWindow.created.at(-1);
    const ua = fake?.webContents.userAgent ?? '';
    expect(ua.endsWith(' AgentLinkDesktop/1 (passkey=browser)')).toBe(true);
    expect(ua.match(/AgentLinkDesktop\/1/g)).toHaveLength(1);
  });

  it('switches from the status page to the session link on ready (one window)', () => {
    const { window, lock } = make();
    window.showStatus('starting');
    expect(window.loadSessionUrl(SESSION_URL)).toBe(true);
    expect(FakeBrowserWindow.created).toHaveLength(1);
    expect(FakeBrowserWindow.created[0]?.loaded).toEqual([statusPageUrl('starting'), SESSION_URL]);
    expect(lock.origin).toBe('http://localhost:4567');
    expect(window.page).toBe('session');
  });

  it('the status page buttons reach the shell; navigation never happens', () => {
    const { window, actions } = make();
    window.showStatus('exited');
    const contents = FakeBrowserWindow.created[0]?.webContents;
    expect(contents?.navigate('will-navigate', STATUS_ACTION_URLS['try-again'])).toBe(true);
    expect(contents?.navigate('will-navigate', STATUS_ACTION_URLS['open-log-folder'])).toBe(true);
    expect(contents?.navigate('will-navigate', 'http://agentlink.invalid/other')).toBe(true);
    expect(contents?.navigate('will-redirect', STATUS_ACTION_URLS['try-again'])).toBe(true);
    expect(actions).toEqual(['try-again', 'open-log-folder']);
  });

  it('the session page cannot trigger the status actions', () => {
    const { window, actions } = make();
    window.showStatus('starting');
    window.loadSessionUrl(SESSION_URL);
    const contents = FakeBrowserWindow.created[0]?.webContents;
    expect(contents?.navigate('will-navigate', STATUS_ACTION_URLS['try-again'])).toBe(true);
    expect(actions).toEqual([]);
  });

  it('a page that is not the fixed status page cannot trigger them either', () => {
    const { window, actions } = make();
    window.showStatus('exited');
    const contents = FakeBrowserWindow.created[0]?.webContents;
    if (contents !== undefined) contents.url = 'data:text/html,<a href=x>';
    contents?.navigate('will-navigate', STATUS_ACTION_URLS['try-again']);
    expect(actions).toEqual([]);
  });

  it('a failure page replaces the session page and the old origin is unlocked', () => {
    const { window, lock } = make();
    window.loadSessionUrl(SESSION_URL);
    window.resetForNewCore();
    window.showStatus('retries');
    expect(lock.origin).toBeNull();
    expect(window.page).toBe('status');
    expect(window.loaded).toBe(false);
    expect(FakeBrowserWindow.created[0]?.loaded.at(-1)).toBe(statusPageUrl('retries'));
  });

  it('creates no window until the core sends a valid link', () => {
    const { window } = make();
    expect(window.loadSessionUrl('https://evil.example/')).toBe(false);
    expect(window.loadSessionUrl(`http://localhost:1/?t=short`)).toBe(false);
    expect(FakeBrowserWindow.created).toHaveLength(0);
    expect(window.show()).toBe(false);
  });

  it('loads the link, locked down and hidden until ready', () => {
    const { window, lock } = make();
    expect(window.loadSessionUrl(SESSION_URL)).toBe(true);
    const fake = FakeBrowserWindow.created[0];
    expect(fake?.loaded).toEqual([SESSION_URL]);
    expect(fake?.options.show).toBe(false);
    expect(fake?.options.webPreferences.sandbox).toBe(true);
    expect(lock.origin).toBe('http://localhost:4567');
    expect(fake?.webContents.navigate('will-navigate', 'https://evil.example/')).toBe(true);
    fake?.emit('ready-to-show');
    expect(fake?.visible).toBe(true);
  });

  it('refuses a link on another origin until a new core', () => {
    const { window } = make();
    window.loadSessionUrl(SESSION_URL);
    const other = `http://localhost:9999/?t=${TOKEN}`;
    expect(window.loadSessionUrl(other)).toBe(false);
    window.resetForNewCore();
    expect(window.loadSessionUrl(other)).toBe(true);
    expect(FakeBrowserWindow.created[0]?.loaded).toEqual([SESSION_URL, other]);
  });

  it('keeps a fixed title and hides on close unless quitting', () => {
    const { window } = make();
    window.loadSessionUrl(SESSION_URL);
    const fake = FakeBrowserWindow.created[0];
    const title = new FakeEvent();
    fake?.emit('page-title-updated', title);
    expect(title.defaultPrevented).toBe(true);
    fake?.show();
    const close = new FakeEvent();
    fake?.emit('close', close);
    expect(close.defaultPrevented).toBe(true);
    expect(fake?.visible).toBe(false);
  });

  it('closes for real when quitting', () => {
    const { window } = make(true);
    window.loadSessionUrl(SESSION_URL);
    const close = new FakeEvent();
    FakeBrowserWindow.created[0]?.emit('close', close);
    expect(close.defaultPrevented).toBe(false);
  });
});
