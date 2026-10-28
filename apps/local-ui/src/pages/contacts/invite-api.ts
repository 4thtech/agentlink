// UX2-d2: the Add contact sheet's calls to the UX2-d1 routes (08 §1; b11 §21; owner decision 1.1).
//
// - `POST /api/ui/invites` and `POST /api/ui/invites/check`: the invite route kind, no presence.
//   An octet-stream body holding one JSON object (`{}`, `{"label": …}` or `{"invite": …}`), the
//   page's CSRF token, and nothing else: no query, no `X-AgentLink-Input`, no presence header.
// - `POST /api/ui/invites/accept`: an owner route behind the central presence gate. The invite
//   travels as the operation input (`X-AgentLink-Input`, base64url JSON), the presence proof as the
//   body (owner code as UTF-8, or the passkey assertion with `X-AgentLink-Presence: passkey`). The
//   server checks presence, signs one approval and accepts; the page never signs.
//
// Everything goes to this same-origin server only (never a 4thTech service, never a shortener). An
// answer is read through an allowlist: only the named fields, each checked for type and size. The
// link and the share text are never logged, and no error here carries them (I-7, b11 §21.5).
import type { PresenceProof } from './owner.js';

export const INVITE_CREATE_PATH = '/api/ui/invites';
export const INVITE_CHECK_PATH = '/api/ui/invites/check';
export const INVITE_ACCEPT_PATH = '/api/ui/invites/accept';

/** The one invite link form the server answers (core INVITE_LINK_PREFIX). */
const LINK_PREFIX = 'https://agentlink.4thtech.io/i#';
const PAYLOAD = /^[A-Za-z0-9_-]{1,8192}$/;
const FINGERPRINT = /^[0-9A-F]{4}·[0-9A-F]{4}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_SHARE_CHARS = 10_000;
const MAX_NAME_CHARS = 128;
const CSRF_HEADER = 'X-AgentLink-CSRF';

export interface CreatedInvite {
  /** The invite link: shown only in the sheet's QR code; never in an attribute. */
  readonly inviteUrl: string;
  /** The ready-to-send text (our template with the link and expiry): the well, Copy and Share. */
  readonly shareText: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

export interface CheckedInvite {
  /** The inviter's own name: untrusted, shown only through the name rule as text (I-5). */
  readonly name: string;
  readonly fingerprint: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

export type CreateOutcome =
  | { readonly kind: 'ok'; readonly invite: CreatedInvite }
  | { readonly kind: 'invalid_name' | 'not_set_up' | 'session_expired' | 'offline' | 'failed' };

export type InviteRefusal = 'expired' | 'own' | 'damaged' | 'cant_use';

export type CheckOutcome =
  | { readonly kind: 'ok'; readonly invite: CheckedInvite }
  | { readonly kind: 'refused'; readonly why: InviteRefusal }
  | { readonly kind: 'not_set_up' | 'session_expired' | 'offline' | 'failed' };

export type AcceptOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'refused'; readonly why: InviteRefusal }
  | {
      readonly kind:
        | 'presence_rejected'
        | 'presence_required'
        | 'busy'
        | 'not_applied'
        | 'not_connected'
        | 'not_set_up'
        | 'session_expired'
        | 'offline'
        | 'failed';
    };

export interface InviteApi {
  create(label: string | undefined): Promise<CreateOutcome>;
  check(invite: string): Promise<CheckOutcome>;
  accept(invite: string, proof: PresenceProof): Promise<AcceptOutcome>;
}

export interface InviteApiOptions {
  readonly fetch?: typeof fetch;
  /** The session token; by default the page's meta tag. */
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

function timeOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || !RFC3339.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function created(json: Record<string, unknown>): CreatedInvite | undefined {
  const { inviteUrl, shareText } = json;
  const expiresAt = timeOf(json['expiresAt']);
  if (typeof inviteUrl !== 'string' || !inviteUrl.startsWith(LINK_PREFIX)) return undefined;
  if (!PAYLOAD.test(inviteUrl.slice(LINK_PREFIX.length))) return undefined;
  if (typeof shareText !== 'string' || shareText.length > MAX_SHARE_CHARS) return undefined;
  // The share text is our template around this very link (11 §6.1 J7): nothing else is sent.
  if (!shareText.endsWith(inviteUrl)) return undefined;
  if (expiresAt === undefined) return undefined;
  return { inviteUrl, shareText, expiresAt };
}

function checked(json: Record<string, unknown>): CheckedInvite | undefined {
  const contact = json['contact'];
  const expiresAt = timeOf(json['expiresAt']);
  if (!isObject(contact) || expiresAt === undefined) return undefined;
  const { name, label, ownerFingerprint } = contact;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_CHARS) {
    return undefined;
  }
  if (label !== 'self-declared') return undefined;
  if (typeof ownerFingerprint !== 'string' || !FINGERPRINT.test(ownerFingerprint)) return undefined;
  return { name, fingerprint: ownerFingerprint, expiresAt };
}

/** A pasted invite the server refused, as one of the sheet's sentences. */
function refusal(error: unknown): InviteRefusal | undefined {
  if (error === 'expired') return 'expired';
  if (error === 'own_invite') return 'own';
  if (error === 'invalid_invite' || error === 'invalid') return 'damaged';
  if (error === 'cannot_pair') return 'cant_use';
  return undefined;
}

export function createInviteApi(options: InviteApiOptions = {}): InviteApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();

