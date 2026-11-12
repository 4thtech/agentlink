// DESK-TOUCHID-FIX: the page's side of a request that starts the desktop app's presence helper (the
// native presence kind on any owner route: approve, rules save, kit save, …; and turning Touch ID or
// Windows Hello on, or on again).
// - Before the request leaves, the focused element loses focus: a focused master-code field keeps
//   macOS secure input on, which can keep the Touch ID sheet from becoming key. (The desktop shell
//   also takes focus off the page as a backstop, apps/desktop/src/main/security.ts.)
// - While it waits, the app says "Rest your finger on the Touch ID key" with a Cancel. Cancel asks
//   the server (POST /api/owner/native/cancel) to stop the helper (SIGTERM; the helper closes its
//   sheet); the waiting request is left alone, and the screen gets the server's own answer: cancelled, or done when the touch was
//   already accepted. The page never makes an answer up.
// The page's `fetch` is wrapped once at start (main.tsx), like the generation guard, so every call
// site is covered. Nothing here sees or keeps a secret: only the method, the path and one header.
import { Button } from '@4thtech-io/ui';
import { useEffect, useSyncExternalStore, type ReactElement } from 'react';
import { desktopPlatform } from './desktop.js';
import { NATIVE_STRINGS } from './strings.js';
import './native-wait.css';

/** The routes that turn native presence on or on again (they run the helper; "off" does not). */
const HELPER_PATHS: readonly string[] = ['/api/owner/native', '/api/owner/native/replace'];

type HeaderBag = HeadersInit | undefined;

function presenceHeader(headers: HeaderBag): string | null {
  if (headers === undefined) return null;
  try {
    return new Headers(headers).get('X-AgentLink-Presence');
  } catch {
    return null;
  }
}

/**
 * True for a same-origin POST that will start the presence helper: `X-AgentLink-Presence: native`
 * on any route, or turning it on or on again.
 */
export function isNativePresenceRequest(
  method: string,
  url: string,
  headers: HeaderBag,
  origin: string = typeof location === 'undefined' ? 'http://localhost' : location.origin,
): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.origin !== new URL(origin).origin) return false;
  if (presenceHeader(headers)?.trim().toLowerCase() === 'native') return true;
  return HELPER_PATHS.includes(parsed.pathname);
}

// --- the waiting state ----------------------------------------------------------------------

/** Every request that started the helper and is not answered yet (Fable review L-4). */
let inFlight = 0;
/** The fetch the cancel request goes through (the wrapped page fetch's base). */
let cancelFetch: typeof fetch | undefined;
let inlineHosts = 0;
const listeners = new Set<() => void>();
const notify = (): void => {
  for (const l of [...listeners]) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
let snapshot = { waiting: false, inline: 0, cancelling: false };
let cancelling = false;
const refresh = (): void => {
  if (inFlight === 0) cancelling = false;
  snapshot = { waiting: inFlight > 0, inline: inlineHosts, cancelling };
  notify();
};

/** True while a request that started the helper has not been answered. */
export function nativeWaiting(): boolean {
  return inFlight > 0;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

/**
 * The Cancel button (Fable review M-1): asks the server to stop the helper of the operation in
 * progress (POST /api/owner/native/cancel). The waiting request itself is neither aborted nor
 * answered here: it ends with the server's own answer (cancelled, or done when the touch was
 * already accepted). Nothing when none is waiting.
 */
export function cancelNativeWait(fetcher: typeof fetch | undefined = cancelFetch): void {
  if (inFlight === 0 || fetcher === undefined) return;
  cancelling = true;
  refresh();
  void fetcher(CANCEL_PATH, {
    method: 'POST',
    headers: { 'X-AgentLink-CSRF': pageToken(), 'Content-Type': 'application/octet-stream' },
    credentials: 'same-origin',
    cache: 'no-store',
  }).catch(() => undefined);
}

const CANCEL_PATH = '/api/owner/native/cancel';

/** Takes focus off whatever has it (a focused password field keeps macOS secure input on). */
function blurFocused(): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

const methodOf = (input: RequestInfo | URL, init: RequestInit | undefined): string =>
  init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const headersOf = (input: RequestInfo | URL, init: RequestInit | undefined): HeaderBag =>
  init?.headers ??
  (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined);

/**
 * `base` with the native presence wait around the requests that start the helper. The request is
 * passed on exactly as given (its own signal included); only focus and the waiting state change.
 */
export function nativeWaitFetch(base: typeof fetch, origin: string): typeof fetch {
  cancelFetch = base;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (
      !isNativePresenceRequest(methodOf(input, init), urlOf(input), headersOf(input, init), origin)
    ) {
      return base(input, init);
    }
    blurFocused();
    inFlight += 1;
    refresh();
    try {
      return await (init === undefined ? base(input) : base(input, init));
    } finally {
      inFlight -= 1;
      refresh();
    }
  };
}

/** Wraps `window.fetch` once, before the first request (main.tsx). */
export function installNativeWait(win: Window = window): void {
  win.fetch = nativeWaitFetch(win.fetch.bind(win), win.location.origin);
}

/**
 * "Rest your finger on the Touch ID key" (Windows: the Windows Hello words) and Cancel, while a
 * request that started the helper waits. Mounted once for the whole app (main.tsx); a screen that
 * shows its own waiting line passes `inline` and the app-wide one stays hidden meanwhile. Nothing
 * in a browser.
 */
export function NativeWaitNotice({
  userAgent,
  inline = false,
}: {
  /** Seam (tests): the user agent; default navigator.userAgent. */
  readonly userAgent?: string;
  /** The screen's own waiting line (always shown while mounted). */
  readonly inline?: boolean;
}): ReactElement | null {
  const platform = desktopPlatform(userAgent);
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
  useEffect(() => {
    if (!inline) return undefined;
    inlineHosts += 1;
    refresh();
    return () => {
      inlineHosts -= 1;
      refresh();
    };
  }, [inline]);
  if (platform === undefined) return null;
  if (!inline && (!state.waiting || state.inline > 0)) return null;
  return (
    <div className={inline ? 'al-native-wait is-inline' : 'al-native-wait'}>
      <p className="al-text-body-sm" role="status" data-native-waiting="">
        {NATIVE_STRINGS.waiting(platform)}
      </p>
      <Button
        variant="ghost"
        onClick={() => cancelNativeWait()}
        disabled={state.cancelling}
        data-native-cancel=""
      >
        {NATIVE_STRINGS.cancel}
      </Button>
    </div>
  );
}
