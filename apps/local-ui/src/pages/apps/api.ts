// U3-i: the AI apps requests (b11 §30; 08 §1; U3-f routes). Reads are plain GETs. Apply and
// Disconnect are owner operations: the presence proof is the octet-stream body and the operation's
// input, exactly `{changeId}`, travels base64url JSON in X-AgentLink-Input (never the URL). The page
// never sends a path: the server takes it from its fixed table. The generation is stamped on every
// mutating request by the page's generation guard (api/generation.ts). The file paths and entries
// that come back are shown as text only (I-5).
import { createApiClient, type ApiClient } from '../../api/client.js';
import type { PresenceProof } from '../contacts/owner.js';
import { parseApps, parsePreview, type AppChange, type AppsList } from './data.js';

export type ReadOutcome =
  { readonly kind: 'ok'; readonly list: AppsList } | { readonly kind: 'error' };

export type PreviewOutcome =
  | { readonly kind: 'change'; readonly change: AppChange }
  /** The server has no change to show: `quit_first`, `conflict`, `present`, ... */
  | { readonly kind: 'none'; readonly status: string }
  | { readonly kind: 'agent_changed' }
  | { readonly kind: 'not_available' }
  | { readonly kind: 'error' };

export type ChangeKind =
  | 'done'
  | 'changed'
  | 'quit_first'
  | 'agent_changed'
  | 'write_failed'
  /** WP-D7: the AgentLink app sits where an AI app must not point (moved meanwhile). */
  | 'app_location'
  | 'not_applied'
  | 'rejected'
  | 'required'
  | 'wait'
  | 'busy'
  | 'session'
  | 'offline'
  | 'not_available'
  | 'failed';
export interface ChangeOutcome {
  readonly kind: ChangeKind;
  /** WP-D7: done, but the `agentlink` command (asked for) was not changed. */
  readonly launcherUnchanged?: true;
}

/** WP-D7: "Use the app for …" (`form: 'app'`), with the `agentlink` command too (`launcher`). */
export interface PreviewRequest {
  readonly form?: 'app';
  readonly launcher?: boolean;
}

export interface AppsApi {
  list(): Promise<ReadOutcome>;
  preview(app: string, agent: string, request?: PreviewRequest): Promise<PreviewOutcome>;
  apply(changeId: string, proof: PresenceProof): Promise<ChangeOutcome>;
  disconnect(changeId: string, proof: PresenceProof): Promise<ChangeOutcome>;
}

export interface AppsApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

const APPS = '/api/ui/apps';
const WORDS: ReadonlySet<string> = new Set([
  'changed',
  'quit_first',
  'agent_changed',
  'write_failed',
  'not_applied',
  'busy',
  'app_location',
]);

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A route answers `{status}` (the presence gate, the preview) or `{error}` (a route's refusal). */
async function word(res: Response): Promise<{ said?: string; launcherUnchanged?: true }> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return {};
    const { status, error, launcher } = body as {
      status?: unknown;
      error?: unknown;
      launcher?: unknown;
    };
    const extra = launcher === 'not_changed' ? { launcherUnchanged: true as const } : {};
    if (typeof status === 'string') return { said: status, ...extra };
    return typeof error === 'string' ? { said: error } : {};
  } catch {
    return {};
  }
}

export function createAppsApi(options: AppsApiOptions = {}): AppsApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  const client: ApiClient = createApiClient({
    fetch: doFetch,
    ...(options.token === undefined ? {} : { token: options.token }),
  });

  async function owner(
    path: string,
    changeId: string,
    proof: PresenceProof,
  ): Promise<ChangeOutcome> {
    const headers = new Headers({
      'X-AgentLink-CSRF': token(),
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-Input': base64url(JSON.stringify({ changeId })),
    });
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
      return { kind: 'offline' };
    } finally {
      body.fill(0);
    }
    if (res.status === 501) return { kind: 'not_available' };
    if (res.status === 401) return { kind: 'session' };
    const { said, launcherUnchanged } = await word(res);
    if (res.status === 200 && said === 'done') {
      return launcherUnchanged === true ? { kind: 'done', launcherUnchanged } : { kind: 'done' };
    }
    if (said === 'presence_rejected') return { kind: 'rejected' };
    if (said === 'presence_required') return { kind: 'required' };
    if (said === 'wait' || res.status === 429) return { kind: 'wait' };
    if (said === 'agent_mismatch') return { kind: 'agent_changed' };
    if (said !== undefined && WORDS.has(said)) return { kind: said as ChangeKind };
    if (res.status === 403) return { kind: 'session' };
    return { kind: 'failed' };
  }

  return {
    async list() {
      const result = await client.get(APPS);
      if (result.kind !== 'ok') return { kind: 'error' };
      const list = parseApps(result.data);
      return list === undefined ? { kind: 'error' } : { kind: 'ok', list };
    },
    async preview(app, agent, request = {}) {
      const query = new URLSearchParams({ app, agent });
      if (request.form === 'app') {
        query.set('form', 'app');
        if (request.launcher === true) query.set('launcher', '1');
      }
      const result = await client.get(`${APPS}/preview?${query.toString()}`);
      if (result.kind === 'not_available') return { kind: 'not_available' };
      if (result.kind === 'error' && result.status === 409) return { kind: 'agent_changed' };
      if (result.kind !== 'ok') return { kind: 'error' };
      const out = parsePreview(result.data);
      return out ?? { kind: 'error' };
    },
    apply: (changeId, proof) => owner(`${APPS}/apply`, changeId, proof),
    disconnect: (changeId, proof) => owner(`${APPS}/disconnect`, changeId, proof),
  };
}
