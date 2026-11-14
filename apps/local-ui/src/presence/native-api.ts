// DESK-D12c: the page's two calls for native presence (08 §1 `/api/owner/native`; 04 §2.3.4).
// - GET: whether this computer's helper is there and turned on for the owner (public).
// - POST: turns it on, its own owner operation; the body is the master code (as every owner route
//   takes it), sent once to this same-origin server, never logged or kept here.
// Confirming with it is the presence kind `native` (`X-AgentLink-Presence: native`, empty body) on
// the screen's existing route; the page never runs the helper and never sees a secret.
import { NATIVE_STATES, type NativeOutcomeKind, type NativeState } from './strings.js';

export interface NativeStatus {
  readonly available: boolean;
  readonly registered: boolean;
  /** Why it cannot be used now: turn it on again (`reregister`, `damaged`), or another owner's. */
  readonly reason?: 'reregister' | 'damaged' | 'other_owner';
  /**
   * WIN-HELLO-NATIVE: why it is not available on this computer (only when `available` is false):
   * not set up, no secure hardware, or unknown. The page offers the master code with plain set-up
   * text (offer.ts), never the WebAuthn security-key path.
   */
  readonly unavailable?: NativeUnavailable;
}

export type NativeUnavailable = 'not_set_up' | 'no_secure_hardware' | 'unknown';
const isUnavailable = (value: unknown): value is NativeUnavailable =>
  value === 'not_set_up' || value === 'no_secure_hardware' || value === 'unknown';

/** Every outcome has one fixed message (strings.ts nativeOutcomeText); none is silent. */
export type NativeRegistration = NativeOutcomeKind;

/**
 * DESK-NATIVE-DEBUG: the longest the page waits for a turn on / off / on again: the OS prompt
 * (120 s in the helper) and the keychain calls; then it says so instead of waiting silently.
 */
export const NATIVE_PAGE_TIMEOUT_MS = 200_000;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const NONE: NativeStatus = Object.freeze({ available: false, registered: false });

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

const defaultFetch: Fetch = (input, init) => globalThis.fetch(input, init);

/** GET /api/owner/native; anything but the exact answer is "not available". */
export async function readNativeStatus(
  fetcher: Fetch = defaultFetch,
  token: string = pageToken(),
): Promise<NativeStatus> {
  try {
    const res = await fetcher('/api/owner/native', {
      method: 'GET',
      headers: { 'X-AgentLink-CSRF': token },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.status !== 200) return NONE;
    const body = (await res.json()) as { native?: unknown };
    const n = body.native as Record<string, unknown> | null | undefined;
    if (typeof n !== 'object' || n === null) return NONE;
    if (typeof n['available'] !== 'boolean' || typeof n['registered'] !== 'boolean') return NONE;
    const reason = n['reason'];
    const unavailable = n['unavailable'];
    return {
      available: n['available'],
      registered: n['registered'],
      ...(reason === 'reregister' || reason === 'damaged' || reason === 'other_owner'
        ? { reason }
        : {}),
      ...(n['available'] === false && isUnavailable(unavailable) ? { unavailable } : {}),
    };
  } catch {
    return NONE;
  }
}

const isState = (value: unknown): value is NativeState =>
  typeof value === 'string' && (NATIVE_STATES as readonly string[]).includes(value);

/** POST /api/owner/native with the master code; the OS prompt follows on the server's side. */
export function registerNative(
  backupCode: string,
  fetcher: Fetch = defaultFetch,
  token: string = pageToken(),
  timeoutMs?: number,
): Promise<NativeRegistration> {
  return nativeOp('/api/owner/native', backupCode, fetcher, token, timeoutMs);
}

/** Fable review M1: turn it off (the master code; never Touch ID itself). */
export function turnOffNative(
  backupCode: string,
  fetcher: Fetch = defaultFetch,
  token: string = pageToken(),
  timeoutMs?: number,
): Promise<NativeRegistration> {
  return nativeOp('/api/owner/native/off', backupCode, fetcher, token, timeoutMs);
}

/** Fable review M1: turn it on again after a fingerprint or sign-in change (one gesture). */
export function replaceNative(
  backupCode: string,
  fetcher: Fetch = defaultFetch,
  token: string = pageToken(),
  timeoutMs?: number,
): Promise<NativeRegistration> {
  return nativeOp('/api/owner/native/replace', backupCode, fetcher, token, timeoutMs);
}

async function nativeOp(
  path: string,
  backupCode: string,
  fetcher: Fetch,
  token: string,
  timeoutMs: number = NATIVE_PAGE_TIMEOUT_MS,
): Promise<NativeRegistration> {
  const body = new TextEncoder().encode(backupCode);
  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, timeoutMs);
  try {
    const res = await fetcher(path, {
      method: 'POST',
      headers: { 'X-AgentLink-CSRF': token, 'Content-Type': 'application/octet-stream' },
      credentials: 'same-origin',
      body,
      signal: stop.signal,
    });
    let answer: Record<string, unknown> = {};
    try {
      answer = (await res.json()) as Record<string, unknown>;
    } catch {
      answer = {};
    }
    const status = answer['status'];
    if (res.status === 200 && status === 'registered') return { kind: 'registered' };
    if (res.status === 200 && status === 'off') return { kind: 'off' };
    // Already off: nothing to do.
    if (status === 'native_missing') return { kind: 'off' };
    // Already on (another tab, or an earlier setup): nothing to do.
    if (status === 'native_exists') return { kind: 'registered' };
    // DESK-TOUCHID-FIX review (Fable L-2): on again failed after the old one was removed: off now.
    if (answer['nowOff'] === true) {
      return {
        kind: 'native',
        state: isState(answer['native']) ? answer['native'] : 'error',
        nowOff: true,
      };
    }
    if (status === 'native_unavailable') return { kind: 'native', state: 'unavailable' };
    if (isState(answer['native'])) return { kind: 'native', state: answer['native'] };
    if (status === 'presence_rejected') return { kind: 'rejected' };
    if (status === 'busy') return { kind: 'busy' };
    if (status === 'wait' || res.status === 429) return { kind: 'wait' };
    if (status === 'needs_setup') return { kind: 'needs_setup' };
    return { kind: 'failed' };
  } catch {
    return timedOut ? { kind: 'timeout' } : { kind: 'failed' };
  } finally {
    clearTimeout(timer);
    body.fill(0);
  }
}

/** The fixed state a presence route answered for the native kind, if any. */
export function nativeStateOf(answer: unknown): NativeState | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const value = (answer as { native?: unknown }).native;
  return isState(value) ? value : undefined;
}
