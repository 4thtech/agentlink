// The one main window (plan Decision 3 "Window"). It is created hidden with the locked-down
// webPreferences (security.ts), shows only the core's origin, and loads a session link only when the
// core sent it over the pipe (never from argv, a deep link or the OS opener). Until then, and when
// the core could not start, it shows the fixed local status page (status-page.ts), whose two buttons
// are fixed URLs intercepted here and acted on ONLY while that exact page is shown. Closing the window
// hides it; the app keeps running in the tray until the person quits (TRAY-SHELL: on Windows with
// the icon turned off, a close quits, D-155 (7)). The title stays "AgentLink"
// (a page title could carry a name; the window switcher and screen sharing would show it).
import type { BrowserWindow, BrowserWindowConstructor, Shell } from './electron-api.js';
import { OriginLock, lockWebContents, markWebContents, windowOptions } from './security.js';
import {
  isStatusPageUrl,
  statusAction,
  statusPageUrl,
  type StatusAction,
  type StatusKind,
} from './status-page.js';

/** What the window shows. */
export type WindowPage = 'none' | 'status' | 'session';

export interface MainWindowDeps {
  readonly BrowserWindow: BrowserWindowConstructor;
  readonly shell: Shell;
  readonly lock: OriginLock;
  readonly platform: string;
  /** FILES-FOLDER-PICKER: the one preload (folder-picker.ts preloadPath); undefined: none. */
  readonly preload?: string | undefined;
  /** True once the app is quitting: then a close really closes. */
  readonly quitting: () => boolean;
  /** A button on the status page (Try again, Open log folder). */
  readonly onStatusAction?: (action: StatusAction) => void;
  /**
   * TRAY-SHELL: the window was shown (the popover hides then). DESK-WIDGET-OPEN: not on `focus`:
   * showing the popover brings the app forward, which can focus this window and must not hide it.
   */
  readonly onShown?: () => void;
  /** DESK-WIDGET-OPEN: the window got focus (the popover decides: popover.mainWindowFocused). */
  readonly onFocused?: () => void;
  /**
   * TRAY-SHELL (D-155 (7)): true while a close should quit the app (Windows with the icon hidden:
   * otherwise AgentLink would keep running with no way back). Absent or false: a close hides.
   */
  readonly quitOnClose?: () => boolean;
  /** TRAY-SHELL: quits the app (app.quit) when quitOnClose says so. */
  readonly quit?: () => void;
}

export class MainWindow {
  readonly #deps: MainWindowDeps;
  #window: BrowserWindow | null = null;
  #loaded = false;
  #page: WindowPage = 'none';
  #status: StatusKind | null = null;
  /**
   * OWNER-FB-0512: true only while the last full load of a session page succeeded (an HTTP answer
   * below 400, no failed load). `#loaded` is set when a load starts, so it cannot tell a good page
   * from the 401 "expired" page or a failed load.
   */
  #ok = false;
  /** TRAY-SHELL: counts session-link loads, so only the latest one reports it finished. */
  #sessionLoad = 0;

  constructor(deps: MainWindowDeps) {
    this.#deps = deps;
  }

