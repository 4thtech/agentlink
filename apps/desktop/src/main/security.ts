// Window and session lockdown (plan Decision 3 "Window", §3 "Renderer compromise"; Fable H1).
//
// - webPreferences: sandbox, contextIsolation, no nodeIntegration (anywhere), no webview, no preload
//   (none is ever set), devtools off, and an IN-MEMORY session partition (no `persist:` prefix: no
//   cookies, storage or cache on disk; the session cookie dies with the app).
// - Origin lock: the window may show only the core's origin `http://localhost:<port>`, learned from
//   the first valid `ready` session link of a core process. will-navigate / will-redirect to anything
//   else are blocked; window.open is always denied (an https link on a fixed allowlist is handed to
//   the OS browser instead); webRequest cancels every other request; downloads are allowed only for
//   a blob: of the locked origin (the backup-code file).
// - Permissions: the request and check handlers deny everything except clipboard write from the
//   locked origin. Device pickers (HID, serial, USB, Bluetooth) and screen capture are refused.
// - WebAuthn (spike WP-D1a, 2026-11-12): in unsigned Electron on macOS there is NO platform
//   authenticator (isUserVerifyingPlatformAuthenticatorAvailable() is false) and a platform create()
//   hangs with no UI, while getClientCapabilities() falsely reports a platform authenticator and PRF.
//   Phase 1 therefore never starts a passkey request in the macOS window: WebAuthn is switched off in
//   the window's renderer (Blink feature `WebAuth`), so `PublicKeyCredential` is absent and the page's
//   presence screens take "Use Touch ID in your browser" (plan M2) or the master code. The user agent
//   carries a fixed marker naming the policy for the page. Pages detect support ONLY with
//   isUserVerifyingPlatformAuthenticatorAvailable(), never getClientCapabilities(). On Windows,
//   WebAuthn stays on in the window (Windows Hello through webauthn.dll; no PRF).
//
// Everything takes the Electron objects by injection (electron-api.ts) and is unit-tested.
import { sessionUrlOrigin } from '../shared/protocol.js';
import type {
  BrowserWindowOptions,
  Session,
  Shell,
  WebContents,
  WebPreferences,
} from './electron-api.js';

/** The window's session partition: no `persist:` prefix, so it lives in memory only. */
export const WINDOW_PARTITION = 'agentlink-window';

/** Permissions the window may get, and only from the locked origin. */
export const ALLOWED_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write'];

/** External https hosts a link may open in the OS browser (exact host match). */
export const EXTERNAL_HOSTS: readonly string[] = [
  'agentlink.4thtech.io',
  'wiki.4thtech.io',
  'github.com',
  'basescan.org',
  'sepolia.basescan.org',
];

/** The only github.com path prefix a link may open (D15-11). */
export const GITHUB_REPO_PATH = '/4thtech/agentlink';

/** Where owner presence (passkey) may run, per platform (phase 1). */
export type PasskeyPolicy = 'window' | 'browser';

/** Phase 1: on macOS the passkey step runs in the browser, never in the window (WP-D1a). */
export function passkeyPolicy(platform: string): PasskeyPolicy {
  return platform === 'darwin' ? 'browser' : 'window';
}

/** The fixed user-agent marker for the page: `AgentLinkDesktop/1 (passkey=<policy>)`. */
export function userAgentMarker(platform: string): string {
  return `AgentLinkDesktop/1 (passkey=${passkeyPolicy(platform)})`;
}

/**
 * Puts the marker on the window's own web contents too (DESK-D12c: the page offers Touch ID /
 * Windows Hello only when navigator.userAgent has it). The session's user agent does not reach web
 * contents that already exist, so this does not rely on the order. Never added twice.
 */
export function markWebContents(contents: WebContents, platform: string): void {
  const current = contents.getUserAgent();
  if (/(?:^|\s)AgentLinkDesktop\/1(?:\s|$)/.test(current)) return;
  contents.setUserAgent(`${current} ${userAgentMarker(platform)}`);
}

/** The Blink feature that turns WebAuthn (navigator.credentials publicKey) on in a renderer. */
export const WEBAUTHN_BLINK_FEATURE = 'WebAuth';

/** The window's webPreferences: fixed, nothing optional, no preload. */
export function webPreferences(platform: string): WebPreferences {
  const base = {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    devTools: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
    partition: WINDOW_PARTITION,
  } as const;
  return passkeyPolicy(platform) === 'browser'
    ? { ...base, disableBlinkFeatures: WEBAUTHN_BLINK_FEATURE }
    : base;
}

/** The main window's options. */
export function windowOptions(platform: string): BrowserWindowOptions {
  return {
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: 'AgentLink',
    backgroundColor: '#0f1115',
    webPreferences: webPreferences(platform),
  };
}

/**
 * The origin the window is locked to. Unset until the first valid session link; after that a link
 * with another origin is refused until `reset()` (a new core process, which may listen elsewhere).
 */
export class OriginLock {
  #origin: string | null = null;

  get origin(): string | null {
    return this.#origin;
  }

