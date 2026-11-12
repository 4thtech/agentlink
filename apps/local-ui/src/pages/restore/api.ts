// The restore wizard's calls (UX1113-R3; D-147; 04 §2.3.3 "Restore in the app"). Nine fixed routes under
// /api/ui/restore/, no query. POST bodies are `application/octet-stream`: the kit file, the recovery
// code, the master code, the passkey assertion or the first-run registration encoding. The operation's
// input travels base64url JSON in `X-AgentLink-Input`. The page's copy of every secret body is zeroed
// once fetch has it. Answers become fixed codes; the server's text is never shown. Nothing is logged.
import type { PresenceProof } from '../contacts/owner.js';

export const RESTORE_BASE = '/api/ui/restore';
const CSRF_HEADER = 'X-AgentLink-CSRF';
const INPUT_HEADER = 'X-AgentLink-Input';

/** The fixed failure codes of 04 §2.3.3 plus the page's own (`offline`, `session`). */
export type RestoreProblem =
  | 'not_a_kit'
  | 'newer_version'
  | 'other_owner'
  | 'wrong_code'
  | 'damaged'
  | 'wait'
  | 'busy'
  | 'presence_required'
  | 'presence_rejected'
  | 'needs_terminal'
  | 'expired'
  | 'too_large'
  | 'invalid'
  | 'failed'
  | 'offline'
  | 'session';

const PROBLEMS: ReadonlySet<string> = new Set<RestoreProblem>([
  'not_a_kit',
  'newer_version',
  'other_owner',
  'wrong_code',
  'damaged',
  'wait',
  'busy',
  'presence_required',
  'presence_rejected',
  'needs_terminal',
  'expired',
  'too_large',
  'invalid',
  'failed',
]);

export interface Failure {
  readonly kind: 'error';
  readonly problem: RestoreProblem;
  /** Seconds to wait, for `wait`. */
  readonly retryAfter?: number;
}
export type Result<T> = ({ readonly kind: 'ok' } & T) | Failure;

export interface FoundKit {
  readonly handle: string;
  readonly name: string;
  readonly folder: string;
  readonly modifiedAt: number;
  readonly size: number;
}

export type HeaderOutcome = 'ok' | 'not_a_kit' | 'newer_version' | 'other_owner';

export type RowState = 'new' | 'name_taken' | 'already_here' | 'removed_earlier';
export interface SummaryRow {
  readonly agentId: string;
  readonly name: string;
  readonly people: number;
  readonly lastMessageAt: number | null;
  readonly state: RowState;
  readonly suggestedName?: string;
}
export interface Summary {
  readonly kitId: string;
  readonly createdAt: number;
  readonly contents: 'full' | 'identity';
  readonly ids: readonly SummaryRow[];
}

export interface Outcome {
  readonly agentId: string;
  readonly name: string;
  readonly outcome: 'restored' | 'failed';
}

/** The public WebAuthn creation values of `apply/begin` (no owner here). */
export interface Creation {
  readonly rpId: string;
  readonly rpName: string;
  readonly userId: string;
  readonly userName: string;
  readonly challenge: string;
  readonly prfSalt: string;
}
export interface PrfRequest {
  readonly rpId: string;
  readonly challenge: string;
  readonly credentialId: string;
  readonly prfSalt: string;
}

/** After the read-back: some IDs were refused (`failed` with per-ID outcomes). */
export interface PartialAnswer {
  readonly status: 'done';
  readonly ids: readonly Outcome[];
  readonly masterCode?: undefined;
  readonly touchId?: undefined;
}

export type BeginAnswer =
  | { readonly status: 'done'; readonly ids: readonly Outcome[] }
  | { readonly status: 'gesture'; readonly nonce: string; readonly publicKey: Creation };

export type FinishAnswer =
  | {
      readonly status: 'done';
      readonly ids: readonly Outcome[];
      readonly masterCode?: string | undefined;
      readonly touchId?: boolean | undefined;
    }
  | { readonly status: 'prf_needed'; readonly nonce: string; readonly publicKey: PrfRequest };

export interface RestoreApi {
  found(): Promise<Result<{ kits: readonly FoundKit[] }>>;
  upload(file: Blob): Promise<Result<{ handle: string; size: number }>>;
  header(handle: string): Promise<Result<{ header: HeaderOutcome; ownerPresent: boolean }>>;
  presence(handle: string, proof: PresenceProof): Promise<Result<object>>;
  /** The recovery code is sent as the body and wiped after. */
  open(handle: string, code: Uint8Array): Promise<Result<{ kit: string; summary: Summary }>>;
  check(handle: string, code: Uint8Array): Promise<Result<{ summary: Summary }>>;
  cancel(kit: string): Promise<Result<object>>;
  applyBegin(
    kit: string,
    selection: readonly string[],
    names: Readonly<Record<string, string>>,
  ): Promise<Result<{ answer: BeginAnswer }>>;
  applyFinish(nonce: string, body: Uint8Array): Promise<Result<{ answer: FinishAnswer }>>;
}

