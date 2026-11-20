// NET-UI-B (0.5.15; D-158): the typed client for "Use your own servers". Shapes follow specs/08 §1
// exactly (`POST /api/ui/network/test`, `POST /api/ui/network/servers`, `POST /api/ui/network/reset`,
// `GET /api/ui/network/progress`, and the 0.5.15 additions to `GET /api/ui/network`). Every answer is
// checked field by field before use; a server-supplied or contact-supplied text (a host, a contact
// name) is plain text, never markup (I-5). The page never signs: the confirm sends the owner's proof
// to a `presence: true` route and the server signs. NET-OWNER-SET wiring: the review
// (`{…, review: true}`) goes to the same owner route with its input in `X-AgentLink-Input` and an
// empty body (no presence proof); the server answers it before its presence gate and signs nothing.
import { createApiClient, type ApiClient, type OwnerPresence } from '../../../../api/client.js';
import type { PresenceProof } from '../../../contacts/owner.js';

export const TEST_PATH = '/api/ui/network/test';
export const SERVERS_PATH = '/api/ui/network/servers';
export const RESET_PATH = '/api/ui/network/reset';
export const PROGRESS_PATH = '/api/ui/network/progress';
export const STATUS_PATH = '/api/ui/network';
/** NET-ANNOUNCE-OPTOUT: "Don't also announce on the default servers" on its own (presence). */
export const ANNOUNCE_PATH = '/api/ui/network/announce';

export type TestOutcome = 'ready' | 'slow' | 'sign_in' | 'refused';
export type TestReason =
  null | 'not_accepted' | 'not_kept' | 'unreachable' | 'not_allowed' | 'too_small' | 'invalid';

export interface TestResult {
  readonly host: string;
  readonly outcome: TestOutcome;
  readonly reason: TestReason;
  readonly roundTripMs: number | null;
  readonly signInRequired: boolean;
  readonly paymentRequired: boolean;
}

export interface ServersInput {
  readonly servers: readonly string[];
  readonly automatic: boolean;
  readonly announce: boolean;
}

export interface ReviewServer {
  readonly host: string;
  readonly role: 'own' | 'automatic';
  readonly outcome: TestOutcome;
}
export interface Review {
  readonly servers: readonly ReviewServer[];
  readonly leaving: readonly { readonly host: string; readonly until: number }[];
  readonly contacts: number;
}
export interface Done {
  readonly contacts: number;
  readonly leavingUntil: number | null;
}

/** The fixed refusal codes of the routes (04 §2.6; 08 §1). */
export type Refusal =
  | 'invalid_list'
  | 'not_ready'
  | 'same_list'
  | 'too_many_previous'
  | 'rotation_pending'
  | 'agent_paused'
  | 'mix_in_on'
  | 'changed'
  | 'not_applied'
  /** NET-ANNOUNCE-OPTOUT: the announce choice is already the asked one. */
  | 'same_choice';

export type Fail =
  | { readonly kind: 'refused'; readonly code: Refusal; readonly fitsFrom?: number }
  | { readonly kind: 'rejected' | 'required' | 'wait' | 'busy' | 'session' | 'offline' | 'failed' };
export type Out<T> = { readonly kind: 'ok'; readonly value: T } | Fail;

export type ChangeState = null | 'paused' | 'rotation_pending';
export interface NetworkStatus {
  readonly agent: 'running' | 'paused' | 'not_running' | 'needs_setup';
  readonly mode: 'automatic' | 'custom' | null;
  /** How many servers this ID uses itself now (kind `own`; the default ones count). */
  readonly ownCount: number;
  readonly mixIn: boolean;
  readonly announceDefault: boolean;
  /**
   * NET-ANNOUNCE-OPTOUT: the opt-out can be switched on its own: custom mode, and the answer says
   * the mix-in is off (`mixIn: false`). Never offered when the answer does not say so.
   */
  readonly optOutOffered: boolean;
  readonly change: ChangeState;
  readonly previousUntil: number | null;
}

export interface ProgressItem {
  readonly name: string;
  readonly state: 'sent' | 'waiting';
}
export interface Progress {
  readonly changedAt: number;
  readonly total: number;
  readonly sent: number;
  readonly waiting: number;
  readonly items: readonly ProgressItem[];
  readonly leavingUntil: number | null;
}

