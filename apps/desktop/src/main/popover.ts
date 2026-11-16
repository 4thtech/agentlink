// TRAY-POPOVER (D-155; b11 §25.4; plan §3): the menu-bar popover window.
//
// - A frameless, fixed-size (360 × 560), always-on-top window that stays off the taskbar
//   (security.ts popoverOptions). Created lazily on the first show and reused.
// - The SAME webPreferences and in-memory partition as the main window, and the same
//   lockWebContents: the main window's HttpOnly session cookie serves the page, so its URL never
//   carries a token; navigation only on the locked origin; window.open denied; no devtools.
// - It loads only `${lockedOrigin}/settings/widget`, and only once the shell says a session exists
//   for the current core (setSessionReady). Before that, after a core restart until the main window
//   has a new session, and when the widget could not load (the core is down, an error answer), it
//   shows the fixed local page (popover-page.ts) whose one button opens the main window.
// - Placed under the tray icon (macOS) or at the notification area on the taskbar's edge (Windows)
//   from the tray's bounds and the display's work area (popover-position.ts); bounds that are zero
//   or off-screen fall back to the cursor, then to the work-area corner.
// - Hides on blur and on Escape; a second click on the icon toggles it closed (the click that blurred
//   it counts as that second click).
// - It never shows an owner-presence prompt: its presence requests are cancelled by the session
//   (security.ts isPopoverPresenceRequest, wired through ownsWebContents), and the page sends Resume
//   and Approve to the main window over its one IPC channel (widget-ipc.ts).
//
// TRAY-SHELL wires it: new Popover({...}); tray left click → toggle(); the main window loaded a
// session link → setSessionReady(true); a new or failed core → setSessionReady(false); hardenSession's
// isPopover → ownsWebContents; widget-ipc widgetContentsId → widgetContentsId(); before-quit →
// destroy(). Electron objects come in by injection (types below; TRAY-SHELL adds them to
// electron-api.ts), so all of it runs under unit tests without Electron.
import type { ElectronEvent, Shell, WebContents } from './electron-api.js';
import { POPOVER_ACTION_URL, isPopoverFallbackUrl, popoverFallbackUrl } from './popover-page.js';
import {
  intersects,
  popoverBounds,
  validDisplayArea,
  validTrayBounds,
  type DisplayArea,
  type Point,
  type Rect,
} from './popover-position.js';
import {
  POPOVER_HEIGHT,
  POPOVER_WIDTH,
  lockWebContents,
  popoverOptions,
  popoverUrl,
  type OriginLock,
  type PopoverWindowOptions,
} from './security.js';

/** What a key press looks like in `before-input-event` (only what is read). */
export interface PopoverInput {
  readonly type: string;
  readonly key: string;
}

/** The popover's web contents: the main window's subset plus the events the popover listens to. */
export type PopoverWebContents = WebContents & {
  readonly id?: number;
  on(
    event: 'before-input-event',
    listener: (event: ElectronEvent, input: PopoverInput) => void,
  ): void;
  on(
    event: 'did-fail-load',
    listener: (
      event: ElectronEvent,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ) => void,
  ): void;
  on(
    event: 'did-navigate',
    listener: (event: ElectronEvent, url: string, httpResponseCode: number) => void,
  ): void;
  on(
    event: 'did-navigate-in-page',
    listener: (event: ElectronEvent, url: string, isMainFrame: boolean) => void,
  ): void;
  on(event: 'render-process-gone', listener: () => void): void;
};

