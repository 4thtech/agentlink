// W4-ONE-TOUCH (S2; D-140; 08 §1 `POST /api/ui/agents/begin`, `POST /api/ui/agents`; 04 §2.8 "Create
// an agent and connect its AI app with one gesture"; 11 §5.8): New agent with one gesture. The page
// never signs and never builds an owner action:
// - `begin` sends `{label, app?}` (X-AgentLink-Input, an empty octet-stream body, no presence) and
//   gets the statement to show, the nonce and the plan-bound WebAuthn challenge;
// - `finish` sends only `{nonce}` and the presence proof: one `navigator.credentials.get` with that
//   challenge (`X-AgentLink-Presence: passkey`, the six-field body of the paid-action confirmation)
//   or the backup code as the body. A wrong code keeps the plan: the page may try again with the
//   same nonce (the third wrong one ends it).
// The PRF output and the code are wiped once sent; nothing here is logged or kept.

export const CREATE_BEGIN_PATH = '/api/ui/agents/begin';
export const CREATE_FINISH_PATH = '/api/ui/agents';

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const B64 = /^[A-Za-z0-9_-]{1,2048}$/;
const APP_ID = /^[a-z][a-z-]{1,31}$/;
const APP_NAME = /^[A-Za-z][A-Za-z0-9 ]{0,31}$/;
const FOLDER = /^[a-z][a-z0-9-]{0,31}$/;
const FINGERPRINT = /^[0-9A-F]{4}(·[0-9A-F]{4}){1,7}$/;

/** What the screen shows before the gesture: rendered only from begin's answer (04 §2.8). */
export interface CreateStatement {
  readonly label: string;
  readonly agentFingerprint: string;
  readonly ownerFingerprint: string;
  readonly folder: string;
  readonly app?: { readonly id: string; readonly name: string; readonly kind: 'connect' | 'move' };
}

export interface CreatePublicKey {
  readonly rpId: string;
  readonly challenge: string;
  readonly allowCredentials: readonly string[];
  readonly prfSalt: string;
  readonly timeoutMs: number;
}

export type CreateBegin =
  | {
      readonly kind: 'ready';
      readonly nonce: string;
      readonly statement: CreateStatement;
      readonly publicKey: CreatePublicKey;
    }
  | { readonly kind: 'refused'; readonly status: string }
  | { readonly kind: 'session' | 'offline' | 'failed' };

export type CreateFinish =
  | {
      readonly kind: 'done' | 'created_not_connected';
      readonly name: string;
      readonly label: string;
      readonly app?: string;
    }
  | {
      readonly kind:
        | 'rejected'
        | 'required'
        | 'tries_exhausted'
        | 'expired'
        | 'not_pending'
        | 'changed'
        | 'quit_first'
        | 'name_taken'
        | 'busy'
        | 'wait'
        | 'verification_required'
        | 'passkey_update_needed'
        | 'agent_changed'
        | 'not_applied'
        | 'dismissed'
        | 'session'
        | 'offline'
        | 'failed';
    };

export interface CreateAgentApi {
  begin(label: string, app?: string): Promise<CreateBegin>;
  finishPasskey(nonce: string, publicKey: CreatePublicKey): Promise<CreateFinish>;
  finishCode(nonce: string, code: string): Promise<CreateFinish>;
}