export interface ServersApi {
  status(): Promise<Out<NetworkStatus>>;
  /** Tests 1 to 8 addresses; results come back in input order. */
  test(urls: readonly string[]): Promise<Out<readonly TestResult[]>>;
  /** The review: signs nothing. */
  review(input: ServersInput): Promise<Out<Review>>;
  /** The confirm: an owner operation (presence) that signs the reviewed card. */
  set(input: ServersInput, proof: PresenceProof): Promise<Out<Done>>;
  resetReview(): Promise<Out<Review>>;
  reset(proof: PresenceProof): Promise<Out<Done>>;
  /** `undefined` when nothing changed yet (`{changedAt: null}`) or the read failed. */
  progress(): Promise<Out<Progress | undefined>>;
  /**
   * NET-ANNOUNCE-OPTOUT (08 §1 `POST /api/ui/network/announce`): an owner operation (presence) that
   * signs `network.announce` on the server; `false` is "Don't also announce on the default servers".
   */
  announce(announceDefault: boolean, proof: PresenceProof): Promise<Out<AnnounceDone>>;
}

export interface AnnounceDone {
  readonly announceDefault: boolean;
}

// ---------------------------------------------------------------------------------------------
// Parsing

type Obj = Readonly<Record<string, unknown>>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const secondsOrNull = (v: unknown): number | null | undefined => (v === null ? null : count(v));
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
const hostOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= 260 && HOST.test(v) ? v : undefined;
const OUTCOMES: ReadonlySet<string> = new Set(['ready', 'slow', 'sign_in', 'refused']);
const REASONS: ReadonlySet<string> = new Set([
  'not_accepted',
  'not_kept',
  'unreachable',
  'not_allowed',
  'too_small',
  'invalid',
]);
const REFUSALS: ReadonlySet<string> = new Set([
  'invalid_list',
  'not_ready',
  'same_list',
  'too_many_previous',
  'rotation_pending',
  'agent_paused',
  'mix_in_on',
  'changed',
  'not_applied',
  'same_choice',
]);
const MAX_NAME = 80;

export function parseTestResults(data: unknown): readonly TestResult[] | undefined {
  const list = obj(data)?.['results'];
  if (!Array.isArray(list) || list.length < 1 || list.length > 8) return undefined;
  const out: TestResult[] = [];
  for (const raw of list) {
    const r = obj(raw);
    if (r === undefined) return undefined;
    const outcome = r['outcome'];
    const reason = r['reason'];
    const rt = r['roundTripMs'];
    // A host that is not plain DNS text is never shown: a placeholder stands in for it.
    const host = hostOf(r['host']) ?? '';
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return undefined;
    if (reason !== null && !(typeof reason === 'string' && REASONS.has(reason))) return undefined;
    out.push({
      host,
      outcome: outcome as TestOutcome,
      reason: reason as TestReason,
      roundTripMs: typeof rt === 'number' && Number.isFinite(rt) && rt >= 0 ? Math.round(rt) : null,
      signInRequired: r['signInRequired'] === true,
      paymentRequired: r['paymentRequired'] === true,
    });
  }
  return out;
}

export function parseReview(data: unknown): Review | undefined {
  const d = obj(data);
  const list = d?.['servers'];
  const leaving = d?.['leaving'];
  const contacts = count(d?.['contacts']);
  if (!Array.isArray(list) || !Array.isArray(leaving) || contacts === undefined) return undefined;
  if (list.length < 2 || list.length > 8 || leaving.length > 26) return undefined;
  const servers: ReviewServer[] = [];
  for (const raw of list) {
    const r = obj(raw);
    const host = hostOf(r?.['host']);
    const role = r?.['role'];
    const outcome = r?.['outcome'];
    if (host === undefined || (role !== 'own' && role !== 'automatic')) return undefined;
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return undefined;
    servers.push({ host, role, outcome: outcome as TestOutcome });
  }
  const gone: { host: string; until: number }[] = [];
  for (const raw of leaving) {
    const r = obj(raw);
    const host = hostOf(r?.['host']);
    const until = count(r?.['until']);
    if (host === undefined || until === undefined) return undefined;
    gone.push({ host, until });
  }
  return { servers, leaving: gone, contacts };
}

