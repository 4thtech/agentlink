// U3-h: the Agents requests (b11 §29; 08 §1). The page never signs. Switching is a plain POST
// `{name, generation}` with no presence. Add, Rename and Remove are owner operations: the presence
// proof is the octet-stream body, the operation's input travels base64url JSON in X-AgentLink-Input
// (never the URL), and the server's central gate checks presence before the route runs. A route that
// is still a stub answers 501 and becomes `not_available`. The generation is also stamped on every
// mutating request by the page's generation guard (api/generation.ts).
import { createApiClient, type ApiClient } from '../../api/client.js';
import type { PresenceProof } from '../contacts/owner.js';
import { appNameOf, parseAppNames } from './app-names.js';
import { parseAgents, type AgentsList } from './data.js';

export type ReadOutcome =
  { readonly kind: 'ok'; readonly list: AgentsList } | { readonly kind: 'error' };

export type SwitchOutcome = {
  readonly kind: 'done' | 'agent_changed' | 'not_available' | 'offline' | 'failed';
};

export type OwnerKind =
  | 'done'
  | 'rejected'
  | 'required'
  | 'wait'
  | 'busy'
  | 'agent_changed'
  | 'in_use'
  | 'contacts_unreachable'
  | 'label_invalid'
  | 'label_mismatch'
  | 'invalid'
  | 'not_applied'
  | 'agent_removing'
  | 'unknown_agent'
  | 'refused'
  | 'not_available'
  | 'session'
  | 'offline'
  | 'failed';
export interface OwnerOutcome {
  readonly kind: OwnerKind;
}

export interface AgentsApi {
  list(): Promise<ReadOutcome>;
  /** GET label-check: whether the server would sign this label (before Touch ID). */
  labelCheck(label: string): Promise<'ok' | 'refused' | 'unavailable'>;
  switchTo(name: string, generation: number): Promise<SwitchOutcome>;
  rename(input: { name: string; label: string }, proof: PresenceProof): Promise<OwnerOutcome>;
  remove(
    input: { name: string; typedLabel: string; anyway?: boolean },
    proof: PresenceProof,
  ): Promise<OwnerOutcome>;
}

export interface AgentsApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

const AGENTS = '/api/ui/agents';
const WORDS: ReadonlySet<string> = new Set([
  'agent_changed',
  'in_use',
  'label_invalid',
  'label_mismatch',
  'invalid',
  'not_applied',
  'agent_removing',
  'unknown_agent',
  'refused',
  'busy',
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

async function statusWord(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return undefined;
    // Presence answers use `status`; a route's refusals arrive as `{error}` (U3-d, U3-e).
    const { status, error } = body as { status?: unknown; error?: unknown };
    if (typeof status === 'string') return status;
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

export function createAgentsApi(options: AgentsApiOptions = {}): AgentsApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();
  const client: ApiClient = createApiClient({
    fetch: doFetch,
    ...(options.token === undefined ? {} : { token: options.token }),
  });

  async function owner(
    path: string,
    input: Record<string, unknown>,
    proof: PresenceProof,
  ): Promise<OwnerOutcome> {
    const headers = new Headers({
      'X-AgentLink-CSRF': token(),
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-Input': base64url(JSON.stringify(input)),
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
    if (res.status === 429) return { kind: 'wait' };
    const word = await statusWord(res);
    if (res.status === 200 && (word === 'done' || word === 'removed')) return { kind: 'done' };
    if (word === 'undeliverable') return { kind: 'contacts_unreachable' };
    if (word === 'presence_rejected') return { kind: 'rejected' };
    if (word === 'presence_required') return { kind: 'required' };
    if (word === 'wait') return { kind: 'wait' };
    if (word !== undefined && WORDS.has(word)) return { kind: word as OwnerKind };
    if (res.status === 403) return { kind: 'session' };
    return { kind: 'failed' };
  }

  return {
    async list() {
      const result = await client.get(AGENTS);
      if (result.kind !== 'ok') return { kind: 'error' };
      const list = parseAgents(result.data);
      if (list === undefined) return { kind: 'error' };
      // U3-i: the rows hold app ids; every screen shows names. The names are read only when an
      // agent has an app, and a failed read falls back to the fixed names.
      if (!list.agents.some((r) => r.apps.length > 0)) return { kind: 'ok', list };
      const named = await client.get('/api/ui/apps');
      const names = parseAppNames(named.kind === 'ok' ? named.data : undefined);
      return {
        kind: 'ok',
        list: {
          ...list,
          agents: list.agents.map((r) => ({
            ...r,
            apps: r.apps.map((id) => appNameOf(id, names)),
          })),
        },
      };
    },
    async labelCheck(label) {
      const result = await client.get(`${AGENTS}/label-check?label=${encodeURIComponent(label)}`);
      if (result.kind !== 'ok') return 'unavailable';
      const status = (result.data as { status?: unknown } | null)?.status;
      return status === 'ok' ? 'ok' : status === 'refused' ? 'refused' : 'unavailable';
    },
    async switchTo(name, generation) {
      // The switch kind reads an octet-stream body like every other presence route (no presence).
      let res: Response;
      try {
        res = await doFetch(`${AGENTS}/switch`, {
          method: 'POST',
          headers: {
            'X-AgentLink-CSRF': token(),
            'Content-Type': 'application/octet-stream',
          },
          body: JSON.stringify({ name, generation }),
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        return { kind: 'offline' };
      }
      if (res.status === 200) return { kind: 'done' };
      if (res.status === 501) return { kind: 'not_available' };
      // 409 is `agent_changed` or a switch already running: either way the page re-reads.
      if (res.status === 409) return { kind: 'agent_changed' };
      return { kind: 'failed' };
    },
    rename: (input, proof) =>
      owner(`${AGENTS}/label`, { name: input.name, label: input.label }, proof),
    remove: (input, proof) =>
      owner(
        `${AGENTS}/remove`,
        {
          name: input.name,
          typedLabel: input.typedLabel,
          ...(input.anyway === true ? { anyway: true } : {}),
        },
        proof,
      ),
  };
}
