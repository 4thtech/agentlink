// OWNER-START-OVER (D-153; 04 §2.5.4; 08 §1): the start-over page's calls. Three fixed routes under
// /api/ui/start-over/, no query. POST bodies are `application/octet-stream` (empty, or the passkey
// creation). The input travels base64url JSON in `X-AgentLink-Input`. Answers become fixed codes; the
// server's text is never shown. Nothing is logged. The page never runs the OS gesture itself in the
// desktop app (the server does, `X-AgentLink-Presence: native`); in a browser it makes one
// user-verified passkey creation for the begin's challenge.
import { encodeRegistration, passkeysAvailable } from '../first-run/passkey.js';

export const START_OVER_BASE = '/api/ui/start-over';
const CSRF_HEADER = 'X-AgentLink-CSRF';
const INPUT_HEADER = 'X-AgentLink-Input';
const PRESENCE_HEADER = 'X-AgentLink-Presence';

export type StartOverProblem =
  | 'phrase'
  | 'expired'
  | 'presence_required'
  | 'presence_rejected'
  | 'busy'
  | 'wait'
  | 'open_app'
  | 'unsupported'
  | 'cancelled'
  | 'failed'
  | 'offline';

const PROBLEMS: ReadonlySet<string> = new Set<StartOverProblem>([
  'phrase',
  'expired',
  'presence_required',
  'presence_rejected',
  'busy',
  'wait',
  'open_app',
]);

export type Presence = 'native' | 'passkey' | 'typed';

/** How the page runs one start over. */
export interface RunOptions {
  /** True: this browser has no user-verifying platform authenticator (default: ask the browser). */
  readonly noSensor?: boolean;
  /** The typed confirmation step: resolves the second typing, or undefined when the person backs out. */
  readonly confirm?: () => Promise<string | undefined>;
}

/** True when a browser reports no user-verifying platform authenticator (Touch ID, Hello…). */
async function noPlatformAuthenticator(): Promise<boolean> {
  if (!passkeysAvailable()) return true;
  try {
    const check = (
      PublicKeyCredential as unknown as {
        isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
      }
    ).isUserVerifyingPlatformAuthenticatorAvailable;
    if (typeof check !== 'function') return false;
    return !(await check());
  } catch {
    return false;
  }
}

export interface StartOverState {
  readonly presence: Presence;
  readonly unfinished: boolean;
}

export type StartOverOutcome =
  | { readonly kind: 'done'; readonly backup: string | null; readonly earlierOnly?: true }
  | {
      readonly kind: 'partial';
      readonly backup: string | null;
      readonly failed: 'move' | 'keychain';
    }
  | { readonly kind: 'error'; readonly problem: StartOverProblem; readonly retryAfter?: number };

interface Creation {
  readonly rpId: string;
  readonly rpName: string;
  readonly userId: string;
  readonly userName: string;
  readonly challenge: string;
}

export interface StartOverApi {
  state(): Promise<StartOverState | undefined>;
  /** begin, the gesture, finish: one call for the page. */
  run(phrase: string, how?: RunOptions): Promise<StartOverOutcome>;
}

export interface StartOverApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
  /** Test seam: the browser's passkey creation (default navigator.credentials.create). */
  readonly create?: (creation: Creation) => Promise<Uint8Array | 'cancelled' | 'unsupported'>;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function inputOf(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function creationOf(value: unknown): Creation | undefined {
  if (!isRecord(value)) return undefined;
  const { rpId, rpName, userId, userName, challenge } = value;
  if (
    rpId !== 'localhost' ||
    typeof rpName !== 'string' ||
    typeof userId !== 'string' ||
    typeof userName !== 'string' ||
    typeof challenge !== 'string'
  ) {
    return undefined;
  }
  return { rpId, rpName, userId, userName, challenge };
}

/**
 * The browser's gesture: a new credential with user verification (Touch ID, Windows Hello, a phone
 * or a security key), not kept as a passkey (`residentKey: discouraged`) and with no PRF: it proves a
 * person is here and unlocks nothing.
 */
async function createDefault(
  creation: Creation,
): Promise<Uint8Array | 'cancelled' | 'unsupported'> {
  if (!passkeysAvailable()) return 'unsupported';
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { id: creation.rpId, name: creation.rpName },
        user: {
          id: fromBase64url(creation.userId),
          name: creation.userName,
          displayName: creation.userName,
        },
        challenge: fromBase64url(creation.challenge),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required' },
        hints: ['client-device'],
        attestation: 'none',
      } as PublicKeyCredentialCreationOptions,
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'NotSupportedError' || name === 'SecurityError' ? 'unsupported' : 'cancelled';
  }
  if (credential === null || !(credential instanceof PublicKeyCredential)) return 'cancelled';
  const response = credential.response as AuthenticatorAttestationResponse;
  if (typeof response.getAuthenticatorData !== 'function') return 'unsupported';
  return encodeRegistration([
    new Uint8Array(credential.rawId),
    new Uint8Array(response.getAuthenticatorData()),
    new Uint8Array(response.clientDataJSON),
    new Uint8Array(0),
  ]);
}

