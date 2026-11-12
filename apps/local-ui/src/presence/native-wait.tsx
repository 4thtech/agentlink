// DESK-TOUCHID-FIX: the page's side of a request that starts the desktop app's presence helper (the
// native presence kind on any owner route: approve, rules save, kit save, …; and turning Touch ID or
// Windows Hello on, or on again).
// - Before the request leaves, the focused element loses focus: a focused master-code field keeps
//   macOS secure input on, which can keep the Touch ID sheet from becoming key. (The desktop shell
//   also takes focus off the page as a backstop, apps/desktop/src/main/security.ts.)
// - While it waits, the app says "Rest your finger on the Touch ID key" with a Cancel. Cancel ends
//   the request; the server sees the page go away and stops the helper (SIGTERM; the helper closes
//   its sheet), and the screen gets the server's own "cancelled" answer (403, presence_rejected,
//   native: cancelled), so it shows its usual message, never "offline".
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

// --- the waiting state (one at a time: the server runs one presence at a time) -----------------

let current: AbortController | undefined;
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
let snapshot = { waiting: false, inline: 0 };
const refresh = (): void => {
  snapshot = { waiting: current !== undefined, inline: inlineHosts };
  notify();
};

/** True while a request that started the helper has not been answered. */
export function nativeWaiting(): boolean {
  return current !== undefined;
}

/** Ends the waiting request (the Cancel button). Nothing when none is waiting. */
export function cancelNativeWait(): void {
  current?.abort();
}

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

/** The server's own answer for a cancelled native presence (approval-server.ts NATIVE_HTTP). */
function cancelledAnswer(): Response {
  return new Response(JSON.stringify({ status: 'presence_rejected', native: 'cancelled' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });
}

/** `base` with the native presence wait around the requests that start the helper. */
export function nativeWaitFetch(base: typeof fetch, origin: string): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (
      !isNativePresenceRequest(methodOf(input, init), urlOf(input), headersOf(input, init), origin)
    ) {
      return base(input, init);
    }
    blurFocused();
    const stop = new AbortController();
    const own = init?.signal ?? undefined;
    const follow = (): void => stop.abort();
    if (own?.aborted === true) stop.abort();
    else own?.addEventListener('abort', follow, { once: true });
    current = stop;
    refresh();
    try {
      return await base(input, { ...init, signal: stop.signal });
    } catch (error) {
      // Our Cancel (not the caller's own abort): the answer the server gives for a cancelled
      // prompt, so every screen shows its usual "Cancelled. Nothing was changed." and never "offline".
      if (stop.signal.aborted && own?.aborted !== true) return cancelledAnswer();
      throw error;
    } finally {
      own?.removeEventListener('abort', follow);
      if (current === stop) current = undefined;
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
      <Button variant="ghost" onClick={cancelNativeWait} data-native-cancel="">
        {NATIVE_STRINGS.cancel}
      </Button>
    </div>
  );
}
