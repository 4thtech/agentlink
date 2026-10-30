// U3-invite: the join screen's calls (08 §4 "One step from an invite link"; b11 §33.2; I-4, I-5).
//
// - `GET /api/ui/join`: the state, the public inviteId, the name-rule name, label, fingerprint and
//   expiry, read through an allowlist (each field checked for type and size). The page never has
//   the link. The open agent's label comes from the `X-AgentLink-Agent` header (percent-encoded
//   plain text, display only).
// - `POST /api/ui/join/accept`: an owner route. The input `{inviteId}` (the ID this screen shows)
//   travels base64url JSON in `X-AgentLink-Input`; the presence proof is the body (the passkey
//   assertion with `X-AgentLink-Presence: passkey`, or the backup code). The server signs; the page
//   never does.
// - `POST /api/ui/join/dismiss` ("Not now"): the invite kind, an octet-stream body `{}`.
// Every non-GET carries the page's generation in `X-AgentLink-Generation`: the app's fetch guard
// stamps it (api/generation.ts). Nothing here is logged.
import type { PresenceProof } from '../contacts/owner.js';

export const JOIN_PATH = '/api/ui/join';
export const JOIN_ACCEPT_PATH = '/api/ui/join/accept';
export const JOIN_DISMISS_PATH = '/api/ui/join/dismiss';
const CSRF_HEADER = 'X-AgentLink-CSRF';
const INVITE_ID = /^[A-Za-z0-9_-]{22}$/;
const FINGERPRINT = /^[0-9A-F]{4}·[0-9A-F]{4}$/;
/** A contact's ref as the contacts routes take it. */
const CONTACT_REF = /^0x[0-9a-f]{40}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_NAME_CHARS = 128;
const MAX_LABEL_CHARS = 64;

export type JoinState =
  | 'none'
  | 'waiting'
  | 'expired'
  | 'own'
  | 'already_accepted'
  | 'connecting'
  | 'waiting_for_them'
  | 'connected';

const STATES: ReadonlySet<string> = new Set([
  'none',
  'waiting',
  'expired',
  'own',
  'already_accepted',
  'connecting',
  'waiting_for_them',
  'connected',
]);

export interface JoinInvite {
  readonly inviteId: string;
  /** The inviter's name under the name rule: untrusted text, shown only as text (I-5). */
  readonly name: string;
  readonly fingerprint: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

export type JoinRead =
  | {
      readonly kind: 'ok';
      readonly state: JoinState;
      readonly invite?: JoinInvite;
      readonly agent?: string;
      /** W4-PEOPLE-INVITE: when connected, the new contact's ref (for its safety code). */
      readonly contactRef?: string;
    }
  | { readonly kind: 'session_expired' | 'offline' | 'not_available' | 'failed' };

export type JoinAcceptOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'invite_changed' }
  | { readonly kind: 'wait'; readonly seconds: number }
  | {
      readonly kind:
        | 'presence_rejected'
        | 'presence_required'
        | 'busy'
        | 'refused'
        | 'policy_denied'
        | 'expired'
        | 'agent_changed'
        | 'not_set_up'
        | 'session_expired'
        | 'offline'
        | 'failed';
    };

export type JoinDismissOutcome = 'dismissed' | 'agent_changed' | 'session_expired' | 'failed';

export interface JoinApi {
  read(): Promise<JoinRead>;
  accept(inviteId: string, proof: PresenceProof): Promise<JoinAcceptOutcome>;
  dismiss(): Promise<JoinDismissOutcome>;
}

export interface JoinApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function toBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The allowlisted invite fields, or undefined (fail closed). */
export function inviteOf(body: Record<string, unknown>): JoinInvite | undefined {
  const { inviteId, inviter, expiresAt } = body;
  if (typeof inviteId !== 'string' || !INVITE_ID.test(inviteId)) return undefined;
  if (!isObject(inviter)) return undefined;
  const { name, label, fingerprint } = inviter;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_CHARS)
    return undefined;
  if (label !== 'self-declared') return undefined;
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return undefined;
  if (typeof expiresAt !== 'string' || !RFC3339.test(expiresAt)) return undefined;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return undefined;
  return { inviteId, name, fingerprint, expiresAt: ms };
}