export function parseDone(data: unknown): Done | undefined {
  const d = obj(data);
  if (d?.['status'] !== 'done') return undefined;
  const contacts = count(d['contacts']);
  const until = secondsOrNull(d['leavingUntil']);
  return contacts === undefined || until === undefined
    ? undefined
    : { contacts, leavingUntil: until };
}

/** NET-ANNOUNCE-OPTOUT: `{status: 'done', announceDefault: boolean}`, else undefined. */
export function parseAnnounceDone(data: unknown): AnnounceDone | undefined {
  const d = obj(data);
  if (d?.['status'] !== 'done' || typeof d['announceDefault'] !== 'boolean') return undefined;
  return { announceDefault: d['announceDefault'] };
}

export function parseProgress(data: unknown): Progress | undefined | 'bad' {
  const d = obj(data);
  if (d === undefined) return 'bad';
  if (d['changedAt'] === null) return undefined;
  const changedAt = count(d['changedAt']);
  const c = obj(d['contacts']);
  const total = count(c?.['total']);
  const sent = count(c?.['sent']);
  const waiting = count(c?.['waiting']);
  const until = secondsOrNull(d['leavingUntil']);
  const items = d['items'];
  if (
    changedAt === undefined ||
    total === undefined ||
    sent === undefined ||
    waiting === undefined ||
    until === undefined ||
    !Array.isArray(items) ||
    items.length > 64
  ) {
    return 'bad';
  }
  const rows: ProgressItem[] = [];
  for (const raw of items) {
    const r = obj(raw);
    const name = r?.['name'];
    const state = r?.['state'];
    if (typeof name !== 'string' || (state !== 'sent' && state !== 'waiting')) continue;
    rows.push({ name: name.slice(0, MAX_NAME), state });
  }
  return { changedAt, total, sent, waiting, items: rows, leavingUntil: until };
}

