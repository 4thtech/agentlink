// The first-run page's calls to the approval server (08 §1; M1-11s-c, D-120 (1)). The browser never
// signs and never sees the owner key: `begin` returns only public WebAuthn creation values, `finish`
// sends the passkey creation response, and the server creates and stores everything. The answers are
// fixed codes; bodies, the session token and the owner code are never logged.
//
// The setup routes take an `application/octet-stream` body (an empty one for `begin`), unlike the
// app's JSON client (api/client.ts), so this file makes its own same-origin call with the page's
// CSRF token, exactly as that client does.

export const STATUS_PATH = '/api/ui/first-run';
export const BEGIN_PATH = '/api/ui/first-run/owner/begin';
export const FINISH_PATH = '/api/ui/first-run/owner/finish';
const CSRF_HEADER = 'X-AgentLink-CSRF';

/** A failure the page explains in plain words (strings.ts SETUP_MESSAGES). */
export type SetupProblem =
  | 'expired'
  | 'not_pending'
  | 'busy'
  | 'wait'
  | 'presence_required'
  | 'presence_rejected'
  | 'invalid'
  | 'unavailable'
  | 'rolled_back'
  | 'keychain'
  | 'check_failed'
  | 'internal'
  | 'offline'
  | 'session_expired'
  | 'forbidden'
  | 'unknown';

export interface SetupError {
  readonly kind: 'error';
  readonly problem: SetupProblem;
  /** Seconds to wait, for `wait`. */
  readonly retryAfter?: number;
}

/** The public WebAuthn creation values `begin` returns (base64url fields). */
export interface CreationValues {
  readonly rpId: string;
  readonly rpName: string;
  readonly userId: string;
  readonly userName: string;
  readonly challenge: string;
  readonly prfSalt: string;
}

export type SetupState = 'missing' | 'set_up' | 'unknown';

export type StatusResult = { readonly kind: 'ok'; readonly owner: SetupState } | SetupError;

export type BeginResult =
  | { readonly kind: 'ready'; readonly publicKey: CreationValues }
  | { readonly kind: 'owner_exists' }
  | SetupError;

export type FinishResult =
  | {
      readonly kind: 'done';
      /** False for `done_unconfirmed`: the owner was kept, one step couldn't be confirmed. */
      readonly confirmed: boolean;
      /** False when the authenticator gave no PRF output: the owner code is the way to approve. */
      readonly passkey: boolean;
      /** The backup owner code, grouped; shown on this page only, never stored or logged. */
      readonly ownerCode: string;
      readonly fingerprint: string;
    }
  | { readonly kind: 'owner_exists' }
  | SetupError;

const PROBLEMS: ReadonlySet<string> = new Set<SetupProblem>([
  'expired',
  'not_pending',
  'busy',
  'wait',
  'presence_required',
  'presence_rejected',
  'invalid',
  'unavailable',
]);
const REASONS: ReadonlySet<string> = new Set<SetupProblem>([
  'rolled_back',
  'keychain',
  'check_failed',
  'internal',
]);
const BASE64URL = /^[A-Za-z0-9_-]{1,2048}$/;
/** The grouped owner code: 24 characters in groups of four (04 §2.8 kind 1). */
const OWNER_CODE = /^[A-Z0-9]{4}( [A-Z0-9]{4}){1,15}$/;
/** The short owner fingerprint (11 §5.2), for example `7F3A·19C2`. */
const FINGERPRINT = /^[0-9A-F]{4}(·[0-9A-F]{4}){1,7}$/;

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

type Fetch = typeof fetch;

export interface SetupApiOptions {
  readonly fetch?: Fetch;
  readonly token?: string;
}