  /** The window, created on first use. */
  #ensure(): BrowserWindow {
    if (this.#window !== null && !this.#window.isDestroyed()) return this.#window;
    const window = new this.#deps.BrowserWindow(
      windowOptions(this.#deps.platform, this.#deps.preload),
    );
    lockWebContents(window.webContents, this.#deps.lock, this.#deps.shell);
    markWebContents(window.webContents, this.#deps.platform);
    // The status page's buttons. lockWebContents blocks the navigation itself (the action host is
    // never on the locked origin); this only decides whether to act, and only for the exact fixed
    // URLs on the exact fixed page.
    window.webContents.on('will-navigate', (event, url) => {
      const action = statusAction(url);
      if (action === null) return;
      event.preventDefault();
      if (this.#page !== 'status' || !isStatusPageUrl(window.webContents.getURL())) return;
      this.#deps.onStatusAction?.(action);
    });
    window.webContents.on('did-navigate', (_event, _url, httpResponseCode) => {
      this.#ok = this.#page === 'session' && httpResponseCode > 0 && httpResponseCode < 400;
    });
    window.webContents.on('did-fail-load', (_event, _code, _text, _url, isMainFrame) => {
      if (isMainFrame) this.#ok = false;
    });
    window.on('page-title-updated', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (this.#deps.quitting()) return;
      event.preventDefault();
      window.hide();
      if (this.#deps.quitOnClose?.() === true) this.#deps.quit?.();
    });
    window.on('show', () => this.#shown());
    window.on('focus', () => {
      try {
        this.#deps.onFocused?.();
      } catch {
        // Never throws into Electron.
      }
    });
    window.once('ready-to-show', () => window.show());
    this.#window = window;
    this.#loaded = false;
    this.#ok = false;
    this.#page = 'none';
    this.#status = null;
    return window;
  }

  /**
   * Shows the fixed local status page for `kind` and brings the window up. It never changes the
   * origin lock. Loading the same page again is skipped (no flicker).
   */
  showStatus(kind: StatusKind): void {
    const window = this.#ensure();
    if (this.#page !== 'status' || this.#status !== kind) {
      this.#sessionLoad += 1;
      this.#page = 'status';
      this.#status = kind;
      this.#loaded = false;
      this.#ok = false;
      void window.loadURL(statusPageUrl(kind)).catch(() => undefined);
    }
    this.show();
  }

  /**
   * FILES-FOLDER-PICKER: the window, only while it shows a session page (never the status page), for
   * the folder dialog to be modal to it; else null.
   */
  get sessionWindow(): BrowserWindow | null {
    const window = this.#window;
    if (window === null || window.isDestroyed() || this.#page !== 'session') return null;
    return window;
  }

  /** What the window shows now. */
  get page(): WindowPage {
    return this.#page;
  }

  /**
   * Loads a session link from the core's `ready` message. Refused (false, nothing loaded) unless the
   * link is valid and on the locked origin. The link is never logged or kept.
   */
  loadSessionUrl(url: string, onLoaded?: () => void): boolean {
    if (!this.#deps.lock.acceptSessionUrl(url)) return false;
    const window = this.#ensure();
    // OWNER-FB-0512: a deep link (`#person=…`) to the page Home already shows moves in place (only the
    // fragment changes: no reload, no blank page, the app keeps its state), as opening from inside
    // the app does. Anything else loads the new link as before.
    const inPlace = this.#sameHome(window, url);
    this.#loaded = true;
    this.#page = 'session';
    this.#status = null;
    const load = ++this.#sessionLoad;
    if (inPlace === null) this.#ok = false; // a full load: good again once it commits
    if (inPlace !== null) {
      void window.loadURL(inPlace).catch(() => undefined);
      try {
        onLoaded?.();
      } catch {
        // Never throws into Electron.
      }
      return true;
    }
    // TRAY-SHELL: `onLoaded` once the page finished loading (its session cookie is set by then), and
    // only if this is still the window's latest session load.
    void window.loadURL(url).then(
      () => {
        if (
          onLoaded === undefined ||
          load !== this.#sessionLoad ||
          this.#window !== window ||
          this.#page !== 'session'
        ) {
          return;
        }
        try {
          onLoaded();
        } catch {
          // Never throws into Electron.
        }
      },
      () => undefined,
    );
    return true;
  }

  /**
   * OWNER-FB-0512: the window's committed address with the new link's `#person=…` fragment, when the
   * window already shows Home (`/`) of the same origin and the link is Home's person link; else null.
   */
  #sameHome(window: BrowserWindow, url: string): string | null {
    if (!this.#loaded || !this.#ok || this.#page !== 'session') return null;
    try {
      const next = new URL(url);
      if (next.pathname !== '/' || !/^#person=0x[0-9a-f]{40}(?:&files)?$/.test(next.hash)) {
        return null;
      }
      const current = new URL(window.webContents.getURL());
      if (current.origin !== next.origin || current.pathname !== '/') return null;
      current.hash = next.hash;
      return current.toString();
    } catch {
      return null;
    }
  }

  /**
   * OWNER-FB-0512: true when a person link can move the window in place: Home is showing from a
   * load that succeeded. Otherwise the core must mint a link for a full load.
   */
  get canOpenInPlace(): boolean {
    const window = this.#window;
    if (window === null || window.isDestroyed() || !this.#loaded || !this.#ok) return false;
    if (this.#page !== 'session') return false;
    try {
      return new URL(window.webContents.getURL()).pathname === '/';
    } catch {
      return false;
    }
  }

  /** True once a session link was loaded into the current window. */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** Shows and focuses the window if it exists (it exists once the core sent a link). */
  show(): boolean {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    this.#shown();
    return true;
  }

  #shown(): void {
    try {
      this.#deps.onShown?.();
    } catch {
      // Never throws into Electron.
    }
  }

  /** TRAY-SHELL: true while the window is on screen (shown and not minimised). */
  get visible(): boolean {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return false;
    return window.isVisible() && !window.isMinimized();
  }

  /**
   * NOTIFY-FOCUS: true while the window is shown, not minimised and has focus (the person is looking
   * at AgentLink); no window, a hidden or a background one: false.
   */
  get focused(): boolean {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return false;
    return window.isVisible() && !window.isMinimized() && window.isFocused();
  }

  /**
   * DESK-TOUCHID-FIX: takes keyboard focus off the page (a focused password field keeps macOS
   * secure input on). False when there is no window.
   */
  blurPage(): boolean {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return false;
    window.blurWebView();
    return true;
  }

  /** For a new core process: the origin may change, the old page is gone. */
  resetForNewCore(): void {
    this.#deps.lock.reset();
    this.#loaded = false;
    this.#ok = false;
    this.#sessionLoad += 1;
  }

  /** DESK-QUIT-ORDER: off screen at once at quit (before the core stops). */
  hide(): void {
    const window = this.#window;
    if (window !== null && !window.isDestroyed() && window.isVisible()) window.hide();
  }

  destroy(): void {
    if (this.#window !== null && !this.#window.isDestroyed()) this.#window.destroy();
    this.#window = null;
  }
}
