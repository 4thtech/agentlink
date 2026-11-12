// The minimal tray (src/main/tray.ts) and the main window (src/main/window.ts).
import { describe, expect, it } from 'vitest';
import { AppTray, TRAY_COPY, trayTooltip } from '../../src/main/tray.js';
import { OriginLock } from '../../src/main/security.js';
import { MainWindow } from '../../src/main/window.js';
import {
  FakeBrowserWindow,
  FakeEvent,
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

  it('has Open and Quit only', () => {
    const electron = fakeElectron();
    let opened = 0;
    let quit = 0;
    const tray = new AppTray(electron, '/icon.png', {
      open: () => {
        opened += 1;
      },
      quit: () => {
        quit += 1;
      },
    });
    const fake = FakeTray.created[0];
    const menu = fake?.menu as FakeMenu;
    expect(menu.template.map((i) => i.label ?? i.type)).toEqual([
      TRAY_COPY.open,
      'separator',
      TRAY_COPY.quit,
    ]);
    menu.template[0]?.click?.();
    menu.template[2]?.click?.();
    fake?.emit('click');
    expect([opened, quit]).toEqual([2, 1]);
    tray.update('running', 2);
    expect(fake?.tooltip).toBe('AgentLink: Running · 2 waiting');
  });
});

describe('MainWindow', () => {
  const make = (quitting = false): { window: MainWindow; lock: OriginLock } => {
    const electron = fakeElectron();
    const lock = new OriginLock();
    const window = new MainWindow({
      BrowserWindow: electron.BrowserWindow,
      shell: electron.shell,
      lock,
      platform: 'darwin',
      quitting: () => quitting,
    });
    return { window, lock };
  };

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
