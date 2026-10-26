// Owner operations from this page (04 §2.5; D-118; I-4). The page never signs and never builds an
// owner action: it sends one POST to a `presence: true` route with
// - the presence proof as the octet-stream body: the owner code the owner typed, or the localhost
//   passkey assertion (M1-8e; `X-AgentLink-Presence: passkey`), exactly as the approval page sends
//   them;
// - the operation's input, JSON base64url-encoded in `X-AgentLink-Input`;
// - the page's session token in `X-AgentLink-CSRF`.
// The server's central gate checks presence before the route runs, and the route signs on the
// server. The proof goes only to this same-origin server; it is never logged or kept, and the passkey
// PRF output is wiped once encoded.

export type PresenceProof =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'passkey'; readonly body: Uint8Array };

export type OwnerResult =
  | { readonly kind: 'done' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'required' }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'refused' }
  | { readonly kind: 'not_applied' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'session' }
  | { readonly kind: 'failed' };

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

function fromBase64url(text: string): Uint8Array {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function checkPath(path: string): void {
  if (!path.startsWith('/api/ui/') || /[\\\t\n\r]/.test(path)) {
    throw new Error('owner path must start with /api/ui/');
  }
}

async function statusOf(res: Response): Promise<unknown> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null
      ? ((body as { status?: unknown; error?: unknown }).status ??
          (body as { error?: unknown }).error)
      : undefined;
  } catch {
    return undefined;
  }
}

function canPasskey(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined
  );
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
      if (proof.kind === 'passkey') headers.set('X-AgentLink-Presence', 'passkey');
      const body = proof.kind === 'passkey' ? proof.body : new TextEncoder().encode(proof.code);
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
        return { kind: 'failed' };
      } finally {
        body.fill(0);
      }
      const status = await statusOf(res);
      if (res.status === 200 && status === 'done') return { kind: 'done' };
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
      return { kind: 'failed' };
    },
  };
}

/** Bytes, each field prefixed by its 16-bit big-endian length (the approval page's passkey body). */
function fields(list: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.reduce((n, f) => n + 2 + f.length, 0));
  let at = 0;
  for (const f of list) {
    out[at] = f.length >> 8;
    out[at + 1] = f.length & 255;
    out.set(f, at + 2);
    at += 2 + f.length;
  }
  return out;
}

const bytes = (buffer: ArrayBuffer | null | undefined): Uint8Array =>
  buffer ? new Uint8Array(buffer) : new Uint8Array(0);

/**
 * One passkey gesture, only after the owner clicked (11 §6.2.1): RP ID `localhost`, user
 * verification required, the stored credential and the PRF extension over the owner's PRF salt.
 * Undefined when the owner cancelled or the authenticator gave no PRF output.
 */
export async function passkeyProof(info: PasskeyInfo): Promise<PresenceProof | undefined> {
  const challenge = new Uint8Array(32);
  crypto.getRandomValues(challenge);
  try {
    const credential = (await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: 'localhost',
        allowCredentials: [{ type: 'public-key', id: fromBase64url(info.credentialId) }],
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { eval: { first: fromBase64url(info.prfSalt) } } },
      } as PublicKeyCredentialRequestOptions,
    })) as PublicKeyCredential | null;
    if (credential === null) return undefined;
    const ext = credential.getClientExtensionResults() as {
      prf?: { results?: { first?: ArrayBuffer } };
    };
    const prf = bytes(ext.prf?.results?.first);
    if (prf.length === 0) return undefined;
    const response = credential.response as AuthenticatorAssertionResponse;
    const body = fields([
      bytes(credential.rawId),
      bytes(response.authenticatorData),
      bytes(response.userHandle),
      prf,
    ]);
    prf.fill(0);
    return { kind: 'passkey', body };
  } catch {
    return undefined;
  }
}
