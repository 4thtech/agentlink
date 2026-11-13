// RET-4 (D-148; 04 §4.2; 08 §1 "The delete sheet"): the page's side of Delete history.
//
// - begin, undo and status are the history route kind: a same-origin POST with the page's CSRF token
//   and one JSON object as the octet-stream body; no presence, nothing deleted.
// - finish is an owner operation (contacts/owner.ts): the presence proof is the body and the input is
//   exactly `{nonce}`; the server applies only the list it fixed at begin, after the Undo window.
// Nothing here logs; answers are parsed field by field.
import type { OwnerClient, OwnerResult, PresenceProof } from '../contacts/owner.js';

export const HISTORY_BEGIN = '/api/ui/history/delete/begin';
export const HISTORY_FINISH = '/api/ui/history/delete/finish';
export const HISTORY_UNDO = '/api/ui/history/delete/undo';
export const HISTORY_STATUS = '/api/ui/history/delete/status';
export const INBOX_REVEAL = '/api/ui/storage/inbox/reveal';

export type Include = 'messages' | 'files' | 'both';

/** What to delete: a person, an age, both, or chosen messages. */
export interface DeleteTarget {
  readonly contact?: string;
  readonly olderThanDays?: number;
  readonly envelopeIds?: readonly string[];
}

export interface Planned {
  readonly nonce: string;
  readonly messages: { readonly count: number; readonly bytes: number };
  readonly files: { readonly count: number; readonly bytes: number };
  readonly notarized: number;
  readonly kept: number;
  readonly truncated: boolean;
  readonly undoSeconds: number;
}

export interface DeleteResult {
  readonly messages: {
    readonly deleted: number;
    readonly notarized: number;
    readonly kept: number;
  };
  readonly files: {
    readonly trashed: number;
    readonly changed: number;
    readonly missing: number;
    readonly refused: number;
    readonly noTrash: number;
    readonly failed: number;
  };
}

export type StatusAnswer =
  | { readonly status: 'done'; readonly result: DeleteResult }
  | { readonly status: 'scheduled' | 'applying' | 'planned' }
  | { readonly status: 'cancelled' | 'changed' | 'agent_changed' | 'failed' | 'not_found' }
  | { readonly status: 'offline' };

export interface HistoryApi {
  begin(target: DeleteTarget, include: Include): Promise<Planned | 'failed' | 'offline'>;
  finish(owner: OwnerClient, nonce: string, proof: PresenceProof): Promise<OwnerResult>;
  undo(nonce: string): Promise<'cancelled' | 'too_late' | 'failed'>;
  status(nonce: string): Promise<StatusAnswer>;
  revealInbox(): Promise<'shown' | 'failed'>;
}

export interface HistoryApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

const CSRF_HEADER = 'X-AgentLink-CSRF';
const NONCE = /^[A-Za-z0-9_-]{43}$/;

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function pair(v: unknown): { count: number; bytes: number } | undefined {
  if (!isRecord(v) || !isCount(v['count']) || !isCount(v['bytes'])) return undefined;
  return { count: v['count'], bytes: v['bytes'] };
}

export function parsePlanned(data: unknown): Planned | undefined {
  if (!isRecord(data) || data['status'] !== 'planned') return undefined;
  const nonce = data['nonce'];
  const messages = pair(data['messages']);
  const files = pair(data['files']);
  const { notarized, kept, truncated, undoSeconds } = data;
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return undefined;
  if (messages === undefined || files === undefined) return undefined;
  if (!isCount(notarized) || !isCount(kept) || typeof truncated !== 'boolean') return undefined;
  return {
    nonce,
    messages,
    files,
    notarized,
    kept,
    truncated,
    undoSeconds: isCount(undoSeconds) && undoSeconds > 0 && undoSeconds <= 60 ? undoSeconds : 10,
  };
}

function parseResult(v: unknown): DeleteResult | undefined {
  if (!isRecord(v) || !isRecord(v['messages']) || !isRecord(v['files'])) return undefined;
  const m = v['messages'];
  const f = v['files'];
  const keys = ['trashed', 'changed', 'missing', 'refused', 'noTrash', 'failed'] as const;
  if (!isCount(m['deleted']) || !isCount(m['notarized']) || !isCount(m['kept'])) return undefined;
  if (!keys.every((k) => isCount(f[k]))) return undefined;
  return {
    messages: { deleted: m['deleted'], notarized: m['notarized'], kept: m['kept'] },
    files: {
      trashed: f['trashed'] as number,
      changed: f['changed'] as number,
      missing: f['missing'] as number,
      refused: f['refused'] as number,
      noTrash: f['noTrash'] as number,
      failed: f['failed'] as number,
    },
  };
}

const STATES: ReadonlySet<string> = new Set([
  'scheduled',
  'applying',
  'planned',
  'cancelled',
  'changed',
  'agent_changed',
  'failed',
  'not_found',
]);

export function createHistoryApi(options: HistoryApiOptions = {}): HistoryApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();

  async function post(
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: unknown } | 'offline'> {
    const headers = new Headers({
      [CSRF_HEADER]: token(),
      'content-type': 'application/octet-stream',
    });
    let res: Response;
    try {
      res = await doFetch(path, {
        method: 'POST',
        headers,
        body: (body === undefined
          ? new Uint8Array(0)
          : new TextEncoder().encode(JSON.stringify(body))) as BodyInit,
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch {
      return 'offline';
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  return {
    async begin(target, include) {
      const body =
        target.envelopeIds !== undefined
          ? { envelopeIds: [...target.envelopeIds], include }
          : {
              ...(target.contact === undefined ? {} : { contact: target.contact }),
              ...(target.olderThanDays === undefined
                ? {}
                : { olderThanDays: target.olderThanDays }),
              include,
            };
      const res = await post(HISTORY_BEGIN, body);
      if (res === 'offline') return 'offline';
      if (res.status !== 200) return 'failed';
      return parsePlanned(res.json) ?? 'failed';
    },
    finish(owner, nonce, proof) {
      return owner.post(HISTORY_FINISH, { nonce }, proof);
    },
    async undo(nonce) {
      const res = await post(HISTORY_UNDO, { nonce });
      if (res === 'offline' || !isRecord(res.json)) return 'failed';
      const s = res.json['status'];
      return s === 'cancelled' || s === 'too_late' ? s : 'failed';
    },
    async status(nonce) {
      const res = await post(HISTORY_STATUS, { nonce });
      if (res === 'offline') return { status: 'offline' };
      if (!isRecord(res.json)) return { status: 'failed' };
      const s = res.json['status'];
      if (s === 'done') {
        const result = parseResult(res.json['result']);
        return result === undefined ? { status: 'failed' } : { status: 'done', result };
      }
      return typeof s === 'string' && STATES.has(s)
        ? ({ status: s } as StatusAnswer)
        : { status: 'failed' };
    },
    async revealInbox() {
      const res = await post(INBOX_REVEAL, undefined);
      return res !== 'offline' && res.status === 200 ? 'shown' : 'failed';
    },
  };
}
