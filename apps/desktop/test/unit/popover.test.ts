// TRAY-POPOVER (D-155): the popover window. Frameless, fixed size, always on top, off the taskbar,
// in the main window's in-memory partition with the same lockdown; loads only
// `${lockedOrigin}/settings/widget` (the main window's session cookie serves it, no token in the
// URL); a fixed local page until a session exists or when the core is down; hides on blur and Esc;
// a second click toggles; created lazily and reused.
import { describe, expect, it } from 'vitest';
import type { BrowserWindowOptions } from '../../src/main/electron-api.js';
import {
  Popover,
  type PopoverDeps,
  type PopoverScreen,
  type PopoverWindow,
} from '../../src/main/popover.js';
import {
  POPOVER_ACTION_URL,
  isPopoverFallbackUrl,
  popoverFallbackHtml,
  popoverFallbackUrl,
  POPOVER_FALLBACK_CSP,
} from '../../src/main/popover-page.js';
import {
  OriginLock,
  POPOVER_HEIGHT,
  POPOVER_PATH,
  POPOVER_WIDTH,
  WINDOW_PARTITION,
  hardenSession,
  popoverOptions,
  popoverUrl,
} from '../../src/main/security.js';
import type { DisplayArea, Rect } from '../../src/main/popover-position.js';
import { FakeBrowserWindow, FakeEvent, FakeSession, SESSION_URL } from './fakes.js';

const ORIGIN = 'http://localhost:4567';
const WIDGET = `${ORIGIN}/settings/widget`;

class FakePopoverWindow extends FakeBrowserWindow implements PopoverWindow {
  static all: FakePopoverWindow[] = [];
  bounds: Rect | null = null;
  focusCount = 0;
  constructor(options: BrowserWindowOptions) {
    super(options);
    (this.webContents as unknown as { id: number }).id = 40 + FakePopoverWindow.all.length;
    FakePopoverWindow.all.push(this);
  }
  setBounds(bounds: Rect): void {
    this.bounds = bounds;
  }
  override focus(): void {
    this.focusCount += 1;
  }
}

const MAC: DisplayArea = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 800 },
};

function fakeScreen(display: DisplayArea = MAC): PopoverScreen & { cursorAsked: number } {
  return {
    cursorAsked: 0,
    getDisplayMatching: () => display,
    getDisplayNearestPoint: () => display,
    getPrimaryDisplay: () => display,
    getCursorScreenPoint() {
      this.cursorAsked += 1;
      return { x: 700, y: 400 };
    },
  };
}

function setup(over: Partial<PopoverDeps> = {}) {
  FakePopoverWindow.all = [];
  const lock = new OriginLock();
  let now = 1_000;
  let quitting = false;
  const opened: number[] = [];
  const screen = fakeScreen();
  const deps: PopoverDeps = {
    BrowserWindow: FakePopoverWindow,
    shell: { openExternal: () => Promise.resolve() },
    lock,
    platform: 'darwin',
    screen,
    trayBounds: () => ({ x: 1000, y: 0, width: 24, height: 24 }),
    openMain: () => {
      opened.push(now);
    },
    quitting: () => quitting,
    now: () => now,
    ...over,
  };
  const popover = new Popover(deps);
  return {
    popover,
    lock,
    screen,
    opened,
    advance: (ms: number) => {
      now += ms;
    },
    quit: () => {
      quitting = true;
    },
    win: (): FakePopoverWindow => {
      const w = FakePopoverWindow.all.at(-1);
      if (w === undefined) throw new Error('no window');
      return w;
    },
  };
}

const ready = (s: ReturnType<typeof setup>): void => {
  expect(s.lock.acceptSessionUrl(SESSION_URL)).toBe(true);
  s.popover.setSessionReady(true);
};

describe('popover options (security.ts)', () => {
  it.each(['darwin', 'win32', 'linux'])('frameless, fixed, on top, same lockdown on %s', (p) => {
    const options = popoverOptions(p, '/app/widget-preload.cjs');
    expect(options).toMatchObject({
      width: POPOVER_WIDTH,
      height: POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      title: 'AgentLink',
    });
    expect(options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      devTools: false,
      webSecurity: true,
      partition: WINDOW_PARTITION,
      preload: '/app/widget-preload.cjs',
    });
    expect(POPOVER_WIDTH).toBe(360);
    expect(POPOVER_HEIGHT).toBe(560);
  });

  it('without the bundled preload there is none', () => {
    expect(popoverOptions('darwin').webPreferences.preload).toBeUndefined();
  });

  it('the widget URL is the locked origin plus the fixed path, never a token', () => {
    const lock = new OriginLock();
    expect(popoverUrl(lock)).toBeNull();
    lock.acceptSessionUrl(SESSION_URL);
    expect(POPOVER_PATH).toBe('/settings/widget');
    expect(popoverUrl(lock)).toBe(WIDGET);
    expect(popoverUrl(lock)).not.toContain('?');
  });
});

