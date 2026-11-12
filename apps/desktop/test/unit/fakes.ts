// Fakes of the Electron main-process API subset (src/main/electron-api.ts) and of a child process
// with an fd 3 stream, for the unit tests. No Electron binary is involved.
import { EventEmitter } from 'node:events';
import type {
  App,
  BrowserWindow,
  BrowserWindowOptions,
  DownloadItem,
  ElectronEvent,
  ElectronModule,
  Menu,
  MenuItemOptions,
  MessageBoxOptions,
  OnBeforeRequestDetails,
  PermissionRequestDetails,
  Session,
  Tray,
  WebContents,
} from '../../src/main/electron-api.js';
import type { CoreChild, SpawnOptions, Timers } from '../../src/main/core-process.js';

export class FakeEvent implements ElectronEvent {
  defaultPrevented = false;
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Listener = (...args: never[]) => unknown;

class Emitter {
  readonly listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  once(event: string, listener: Listener): void {
    this.on(event, listener);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: unknown[]) => unknown)(...args);
    }
  }
  count(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

export class FakeWebContents extends Emitter implements WebContents {
  windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null;
  devToolsClosed = 0;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void {
    this.windowOpenHandler = handler;
  }
  closeDevTools(): void {
    this.devToolsClosed += 1;
  }
  /** Emits a navigation-like event and returns whether it was blocked. */
  navigate(event: 'will-navigate' | 'will-redirect', url: string): boolean {
    const e = new FakeEvent();
    this.emit(event, e, url);
    return e.defaultPrevented;
  }
}

export class FakeBrowserWindow extends Emitter implements BrowserWindow {
  static created: FakeBrowserWindow[] = [];
  readonly webContents = new FakeWebContents();
  readonly loaded: string[] = [];
  visible = false;
  destroyed = false;
  shows = 0;
  constructor(readonly options: BrowserWindowOptions) {
    super();
    FakeBrowserWindow.created.push(this);
  }
  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    return Promise.resolve();
  }
  show(): void {
    this.visible = true;
    this.shows += 1;
  }
  focus(): void {}
  hide(): void {
    this.visible = false;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return false;
  }
  restore(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

export class FakeSession extends Emitter implements Session {
  permissionRequest:
    | ((
        contents: WebContents,
        permission: string,
        callback: (granted: boolean) => void,
        details: PermissionRequestDetails,
      ) => void)
    | null = null;
  permissionCheck:
    ((contents: WebContents | null, permission: string, origin: string) => boolean) | null = null;
  deviceHandler: (() => boolean) | null = null;
  displayMedia: ((request: unknown, callback: (s: Record<string, never>) => void) => void) | null =
    null;
  beforeRequest:
    | ((details: OnBeforeRequestDetails, callback: (r: { cancel?: boolean }) => void) => void)
    | null = null;
  proxy: unknown = null;
  userAgent = 'Mozilla/5.0 Chrome/156 Electron/45.1.0';
  readonly webRequest = {
    onBeforeRequest: (
      listener: (
        details: OnBeforeRequestDetails,
        callback: (r: { cancel?: boolean }) => void,
      ) => void,
    ): void => {
      this.beforeRequest = listener;
    },
  };
  setPermissionRequestHandler(handler: NonNullable<FakeSession['permissionRequest']>): void {
    this.permissionRequest = handler;
  }
  setPermissionCheckHandler(handler: NonNullable<FakeSession['permissionCheck']>): void {
    this.permissionCheck = handler;
  }
  setDevicePermissionHandler(handler: () => boolean): void {
    this.deviceHandler = handler;
  }
  setDisplayMediaRequestHandler(handler: NonNullable<FakeSession['displayMedia']>): void {
    this.displayMedia = handler;
  }
  setProxy(config: { mode: 'direct' }): Promise<void> {
    this.proxy = config;
    return Promise.resolve();
  }
  setUserAgent(userAgent: string): void {
    this.userAgent = userAgent;
  }
  getUserAgent(): string {
    return this.userAgent;
  }
  /** Runs the permission request handler; resolves with the decision. */
  request(permission: string, requestingUrl?: string): boolean {
    let granted: boolean | undefined;
    this.permissionRequest?.(
      new FakeWebContents(),
      permission,
      (g) => {
        granted = g;
      },
      requestingUrl === undefined ? {} : { requestingUrl },
    );
    if (granted === undefined) throw new Error('permission callback not called');
    return granted;
  }
  /** Runs the webRequest listener; true when the request is cancelled. */
  cancels(url: string): boolean {
    let cancel: boolean | undefined;
    this.beforeRequest?.({ url }, (r) => {
      cancel = r.cancel === true;
    });
    if (cancel === undefined) throw new Error('webRequest callback not called');
    return cancel;
  }
  download(url: string): { blocked: boolean; cancelled: boolean } {
    const event = new FakeEvent();
    let cancelled = false;
    const item: DownloadItem = {
      getURL: () => url,
      cancel: () => {
        cancelled = true;
      },
    };
    this.emit('will-download', event, item, new FakeWebContents());
    return { blocked: event.defaultPrevented, cancelled };
  }
}

export class FakeTray extends Emitter implements Tray {
  static created: FakeTray[] = [];
  tooltip = '';
  menu: Menu | null = null;
  destroyed = false;
  constructor(readonly icon: string) {
    super();
    FakeTray.created.push(this);
  }
  setToolTip(text: string): void {
    this.tooltip = text;
  }
  setContextMenu(menu: Menu): void {
    this.menu = menu;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export interface FakeMenu extends Menu {
  readonly template: MenuItemOptions[];
}

export class FakeApp extends Emitter implements App {
  isPackaged = true;
  switches = new Set<string>();
  readonly commandLine = { hasSwitch: (name: string): boolean => this.switches.has(name) };
  sandboxEnabled = false;
  lockGranted = true;
  lockData: Record<string, unknown> | undefined;
  exitCode: number | null = null;
  quitCalls = 0;
  inApplications = false;
  moveResult = true;
  moveCalls = 0;
  readonly order: string[] = [];
  enableSandbox(): void {
    this.sandboxEnabled = true;
    this.order.push('sandbox');
  }
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean {
    this.lockData = additionalData;
    this.order.push('lock');
    return this.lockGranted;
  }
  whenReady(): Promise<void> {
    this.order.push('ready');
    return Promise.resolve();
  }
  quit(): void {
    this.quitCalls += 1;
    const event = new FakeEvent();
    this.emit('before-quit', event);
  }
  exit(code?: number): void {
    this.exitCode = code ?? 0;
    this.order.push(`exit:${this.exitCode}`);
  }
  isInApplicationsFolder(): boolean {
    return this.inApplications;
  }
  moveToApplicationsFolder(): boolean {
    this.moveCalls += 1;
    return this.moveResult;
  }
}

export class FakeDialog {
  readonly shown: MessageBoxOptions[] = [];
  responses: number[] = [];
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }> {
    this.shown.push(options);
    return Promise.resolve({ response: this.responses.shift() ?? 0 });
  }
}

export interface FakeElectron extends ElectronModule {
  readonly app: FakeApp;
  readonly dialog: FakeDialog;
  readonly sessions: Map<string, FakeSession>;
  readonly opened: string[];
}

export function fakeElectron(): FakeElectron {
  FakeBrowserWindow.created = [];
  FakeTray.created = [];
  const sessions = new Map<string, FakeSession>();
  const opened: string[] = [];
  return {
    app: new FakeApp(),
    BrowserWindow: FakeBrowserWindow,
    session: {
      fromPartition: (partition: string) => {
        const existing = sessions.get(partition);
        if (existing !== undefined) return existing;
        const created = new FakeSession();
        sessions.set(partition, created);
        return created;
      },
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template: MenuItemOptions[]): FakeMenu => ({ template }) },
    dialog: new FakeDialog(),
    shell: {
      openExternal: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
    sessions,
    opened,
  };
}

/** A fake fd 3 stream: the test writes core lines with `push`, reads shell lines from `written`. */
export class FakeStream extends EventEmitter {
  readonly written: string[] = [];
  destroyed = false;
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
  push(text: string | Uint8Array): void {
    this.emit('data', typeof text === 'string' ? new TextEncoder().encode(text) : text);
  }
}

export class FakeChild extends EventEmitter implements CoreChild {
  readonly stream = new FakeStream();
  readonly stdio: unknown[] = [null, null, null, this.stream];
  exitCode: number | null = null;
  readonly kills: string[] = [];
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: SpawnOptions,
  ) {
    super();
  }
  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): boolean {
    this.kills.push(signal);
    return true;
  }
  /** The process exits. */
  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

export class FakeTimers implements Timers {
  time = 0;
  private next = 1;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, ms: number): number {
    const id = this.next++;
    this.pending.set(id, { at: this.time + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  now(): number {
    return this.time;
  }
  /** Advances time and runs due timers in order. */
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.pending.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = until;
  }
}

export function fakeSpawn(): {
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => FakeChild;
  children: FakeChild[];
} {
  const children: FakeChild[] = [];
  return {
    children,
    spawn: (command, args, options) => {
      const child = new FakeChild(command, args, options);
      children.push(child);
      return child;
    },
  };
}

export const TOKEN = 'A'.repeat(43);
export const SESSION_URL = `http://localhost:4567/?t=${TOKEN}`;
export const readyLine = (url = SESSION_URL): string =>
  `${JSON.stringify({ v: 1, type: 'ready', sessionUrl: url })}\n`;
