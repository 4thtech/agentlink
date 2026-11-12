// DESK-D12c: the page's two calls for native presence (08 §1 `/api/owner/native`; 04 §2.3.4).
// - GET: whether this computer's helper is there and turned on for the owner (public).
// - POST: turns it on, its own owner operation; the body is the backup code (as every owner route
//   takes it), sent once to this same-origin server, never logged or kept here.
// Confirming with it is the presence kind `native` (`X-AgentLink-Presence: native`, empty body) on
// the screen's existing route; the page never runs the helper and never sees a secret.
import { NATIVE_STATES, type NativeState } from './strings.js';

export interface NativeStatus {
  readonly available: boolean;
  readonly registered: boolean;
}

export type NativeRegistration =
  | { readonly kind: 'registered' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'native'; readonly state: NativeState }
  | { readonly kind: 'failed' };

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
    return { available: n['available'], registered: n['registered'] };
  } catch {
    return NONE;
  }
}

const isState = (value: unknown): value is NativeState =>
  typeof value === 'string' && (NATIVE_STATES as readonly string[]).includes(value);

/** POST /api/owner/native with the backup code; the OS prompt follows on the server's side. */
export async function registerNative(
  backupCode: string,
  fetcher: Fetch = defaultFetch,
  token: string = pageToken(),
): Promise<NativeRegistration> {
  const body = new TextEncoder().encode(backupCode);
  try {
    const res = await fetcher('/api/owner/native', {
      method: 'POST',
      headers: { 'X-AgentLink-CSRF': token, 'Content-Type': 'application/octet-stream' },
      credentials: 'same-origin',
      body,
    });
    let answer: Record<string, unknown> = {};
    try {
      answer = (await res.json()) as Record<string, unknown>;
    } catch {
      answer = {};
    }
    const status = answer['status'];
    if (res.status === 200 && status === 'registered') return { kind: 'registered' };
    // Already on (another tab, or an earlier setup): nothing to do.
    if (status === 'native_exists') return { kind: 'registered' };
    if (status === 'native_unavailable') return { kind: 'native', state: 'unavailable' };
    if (isState(answer['native'])) return { kind: 'native', state: answer['native'] };
    if (status === 'presence_rejected') return { kind: 'rejected' };
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  } finally {
    body.fill(0);
  }
}

/** The fixed state a presence route answered for the native kind, if any. */
export function nativeStateOf(answer: unknown): NativeState | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const value = (answer as { native?: unknown }).native;
  return isState(value) ? value : undefined;
}
