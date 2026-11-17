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
  POPOVER_WRITE_PATHS,
  hardenSession,
  isServiceWorkerRequest,
  popoverOptions,
  popoverUrl,
  type PopoverWindowOptions,
} from '../../src/main/security.js';
import type { DisplayArea, Rect } from '../../src/main/popover-position.js';
import {
  FakeBrowserWindow,
  FakeEvent,
  FakeSession,
  FakeWebContents,
  SESSION_URL,
} from './fakes.js';

const ORIGIN = 'http://localhost:4567';
const WIDGET = `${ORIGIN}/settings/widget`;

class FakePopoverWindow extends FakeBrowserWindow implements PopoverWindow {
  static all: FakePopoverWindow[] = [];
  override readonly webContents: FakeWebContents & { id: number } = Object.assign(
    new FakeWebContents(),
    { id: 40 + FakePopoverWindow.all.length },
  );
  override bounds: Rect | null = null;
  focusCount = 0;
  constructor(readonly popoverOptions: PopoverWindowOptions) {
    super(popoverOptions as unknown as BrowserWindowOptions);
    FakePopoverWindow.all.push(this);
  }
  override setBounds(bounds: Rect): void {
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

  it('is pinned to the widget URL: other same-origin pages and redirects are refused', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    const contents = s.win().webContents;
    expect(contents.navigate('will-navigate', `${ORIGIN}/settings/home`)).toBe(true);
    expect(contents.navigate('will-navigate', `${ORIGIN}/approve/apr_${'A'.repeat(22)}`)).toBe(
      true,
    );
    expect(contents.navigate('will-navigate', `${WIDGET}?t=x`)).toBe(true);
    expect(contents.navigate('will-redirect', `${ORIGIN}/`)).toBe(true);
    expect(contents.navigate('will-redirect', WIDGET)).toBe(false);
    expect(contents.navigate('will-navigate', `${WIDGET}#top`)).toBe(false);
  });

  it('the fallback page navigates nowhere, not even to the widget', () => {
    const s = setup();
    s.lock.acceptSessionUrl(SESSION_URL);
    s.popover.show();
    expect(s.popover.page).toBe('fallback');
    expect(s.win().webContents.navigate('will-navigate', WIDGET)).toBe(true);
    expect(s.win().webContents.navigate('will-redirect', WIDGET)).toBe(true);
  });