export interface RestoreApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function summaryOf(value: unknown): Summary | undefined {
  if (!isRecord(value) || !Array.isArray(value['ids'])) return undefined;
  const kitId = str(value['kitId']);
  const createdAt = value['createdAt'];
  const contents = value['contents'];
  if (kitId === undefined || typeof createdAt !== 'number') return undefined;
  if (contents !== 'full' && contents !== 'identity') return undefined;
  const ids: SummaryRow[] = [];
  for (const row of value['ids']) {
    if (!isRecord(row)) return undefined;
    const { agentId, name, people, lastMessageAt, state, suggestedName } = row;
    if (
      typeof agentId !== 'string' ||
      typeof name !== 'string' ||
      typeof people !== 'number' ||
      (lastMessageAt !== null && typeof lastMessageAt !== 'number') ||
      (state !== 'new' &&
        state !== 'name_taken' &&
        state !== 'already_here' &&
        state !== 'removed_earlier')
    ) {
      return undefined;
    }
    ids.push({
      agentId,
      name,
      people,
      lastMessageAt,
      state,
      ...(typeof suggestedName === 'string' ? { suggestedName } : {}),
    });
  }
  return { kitId, createdAt, contents, ids };
}

function outcomesOf(value: unknown): Outcome[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Outcome[] = [];
  for (const o of value) {
    if (!isRecord(o)) return undefined;
    const { agentId, name, outcome } = o;
    if (typeof agentId !== 'string' || typeof name !== 'string') return undefined;
    if (outcome !== 'restored' && outcome !== 'failed') return undefined;
    out.push({ agentId, name, outcome });
  }
  return out;
}

function creationOf(value: unknown): Creation | undefined {
  if (!isRecord(value)) return undefined;
  const { rpId, rpName, userId, userName, challenge, prfSalt } = value;
  if (
    rpId !== 'localhost' ||
    typeof rpName !== 'string' ||
    typeof userId !== 'string' ||
    typeof userName !== 'string' ||
    typeof challenge !== 'string' ||
    typeof prfSalt !== 'string'
  ) {
    return undefined;
  }
  return { rpId, rpName, userId, userName, challenge, prfSalt };
}

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown> | undefined;
}