/** The popover's BrowserWindow (only what it calls). */
export interface PopoverWindow {
  readonly webContents: PopoverWebContents;
  loadURL(url: string): Promise<void>;
  setBounds(bounds: Rect): void;
  show(): void;
  focus(): void;
  hide(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  on(event: 'close' | 'page-title-updated', listener: (event: ElectronEvent) => void): void;
  on(event: 'blur' | 'closed', listener: () => void): void;
}

export type PopoverWindowConstructor = new (options: PopoverWindowOptions) => PopoverWindow;

/** Electron's `screen` (only what the popover reads). */
export interface PopoverScreen {
  getDisplayMatching(rect: Rect): DisplayArea;
  getDisplayNearestPoint(point: Point): DisplayArea;
  getPrimaryDisplay(): DisplayArea;
  getCursorScreenPoint(): Point;
}

export interface PopoverDeps {
  readonly BrowserWindow: PopoverWindowConstructor;
  readonly shell: Pick<Shell, 'openExternal'>;
  /** The main window's origin lock (shared: one core origin for both windows). */
  readonly lock: OriginLock;
  readonly platform: string;
  /** widget-ipc.ts widgetPreloadPath(); undefined: no preload (the page has no IPC). */
  readonly preload?: string | undefined;
  readonly screen: PopoverScreen;
  /** The tray icon's bounds (Tray.getBounds); anything unusable falls back. May throw. */
  readonly trayBounds: () => unknown;
  /** The fallback page's Open AgentLink: show the main window. */
  readonly openMain: () => void;
  /** True once the app is quitting: then a close really closes. */
  readonly quitting: () => boolean;
  readonly now?: () => number;
}

/** What the popover shows. */
export type PopoverPage = 'none' | 'fallback' | 'widget';

/** A click on the icon this soon after a blur-hide is the click that caused the blur. */
export const TOGGLE_GRACE_MS = 300;

const safe = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

const isPoint = (p: unknown): p is Point =>
  typeof p === 'object' &&
  p !== null &&
  Number.isFinite((p as Point).x) &&
  Number.isFinite((p as Point).y);

export class Popover {
  readonly #deps: PopoverDeps;
  readonly #now: () => number;
  #window: PopoverWindow | null = null;
  #page: PopoverPage = 'none';
  #sessionReady = false;
  #blurHiddenAt = Number.NEGATIVE_INFINITY;

