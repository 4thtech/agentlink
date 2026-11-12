// The subset of the Electron main-process API the shell uses, typed here (types only, no runtime).
//
// Why local types: the plan (Decision 1, M4) forbids the `electron` npm package (its install step
// downloads a binary) and there is no types-only package of Electron. The shell modules take these
// interfaces by injection, so every lockdown rule is unit-tested without a running Electron; main.ts
// obtains the real module with `createRequire(import.meta.url)('electron')` inside Electron only.
// Shapes follow the Electron 45 API documentation; only what the shell calls is declared.

export interface ElectronEvent {
  preventDefault(): void;
}

export interface CommandLine {
  hasSwitch(name: string): boolean;
}

export interface App {
  readonly commandLine: CommandLine;
  readonly isPackaged: boolean;
  enableSandbox(): void;
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
  whenReady(): Promise<void>;
  /** WP-D10 updater: the installed version and the app's own data folder. */
  getVersion?(): string;
  getPath?(name: 'userData'): string;
  quit(): void;
  exit(code?: number): void;
  isInApplicationsFolder?(): boolean;
  moveToApplicationsFolder?(options?: {
    conflictHandler?: (conflictType: 'exists' | 'existsAndRunning') => boolean;
  }): boolean;
  on(
    event: 'web-contents-created',
    listener: (event: ElectronEvent, contents: WebContents) => void,
  ): void;
  on(
    event: 'second-instance',
    listener: (
      event: ElectronEvent,
      argv: string[],
      workingDirectory: string,
      additionalData: unknown,
    ) => void,
  ): void;
  on(event: 'open-url', listener: (event: ElectronEvent, url: string) => void): void;
  on(event: 'before-quit', listener: (event: ElectronEvent) => void): void;
  on(event: 'window-all-closed' | 'activate', listener: () => void): void;
}

export interface PermissionRequestDetails {
  readonly requestingUrl?: string;
}

export interface DownloadItem {
  getURL(): string;
  cancel(): void;
}

export interface OnBeforeRequestDetails {
  readonly url: string;
}

export interface WebRequest {
  onBeforeRequest(
    listener: (
      details: OnBeforeRequestDetails,
      callback: (response: { cancel?: boolean }) => void,
    ) => void,
  ): void;
}

export interface Session {
  readonly webRequest: WebRequest;
  setPermissionRequestHandler(
    handler: (
      webContents: WebContents,
      permission: string,
      callback: (granted: boolean) => void,
      details: PermissionRequestDetails,
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      webContents: WebContents | null,
      permission: string,
      requestingOrigin: string,
    ) => boolean,
  ): void;
  setDevicePermissionHandler(handler: () => boolean): void;
  setDisplayMediaRequestHandler(
    handler: (request: unknown, callback: (streams: Record<string, never>) => void) => void,
  ): void;
  setProxy(config: { mode: 'direct' }): Promise<void>;
  setUserAgent(userAgent: string): void;
  getUserAgent(): string;
  on(
    event: 'will-download',
    listener: (event: ElectronEvent, item: DownloadItem, contents: WebContents) => void,
  ): void;
  on(
    event: 'select-hid-device' | 'select-serial-port' | 'select-usb-device',
    listener: (event: ElectronEvent, details: unknown, callback: (id?: string) => void) => void,
  ): void;
}

export interface WindowOpenHandlerResponse {
  readonly action: 'deny';
}

export interface WebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResponse): void;
  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (event: ElectronEvent, url: string) => void,
  ): void;
  on(event: 'will-attach-webview', listener: (event: ElectronEvent) => void): void;
  on(event: 'devtools-opened', listener: () => void): void;
  on(
    event: 'select-bluetooth-device',
    listener: (event: ElectronEvent, devices: unknown[], callback: (id: string) => void) => void,
  ): void;
  closeDevTools(): void;
}

export interface WebPreferences {
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webviewTag: false;
  readonly devTools: false;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly experimentalFeatures: false;
  readonly navigateOnDragDrop: false;
  readonly safeDialogs: true;
  readonly spellcheck: false;
  readonly partition: string;
  readonly disableBlinkFeatures?: string;
}

export interface BrowserWindowOptions {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly show: boolean;
  readonly title: string;
  readonly backgroundColor: string;
  readonly webPreferences: WebPreferences;
}

export interface BrowserWindow {
  readonly webContents: WebContents;
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  hide(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  destroy(): void;
  on(event: 'close', listener: (event: ElectronEvent) => void): void;
  on(event: 'page-title-updated', listener: (event: ElectronEvent) => void): void;
  once(event: 'ready-to-show', listener: () => void): void;
}

export type BrowserWindowConstructor = new (options: BrowserWindowOptions) => BrowserWindow;

export interface MenuItemOptions {
  readonly label?: string;
  readonly type?: 'separator';
  readonly click?: () => void;
}

export interface Menu {
  readonly __menu?: never;
}

export interface Tray {
  setToolTip(text: string): void;
  setContextMenu(menu: Menu): void;
  on(event: 'click', listener: () => void): void;
  destroy(): void;
}

export interface MessageBoxOptions {
  readonly type: 'warning' | 'error' | 'info';
  readonly title: string;
  readonly message: string;
  readonly detail?: string;
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink?: boolean;
}

export interface Dialog {
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>;
}

export interface Shell {
  openExternal(url: string): Promise<void>;
  /** WP-D10: opens the verified installer the person chose to open (resolves '' on success). */
  openPath?(path: string): Promise<string>;
}

/** The Electron module as main.ts uses it. */
export interface ElectronModule {
  readonly app: App;
  readonly BrowserWindow: BrowserWindowConstructor;
  readonly session: { fromPartition(partition: string, options?: { cache: boolean }): Session };
  readonly Tray: new (iconPath: string) => Tray;
  readonly Menu: { buildFromTemplate(template: MenuItemOptions[]): Menu };
  readonly dialog: Dialog;
  readonly shell: Shell;
}
