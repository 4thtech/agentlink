// The one main window (plan Decision 3 "Window"). It is created hidden with the locked-down
// webPreferences (security.ts), shows only the core's origin, and loads a session link only when the
// core sent it over the pipe (never from argv, a deep link or the OS opener). Until then, and when
// the core could not start, it shows the fixed local status page (status-page.ts), whose two buttons
// are fixed URLs intercepted here and acted on ONLY while that exact page is shown. Closing the window
// hides it; the app keeps running in the tray until the person quits. The title stays "AgentLink"
// (a page title could carry a name; the window switcher and screen sharing would show it).
import type { BrowserWindow, BrowserWindowConstructor, Shell } from './electron-api.js';
import { OriginLock, lockWebContents, windowOptions } from './security.js';
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
  /** True once the app is quitting: then a close really closes. */
  readonly quitting: () => boolean;
  /** A button on the status page (Try again, Open log folder). */
  readonly onStatusAction?: (action: StatusAction) => void;
}

export class MainWindow {
  readonly #deps: MainWindowDeps;
  #window: BrowserWindow | null = null;
  #loaded = false;
  #page: WindowPage = 'none';
  #status: StatusKind | null = null;

  constructor(deps: MainWindowDeps) {
    this.#deps = deps;
  }

  /** The window, created on first use. */
  #ensure(): BrowserWindow {
    if (this.#window !== null && !this.#window.isDestroyed()) return this.#window;
    const window = new this.#deps.BrowserWindow(windowOptions(this.#deps.platform));
    lockWebContents(window.webContents, this.#deps.lock, this.#deps.shell);
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
    window.on('page-title-updated', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (this.#deps.quitting()) return;
      event.preventDefault();
      window.hide();
    });
    window.once('ready-to-show', () => window.show());
    this.#window = window;
    this.#loaded = false;
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
      this.#page = 'status';
      this.#status = kind;
      this.#loaded = false;
      void window.loadURL(statusPageUrl(kind)).catch(() => undefined);
    }
    this.show();
  }

  /** What the window shows now. */
  get page(): WindowPage {
    return this.#page;
  }

  /**
   * Loads a session link from the core's `ready` message. Refused (false, nothing loaded) unless the
   * link is valid and on the locked origin. The link is never logged or kept.
   */
  loadSessionUrl(url: string): boolean {
    if (!this.#deps.lock.acceptSessionUrl(url)) return false;
    const window = this.#ensure();
    this.#loaded = true;
    this.#page = 'session';
    this.#status = null;
    void window.loadURL(url).catch(() => undefined);
    return true;
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
    return true;
  }

  /** For a new core process: the origin may change, the old page is gone. */
  resetForNewCore(): void {
    this.#deps.lock.reset();
    this.#loaded = false;
  }

  destroy(): void {
    if (this.#window !== null && !this.#window.isDestroyed()) this.#window.destroy();
    this.#window = null;
  }
}