/** The open agent's label from the stamp, display only; undefined when absent or malformed. */
function agentOf(res: Response): string | undefined {
  const raw = res.headers.get('X-AgentLink-Agent');
  if (raw === null) return undefined;
  try {
    const label = decodeURIComponent(raw);
    return label.length > 0 && label.length <= MAX_LABEL_CHARS ? label : undefined;
  } catch {
    return undefined;
  }
}

export function createJoinApi(options: JoinApiOptions = {}): JoinApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();

  async function post(
    path: string,
    headers: Headers,
    body: Uint8Array,
  ): Promise<{ status: number; json: Record<string, unknown> } | 'offline'> {
    let res: Response;
    try {
      res = await doFetch(path, {
        method: 'POST',
        headers,
        body: body as BodyInit,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return 'offline';
    } finally {
      body.fill(0);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json: isObject(json) ? json : {} };
  }

  return {
    async read() {
      let res: Response;
      try {
        res = await doFetch(JOIN_PATH, {
          method: 'GET',
          headers: new Headers({ [CSRF_HEADER]: token() }),
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        return { kind: 'offline' };
      }
      if (res.status === 401) return { kind: 'session_expired' };
      if (res.status === 501) return { kind: 'not_available' };
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return { kind: 'failed' };
      }
      if (res.status !== 200 || !isObject(json)) return { kind: 'failed' };
      const state = json['state'];
      if (typeof state !== 'string' || !STATES.has(state)) return { kind: 'failed' };
      const agent = agentOf(res);
      if (state === 'none') return { kind: 'ok', state, ...(agent === undefined ? {} : { agent }) };
      const invite = inviteOf(json);
      if (invite === undefined) return { kind: 'failed' };
      // W4-PEOPLE-INVITE: only when connected, the new contact's ref; any other shape is left out.
      const ref = json['contactRef'];
      const contactRef =
        state === 'connected' && typeof ref === 'string' && CONTACT_REF.test(ref) ? ref : undefined;
      return {
        kind: 'ok',
        state: state as JoinState,
        invite,
        ...(agent === undefined ? {} : { agent }),
        ...(contactRef === undefined ? {} : { contactRef }),
      };
    },

    async accept(inviteId, proof) {
      const headers = new Headers({
        [CSRF_HEADER]: token(),
        'content-type': 'application/octet-stream',
        'X-AgentLink-Input': toBase64url(new TextEncoder().encode(JSON.stringify({ inviteId }))),
      });
      if (proof.kind === 'passkey') headers.set('X-AgentLink-Presence', 'passkey');
      const body = proof.kind === 'passkey' ? proof.body : new TextEncoder().encode(proof.code);
      const answer = await post(JOIN_ACCEPT_PATH, headers, body);
      if (answer === 'offline') return { kind: 'offline' };
      const { status, json } = answer;
      // Refusals come as {status} (the gates) or {error} (the route).
      const word = json['status'] ?? json['error'];
      if (status === 200 && word === 'pending') return { kind: 'pending' };
      if (status === 401) return { kind: 'session_expired' };
      if (word === 'invite_changed') return { kind: 'invite_changed' };
      if (word === 'agent_changed') return { kind: 'agent_changed' };
      if (word === 'presence_rejected' || word === 'presence_required' || word === 'busy') {
        return { kind: word };
      }
      if (status === 429 || word === 'wait') {
        const raw = json['retryAfter'];
        const seconds =
          typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 86_400
            ? raw
            : 30;
        return { kind: 'wait', seconds };
      }
      if (word === 'expired') return { kind: 'expired' };
      if (word === 'policy_denied') return { kind: 'policy_denied' };
      if (word === 'not_set_up' || word === 'needs_setup') return { kind: 'not_set_up' };
      if (status === 409) return { kind: 'refused' };
      return { kind: 'failed' };
    },

    async dismiss() {
      const headers = new Headers({
        [CSRF_HEADER]: token(),
        'content-type': 'application/octet-stream',
      });
      const answer = await post(JOIN_DISMISS_PATH, headers, new TextEncoder().encode('{}'));
      if (answer === 'offline') return 'failed';
      const word = answer.json['status'] ?? answer.json['error'];
      if (answer.status === 200 && word === 'dismissed') return 'dismissed';
      if (answer.status === 401) return 'session_expired';
      if (word === 'agent_changed') return 'agent_changed';
      return 'failed';
    },
  };
}
