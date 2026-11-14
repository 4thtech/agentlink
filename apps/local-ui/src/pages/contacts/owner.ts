// Owner operations from this page (04 §2.5; D-118; I-4). The page never signs and never builds an
// owner action: it sends one POST to a `presence: true` route with
// - the presence proof as the octet-stream body: the master code the owner typed, or the localhost
//   passkey assertion (M1-8e; `X-AgentLink-Presence: passkey`), exactly as the approval page sends
//   them;
// - the operation's input, JSON base64url-encoded in `X-AgentLink-Input`;
// - the page's session token in `X-AgentLink-CSRF`.
// The server's central gate checks presence before the route runs, and the route signs on the
// server. The proof goes only to this same-origin server; it is never logged or kept, and the passkey
// PRF output is wiped once encoded.

import { knownFailureReason, type FailureReasonCode } from '../../api/failure-reasons.js';
import {
  browserCeremonyGesture,
  proofBody,
  type CeremonyGesture,
} from '../../api/presence-ceremony.js';
import { webAuthnHere } from '../../presence/webauthn-here.js';

/**
 * The master code as typed, or the passkey: REL051-SF1, the gesture runs when the request is sent,
 * for the challenge the server issued for exactly that request (api/presence-ceremony.ts).
 */
export type PresenceProof =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'passkey'; readonly gesture: CeremonyGesture }
  /**
   * DESK-D12c: Touch ID / Windows Hello in the desktop app. No bytes: the server runs this computer's
   * presence helper for this one operation, for a ceremony it issued for exactly this request
   * (DESK051-C6; `X-AgentLink-Presence: native`, `X-AgentLink-Ceremony`, empty body).
   */
  | { readonly kind: 'native' };

export type OwnerResult =
  | { readonly kind: 'done' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'required' }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'refused' }
  | { readonly kind: 'not_applied' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'session' }
  | { readonly kind: 'failed'; readonly reason?: FailureReasonCode };

/** The stored localhost passkey, when there is one this browser can use. */
export interface PasskeyInfo {
  readonly credentialId: string;
  readonly prfSalt: string;
}

export interface OwnerClient {
  passkey(): Promise<PasskeyInfo | undefined>;
  post(path: string, input: unknown, proof: PresenceProof): Promise<OwnerResult>;
}

export interface OwnerClientOptions {
  readonly fetch?: typeof fetch;
  /** The session token; by default read from the page's meta tag on each call. */
  readonly token?: string;
}

const CSRF_HEADER = 'X-AgentLink-CSRF';
const B64URL = /^[A-Za-z0-9_-]+$/;

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function checkPath(path: string): void {
  if (!path.startsWith('/api/ui/') || /[\\\t\n\r]/.test(path)) {
    throw new Error('owner path must start with /api/ui/');
  }
}

async function answerOf(
  res: Response,
): Promise<{ readonly status: unknown; readonly reason: FailureReasonCode | undefined }> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return { status: undefined, reason: undefined };
    const b = body as { status?: unknown; error?: unknown; reason?: unknown };
    return { status: b.status ?? b.error, reason: knownFailureReason(b.reason) };
  } catch {
    return { status: undefined, reason: undefined };
  }
}

// APP-CONTINUITY: never in the desktop app's window (presence/webauthn-here.ts).
function canPasskey(): boolean {
  return webAuthnHere();
}