export interface SetupApi {
  status(): Promise<StatusResult>;
  begin(): Promise<BeginResult>;
  finish(body: Uint8Array): Promise<FinishResult>;
}

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown> | undefined;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A non-2xx or unknown answer as a fixed problem (never the body's text). */
function problemOf(answer: Answer): SetupError {
  const status = str(answer.json?.['status']);
  if (status === 'failed') {
    const reason = str(answer.json?.['reason']);
    return {
      kind: 'error',
      problem: reason !== undefined && REASONS.has(reason) ? (reason as SetupProblem) : 'internal',
    };
  }
  if (status === 'wait') {
    const raw = answer.json?.['retryAfter'];
    const retryAfter =
      typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 86_400 ? raw : 1;
    return { kind: 'error', problem: 'wait', retryAfter };
  }
  if (status !== undefined && PROBLEMS.has(status)) {
    return { kind: 'error', problem: status as SetupProblem };
  }
  if (answer.status === 401) return { kind: 'error', problem: 'session_expired' };
  if (answer.status === 403) return { kind: 'error', problem: 'forbidden' };
  return { kind: 'error', problem: 'unknown' };
}

function creationValues(value: unknown): CreationValues | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const rpId = str(v['rpId']);
  const rpName = str(v['rpName']);
  const userName = str(v['userName']);
  const userId = str(v['userId']);
  const challenge = str(v['challenge']);
  const prfSalt = str(v['prfSalt']);
  if (
    rpId !== 'localhost' ||
    rpName === undefined ||
    rpName.length > 64 ||
    userName === undefined ||
    userName.length > 64 ||
    userId === undefined ||
    !BASE64URL.test(userId) ||
    challenge === undefined ||
    !BASE64URL.test(challenge) ||
    prfSalt === undefined ||
    !BASE64URL.test(prfSalt)
  ) {
    return undefined;
  }
  return { rpId, rpName, userId, userName, challenge, prfSalt };
}

export function createSetupApi(options: SetupApiOptions = {}): SetupApi {
  const doFetch: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: Uint8Array,
  ): Promise<Answer | 'offline'> {
    const headers = new Headers({ [CSRF_HEADER]: options.token ?? pageToken() });
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    if (method === 'POST') {
      headers.set('content-type', 'application/octet-stream');
      init.body = body === undefined ? new Uint8Array(0) : new Uint8Array(body);
    }
    let res: Response;
    try {
      res = await doFetch(path, init);
    } catch {
      return 'offline';
    }
    let json: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = await res.json();
      json =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  return {
    async status() {
      const answer = await call('GET', STATUS_PATH);
      if (answer === 'offline') return { kind: 'error', problem: 'offline' };
      if (answer.status !== 200) return problemOf(answer);
      const owner = str(answer.json?.['owner']);
      return {
        kind: 'ok',
        owner: owner === 'missing' || owner === 'set_up' ? owner : 'unknown',
      };
    },

    async begin() {
      const answer = await call('POST', BEGIN_PATH);
      if (answer === 'offline') return { kind: 'error', problem: 'offline' };
      const status = str(answer.json?.['status']);
      if (status === 'owner_exists') return { kind: 'owner_exists' };
      if (answer.status === 200 && status === 'ready') {
        const publicKey = creationValues(answer.json?.['publicKey']);
        return publicKey === undefined
          ? { kind: 'error', problem: 'unknown' }
          : { kind: 'ready', publicKey };
      }
      return problemOf(answer);
    },

    async finish(body) {
      const answer = await call('POST', FINISH_PATH, body);
      if (answer === 'offline') return { kind: 'error', problem: 'offline' };
      const status = str(answer.json?.['status']);
      if (status === 'owner_exists') return { kind: 'owner_exists' };
      if (answer.status === 200 && (status === 'done' || status === 'done_unconfirmed')) {
        const ownerCode = str(answer.json?.['ownerCode']);
        const fingerprint = str(answer.json?.['fingerprint']);
        const passkey = answer.json?.['passkey'];
        if (
          ownerCode === undefined ||
          !OWNER_CODE.test(ownerCode) ||
          fingerprint === undefined ||
          !FINGERPRINT.test(fingerprint) ||
          typeof passkey !== 'boolean'
        ) {
          // The setup may have happened; the page sends the owner to `agentlink doctor`.
          return { kind: 'error', problem: 'unknown' };
        }
        return { kind: 'done', confirmed: status === 'done', passkey, ownerCode, fingerprint };
      }
      return problemOf(answer);
    },
  };
}
