// The one main window (plan Decision 3 "Window"). It is created hidden with the locked-down
// webPreferences (security.ts), shows only the core's origin, and loads a session link only when the
// core sent it over the pipe (never from argv, a deep link or the OS opener). Closing the window
// hides it; the app keeps running in the tray until the person quits. The title stays "AgentLink"
// (a page title could carry a name; the window switcher and screen sharing would show it).
import type { BrowserWindow, BrowserWindowConstructor, Shell } from './electron-api.js';
import { OriginLock, lockWebContents, windowOptions } from './security.js';

export interface MainWindowDeps {
  readonly BrowserWindow: BrowserWindowConstructor;
  readonly shell: Shell;
  readonly lock: OriginLock;
  readonly platform: string;
  /** True once the app is quitting: then a close really closes. */
  readonly quitting: () => boolean;
}

export class MainWindow {
  readonly #deps: MainWindowDeps;
  #window: BrowserWindow | null = null;
  #loaded = false;

  constructor(deps: MainWindowDeps) {
    this.#deps = deps;
  }

  /** The window, created on first use. */
  #ensure(): BrowserWindow {
    if (this.#window !== null && !this.#window.isDestroyed()) return this.#window;
    const window = new this.#deps.BrowserWindow(windowOptions(this.#deps.platform));
    lockWebContents(window.webContents, this.#deps.lock, this.#deps.shell);
    window.on('page-title-updated', (event) => event.preventDefault());
    window.on('close', (event) => {
      if (this.#deps.quitting()) return;
      event.preventDefault();
      window.hide();
    });
    window.once('ready-to-show', () => window.show());
    this.#window = window;
    this.#loaded = false;
    return window;
  }

  /**
   * Loads a session link from the core's `ready` message. Refused (false, nothing loaded) unless the
   * link is valid and on the locked origin. The link is never logged or kept.
   */
  loadSessionUrl(url: string): boolean {
    if (!this.#deps.lock.acceptSessionUrl(url)) return false;
    const window = this.#ensure();
    this.#loaded = true;
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