export function createOwnerClient(options: OwnerClientOptions = {}): OwnerClient {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();

  return {
    async passkey() {
      if (!canPasskey()) return undefined;
      try {
        const res = await doFetch('/api/owner/passkey', {
          method: 'GET',
          headers: { [CSRF_HEADER]: token() },
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (res.status !== 200) return undefined;
        const out = (await res.json()) as { passkey?: Record<string, unknown> };
        const p = out.passkey;
        if (
          p === undefined ||
          p['registered'] !== true ||
          p['rpId'] !== 'localhost' ||
          typeof p['credentialId'] !== 'string' ||
          typeof p['prfSalt'] !== 'string' ||
          !B64URL.test(p['credentialId']) ||
          !B64URL.test(p['prfSalt'])
        ) {
          return undefined;
        }
        return { credentialId: p['credentialId'], prfSalt: p['prfSalt'] };
      } catch {
        return undefined;
      }
    },

    async post(path, input, proof) {
      checkPath(path);
      const headers = new Headers({
        [CSRF_HEADER]: token(),
        'Content-Type': 'application/octet-stream',
      });
      if (input !== undefined) {
        headers.set(
          'X-AgentLink-Input',
          base64url(new TextEncoder().encode(JSON.stringify(input))),
        );
      }
      let res: Response | undefined;
      let body: Uint8Array | undefined;
      try {
        const ready = await proofBody(doFetch, path, headers, proof);
        if ('res' in ready) res = ready.res;
        else body = ready.body;
        if (body !== undefined) {
          res = await doFetch(path, {
            method: 'POST',
            headers,
            body: body as BodyInit,
            credentials: 'same-origin',
            cache: 'no-store',
          });
        }
      } catch {
        return { kind: 'failed' };
      } finally {
        body?.fill(0);
      }
      if (res === undefined) return { kind: 'failed' };
      const { status, reason } = await answerOf(res);
      if (res.status === 200 && status === 'done') return { kind: 'done' };
      // DESK-D12c: a refused Touch ID / Windows Hello gesture (cancel, lockout, …) changed nothing;
      // the screen says so and keeps "Use your master code instead".
      if (proof.kind === 'native' && status === 'presence_rejected') return { kind: 'rejected' };
      if (res.status === 401) return { kind: 'session' };
      if (res.status === 403 && status === 'presence_rejected') return { kind: 'rejected' };
      if (res.status === 403 && status === 'presence_required') return { kind: 'required' };
      if (res.status === 403) return { kind: 'session' };
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        return { kind: 'wait', seconds: Number.isSafeInteger(after) && after > 0 ? after : 30 };
      }
      if (res.status === 409 && status === 'busy') return { kind: 'busy' };
      if (res.status === 409 && status === 'not_applied') return { kind: 'not_applied' };
      if (res.status === 409) return { kind: 'refused' };
      // R2: a failed answer's fixed reason (never its text) gives the page specific words.
      return reason !== undefined && status === 'failed'
        ? { kind: 'failed', reason }
        : { kind: 'failed' };
    },
  };
}

/**
 * The passkey, chosen after the owner clicked (11 §6.2.1). REL051-SF1: the gesture itself runs when
 * the request is sent, for the challenge the server issued for exactly that request: RP ID
 * `localhost`, user verification required, the stored credential and the PRF extension over the
 * owner's PRF salt (api/presence-ceremony.ts). A dismissed gesture is answered `presence_required`.
 */
export function passkeyProof(info: PasskeyInfo): Promise<PresenceProof | undefined> {
  // Only for the passkey the page offered: a ceremony naming another one is not answered.
  return Promise.resolve({
    kind: 'passkey',
    gesture: (pk) =>
      pk.allowCredentials.includes(info.credentialId)
        ? browserCeremonyGesture(pk)
        : Promise.resolve(undefined),
  });
}

// --- HOTFIX-045-TOUCHID: why the passkey can't be used, and the values to switch to one ---------
//
// `GET /api/owner/passkey` answers from the owner store, with or without an open agent. When the
// passkey can't be used it names why in a fixed code (`reason`); the page shows that in plain words
// instead of falling back to the master code silently. `switchTo` is present only when this owner
// can switch here (the server gives `userId`, the owner the new passkey is bound to).

/** Why the passkey isn't offered (strings.ts PASSKEY_WHY). */
export type PasskeyUnavailableReason = 'browser' | 'not_set_up_here' | 'other_owner' | 'unknown';

/** The public values of the one-time switch (first-run setup-api.ts UpgradeValues). */
export interface PasskeySwitchValues {
  readonly rpId: 'localhost';
  readonly userId: string;
  readonly prfSalt: string;
}

export type PasskeyStatus =
  | { readonly kind: 'ready'; readonly info: PasskeyInfo }
  | {
      readonly kind: 'unavailable';
      readonly reason: PasskeyUnavailableReason;
      readonly switchTo?: PasskeySwitchValues;
    };

const REASONS: ReadonlySet<string> = new Set(['not_set_up_here', 'other_owner']);

/** Reads the passkey state; any failure is `unknown` (the master code still works). */
export async function readPasskeyStatus(options: OwnerClientOptions = {}): Promise<PasskeyStatus> {
  if (!canPasskey()) return { kind: 'unavailable', reason: 'browser' };
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  try {
    const res = await doFetch('/api/owner/passkey', {
      method: 'GET',
      headers: { [CSRF_HEADER]: options.token ?? pageToken() },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.status !== 200) return { kind: 'unavailable', reason: 'unknown' };
    const out = (await res.json()) as { passkey?: Record<string, unknown> };
    const p = out.passkey;
    if (p === undefined || p['rpId'] !== 'localhost') {
      return { kind: 'unavailable', reason: 'unknown' };
    }
    const prfSalt = p['prfSalt'];
    const credentialId = p['credentialId'];
    const userId = p['userId'];
    if (typeof prfSalt !== 'string' || !B64URL.test(prfSalt)) {
      return { kind: 'unavailable', reason: 'unknown' };
    }
    if (p['registered'] === true) {
      return typeof credentialId === 'string' && B64URL.test(credentialId)
        ? { kind: 'ready', info: { credentialId, prfSalt } }
        : { kind: 'unavailable', reason: 'unknown' };
    }
    const reason = p['reason'];
    const why: PasskeyUnavailableReason =
      typeof reason === 'string' && REASONS.has(reason)
        ? (reason as PasskeyUnavailableReason)
        : 'unknown';
    const canSwitch =
      why === 'not_set_up_here' && typeof userId === 'string' && B64URL.test(userId);
    return {
      kind: 'unavailable',
      reason: why,
      ...(canSwitch ? { switchTo: { rpId: 'localhost', userId, prfSalt } } : {}),
    };
  } catch {
    return { kind: 'unavailable', reason: 'unknown' };
  }
}