export interface CreateAgentApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
  /** The page's WebAuthn container (tests pass a stand-in). Default: navigator.credentials. */
  readonly credentials?: () => CredentialsContainer | undefined;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64(text: string): Uint8Array {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const bytesOf = (buffer: ArrayBuffer | null | undefined): Uint8Array =>
  buffer ? new Uint8Array(buffer) : new Uint8Array(0);

/** Each field after its 16-bit big-endian length (the server's parsePayConfirmAssertion). */
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

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The statement as fixed, checked fields only (never anything else of the answer). */
export function parseStatement(value: unknown): CreateStatement | undefined {
  if (!isObject(value)) return undefined;
  const { label, agentFingerprint, ownerFingerprint, folder, app } = value;
  if (
    typeof label !== 'string' ||
    label.length === 0 ||
    [...label].length > 32 ||
    typeof agentFingerprint !== 'string' ||
    !FINGERPRINT.test(agentFingerprint) ||
    typeof ownerFingerprint !== 'string' ||
    !FINGERPRINT.test(ownerFingerprint) ||
    typeof folder !== 'string' ||
    !FOLDER.test(folder)
  ) {
    return undefined;
  }
  let shown: CreateStatement['app'];
  if (app !== undefined) {
    if (!isObject(app)) return undefined;
    const { app: id, name, kind } = app;
    if (
      typeof id !== 'string' ||
      !APP_ID.test(id) ||
      typeof name !== 'string' ||
      !APP_NAME.test(name) ||
      (kind !== 'connect' && kind !== 'move')
    ) {
      return undefined;
    }
    shown = { id, name, kind };
  }
  return { label, agentFingerprint, ownerFingerprint, folder, ...(shown ? { app: shown } : {}) };
}

function publicKeyOf(value: unknown): CreatePublicKey | undefined {
  if (!isObject(value)) return undefined;
  const { rpId, challenge, allowCredentials, prfSalt, timeoutMs } = value;
  if (
    rpId !== 'localhost' ||
    typeof challenge !== 'string' ||
    !B64.test(challenge) ||
    typeof prfSalt !== 'string' ||
    !B64.test(prfSalt) ||
    !Array.isArray(allowCredentials) ||
    !allowCredentials.every((c) => typeof c === 'string' && B64.test(c)) ||
    typeof timeoutMs !== 'number'
  ) {
    return undefined;
  }
  return { rpId, challenge, allowCredentials: allowCredentials as string[], prfSalt, timeoutMs };
}

const FINISH_WORDS: ReadonlySet<string> = new Set([
  'tries_exhausted',
  'expired',
  'not_pending',
  'changed',
  'quit_first',
  'name_taken',
  'busy',
  'verification_required',
  'passkey_update_needed',
  'agent_changed',
  'not_applied',
]);

export function createAgentApi(options: CreateAgentApiOptions = {}): CreateAgentApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  const credentials =
    options.credentials ??
    ((): CredentialsContainer | undefined =>
      typeof navigator === 'undefined' ? undefined : navigator.credentials);

  async function post(
    path: string,
    input: Record<string, unknown>,
    body: Uint8Array,
    passkey: boolean,
  ): Promise<{ status: number; json: Record<string, unknown> } | 'offline'> {
    const headers = new Headers({
      'X-AgentLink-CSRF': token(),
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-Input': toB64(new TextEncoder().encode(JSON.stringify(input))),
    });
    if (passkey) headers.set('X-AgentLink-Presence', 'passkey');
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
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (isObject(parsed)) json = parsed;
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  function finished(
    answer: { status: number; json: Record<string, unknown> } | 'offline',
  ): CreateFinish {
    if (answer === 'offline') return { kind: 'offline' };
    const { status, json } = answer;
    const word = typeof json['status'] === 'string' ? json['status'] : json['error'];
    if (status === 200 && (word === 'done' || word === 'created_not_connected')) {
      const name = json['name'];
      const label = json['label'];
      const app = json['app'];
      if (typeof name !== 'string' || !FOLDER.test(name) || typeof label !== 'string') {
        return { kind: 'failed' };
      }
      return {
        kind: word,
        name,
        label,
        ...(typeof app === 'string' && APP_ID.test(app) ? { app } : {}),
      };
    }
    if (status === 401) return { kind: 'session' };
    if (status === 429 || word === 'wait') return { kind: 'wait' };
    if (word === 'presence_rejected') return { kind: 'rejected' };
    if (word === 'presence_required') return { kind: 'required' };
    if (typeof word === 'string' && FINISH_WORDS.has(word)) {
      return {
        kind: word as Exclude<CreateFinish['kind'], 'done' | 'created_not_connected'>,
      } as CreateFinish;
    }
    return { kind: 'failed' };
  }

  return {
    async begin(label, app) {
      const answer = await post(
        CREATE_BEGIN_PATH,
        app === undefined ? { label } : { label, app },
        new Uint8Array(0),
        false,
      );
      if (answer === 'offline') return { kind: 'offline' };
      if (answer.status === 401) return { kind: 'session' };
      const word = answer.json['status'] ?? answer.json['error'];
      if (answer.status === 200 && word === 'ready') {
        const nonce = answer.json['nonce'];
        const statement = parseStatement(answer.json['statement']);
        const publicKey = publicKeyOf(answer.json['publicKey']);
        if (typeof nonce !== 'string' || !NONCE.test(nonce) || !statement || !publicKey) {
          return { kind: 'failed' };
        }
        return { kind: 'ready', nonce, statement, publicKey };
      }
      return typeof word === 'string' ? { kind: 'refused', status: word } : { kind: 'failed' };
    },

    async finishPasskey(nonce, pk) {
      const container = credentials();
      if (container === undefined) return { kind: 'dismissed' };
      let credential: Credential | null;
      try {
        credential = await container.get({
          publicKey: {
            challenge: fromB64(pk.challenge) as BufferSource,
            rpId: pk.rpId,
            allowCredentials: pk.allowCredentials.map((id) => ({
              type: 'public-key' as const,
              id: fromB64(id) as BufferSource,
            })),
            userVerification: 'required',
            timeout: pk.timeoutMs,
            extensions: {
              prf: { eval: { first: fromB64(pk.prfSalt) } },
            } as AuthenticationExtensionsClientInputs,
          },
        });
      } catch {
        return { kind: 'dismissed' };
      }
      if (credential === null) return { kind: 'dismissed' };
      const c = credential as PublicKeyCredential;
      const r = c.response as AuthenticatorAssertionResponse;
      const ext = c.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
      const prf = bytesOf(ext.prf?.results?.first);
      const body = fields([
        bytesOf(c.rawId),
        bytesOf(r.authenticatorData),
        bytesOf(r.clientDataJSON),
        bytesOf(r.signature),
        bytesOf(r.userHandle),
        prf,
      ]);
      prf.fill(0);
      return finished(await post(CREATE_FINISH_PATH, { nonce }, body, true));
    },

    async finishCode(nonce, code) {
      // A plain Uint8Array of this realm (the code is never kept: post() wipes it).
      const body = Uint8Array.from(new TextEncoder().encode(code));
      return finished(await post(CREATE_FINISH_PATH, { nonce }, body, false));
    },
  };
}