  /**
   * Accepts a session link from the core: true when it is valid and has the locked origin (locking
   * it the first time). False means: do not load it.
   */
  acceptSessionUrl(url: string): boolean {
    const origin = sessionUrlOrigin(url);
    if (origin === null) return false;
    if (this.#origin === null) {
      this.#origin = origin;
      return true;
    }
    return origin === this.#origin;
  }

  reset(): void {
    this.#origin = null;
  }

  /** True when `url` is on the locked origin (http, host `localhost`, that port, no credentials). */
  allows(url: string): boolean {
    if (this.#origin === null) return false;
    const parsed = parseUrl(url);
    if (parsed === null) return false;
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') {
      const http = parsed.protocol === 'ws:' ? `http://${parsed.host}` : parsed.origin;
      return http === this.#origin && parsed.hostname === 'localhost';
    }
    return false;
  }

  /** True for a `blob:` URL created by a document of the locked origin. */
  allowsBlob(url: string): boolean {
    if (this.#origin === null || !url.startsWith('blob:')) return false;
    return this.allows(url.slice('blob:'.length));
  }
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True for an https link to an allowlisted host (no credentials, default port). */
export function isAllowedExternal(url: string): boolean {
  const parsed = parseUrl(url);
  if (parsed === null || parsed.protocol !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return false;
  if (!EXTERNAL_HOSTS.includes(parsed.hostname)) return false;
  // D15-11: on GitHub only this repository's pages (GitHub paths are case-insensitive).
  if (parsed.hostname === 'github.com') {
    const path = parsed.pathname.toLowerCase();
    return path === GITHUB_REPO_PATH || path.startsWith(`${GITHUB_REPO_PATH}/`);
  }
  return true;
}

/** True when a request from the window may proceed (webRequest.onBeforeRequest). */
export function requestAllowed(lock: OriginLock, url: string): boolean {
  if (lock.allows(url) || lock.allowsBlob(url)) return true;
  // Inline images/fonts the page builds itself; they cause no network request.
  return url.startsWith('data:');
}

/**
 * Locks one webContents (the window's, and any other one that is ever created): navigation only on
 * the locked origin, every window.open denied (allowlisted https → OS browser), no webview, devtools
 * closed if they open, no Bluetooth device picker.
 */
export function lockWebContents(
  contents: WebContents,
  lock: OriginLock,
  shell: Pick<Shell, 'openExternal'>,
): void {
  const block = (event: { preventDefault(): void }, url: string): void => {
    if (!lock.allows(url)) event.preventDefault();
  };
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('devtools-opened', () => contents.closeDevTools());
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
}

const originOf = (url: string | undefined): string | null => {
  if (url === undefined) return null;
  const parsed = parseUrl(url);
  return parsed === null ? null : parsed.origin;
};

/** The permission decision (request and check handlers share it). */
export function permissionAllowed(
  lock: OriginLock,
  permission: string,
  requestingUrl: string | undefined,
): boolean {
  if (!ALLOWED_PERMISSIONS.includes(permission)) return false;
  const origin = originOf(requestingUrl);
  return origin !== null && lock.origin !== null && origin === lock.origin;
}

/** DESK-TOUCHID-FIX: the routes that turn native presence on or on again (they run the helper). */
const NATIVE_HELPER_PATHS: readonly string[] = ['/api/owner/native', '/api/owner/native/replace'];

/**
 * DESK-TOUCHID-FIX: true for a request that will start the native presence helper: a POST with
 * `X-AgentLink-Presence: native` (any owner route), or a POST that turns it on or on again.
 */
export function isNativePresenceRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const parsed = parseUrl(url);
  if (parsed === null) return false;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-agentlink-presence' && value.trim().toLowerCase() === 'native') {
      return true;
    }
  }
  return NATIVE_HELPER_PATHS.includes(parsed.pathname);
}

/**
 * Hardens the window's session: permissions, device pickers, screen capture, requests, downloads,
 * a direct proxy (a system proxy never sees the loopback traffic) and the user-agent marker.
 * DESK-TOUCHID-FIX: `onNativePresence` runs before a request that starts the presence helper leaves
 * the window (main.ts takes focus off the page with it, so a focused master-code field cannot keep
 * macOS secure input on while the Touch ID sheet wants to become key). The page blurs the field
 * itself first; this is the backstop. Headers pass unchanged.
 */
export async function hardenSession(
  session: Session,
  lock: OriginLock,
  platform: string,
  onNativePresence?: () => void,
): Promise<void> {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permissionAllowed(lock, permission, details.requestingUrl));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    permissionAllowed(lock, permission, requestingOrigin),
  );
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  for (const picker of ['select-hid-device', 'select-serial-port', 'select-usb-device'] as const) {
    session.on(picker, (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
  }
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !requestAllowed(lock, details.url) });
  });
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (
      onNativePresence !== undefined &&
      lock.allows(details.url) &&
      isNativePresenceRequest(details.method, details.url, details.requestHeaders)
    ) {
      try {
        onNativePresence();
      } catch {
        // Never blocks the request.
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  session.on('will-download', (event, item) => {
    if (!lock.allowsBlob(item.getURL())) {
      event.preventDefault();
      item.cancel();
    }
  });
  session.setUserAgent(`${session.getUserAgent()} ${userAgentMarker(platform)}`);
  await session.setProxy({ mode: 'direct' });
}