  async function call(
    path: string,
    init: { headers: Headers; body: Uint8Array },
  ): Promise<
    { kind: 'answer'; status: number; json: Record<string, unknown> } | { kind: 'offline' }
  > {
    let res: Response;
    try {
      res = await doFetch(path, {
        method: 'POST',
        headers: init.headers,
        body: init.body as BodyInit,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return { kind: 'offline' };
    } finally {
      init.body.fill(0);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { kind: 'answer', status: res.status, json: isObject(json) ? json : {} };
  }

  function inviteHeaders(): Headers {
    return new Headers({ [CSRF_HEADER]: token(), 'content-type': 'application/octet-stream' });
  }

  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

  return {
    async create(label) {
      const body = encode(label === undefined ? {} : { label });
      const answer = await call(INVITE_CREATE_PATH, { headers: inviteHeaders(), body });
      if (answer.kind === 'offline') return { kind: 'offline' };
      const { status, json } = answer;
      if (status === 200 && json['status'] === 'ok') {
        const invite = created(json);
        return invite === undefined ? { kind: 'failed' } : { kind: 'ok', invite };
      }
      if (status === 401) return { kind: 'session_expired' };
      if (json['error'] === 'invalid_label') return { kind: 'invalid_name' };
      if (json['error'] === 'not_set_up') return { kind: 'not_set_up' };
      return { kind: 'failed' };
    },

    async check(invite) {
      const body = encode({ invite });
      const answer = await call(INVITE_CHECK_PATH, { headers: inviteHeaders(), body });
      if (answer.kind === 'offline') return { kind: 'offline' };
      const { status, json } = answer;
      if (status === 200 && json['status'] === 'ok') {
        const found = checked(json);
        return found === undefined ? { kind: 'failed' } : { kind: 'ok', invite: found };
      }
      if (status === 401) return { kind: 'session_expired' };
      if (json['error'] === 'not_set_up') return { kind: 'not_set_up' };
      const why = refusal(json['error']);
      return why === undefined ? { kind: 'failed' } : { kind: 'refused', why };
    },

    async accept(invite, proof) {
      const headers = new Headers({
        [CSRF_HEADER]: token(),
        'content-type': 'application/octet-stream',
        'X-AgentLink-Input': toBase64url(encode({ invite })),
      });
      if (proof.kind === 'passkey') headers.set('X-AgentLink-Presence', 'passkey');
      const body = proof.kind === 'passkey' ? proof.body : new TextEncoder().encode(proof.code);
      const answer = await call(INVITE_ACCEPT_PATH, { headers, body });
      if (answer.kind === 'offline') return { kind: 'offline' };
      const { status, json } = answer;
      if (status === 200 && json['status'] === 'pending') return { kind: 'pending' };
      if (status === 401) return { kind: 'session_expired' };
      const gate = json['status'];
      if (gate === 'presence_rejected' || gate === 'presence_required' || gate === 'busy') {
        return { kind: gate };
      }
      if (status === 429 || gate === 'wait') {
        const raw = json['retryAfter'];
        const seconds =
          typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 86_400
            ? raw
            : 30;
        return { kind: 'wait', seconds };
      }
      if (gate === 'needs_setup' || json['error'] === 'not_set_up') return { kind: 'not_set_up' };
      const why = refusal(json['error']);
      if (why !== undefined) return { kind: 'refused', why };
      if (json['error'] === 'not_applied') return { kind: 'not_applied' };
      // 409 `refused` (nothing signed: the rules, or the invite changed since the check) and every
      // other answer: nothing was changed.
      if (status === 409) return { kind: 'not_connected' };
      return { kind: 'failed' };
    },
  };
}
