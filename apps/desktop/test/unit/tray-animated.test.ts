// TRAY-ENGINE: AppTray with the animated frames (src/main/tray.ts), the API TRAY-SHELL wires.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppTray, TRAY_COPY, type TraySystem } from '../../src/main/tray.js';
import { TrayFrames, parseTrayManifest, type TrayImage } from '../../src/main/tray-frames.js';
import type { Menu, MenuItemOptions } from '../../src/main/electron-api.js';
import { ManualClock } from './tray-clock.js';

const ASSETS = resolve(__dirname, '..', '..', 'assets', 'tray');
const MANIFEST = parseTrayManifest(JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8')));

class Img implements TrayImage {
  template = false;
  constructor(readonly source: string) {}
  isEmpty(): boolean {
    return false;
  }
  setTemplateImage(t: boolean): void {
    this.template = t;
  }
  addRepresentation(): void {}
}

class Tray extends EventEmitter {
  static last: Tray | null = null;
  images: Img[] = [];
  tooltip = '';
  menu: Menu | null = null;
  popped: (Menu | undefined)[] = [];
  destroyed = false;
  constructor(readonly icon: unknown) {
    super();
    Tray.last = this;
  }
  setToolTip(t: string): void {
    this.tooltip = t;
  }
  setContextMenu(m: Menu): void {
    this.menu = m;
  }
  setImage(img: Img): void {
    this.images.push(img);
  }
  popUpContextMenu(m?: Menu): void {
    this.popped.push(m);
  }
  getBounds() {
    return { x: 10, y: 0, width: 24, height: 22 };
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const electron = {
  Tray,
  Menu: { buildFromTemplate: (template: MenuItemOptions[]) => ({ template }) as unknown as Menu },
};

function frames(platform: string) {
  return new TrayFrames({
    manifest: MANIFEST,
    dir: '/r',
    platform,
    nativeImage: {
      createFromPath: (p) => new Img(p),
      createFromBuffer: (_b, o) => new Img(`buffer:${o?.scaleFactor ?? 1}`),
    },
    readFile: (p) => new TextEncoder().encode(p),
    fallback: () => new Img('builtin'),
  });
}

function system(dark = true, reduced = false) {
  const theme = Object.assign(new EventEmitter(), { shouldUseDarkColorsForSystemIntegratedUI: dark });
  const prefs = { reduced, getAnimationSettings: () => ({ shouldRenderRichAnimation: true, prefersReducedMotion: prefs.reduced }) };
  const sys: TraySystem = { nativeTheme: theme, systemPreferences: prefs };
  return { sys, theme, prefs };
}

const last = (t: Tray) => t.images.at(-1)?.source ?? '';

describe('AppTray with frames', () => {
  it('left click calls click; right click pops the menu Open AgentLink / Quit', () => {
    const clock = new ManualClock();
    let clicked = 0;
    let opened = 0;
    let quit = 0;
    const { sys } = system();
    new AppTray(
      electron,
      '/icon.png',
      { open: () => (opened += 1), quit: () => (quit += 1), click: () => (clicked += 1) },
      { frames: frames('darwin'), system: sys, timers: clock, platform: 'darwin' },
    );
    const tray = Tray.last!;
    expect(tray.menu).toBeNull(); // a context menu would take the left click on macOS
    tray.emit('click');
    expect(clicked).toBe(1);
    expect(opened).toBe(0);
    tray.emit('right-click');
    const menu = tray.popped[0] as unknown as { template: MenuItemOptions[] };
    expect(menu.template.filter((i) => i.type !== 'separator').map((i) => i.label)).toEqual([
      TRAY_COPY.open,
      TRAY_COPY.quit,
    ]);
    (menu.template[0]!.click as () => void)();
    (menu.template.at(-1)!.click as () => void)();
    expect(opened).toBe(1);
    expect(quit).toBe(1);
  });

  it('macOS: template frames, connecting breathes, a pulse settles on the ring', () => {
    const clock = new ManualClock();
    const { sys } = system();
    const app = new AppTray(electron, '/icon.png', { open: () => {}, quit: () => {}, click: () => {} }, {
      frames: frames('darwin'),
      system: sys,
      timers: clock,
      platform: 'darwin',
    });
    const tray = Tray.last!;
    expect(last(tray)).toContain('connecting-0Template.png');
    expect(tray.images.every((i) => i.template)).toBe(true);
    clock.advance(40);
    expect(last(tray)).toContain('connecting-1Template.png');
    app.setIndicator({ state: 'connected' });
    expect(last(tray)).toContain('tray-connectedTemplate.png');
    app.pulse('msg-in');
    clock.advance(2000);
    expect(last(tray)).toContain('tray-connected-unreadTemplate.png');
    app.clearUnread();
    expect(last(tray)).toContain('tray-connectedTemplate.png');
    expect(app.getBounds()).toEqual({ x: 10, y: 0, width: 24, height: 22 });
  });

  it('Windows: follows the taskbar theme when nativeTheme updates', () => {
    const clock = new ManualClock();
    const { sys, theme } = system(true);
    const app = new AppTray(electron, 'x.ico', { open: () => {}, quit: () => {}, click: () => {} }, {
      frames: frames('win32'),
      system: sys,
      timers: clock,
      platform: 'win32',
      initial: { state: 'connected' },
    });
    const tray = Tray.last!;
    const darkImg = tray.images.at(-1)!;
    expect(darkImg.template).toBe(false);
    theme.shouldUseDarkColorsForSystemIntegratedUI = false;
    theme.emit('updated');
    expect(tray.images.at(-1)).not.toBe(darkImg);
    expect(tray.images.length).toBe(2);
    app.destroy();
    expect(theme.listenerCount('updated')).toBe(0);
    expect(tray.destroyed).toBe(true);
  });

  it('reduced motion (system or the app setting): static only, no timers', () => {
    const clock = new ManualClock();
    const { sys, prefs, theme } = system(true, true);
    const app = new AppTray(electron, '/i', { open: () => {}, quit: () => {}, click: () => {} }, {
      frames: frames('darwin'),
      system: sys,
      timers: clock,
      platform: 'darwin',
    });
    expect(clock.pendingCount).toBe(0);
    prefs.reduced = false;
    theme.emit('updated'); // the system settings are read again
    expect(clock.pendingCount).toBe(1);
    app.setAppMotion(false);
    expect(clock.pendingCount).toBe(0);
    app.pulse('approval');
    expect(clock.pendingCount).toBe(0);
    app.setAppMotion(true);
    app.setIndicator({ state: 'connected' });
    expect(last(Tray.last!)).toContain('tray-approvalsTemplate.png');
  });

  it('destroy clears every timer', () => {
    const clock = new ManualClock();
    const { sys } = system();
    const app = new AppTray(electron, '/i', { open: () => {}, quit: () => {}, click: () => {} }, {
      frames: frames('darwin'),
      system: sys,
      timers: clock,
      platform: 'darwin',
    });
    app.pulse('msg-out');
    app.destroy();
    expect(clock.pendingCount).toBe(0);
    app.pulse('msg-in');
    expect(clock.pendingCount).toBe(0);
  });

  it('without frames it keeps the single image and the tooltip (numbers only)', () => {
    const app = new AppTray(electron, '/i', { open: () => {}, quit: () => {} });
    const tray = Tray.last!;
    app.pulse('msg-in');
    app.setIndicator({ state: 'offline' });
    expect(tray.images).toHaveLength(0);
    app.update('running', 2);
    expect(tray.tooltip).toBe('AgentLink: Running · 2 waiting');
  });
});