  constructor(deps: PopoverDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** What the popover shows now. */
  get page(): PopoverPage {
    return this.#window === null ? 'none' : this.#page;
  }

  /** True while the popover is on screen. */
  get visible(): boolean {
    const window = this.#live();
    return window !== null && window.isVisible();
  }

  /** The tray icon's left click: show, or hide when it is up (or was just blurred by this click). */
  toggle(): void {
    if (this.visible) {
      this.hide();
      return;
    }
    if (this.#now() - this.#blurHiddenAt < TOGGLE_GRACE_MS) {
      this.#blurHiddenAt = Number.NEGATIVE_INFINITY;
      return;
    }
    this.show();
  }

  /** Shows the popover at the icon, loading the page it should show if needed. */
  show(): void {
    const window = this.#ensure();
    const wanted = this.#wanted();
    if (this.#page !== wanted) this.#load(window, wanted);
    this.#place(window);
    window.show();
    window.focus();
  }

  hide(): void {
    const window = this.#live();
    if (window !== null && window.isVisible()) window.hide();
  }

  /**
   * TRAY-SHELL: true once the main window loaded a session link of the current core (the popover
   * then loads, or reloads, the widget); false for a new or failed core (the fixed page).
   */
  setSessionReady(ready: boolean): void {
    this.#sessionReady = ready;
    const window = this.#live();
    if (window === null) return;
    if (ready) this.#load(window, this.#wanted());
    else if (this.#page !== 'fallback') this.#load(window, 'fallback');
  }

  /**
   * widget-ipc.ts: the popover's web contents id while it is on screen and shows the widget page;
   * else null (then every IPC call is refused).
   */
  widgetContentsId(): number | null {
    const window = this.#live();
    if (window === null || this.#page !== 'widget' || !window.isVisible()) return null;
    const id = window.webContents.id;
    return typeof id === 'number' ? id : null;
  }

  /** hardenSession's `isPopover`: true for the popover's web contents (any page). */
  ownsWebContents(id: number | undefined): boolean {
    const window = this.#live();
    return window !== null && typeof id === 'number' && window.webContents.id === id;
  }

  /** At quit: closes the window for good. */
  destroy(): void {
    const window = this.#live();
    this.#window = null;
    this.#page = 'none';
    if (window !== null) window.destroy();
  }

  #live(): PopoverWindow | null {
    const window = this.#window;
    if (window === null) return null;
    if (window.isDestroyed()) {
      this.#window = null;
      this.#page = 'none';
      return null;
    }
    return window;
  }

  /** True for the widget URL on the locked origin (a fragment aside, which never reaches the server). */
  #isWidgetUrl(url: string): boolean {
    const widget = popoverUrl(this.#deps.lock);
    if (widget === null) return false;
    const hash = url.indexOf('#');
    return (hash === -1 ? url : url.slice(0, hash)) === widget;
  }

  /** True when `url` is the page the popover is meant to show now. */
  #shows(url: string): boolean {
    if (this.#page === 'widget') return this.#isWidgetUrl(url);
    if (this.#page === 'fallback') return isPopoverFallbackUrl(url);
    return false;
  }

  #wanted(): 'widget' | 'fallback' {
    return this.#sessionReady && popoverUrl(this.#deps.lock) !== null ? 'widget' : 'fallback';
  }

  #load(window: PopoverWindow, page: 'widget' | 'fallback'): void {
    const url = page === 'widget' ? popoverUrl(this.#deps.lock) : popoverFallbackUrl();
    if (url === null) {
      this.#load(window, 'fallback');
      return;
    }
    this.#page = page;
    void window.loadURL(url).catch(() => undefined);
  }

  #ensure(): PopoverWindow {
    const existing = this.#live();
    if (existing !== null) return existing;
    const deps = this.#deps;
    const window = new deps.BrowserWindow(popoverOptions(deps.platform, deps.preload));
    const contents = window.webContents;
    lockWebContents(contents, deps.lock, deps.shell);
    // The fallback page's one button: acted on only while that exact page is shown. The navigation
    // itself is blocked (the action host is never on the locked origin).
    contents.on('will-navigate', (event, url) => {
      if (url !== POPOVER_ACTION_URL) return;
      event.preventDefault();
      if (this.#window !== window || this.#page !== 'fallback') return;
      if (!isPopoverFallbackUrl(contents.getURL())) return;
      this.hide();
      try {
        deps.openMain();
      } catch {
        // Never throws into Electron.
      }
    });
    // Fable r1 M2: pinned to exactly the page it should show. The widget may only (re)load its own
    // URL; the fallback page navigates nowhere (its button is handled above).
    const pin = (event: ElectronEvent, url: string): void => {
      if (this.#window !== window || this.#page !== 'widget' || !this.#isWidgetUrl(url)) {
        event.preventDefault();
      }
    };
    contents.on('will-navigate', pin);
    contents.on('will-redirect', pin);
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && this.#window === window && !this.#shows(url)) {
        this.#load(window, this.#wanted());
      }
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.hide();
      }
    });
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      // -3 (ERR_ABORTED): a newer load replaced it; that one decides.
      if (!isMainFrame || errorCode === -3) return;
      if (this.#window === window && this.#page === 'widget') this.#load(window, 'fallback');
    });
    contents.on('did-navigate', (_event, url, httpResponseCode) => {
      if (this.#window !== window) return;
      if (this.#page === 'widget' && httpResponseCode >= 400) this.#load(window, 'fallback');
      else if (!this.#shows(url)) this.#load(window, this.#wanted());
    });
    contents.on('render-process-gone', () => {
      // The next show loads the page again.
      if (this.#window === window) this.#page = 'none';
    });
    window.on('blur', () => {
      if (!window.isVisible()) return;
      window.hide();
      this.#blurHiddenAt = this.#now();
    });
    window.on('page-title-updated', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (deps.quitting()) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
      if (this.#window === window) {
        this.#window = null;
        this.#page = 'none';
      }
    });
    this.#window = window;
    this.#page = 'none';
    return window;
  }

  #place(window: PopoverWindow): void {
    const { screen, platform } = this.#deps;
    let anchor: Rect | null = null;
    let display: DisplayArea | null = null;
    const tray = validTrayBounds(safe(() => this.#deps.trayBounds()));
    if (tray !== null) {
      const matching = safe(() => screen.getDisplayMatching(tray));
      if (
        validDisplayArea(matching) !== null &&
        intersects(tray, (matching as DisplayArea).bounds)
      ) {
        anchor = tray;
        display = matching;
      }
    }
    if (anchor === null) {
      const cursor = safe(() => screen.getCursorScreenPoint());
      if (isPoint(cursor)) {
        const nearest = validDisplayArea(safe(() => screen.getDisplayNearestPoint(cursor)));
        if (nearest !== null) {
          anchor = { x: cursor.x, y: cursor.y, width: 0, height: 0 };
          display = nearest;
        }
      }
    }
    if (display !== null && validDisplayArea(display) === null) {
      anchor = null;
      display = null;
    }
    display ??= validDisplayArea(safe(() => screen.getPrimaryDisplay()));
    if (display === null) return;
    const bounds = popoverBounds({
      platform,
      size: { width: POPOVER_WIDTH, height: POPOVER_HEIGHT },
      anchor,
      display,
    });
    safe(() => window.setBounds(bounds));
  }
}
