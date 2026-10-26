// The Files page's calls to the local server (08 §1; 04 §2.5; D-118, D-119). Same-origin `/api/...`
// with the page's CSRF token, as api/client.ts does; this file keeps the answer's body, which the
// page needs for a refused folder's reason, and sends the owner route's octet-stream body.
//
// The browser never signs and never sees what is signed. A confirm sends the review token and the
// acknowledged warning codes (base64url JSON in `X-AgentLink-Input`) and the owner's presence in the
// body: the passkey assertion (credential ID, authenticator data, user handle and PRF output, each
// after a 16-bit big-endian length, `X-AgentLink-Presence: passkey`), or the owner code as UTF-8.
// The server checks presence, then signs. Bodies, the token and the owner code are never logged.
const CSRF_HEADER = 'X-AgentLink-CSRF';
const PASSKEY_PATH = '/api/owner/passkey';

export interface FilesApiOptions {
  readonly fetch?: typeof fetch;
  /** The session token; by default the page's meta tag. */
  readonly token?: string;
}

export type Answer =
  | { readonly kind: 'answer'; readonly status: number; readonly json: unknown }
  | { readonly kind: 'offline' };

export interface PasskeyInfo {
  readonly credentialId: string;
  readonly prfSalt: string;
}

export type Presence =
  | { readonly kind: 'passkey'; readonly body: Uint8Array }
  | { readonly kind: 'code'; readonly code: string };

/** What a confirm came to, as the page explains it (strings.ts). */
export type CommitOutcome =
  | { readonly kind: 'applied'; readonly confirmed: boolean }
  | { readonly kind: 'wait'; readonly seconds: number }
  | {
      readonly kind:
        | 'presence_rejected'
        | 'presence_required'
        | 'busy'
        | 'changed'
        | 'expired'
        | 'refused'
        | 'not_set_up'
        | 'session_expired'
        | 'offline'
        | 'failed';
    };

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

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Each field after its 16-bit big-endian length (the server's passkey body). */
export function encodeFields(fields: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(fields.reduce((n, f) => n + 2 + f.length, 0));
  let at = 0;
  for (const field of fields) {
    if (field.length > 0xffff) throw new Error('field too long');
    out[at] = field.length >> 8;
    out[at + 1] = field.length & 0xff;
    out.set(field, at + 2);
    at += 2 + field.length;
  }
  return out;
}

const B64URL = /^[A-Za-z0-9_-]{1,1024}$/;

export interface FilesApi {
  get(path: string): Promise<Answer>;
  passkey(): Promise<PasskeyInfo | undefined>;
  commit(
    path: string,
    input: { readonly review: string; readonly acknowledged: readonly string[] },
    presence: Presence,
  ): Promise<CommitOutcome>;
}

export function createFilesApi(options: FilesApiOptions = {}): FilesApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();

  async function call(path: string, init: RequestInit): Promise<Answer> {
    if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('api path');
    let res: Response;
    try {
      res = await doFetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
    } catch {
      return { kind: 'offline' };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { kind: 'answer', status: res.status, json };
  }

  return {
    get: (path) => call(path, { method: 'GET', headers: new Headers({ [CSRF_HEADER]: token() }) }),

    async passkey() {
      const answer = await call(PASSKEY_PATH, {
        method: 'GET',
        headers: new Headers({ [CSRF_HEADER]: token() }),
      });
      if (answer.kind !== 'answer' || answer.status !== 200 || !isObject(answer.json)) {
        return undefined;
      }
      const info = answer.json['passkey'];
      if (!isObject(info) || info['registered'] !== true) return undefined;
      const { credentialId, prfSalt } = info;
      if (typeof credentialId !== 'string' || !B64URL.test(credentialId)) return undefined;
      if (typeof prfSalt !== 'string' || !B64URL.test(prfSalt)) return undefined;
      return { credentialId, prfSalt };
    },

    async commit(path, input, presence) {
      const headers = new Headers({
        [CSRF_HEADER]: token(),
        'content-type': 'application/octet-stream',
        'X-AgentLink-Input': toBase64url(new TextEncoder().encode(JSON.stringify(input))),
      });
      if (presence.kind === 'passkey') headers.set('X-AgentLink-Presence', 'passkey');
      const body =
        presence.kind === 'passkey' ? presence.body : new TextEncoder().encode(presence.code);
      const answer = await call(path, { method: 'POST', headers, body: body as BodyInit });
      if (answer.kind === 'offline') return { kind: 'offline' };
      const json = isObject(answer.json) ? answer.json : {};
      if (answer.status === 200 && json['status'] === 'applied') {
        return { kind: 'applied', confirmed: json['confirmed'] === true };
      }
      if (answer.status === 401) return { kind: 'session_expired' };
      const status = json['status'];
      const error = json['error'];
      if (status === 'wait') {
        const raw = json['retryAfter'];
        const seconds =
          typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 86_400
            ? raw
            : 1;
        return { kind: 'wait', seconds };
      }
      if (status === 'presence_rejected' || status === 'presence_required' || status === 'busy') {
        return { kind: status };
      }
      if (status === 'needs_setup') return { kind: 'not_set_up' };
      if (error === 'changed' || error === 'expired') return { kind: error };
      if (status === 'refused' || answer.status === 409) return { kind: 'refused' };
      return { kind: 'failed' };
    },
  };
}

/** True when this browser can use a passkey at all. */
export function passkeysAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined &&
    typeof navigator.credentials.get === 'function'
  );
}

interface PrfResults {
  readonly prf?: { readonly results?: { readonly first?: ArrayBuffer | ArrayBufferView } };
}

function bytesOf(value: ArrayBuffer | ArrayBufferView | null | undefined): Uint8Array {
  if (value === undefined || value === null) return new Uint8Array(0);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

/**
 * One passkey gesture for the stored localhost passkey, after the owner's click: the assertion body
 * for the server, or why there is none. The challenge is random: the server checks the PRF output
 * against the owner key, not the challenge (M1-8e).
 */
export async function passkeyPresence(
  info: PasskeyInfo,
): Promise<{ readonly kind: 'ok'; readonly body: Uint8Array } | { readonly kind: 'not_used' }> {
  if (!passkeysAvailable()) return { kind: 'not_used' };
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: 'localhost',
        allowCredentials: [{ type: 'public-key', id: fromBase64url(info.credentialId) }],
        userVerification: 'required',
        timeout: 120_000,
        extensions: {
          prf: { eval: { first: fromBase64url(info.prfSalt) } },
        } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch {
    return { kind: 'not_used' };
  }
  if (credential === null || !(credential instanceof PublicKeyCredential)) {
    return { kind: 'not_used' };
  }
  const response = credential.response as AuthenticatorAssertionResponse;
  const prf = bytesOf((credential.getClientExtensionResults() as PrfResults).prf?.results?.first);
  try {
    if (prf.length === 0) return { kind: 'not_used' };
    return {
      kind: 'ok',
      body: encodeFields([
        new Uint8Array(credential.rawId),
        new Uint8Array(response.authenticatorData),
        bytesOf(response.userHandle),
        prf,
      ]),
    };
  } finally {
    prf.fill(0);
  }
}
