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
  /** M1-UX-FIRSTRUN-V2: begin refused the Send folder (it holds files); nothing began. */
  | 'folder_not_empty'
  /** M1-UX-FIRSTRUN-V2: begin refused the Send folder (a link or not a folder); nothing began. */
  | 'folder_unavailable'
  /** U3-d: the agent's name is not one core would sign (06 §2.1); nothing began. */
  | 'label_invalid'
  /** 409 `no_agent`: the app has no agent yet; setup comes first. */
  | 'no_agent'
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

/**
 * M1-UX-FIRSTRUN-V2: the first policy's Send folder after finish: `allowed`, `not_confirmed`,
 * `not_allowed`, or `none` when the server signed no first policy (or said nothing known).
 */
export type SendFolderOutcome = 'allowed' | 'not_confirmed' | 'not_allowed' | 'none';

/** The fallback computer name for the save form (owner-setup.ts UNNAMED_COMPUTER). */
export const UNNAMED_COMPUTER = 'this computer';

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
      /** M1-UX-FIRSTRUN-V2: what happened to the Send folder (a fixed code). */
      readonly sendFolder: SendFolderOutcome;
      /** M1-UX-FIRSTRUN-V2: the computer's name for the save form's username field. */
      readonly computerName: string;
    }
  | { readonly kind: 'owner_exists' }
  | SetupError;

const SEND_OUTCOMES: ReadonlySet<string> = new Set(['allowed', 'not_confirmed', 'not_allowed']);
const FOLDER_REASONS: ReadonlySet<string> = new Set(['folder_not_empty', 'folder_unavailable']);
/** The same plain-name rule as the server (owner-setup.ts computerNameOf). */
const COMPUTER_NAME = /^[A-Za-z0-9 ._-]{1,63}$/;