export function createStartOverApi(options: StartOverApiOptions = {}): StartOverApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const create = options.create ?? createDefault;

  async function call(
    method: 'GET' | 'POST',
    step: 'state' | 'begin' | 'finish',
    input?: unknown,
    presence?: Presence,
    body?: Uint8Array,
  ): Promise<{ status: number; json: Record<string, unknown> | undefined } | 'offline'> {
    const headers = new Headers({ [CSRF_HEADER]: options.token ?? pageToken() });
    if (input !== undefined) headers.set(INPUT_HEADER, inputOf(input));
    if (presence !== undefined) headers.set(PRESENCE_HEADER, presence);
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    let sent: Uint8Array<ArrayBuffer> | undefined;
    if (method === 'POST') {
      headers.set('content-type', 'application/octet-stream');
      sent = new Uint8Array(body ?? new Uint8Array(0));
      init.body = sent;
    }
    let res: Response;
    try {
      res = await doFetch(`${START_OVER_BASE}/${step}`, init);
    } catch {
      return 'offline';
    } finally {
      sent?.fill(0);
      body?.fill(0);
    }
    try {
      const parsed: unknown = await res.json();
      return { status: res.status, json: isRecord(parsed) ? parsed : undefined };
    } catch {
      return { status: res.status, json: undefined };
    }
  }

  const failure = (
    answer: { status: number; json: Record<string, unknown> | undefined } | 'offline',
  ): StartOverOutcome => {
    if (answer === 'offline') return { kind: 'error', problem: 'offline' };
    const error = answer.json?.['error'];
    const problem: StartOverProblem =
      typeof error === 'string' && PROBLEMS.has(error) ? (error as StartOverProblem) : 'failed';
    const retry = answer.json?.['retryAfter'];
    return typeof retry === 'number' && problem === 'wait'
      ? { kind: 'error', problem, retryAfter: retry }
      : { kind: 'error', problem };
  };

  return {
    async state() {
      const answer = await call('GET', 'state');
      if (answer === 'offline' || answer.status !== 200 || answer.json === undefined) {
        return undefined;
      }
      const { presence, unfinished } = answer.json;
      if ((presence !== 'native' && presence !== 'passkey') || typeof unfinished !== 'boolean') {
        return undefined;
      }
      return { presence, unfinished };
    },

    async run(phrase, how = {}) {
      // A browser page that found no user-verifying platform authenticator says so; the desktop
      // app's server decides itself, and never accepts less than a gesture where one is set up.
      const noSensor = how.noSensor ?? (await noPlatformAuthenticator());
      const begun = await call('POST', 'begin', noSensor ? { phrase, sensor: 'none' } : { phrase });
      if (begun === 'offline' || begun.status !== 200) return failure(begun);
      const nonce = begun.json?.['nonce'];
      const presence = begun.json?.['presence'];
      if (
        typeof nonce !== 'string' ||
        (presence !== 'native' && presence !== 'passkey' && presence !== 'typed')
      ) {
        return { kind: 'error', problem: 'failed' };
      }
      let body: Uint8Array | undefined;
      let second: string | undefined;
      if (presence === 'typed') {
        // Owner decision (14 Nov 2026): no sensor here, so the person types the phrase again on its
        // own step. The page never fills that field from the first one.
        if (how.confirm === undefined) return { kind: 'error', problem: 'presence_required' };
        second = await how.confirm();
        if (second === undefined) return { kind: 'error', problem: 'cancelled' };
      }
      if (presence === 'passkey') {
        const creation = creationOf(begun.json?.['publicKey']);
        if (creation === undefined) return { kind: 'error', problem: 'failed' };
        const made = await create(creation);
        if (made === 'cancelled' || made === 'unsupported') return { kind: 'error', problem: made };
        body = made;
      }
      const done = await call(
        'POST',
        'finish',
        second === undefined ? { nonce } : { nonce, phrase: second },
        presence,
        body,
      );
      if (done === 'offline' || done.status !== 200) return failure(done);
      const status = done.json?.['status'];
      const backup = done.json?.['backup'];
      const shownBackup = typeof backup === 'string' ? backup : null;
      if (status === 'done') {
        return done.json?.['earlierOnly'] === true
          ? { kind: 'done', backup: shownBackup, earlierOnly: true }
          : { kind: 'done', backup: shownBackup };
      }
      const failed = done.json?.['failed'];
      if (status === 'partial' && (failed === 'move' || failed === 'keychain')) {
        return { kind: 'partial', backup: shownBackup, failed };
      }
      return { kind: 'error', problem: 'failed' };
    },
  };
}
