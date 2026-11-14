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
  /** DESK051-UPD: an Intel copy running under Rosetta on Apple silicon (macOS only). */
  readonly runningUnderARM64Translation?: boolean;
  quit(): void;
  exit(code?: number): void;
  /** D15-01: start an executable once this one exits (default: this app with its own arguments). */
  relaunch?(options?: { execPath?: string; args?: string[] }): void;
  isInApplicationsFolder?(): boolean;
  /** N7: the dock (macOS) / launcher (Linux) badge number; false where the OS has none. */
  setBadgeCount?(count?: number): boolean;
  /** N7 (Windows): the AppUserModelID toasts are attributed to. */
  setAppUserModelId?(id: string): void;
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

/** DESK-TOUCHID-FIX: what onBeforeSendHeaders sees of a request. */
export interface OnBeforeSendHeadersDetails {
  readonly url: string;
  readonly method: string;
  readonly requestHeaders: Record<string, string>;
}

export interface WebRequest {
  onBeforeSendHeaders(
    listener: (
      details: OnBeforeSendHeadersDetails,
      callback: (response: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void,
    ) => void,
  ): void;
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
  /** The committed URL of the main frame. */
  getURL(): string;
  /** The page's user agent (navigator.userAgent and the request header). */
  getUserAgent(): string;
  setUserAgent(userAgent: string): void;
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
  /** DESK-TOUCHID-FIX: takes keyboard focus away from the web contents. */
  blurWebView(): void;
  hide(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  /** NOTIFY-FOCUS: the window is the one the person is using right now. */
  isFocused(): boolean;
  isVisible(): boolean;
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
  /** Opens a local folder in the OS file manager (Finder / Explorer). Resolves '' on success. */
  openPath(path: string): Promise<string>;
}

export interface NativeImage {
  isEmpty(): boolean;
  setTemplateImage(template: boolean): void;
}

export interface NativeImageModule {
  createFromPath(path: string): NativeImage;
  createFromBuffer(buffer: Uint8Array, options?: { scaleFactor?: number }): NativeImage;
}

/** N7: a native notification's options (only these: no icon path, no actions, no reply). */
export interface NotificationOptions {
  readonly title: string;
  readonly body: string;
}

/** N7: Electron's main-process Notification (only what the shell uses). */
export interface NativeNotification {
  on(event: 'click' | 'close', listener: () => void): void;
  show(): void;
}

export interface NotificationConstructor {
  new (options: NotificationOptions): NativeNotification;
  isSupported(): boolean;
}

/** The Electron module as main.ts uses it. */
export interface ElectronModule {
  readonly app: App;
  readonly BrowserWindow: BrowserWindowConstructor;
  readonly session: { fromPartition(partition: string, options?: { cache: boolean }): Session };
  readonly Tray: new (icon: string | NativeImage) => Tray;
  readonly nativeImage: NativeImageModule;
  readonly Menu: { buildFromTemplate(template: MenuItemOptions[]): Menu };
  readonly dialog: Dialog;
  readonly shell: Shell;
  /** DESK051-UPD: whether the computer is online (no request is made while it is not). */
  readonly net?: { isOnline(): boolean };
  /** N7: native notifications (main process). */
  readonly Notification?: NotificationConstructor;
  /** WIN-DESK-2: Windows only, whether the taskbar is dark (picks the tray icon). */
  readonly nativeTheme?: { readonly shouldUseDarkColorsForSystemIntegratedUI?: boolean };
}