const PROBLEMS: ReadonlySet<string> = new Set<SetupProblem>([
  'label_invalid',
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

/** U3-d: whether the server would sign this label (`GET /api/ui/agents/label-check`). */
export type LabelCheckResult = { readonly kind: 'ok' } | { readonly kind: 'refused' } | SetupError;

export interface SetupApi {
  status(): Promise<StatusResult>;
  /** U3-g: the agent's name travels as the operation input `{label}` (U3-d; absent: no name). */
  begin(label?: string): Promise<BeginResult>;
  finish(body: Uint8Array, label?: string): Promise<FinishResult>;
  /** U3-g: asked before Touch ID, so the gesture is only asked for a name that can be signed. */
  labelCheck(label: string): Promise<LabelCheckResult>;
}

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown> | undefined;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A non-2xx or unknown answer as a fixed problem (never the body's text). */
function problemOf(answer: Answer): SetupError {
  if (str(answer.json?.['error']) === 'no_agent') return { kind: 'error', problem: 'no_agent' };
  const status = str(answer.json?.['status']);
  if (status === 'folder_refused') {
    const reason = str(answer.json?.['reason']);
    return {
      kind: 'error',
      problem:
        reason !== undefined && FOLDER_REASONS.has(reason)
          ? (reason as SetupProblem)
          : 'folder_unavailable',
    };
  }
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

const INPUT_HEADER = 'X-AgentLink-Input';
export const LABEL_CHECK_PATH = '/api/ui/agents/label-check';

/** base64url without padding of the UTF-8 JSON of `value` (the operation input, 08 §1). */
function inputOf(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One same-origin call with the page's CSRF token; the copy of `body` sent is zeroed after. */
async function request(
  doFetch: Fetch,
  token: string | undefined,
  method: 'GET' | 'POST',
  path: string,
  body?: Uint8Array,
  input?: unknown,
): Promise<Answer | 'offline'> {
  const headers = new Headers({ [CSRF_HEADER]: token ?? pageToken() });
  if (input !== undefined) headers.set(INPUT_HEADER, inputOf(input));
  const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
  // The copy sent (for finish, it holds the PRF output; for the passkey switch, also the backup
  // code) is zeroed once fetch has it (IR-M1-11b-1-1 L-3); the caller zeroes its own buffer.
  let sent: Uint8Array<ArrayBuffer> | undefined;
  if (method === 'POST') {
    headers.set('content-type', 'application/octet-stream');
    sent = body === undefined ? new Uint8Array(0) : new Uint8Array(body);
    init.body = sent;
  }
  let res: Response;
  try {
    res = await doFetch(path, init);
  } catch {
    return 'offline';
  } finally {
    sent?.fill(0);
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

export function createSetupApi(options: SetupApiOptions = {}): SetupApi {
  const doFetch: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const call = (
    method: 'GET' | 'POST',
    path: string,
    body?: Uint8Array,
    input?: unknown,
  ): Promise<Answer | 'offline'> => request(doFetch, options.token, method, path, body, input);

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

    async labelCheck(label) {
      let query: string;
      try {
        query = encodeURIComponent(label);
      } catch {
        return { kind: 'refused' }; // a lone surrogate is never a name core would sign
      }
      const answer = await call('GET', `${LABEL_CHECK_PATH}?label=${query}`);
      if (answer === 'offline') return { kind: 'error', problem: 'offline' };
      if (answer.status !== 200) return problemOf(answer);
      const status = str(answer.json?.['status']);
      if (status === 'ok') return { kind: 'ok' };
      if (status === 'refused') return { kind: 'refused' };
      return { kind: 'error', problem: 'unknown' };
    },

    async begin(label) {
      const answer = await call(
        'POST',
        BEGIN_PATH,
        undefined,
        label === undefined ? undefined : { label },
      );
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

    async finish(body, label) {
      const answer = await call(
        'POST',
        FINISH_PATH,
        body,
        label === undefined ? undefined : { label },
      );
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
        const send = str(answer.json?.['sendFolder']);
        const name = str(answer.json?.['computerName']);
        return {
          kind: 'done',
          confirmed: status === 'done',
          passkey,
          ownerCode,
          fingerprint,
          sendFolder:
            send !== undefined && SEND_OUTCOMES.has(send) ? (send as SendFolderOutcome) : 'none',
          computerName: name !== undefined && COMPUTER_NAME.test(name) ? name : UNNAMED_COMPUTER,
        };
      }
      return problemOf(answer);
    },
  };
}

// --- M1-UX-FIRSTRUN-V2-c (B-9): an owner set up before 0.3.0 switches to a passkey ---------------
//
// The switch is the existing owner operation of the approval server (M1-8e, owner-passkey.ts
// registerOwnerPasskey): `GET /api/owner/passkey` says whether a passkey is registered and gives the
// public WebAuthn values; `POST /api/owner/passkey` takes the backup code and the passkey assertion
// in one octet-stream body. The server opens the `owner` item with the code (the wrong-code backoff
// applies), seals the same owner key under the passkey and never writes the `owner` item, so the
// backup code keeps working. Nothing here signs; the code is never in a URL or a log.

export const PASSKEY_PATH = '/api/owner/passkey';

/** The public values for the passkey gesture (base64url fields). */
export interface UpgradeValues {
  readonly rpId: 'localhost';
  /** The owner's public key as `user.id` (04 §2.3 step 2). */
  readonly userId: string;
  readonly prfSalt: string;
}

export type PasskeyInfoResult =
  | { readonly kind: 'ok'; readonly registered: boolean; readonly values: UpgradeValues }
  /** No owner yet (503): owner setup, not the switch. */
  | { readonly kind: 'needs_setup' }
  | SetupError;

/** Why the switch didn't happen (strings.ts UPGRADE_MESSAGES); fixed codes only. */
export type UpgradeProblem =
  | 'presence_required'
  | 'presence_rejected'
  | 'passkey_exists'
  | 'passkey_unsupported'
  | 'busy'
  | 'wait'
  | 'needs_setup'
  | 'failed'
  | 'offline'
  | 'session_expired'
  | 'forbidden'
  | 'unknown';

export type UpgradeResult =
  | { readonly kind: 'registered' }
  | { readonly kind: 'error'; readonly problem: UpgradeProblem; readonly retryAfter?: number };

export interface UpgradeApi {
  info(): Promise<PasskeyInfoResult>;
  /** One registration body (passkey.ts encodeUpgradeBody); the caller zeroes its buffer. */
  register(body: Uint8Array): Promise<UpgradeResult>;
}

const UPGRADE_PROBLEMS: ReadonlySet<string> = new Set<UpgradeProblem>([
  'presence_required',
  'presence_rejected',
  'passkey_exists',
  'passkey_unsupported',
  'busy',
  'needs_setup',
  'failed',
]);

export function createUpgradeApi(options: SetupApiOptions = {}): UpgradeApi {
  const doFetch: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async info() {
      const answer = await request(doFetch, options.token, 'GET', PASSKEY_PATH);
      if (answer === 'offline') return { kind: 'error', problem: 'offline' };
      if (answer.status === 503) return { kind: 'needs_setup' };
      if (answer.status !== 200) return problemOf(answer);
      const raw = answer.json?.['passkey'];
      const p =
        typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
      const userId = str(p?.['userId']);
      const prfSalt = str(p?.['prfSalt']);
      const registered = p?.['registered'];
      if (
        p?.['rpId'] !== 'localhost' ||
        typeof registered !== 'boolean' ||
        userId === undefined ||
        !BASE64URL.test(userId) ||
        prfSalt === undefined ||
        !BASE64URL.test(prfSalt)
      ) {
        return { kind: 'error', problem: 'unknown' };
      }
      return { kind: 'ok', registered, values: { rpId: 'localhost', userId, prfSalt } };
    },

    async register(body) {
      const answer = await request(doFetch, options.token, 'POST', PASSKEY_PATH, body);
      if (answer === 'offline') return { kind: 'error', problem: 'offline' };
      const status = str(answer.json?.['status']);
      if (answer.status === 200 && status === 'registered') return { kind: 'registered' };
      if (status === 'wait') {
        const raw = answer.json?.['retryAfter'];
        const retryAfter =
          typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 86_400
            ? raw
            : 1;
        return { kind: 'error', problem: 'wait', retryAfter };
      }
      if (status !== undefined && UPGRADE_PROBLEMS.has(status)) {
        return { kind: 'error', problem: status as UpgradeProblem };
      }
      if (answer.status === 401) return { kind: 'error', problem: 'session_expired' };
      if (answer.status === 403) return { kind: 'error', problem: 'forbidden' };
      return { kind: 'error', problem: 'unknown' };
    },
  };
}
