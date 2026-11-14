// The one owner operation of the Rules page: a POST to the server's central presence gate
// (packages/node/src/approval-server.ts `ownerGate`; 04 §2.5, D-68, I-4). The browser never signs and
// never builds a signed body (D-118): it sends the review it acknowledged as `X-AgentLink-Input` and
// the owner's presence as the octet-stream body, either the passkey assertion answering the ceremony
// the server issued for exactly this request (REL051-SF1, api/presence-ceremony.ts), as the approval
// page sends it) or the master code or owner passphrase the owner typed. The presence bytes are
// wiped after the request and are never logged or kept.
//
// The passkey prompt runs only after the owner clicks Save (11 §6.2.1), against `localhost` and the
// owner's registered credential from `GET /api/owner/passkey`.
//
// TODO(M1-11c follow-up): other pages need the same owner call (Files, Contacts). Move this into the
// shared api/ client when the second page lands.
import { sendWithPresence } from '../approvals/client.js';
import { pageCredentials } from '../../presence/webauthn-here.js';

const CSRF_HEADER = 'X-AgentLink-CSRF';
const PASSKEY_PATH = '/api/owner/passkey';
const RP_ID = 'localhost';

export interface PasskeyInfo {
  readonly credentialId: string;
  readonly prfSalt: string;
}

export type SaveAnswer =
  | { readonly kind: 'saved' }
  | { readonly kind: 'wrong_code' }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'refused' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'session_expired' }
  | { readonly kind: 'passkey_cancelled' }
  | { readonly kind: 'failed' };

export type Presence =
  | { readonly kind: 'passkey'; readonly passkey: PasskeyInfo }
  | { readonly kind: 'code'; readonly code: string };

export interface OwnerClient {
  /** The owner's registered passkey, or null (then the owner types the master code or passphrase). */
  passkey(): Promise<PasskeyInfo | null>;
  /** One owner operation: `input` as the operation input, `presence` as the body. */
  save(path: string, input: unknown, presence: Presence): Promise<SaveAnswer>;
}

export interface OwnerClientOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly credentials?: CredentialsContainer;
}

const toB64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** The server's answer as one of the page's outcomes (fixed codes; never shown raw). */
function outcome(status: number, body: unknown): SaveAnswer {
  const b = isObject(body) ? body : {};
  if (status === 200 && b.status === 'saved') return { kind: 'saved' };
  if (status === 401) return { kind: 'session_expired' };
  if (status === 403) return { kind: 'wrong_code' };
  if (status === 429) {
    const s = b.retryAfter;
    return { kind: 'wait', seconds: typeof s === 'number' && s > 0 && s < 86_400 ? s : 60 };
  }
  if (status === 409) {
    if (b.error === 'stale') return { kind: 'stale' };
    if (b.status === 'busy') return { kind: 'busy' };
    return { kind: 'refused' };
  }
  return { kind: 'failed' };
}

export function createOwnerClient(options: OwnerClientOptions = {}): OwnerClient {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  const credentials = (): CredentialsContainer | undefined =>
    // APP-CONTINUITY: never in the desktop app's window (presence/webauthn-here.ts).
    options.credentials ?? pageCredentials();

  async function passkey(): Promise<PasskeyInfo | null> {
    try {
      const res = await doFetch(PASSKEY_PATH, {
        method: 'GET',
        headers: { [CSRF_HEADER]: token() },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (res.status !== 200) return null;
      const body = await readJson(res);
      const p = isObject(body) ? body.passkey : undefined;
      if (!isObject(p) || p.registered !== true || p.rpId !== RP_ID) return null;
      const { credentialId, prfSalt } = p;
      if (typeof credentialId !== 'string' || typeof prfSalt !== 'string') return null;
      return { credentialId, prfSalt };
    } catch {
      return null;
    }
  }

  async function save(path: string, input: unknown, presence: Presence): Promise<SaveAnswer> {
    if (!path.startsWith('/api/ui/')) throw new Error('owner path must start with /api/ui/');
    const headers = new Headers({
      [CSRF_HEADER]: token(),
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-Input': toB64url(new TextEncoder().encode(JSON.stringify(input))),
    });
    // REL051-SF1: the passkey answers the ceremony the server issued for exactly this request.
    const sent = await sendWithPresence(doFetch, credentials(), path, headers, presence);
    if (sent === 'dismissed') return { kind: 'passkey_cancelled' };
    if (sent === undefined) return { kind: 'failed' };
    return outcome(sent.status, await readJson(sent));
  }

  return { passkey, save };
}