  it('a navigation to another page (also in-page pushState) reloads the widget', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    const contents = s.win().webContents;
    contents.emit('did-navigate-in-page', new FakeEvent(), `${ORIGIN}/settings/home`, true);
    expect(s.win().loaded).toEqual([WIDGET, WIDGET]);
    contents.emit('did-navigate', new FakeEvent(), `${ORIGIN}/inbox`, 200);
    expect(s.win().loaded).toEqual([WIDGET, WIDGET, WIDGET]);
    // The widget itself, a fragment change and a sub-frame are left alone.
    contents.emit('did-navigate', new FakeEvent(), WIDGET, 200);
    contents.emit('did-navigate-in-page', new FakeEvent(), `${WIDGET}#x`, true);
    contents.emit('did-navigate-in-page', new FakeEvent(), `${ORIGIN}/inbox`, false);
    expect(s.win().loaded).toHaveLength(3);
  });

  it('without a session, a stray navigation goes back to the fallback page', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    s.popover.setSessionReady(false);
    const before = s.win().loaded.length;
    s.win().webContents.emit('did-navigate-in-page', new FakeEvent(), `${ORIGIN}/inbox`, true);
    expect(s.win().loaded.length).toBe(before + 1);
    expect(s.win().loaded.at(-1)).toBe(popoverFallbackUrl());
    s.win().webContents.emit('did-navigate', new FakeEvent(), popoverFallbackUrl(), 200);
    expect(s.win().loaded.length).toBe(before + 1);
  });

  it('an unusable display falls back to the primary display', () => {
    const broken = {
      bounds: { x: Number.NaN, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 25, width: Infinity, height: 800 },
    } as DisplayArea;
    const s = setup({
      screen: {
        getDisplayMatching: () => broken,
        getDisplayNearestPoint: () => broken,
        getPrimaryDisplay: () => MAC,
        getCursorScreenPoint: () => ({ x: 1, y: 1 }),
      },
    });
    s.popover.show();
    expect(s.win().bounds).toEqual({ x: 1440 - 8 - 360, y: 25 + 8, width: 360, height: 560 });
  });

  it('hides on blur and on Escape', () => {
    const s = setup();
    ready(s);
    s.popover.show();
    expect(s.popover.visible).toBe(true);
    // DESK-WIDGET-OPEN: a blur right after the show is ignored (the app coming forward).
    s.advance(200);
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
    // DESK-WIDGET-OPEN: the pointer is on the icon when that click blurs it.
    const s = setup({ screen: { ...fakeScreen(), getCursorScreenPoint: () => ({ x: 1010, y: 10 }) } });
    ready(s);
    s.popover.toggle();
    expect(s.popover.visible).toBe(true);
    s.popover.toggle();
    expect(s.popover.visible).toBe(false);
    s.advance(1_000);
    s.popover.toggle();
    expect(s.popover.visible).toBe(true);
    s.advance(500);
    // Clicking the icon blurs the popover first, then the click arrives.
    s.win().emit('blur');
    s.advance(50);
    s.popover.toggle();
    expect(s.popover.visible).toBe(false);
    s.advance(1_000);
    s.popover.toggle();
    expect(s.popover.visible).toBe(true);
  });

  it('DESK-WIDGET-OPEN: macOS: a panel on every Space and over full screen', () => {
    expect(popoverOptions('darwin').type).toBe('panel');
    expect(popoverOptions('win32').type).toBeUndefined();
    expect(popoverOptions('linux').type).toBeUndefined();
    const s = setup();
    s.popover.show();
    expect(s.win().allWorkspaces).toEqual([[true, { visibleOnFullScreen: true }]]);
    s.popover.hide();
    s.popover.show();
    expect(s.win().allWorkspaces).toHaveLength(1);
    const w = setup({ platform: 'win32' });
    w.popover.show();
    expect(w.win().allWorkspaces).toEqual([]);
  });

  it('DESK-WIDGET-OPEN: macOS: showing it brings AgentLink forward (steal)', () => {
    const focused: unknown[] = [];
    const s = setup({ focusApp: () => focused.push('mac') });
    s.popover.show();
    expect(focused).toEqual(['mac']);
    const w = setup({ platform: 'win32', focusApp: () => focused.push('win') });
    w.popover.show();
    expect(focused).toEqual(['mac']);
  });

  it('DESK-WIDGET-OPEN: an early blur (the app coming forward) does not hide it', () => {
    const s = setup();
    ready(s);
    s.popover.toggle();
    s.advance(50);
    s.win().emit('blur');
    expect(s.popover.visible).toBe(true);
    s.advance(200);
    s.win().emit('blur');
    expect(s.popover.visible).toBe(false);
  });

  it('DESK-WIDGET-OPEN: an unrelated blur, then a click on the icon, opens it', () => {
    // The pointer is elsewhere (another app took focus), not on the icon.
    const s = setup();
    ready(s);
    s.popover.toggle();
    s.advance(500);
    s.win().emit('blur');
    expect(s.popover.visible).toBe(false);
    s.advance(50);
    s.popover.toggle();
    expect(s.popover.visible).toBe(true);
  });

  it('DESK-WIDGET-OPEN: the first show waits for the first paint (no blank flash)', () => {
    class HeldWindow extends FakePopoverWindow {
      override autoReady: boolean | null = false;
    }
    const s = setup({ BrowserWindow: HeldWindow });
    ready(s);
    s.popover.toggle();
    expect(s.win().loaded).toEqual([WIDGET]);
    expect(s.popover.visible).toBe(false);
    expect(s.win().focusCount).toBe(0);
    s.win().emit('ready-to-show');
    expect(s.popover.visible).toBe(true);
    expect(s.win().focusCount).toBe(1);
    // Painted once: later shows are immediate.
    s.popover.hide();
    s.advance(1_000);
    s.popover.toggle();
    expect(s.popover.visible).toBe(true);
  });

  it('DESK-WIDGET-OPEN: a hide before the first paint cancels the pending show', () => {
    class HeldWindow extends FakePopoverWindow {
      override autoReady: boolean | null = false;
    }
    const s = setup({ BrowserWindow: HeldWindow });
    s.popover.toggle();
    s.popover.hide();
    s.win().emit('ready-to-show');
    expect(s.popover.visible).toBe(false);
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

describe('the popover only reads (hardenSession allowlist)', () => {
  const harden = async () => {
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
    const send = (
      id: number | undefined,
      method: string,
      url: string,
      headers: Record<string, string> = {},
    ) => {
      let answer: { cancel?: boolean } | undefined;
      session.beforeSendHeaders?.(
        { method, url, requestHeaders: headers, webContentsId: id } as never,
        (r) => {
          answer = r;
        },
      );
      return answer?.cancel === true;
    };
    return { send, blurs: () => blurs };
  };

  it('no non-GET path is allowed', () => {
    expect(POPOVER_WRITE_PATHS).toEqual([]);
  });

  it.each([
    ['POST', '/api/approvals/apr_AAAAAAAAAAAAAAAAAAAAAA/approve'],
    ['POST', '/api/approvals/apr_AAAAAAAAAAAAAAAAAAAAAA/deny'],
    ['POST', '/api/approvals/review'],
    ['POST', '/api/ui/contacts/join'],
    ['POST', '/api/ui/contacts/invite'],
    ['POST', '/api/ui/files'],
    ['POST', '/api/ui/files/save'],
    ['POST', '/api/ui/files/review'],
    ['POST', '/api/ui/pause'],
    ['POST', '/api/ui/resume'],
    ['POST', '/api/owner/native'],
    ['POST', '/api/owner/passkey'],
    ['PUT', '/api/ui/ui-settings'],
    ['PATCH', '/api/ui/rules'],
    ['DELETE', '/api/ui/contacts/x'],
    ['OPTIONS', '/api/ui/widget'],
  ])('cancels %s %s from the popover', async (method, path) => {
    const { send } = await harden();
    expect(send(41, method, `${ORIGIN}${path}`)).toBe(true);
  });

  it('cancels any request carrying presence, even a GET', async () => {
    const { send, blurs } = await harden();
    expect(send(41, 'GET', `${ORIGIN}/api/ui/widget`, { 'x-agentlink-presence': 'native' })).toBe(
      true,
    );
    expect(send(41, 'POST', `${ORIGIN}/api/rules`, { 'X-AgentLink-Presence': 'challenge' })).toBe(
      true,
    );
    expect(blurs()).toBe(0);
  });

  it('lets reads through', async () => {
    const { send } = await harden();
    expect(send(41, 'GET', `${ORIGIN}/api/ui/widget`)).toBe(false);
    expect(send(41, 'GET', `${ORIGIN}/api/ui/events`)).toBe(false);
    expect(send(41, 'HEAD', `${ORIGIN}/settings/widget`)).toBe(false);
  });

  it('leaves the main window unchanged', async () => {
    const { send, blurs } = await harden();
    expect(send(7, 'POST', `${ORIGIN}/api/owner/native`)).toBe(false);
    expect(send(7, 'POST', `${ORIGIN}/api/approvals/review`)).toBe(false);
    expect(blurs()).toBe(1);
  });

  it('a throwing isPopover fails closed', async () => {
    const session = new FakeSession();
    const lock = new OriginLock();
    lock.acceptSessionUrl(SESSION_URL);
    await hardenSession(session, lock, 'darwin', undefined, () => {
      throw new Error('x');
    });
    let cancel: boolean | undefined;
    session.beforeSendHeaders?.(
      { method: 'POST', url: `${ORIGIN}/api/ui/files/save`, requestHeaders: {} } as never,
      (r) => {
        cancel = r.cancel;
      },
    );
    expect(cancel).toBe(true);
  });

  it('no service worker is ever registered (any window)', async () => {
    const { send } = await harden();
    expect(send(7, 'GET', `${ORIGIN}/sw.js`, { 'Service-Worker': 'script' })).toBe(true);
    expect(send(41, 'GET', `${ORIGIN}/sw.js`, { 'service-worker': 'script' })).toBe(true);
    expect(isServiceWorkerRequest({ Accept: '*/*' })).toBe(false);
  });
});