export function createRestoreApi(options: RestoreApiOptions = {}): RestoreApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: Uint8Array | Blob,
    input?: unknown,
    passkey = false,
  ): Promise<Answer | 'offline'> {
    const headers = new Headers({ [CSRF_HEADER]: options.token ?? pageToken() });
    if (input !== undefined) headers.set(INPUT_HEADER, inputOf(input));
    if (passkey) headers.set('X-AgentLink-Presence', 'passkey');
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    let sent: Uint8Array<ArrayBuffer> | undefined;
    if (method === 'POST') {
      headers.set('content-type', 'application/octet-stream');
      if (body instanceof Blob) init.body = body;
      else {
        sent = new Uint8Array(body ?? new Uint8Array(0));
        init.body = sent;
      }
    }
    let res: Response;
    try {
      res = await doFetch(path, init);
    } catch {
      return 'offline';
    } finally {
      sent?.fill(0);
      if (body instanceof Uint8Array) body.fill(0);
    }
    let json: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = await res.json();
      json = isRecord(parsed) ? parsed : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  const failure = (answer: Answer | 'offline'): Failure => {
    if (answer === 'offline') return { kind: 'error', problem: 'offline' };
    const code = str(answer.json?.['error']);
    if (code !== undefined && PROBLEMS.has(code)) {
      const raw = answer.json?.['retryAfter'];
      const retryAfter =
        typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= 86_400 ? raw : 30;
      return {
        kind: 'error',
        problem: code as RestoreProblem,
        ...(code === 'wait' ? { retryAfter } : {}),
      };
    }
    if (answer.status === 401 || answer.status === 403)
      return { kind: 'error', problem: 'session' };
    return { kind: 'error', problem: 'failed' };
  };

  const partial = (a: Answer | 'offline'): PartialAnswer | undefined => {
    if (a === 'offline' || a.json?.['error'] !== 'failed') return undefined;
    const ids = outcomesOf(a.json?.['ids']);
    return ids === undefined ? undefined : { status: 'done', ids };
  };

  const bad: Failure = { kind: 'error', problem: 'failed' };
  const okOnly = (a: Answer | 'offline'): a is Answer => a !== 'offline' && a.status === 200;

  return {
    async found() {
      const a = await call('GET', `${RESTORE_BASE}/found`);
      if (!okOnly(a)) return failure(a);
      const list = a.json?.['kits'];
      if (!Array.isArray(list)) return bad;
      const kits: FoundKit[] = [];
      for (const k of list) {
        if (!isRecord(k)) continue;
        const { handle, name, folder, modifiedAt, size } = k;
        if (
          typeof handle === 'string' &&
          typeof name === 'string' &&
          typeof folder === 'string' &&
          typeof modifiedAt === 'number' &&
          typeof size === 'number'
        ) {
          kits.push({ handle, name, folder, modifiedAt, size });
        }
      }
      kits.sort((x, y) => y.modifiedAt - x.modifiedAt);
      return { kind: 'ok', kits };
    },
    async upload(file) {
      const a = await call('POST', `${RESTORE_BASE}/upload`, file);
      if (!okOnly(a)) return failure(a);
      const handle = str(a.json?.['handle']);
      const size = a.json?.['size'];
      if (handle === undefined || typeof size !== 'number') return bad;
      return { kind: 'ok', handle, size };
    },
    async header(handle) {
      const a = await call('POST', `${RESTORE_BASE}/header`, undefined, { handle });
      if (!okOnly(a)) return failure(a);
      const header = a.json?.['header'];
      if (
        header !== 'ok' &&
        header !== 'not_a_kit' &&
        header !== 'newer_version' &&
        header !== 'other_owner'
      ) {
        return bad;
      }
      return { kind: 'ok', header, ownerPresent: a.json?.['ownerPresent'] === true };
    },
    async presence(handle, proof) {
      const body = proof.kind === 'passkey' ? proof.body : new TextEncoder().encode(proof.code);
      const a = await call(
        'POST',
        `${RESTORE_BASE}/presence`,
        body,
        { handle },
        proof.kind === 'passkey',
      );
      if (!okOnly(a)) return failure(a);
      return { kind: 'ok' };
    },
    async open(handle, code) {
      const a = await call('POST', `${RESTORE_BASE}/open`, code, { handle });
      if (!okOnly(a)) return failure(a);
      const kit = str(a.json?.['kit']);
      const summary = summaryOf(a.json?.['summary']);
      if (kit === undefined || summary === undefined) return bad;
      return { kind: 'ok', kit, summary };
    },
    async check(handle, code) {
      const a = await call('POST', `${RESTORE_BASE}/check`, code, { handle });
      if (!okOnly(a)) return failure(a);
      const summary = summaryOf(a.json?.['summary']);
      return summary === undefined ? bad : { kind: 'ok', summary };
    },
    async cancel(kit) {
      const a = await call('POST', `${RESTORE_BASE}/cancel`, undefined, { kit });
      if (!okOnly(a)) return failure(a);
      return { kind: 'ok' };
    },
    async applyBegin(kit, selection, names) {
      const a = await call('POST', `${RESTORE_BASE}/apply/begin`, undefined, {
        kit,
        selection,
        names,
      });
      const partialBegin = partial(a);
      if (partialBegin !== undefined) return { kind: 'ok', answer: partialBegin };
      if (!okOnly(a)) return failure(a);
      const status = a.json?.['status'];
      if (status === 'done') {
        const ids = outcomesOf(a.json?.['ids']);
        return ids === undefined ? bad : { kind: 'ok', answer: { status: 'done', ids } };
      }
      if (status === 'gesture') {
        const nonce = str(a.json?.['nonce']);
        const publicKey = creationOf(a.json?.['publicKey']);
        if (nonce === undefined || publicKey === undefined) return bad;
        return { kind: 'ok', answer: { status: 'gesture', nonce, publicKey } };
      }
      return bad;
    },
    async applyFinish(nonce, body) {
      const a = await call('POST', `${RESTORE_BASE}/apply/finish`, body, { nonce });
      const partialFinish = partial(a);
      if (partialFinish !== undefined) return { kind: 'ok', answer: partialFinish };
      if (!okOnly(a)) return failure(a);
      const status = a.json?.['status'];
      if (status === 'done') {
        const ids = outcomesOf(a.json?.['ids']);
        const masterCode = str(a.json?.['masterCode']);
        if (ids === undefined || masterCode === undefined) return bad;
        return {
          kind: 'ok',
          answer: { status: 'done', ids, masterCode, touchId: a.json?.['touchId'] === true },
        };
      }
      if (status === 'prf_needed') {
        const nonce2 = str(a.json?.['nonce']);
        const pk = a.json?.['publicKey'];
        if (nonce2 === undefined || !isRecord(pk)) return bad;
        const { rpId, challenge, credentialId, prfSalt } = pk;
        if (
          rpId !== 'localhost' ||
          typeof challenge !== 'string' ||
          typeof credentialId !== 'string' ||
          typeof prfSalt !== 'string'
        ) {
          return bad;
        }
        return {
          kind: 'ok',
          answer: {
            status: 'prf_needed',
            nonce: nonce2,
            publicKey: { rpId, challenge, credentialId, prfSalt },
          },
        };
      }
      return bad;
    },
  };
}