export function parseStatus(data: unknown): NetworkStatus | undefined {
  const d = obj(data);
  const agent = d?.['agent'];
  if (
    agent !== 'running' &&
    agent !== 'paused' &&
    agent !== 'not_running' &&
    agent !== 'needs_setup'
  ) {
    return undefined;
  }
  const mode = d?.['mode'];
  const servers = Array.isArray(d?.['servers']) ? (d['servers'] as unknown[]) : [];
  const ownCount = servers.filter((s) => obj(s)?.['kind'] === 'own').length;
  const change = d?.['change'];
  const until = d?.['previousUntil'];
  return {
    agent,
    mode: mode === 'automatic' || mode === 'custom' ? mode : null,
    ownCount,
    mixIn: d?.['mixIn'] === true,
    announceDefault: d?.['announceDefault'] !== false,
    optOutOffered: mode === 'custom' && d?.['mixIn'] === false,
    change: change === 'paused' || change === 'rotation_pending' ? change : null,
    previousUntil: count(until) ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// The production client

export interface ServersApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

/** base64url without padding of a UTF-8 string (as the shared client sends an owner input). */
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function presenceOf(proof: PresenceProof): OwnerPresence {
  return proof.kind === 'code'
    ? proof.code
    : proof.kind === 'passkey'
      ? { passkey: proof.gesture }
      : { native: true };
}

/** A refusal word and its `fitsFrom` from a route's answer body. */
function refusalOf(status: number, body: unknown): Fail {
  const b = obj(body);
  const word = b?.['error'] ?? b?.['status'];
  if (status === 429) return { kind: 'busy' };
  if (typeof word === 'string' && REFUSALS.has(word)) {
    const fits = count(b?.['fitsFrom']);
    return {
      kind: 'refused',
      code: word as Refusal,
      ...(fits === undefined ? {} : { fitsFrom: fits }),
    };
  }
  return { kind: 'failed' };
}

export function createServersApi(options: ServersApiOptions = {}): ServersApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const client: ApiClient = createApiClient({
    fetch: doFetch,
    ...(options.token === undefined ? {} : { token: options.token }),
  });

  // A plain JSON POST that keeps the answer body of a refusal (the shared client drops it).
  async function post(
    path: string,
    body: unknown,
  ): Promise<{ readonly status: number; readonly data: unknown } | 'offline'> {
    let res: Response;
    try {
      res = await doFetch(path, {
        method: 'POST',
        headers: {
          'X-AgentLink-CSRF': options.token ?? pageToken(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return 'offline';
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    return { status: res.status, data };
  }

  // NET-OWNER-SET: the review on an owner route: the input in X-AgentLink-Input, an empty
  // octet-stream body (no master code, no passkey), so the server answers it before presence.
  async function postInput(
    path: string,
    input: unknown,
  ): Promise<{ readonly status: number; readonly data: unknown } | 'offline'> {
    let res: Response;
    try {
      res = await doFetch(path, {
        method: 'POST',
        headers: {
          'X-AgentLink-CSRF': options.token ?? pageToken(),
          'content-type': 'application/octet-stream',
          'X-AgentLink-Input': base64url(JSON.stringify(input)),
        },
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return 'offline';
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    return { status: res.status, data };
  }

  async function review(path: string, body: Record<string, unknown>): Promise<Out<Review>> {
    const res = await postInput(path, { ...body, review: true });
    if (res === 'offline') return { kind: 'offline' };
    if (res.status === 401 || res.status === 403) return { kind: 'session' };
    if (res.status === 200) {
      const parsed = parseReview(res.data);
      return parsed === undefined ? { kind: 'failed' } : { kind: 'ok', value: parsed };
    }
    return refusalOf(res.status, res.data);
  }

  async function confirm(path: string, input: unknown, proof: PresenceProof): Promise<Out<Done>> {
    return ownerCall(path, input, proof, parseDone);
  }

  async function ownerCall<T>(
    path: string,
    input: unknown,
    proof: PresenceProof,
    parse: (data: unknown) => T | undefined,
  ): Promise<Out<T>> {
    const res = await client.owner(path, input, presenceOf(proof));
    switch (res.kind) {
      case 'ok': {
        const done = parse(res.data);
        return done === undefined ? { kind: 'failed' } : { kind: 'ok', value: done };
      }
      case 'answer':
        return refusalOf(res.status, res.data);
      case 'presence_rejected':
        return { kind: 'rejected' };
      case 'presence_required':
        return { kind: 'required' };
      case 'wait':
        return { kind: 'wait' };
      case 'busy':
        return { kind: 'busy' };
      case 'session_expired':
        return { kind: 'session' };
      case 'offline':
        return { kind: 'offline' };
      case 'error':
        return { kind: 'failed' };
    }
  }

  return {
    async status() {
      const res = await client.get(STATUS_PATH);
      if (res.kind === 'offline') return { kind: 'offline' };
      if (res.kind === 'session_expired') return { kind: 'session' };
      if (res.kind !== 'ok') return { kind: 'failed' };
      const parsed = parseStatus(res.data);
      return parsed === undefined ? { kind: 'failed' } : { kind: 'ok', value: parsed };
    },
    async test(urls) {
      const res = await post(TEST_PATH, { servers: urls });
      if (res === 'offline') return { kind: 'offline' };
      if (res.status === 401 || res.status === 403) return { kind: 'session' };
      if (res.status === 429) return { kind: 'busy' };
      if (res.status !== 200) return { kind: 'failed' };
      const parsed = parseTestResults(res.data);
      return parsed === undefined || parsed.length !== urls.length
        ? { kind: 'failed' }
        : { kind: 'ok', value: parsed };
    },
    review: (input) =>
      review(SERVERS_PATH, {
        servers: input.servers,
        automatic: input.automatic,
        announce: input.announce,
      }),
    set: (input, proof) =>
      confirm(
        SERVERS_PATH,
        { servers: input.servers, automatic: input.automatic, announce: input.announce },
        proof,
      ),
    resetReview: () => review(RESET_PATH, {}),
    announce: (announceDefault, proof) =>
      ownerCall(ANNOUNCE_PATH, { announce: announceDefault }, proof, parseAnnounceDone),
    reset: (proof) => confirm(RESET_PATH, {}, proof),
    async progress() {
      const res = await client.get(PROGRESS_PATH);
      if (res.kind === 'offline') return { kind: 'offline' };
      if (res.kind !== 'ok') return { kind: 'failed' };
      const parsed = parseProgress(res.data);
      return parsed === 'bad' ? { kind: 'failed' } : { kind: 'ok', value: parsed };
    },
  };
}