describe('the fallback page', () => {
  it('is fixed, script-free and offers only Open AgentLink', () => {
    const html = popoverFallbackHtml();
    expect(html).toContain(POPOVER_FALLBACK_CSP);
    expect(POPOVER_FALLBACK_CSP).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('Open AgentLink');
    expect(html).toContain(POPOVER_ACTION_URL);
    expect(new URL(POPOVER_ACTION_URL).hostname.endsWith('.invalid')).toBe(true);
    expect(popoverFallbackUrl().startsWith('data:text/html')).toBe(true);
    expect(isPopoverFallbackUrl(popoverFallbackUrl())).toBe(true);
    expect(isPopoverFallbackUrl(`${popoverFallbackUrl()}x`)).toBe(false);
  });
});

describe('Popover', () => {
  it('is created lazily, on the first show, and reused', () => {
    const s = setup();
    expect(FakePopoverWindow.all).toHaveLength(0);
    s.popover.show();
    s.popover.hide();
    s.popover.show();
    expect(FakePopoverWindow.all).toHaveLength(1);
    expect(s.win().options).toMatchObject({ frame: false, alwaysOnTop: true, skipTaskbar: true });
  });

  it('before a session exists it shows the fixed local page, never the widget', () => {
    const s = setup();
    s.popover.show();
    expect(s.win().loaded).toEqual([popoverFallbackUrl()]);
    expect(s.popover.page).toBe('fallback');
    expect(s.popover.widgetContentsId()).toBeNull();
  });

  it('with a session it loads the widget from the locked origin (no token)', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    expect(s.win().loaded).toEqual([WIDGET]);
    expect(s.popover.page).toBe('widget');
    expect(s.popover.widgetContentsId()).toBe(s.win().webContents.id);
  });

  it('a new session reloads the widget; losing it shows the fallback', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    s.popover.setSessionReady(false);
    expect(s.win().loaded.at(-1)).toBe(popoverFallbackUrl());
    expect(s.popover.widgetContentsId()).toBeNull();
    s.popover.setSessionReady(true);
    expect(s.win().loaded.at(-1)).toBe(WIDGET);
  });

  it('a ready session without a locked origin still shows the fallback', () => {
    const s = setup();
    s.popover.setSessionReady(true);
    s.popover.show();
    expect(s.win().loaded).toEqual([popoverFallbackUrl()]);
  });

  it('a failed load (core down) or an error answer shows the fallback', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    s.win().webContents.emit('did-fail-load', new FakeEvent(), -102, 'refused', WIDGET, true);
    expect(s.win().loaded.at(-1)).toBe(popoverFallbackUrl());
    s.popover.setSessionReady(true);
    s.win().webContents.emit('did-navigate', new FakeEvent(), WIDGET, 401);
    expect(s.win().loaded.at(-1)).toBe(popoverFallbackUrl());
  });

  it('an aborted load or a sub-frame failure does not replace the page', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    s.win().webContents.emit('did-fail-load', new FakeEvent(), -3, 'aborted', WIDGET, true);
    s.win().webContents.emit('did-fail-load', new FakeEvent(), -102, 'x', WIDGET, false);
    expect(s.win().loaded).toEqual([WIDGET]);
  });

  it('the fallback Open AgentLink opens the main window, only from the fallback page', () => {
    const s = setup();
    s.popover.show();
    const blocked = s.win().webContents.navigate('will-navigate', POPOVER_ACTION_URL);
    expect(blocked).toBe(true);
    expect(s.opened).toHaveLength(1);
    expect(s.win().visible).toBe(false);
    // From the widget page the same URL does nothing.
    s.lock.acceptSessionUrl(SESSION_URL);
    s.popover.setSessionReady(true);
    s.popover.show();
    s.win().webContents.navigate('will-navigate', POPOVER_ACTION_URL);
    expect(s.opened).toHaveLength(1);
  });

  it('is locked like the main window: off-origin navigation and window.open are refused', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    const contents = s.win().webContents;
    expect(contents.navigate('will-navigate', 'https://evil.example/')).toBe(true);
    expect(contents.navigate('will-redirect', 'http://localhost:9999/')).toBe(true);
    expect(contents.navigate('will-navigate', `${ORIGIN}/settings/widget`)).toBe(false);
    expect(contents.windowOpenHandler?.({ url: 'https://evil.example/' })).toEqual({
      action: 'deny',
    });
  });

  it('hides on blur and on Escape', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    expect(s.popover.visible).toBe(true);
    s.win().emit('blur');
    expect(s.popover.visible).toBe(false);
    s.advance(1_000);
    s.popover.show();
    const esc = new FakeEvent();
    s.win().webContents.emit('before-input-event', esc, { type: 'keyDown', key: 'Escape' });
    expect(s.popover.visible).toBe(false);
    expect(esc.defaultPrevented).toBe(true);
    s.popover.show();
    s.win().webContents.emit('before-input-event', new FakeEvent(), { type: 'keyDown', key: 'a' });
    s.win().webContents.emit('before-input-event', new FakeEvent(), {
      type: 'keyUp',
      key: 'Escape',
    });
    expect(s.popover.visible).toBe(true);
  });

  it('a second click toggles it closed (also when that click blurred it first)', () => {
    const s = setup();
    ready(s);
    s.popover.toggle();
    expect(s.popover.visible).toBe(true);
    s.popover.toggle();
    expect(s.popover.visible).toBe(false);
    s.advance(1_000);
    s.popover.toggle();
    expect(s.popover.visible).toBe(true);
    // Clicking the icon blurs the popover first, then the click arrives.
    s.win().emit('blur');
    s.advance(50);
    s.popover.toggle();
    expect(s.popover.visible).toBe(false);
    s.advance(1_000);
    s.popover.toggle();
    expect(s.popover.visible).toBe(true);
  });

  it('is placed under the tray icon in the work area and focused', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    expect(s.win().bounds).toMatchObject({ y: 25 + 6, width: 360, height: 560 });
    expect(s.win().bounds?.x).toBe(1012 - 180);
    expect(s.win().focusCount).toBeGreaterThan(0);
  });

  it('zero tray bounds fall back to the cursor', () => {
    const s = setup({ trayBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
    s.popover.show();
    expect(s.screen.cursorAsked).toBe(1);
    const b = s.win().bounds;
    expect(b).not.toBeNull();
    expect(b?.x).toBe(700 - 180);
  });

  it('a tray getBounds that throws still places it', () => {
    const s = setup({
      trayBounds: () => {
        throw new Error('gone');
      },
    });
    s.popover.show();
    expect(s.win().bounds).not.toBeNull();
  });

  it('a close hides it unless the app is quitting', () => {
    const s = setup();
    s.popover.show();
    const close = new FakeEvent();
    s.win().emit('close', close);
    expect(close.defaultPrevented).toBe(true);
    expect(s.popover.visible).toBe(false);
    s.quit();
    const last = new FakeEvent();
    s.win().emit('close', last);
    expect(last.defaultPrevented).toBe(false);
  });

  it('a page title never reaches the window', () => {
    const s = setup();
    s.popover.show();
    const e = new FakeEvent();
    s.win().emit('page-title-updated', e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('a crashed renderer is replaced on the next show', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    s.win().emit('closed');
    s.win().destroyed = true;
    s.popover.show();
    expect(FakePopoverWindow.all).toHaveLength(2);
    expect(s.win().loaded).toEqual([WIDGET]);
  });

  it('destroy() closes it for good', () => {
    const s = setup();
    s.popover.show();
    s.popover.destroy();
    expect(s.win().destroyed).toBe(true);
    expect(s.popover.visible).toBe(false);
    expect(s.popover.widgetContentsId()).toBeNull();
  });
});

describe('no owner presence from the popover (hardenSession)', () => {
  it("cancels the popover's requests that would start an owner-presence prompt", async () => {
    const session = new FakeSession();
    const lock = new OriginLock();
    lock.acceptSessionUrl(SESSION_URL);
    let blurs = 0;
    await hardenSession(
      session,
      lock,
      'darwin',
      () => {
        blurs += 1;
      },
      (id) => id === 41,
    );
    const send = (id: number, method: string, url: string, headers: Record<string, string>) => {
      let answer: { cancel?: boolean } | undefined;
      session.beforeSendHeaders?.(
        { method, url, requestHeaders: headers, webContentsId: id } as never,
        (r) => {
          answer = r;
        },
      );
      return answer;
    };
    const native = { 'X-AgentLink-Presence': 'native' };
    expect(send(41, 'POST', `${ORIGIN}/api/approvals/a1/approve`, native)?.cancel).toBe(true);
    expect(send(41, 'POST', `${ORIGIN}/api/owner/native`, {})?.cancel).toBe(true);
    expect(send(41, 'POST', `${ORIGIN}/api/owner/passkey`, {})?.cancel).toBe(true);
    expect(
      send(41, 'POST', `${ORIGIN}/api/rules`, { 'x-agentlink-presence': 'challenge' })?.cancel,
    ).toBe(true);
    expect(send(41, 'GET', `${ORIGIN}/api/owner/native`, {})?.cancel).toBeFalsy();
    expect(send(41, 'POST', `${ORIGIN}/api/ui/pause`, {})?.cancel).toBeFalsy();
    expect(blurs).toBe(0);
    expect(send(41, 'GET', `${ORIGIN}/api/ui/widget`, {})?.cancel).toBeFalsy();
    // The main window is unchanged.
    expect(send(7, 'POST', `${ORIGIN}/api/owner/native`, {})?.cancel).toBeFalsy();
    expect(blurs).toBe(1);
  });
});

void FakeBrowserWindow;
