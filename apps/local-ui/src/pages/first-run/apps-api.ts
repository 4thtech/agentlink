// The first-run page's calls for "Pick your AI app" and "Connect your AI app" (b11 §28.2, §28.4; 08 §1
// "Agents and AI apps in the app"; U3-f's routes in packages/node/src/local-ui/api/apps.ts).
//
// - `GET /api/ui/apps` (a read, also allowed before an owner exists): the detected AI apps, entry-only.
// - `GET /api/ui/agents`: the open agent's folder name, the value `--agent` takes (b11 §30.3).
// - `GET /api/ui/apps/preview?app=&agent=`: the exact `agentlink` entry change and its `changeId`.
// - `POST /api/ui/apps/apply` `{changeId}` (presence): the signed `app.connect`; the page's
//   generation goes in the fetch guard's header (api/generation.ts).
// The page sends no path and never any file content: it shows only what the server answers, as text,
// and only the answers' fixed fields. Answers from a server that does not have the route yet (501)
// are `not_available`; the page then offers "Later". Nothing is logged.
import { createOwnerClient } from '../contacts/owner.js';
import type { PasskeyInfo, PresenceProof } from '../contacts/owner.js';

export const APPS_PATH = '/api/ui/apps';
export const APPS_PREVIEW_PATH = '/api/ui/apps/preview';
export const APPS_APPLY_PATH = '/api/ui/apps/apply';
export const AGENTS_PATH = '/api/ui/agents';

export type { PasskeyInfo, PresenceProof };

const CSRF_HEADER = 'X-AgentLink-CSRF';
const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const APP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const CHANGE_ID = /^[0-9a-f]{64}$/;
const STATES = ['not_connected', 'connected', 'not_ours', 'unreadable'] as const;

/** One detected AI app (the server's fixed fields only). */
export interface DetectedApp {
  readonly id: string;
  /** Plain text, shown as text only. */
  readonly name: string;
  /** The config file as the server displays it (without the home folder). */
  readonly path: string;
  readonly state: (typeof STATES)[number];
  /** The folder name of the agent whose entry the app runs, when it does. */
  readonly agent?: string;
  /** True for an app that rewrites its file on exit and is open now (Claude Desktop). */
  readonly quitFirst: boolean;
}

export type AppsListResult =
  | { readonly kind: 'ok'; readonly apps: readonly DetectedApp[]; readonly desktopRunning: boolean }
  | { readonly kind: 'not_available' }
  | { readonly kind: 'session_expired' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed' };

export type CurrentAgentResult =
  | { readonly kind: 'ok'; readonly folder: string }
  /** Outside the app host, or the read failed: there is no agent folder to connect an app to. */
  | { readonly kind: 'none' };

/** The `agentlink` entry change a preview shows (b11 §30.3). */
export interface AppChange {
  readonly kind: 'connect' | 'move' | 'disconnect';
  readonly app: string;
  readonly name: string;
  readonly path: string;
  /** The agent folder the entry runs ("Agent folder: personal"). */
  readonly folder: string;
  readonly oldEntry: Readonly<Record<string, unknown>> | null;
  readonly newEntry: Readonly<Record<string, unknown>> | null;
  readonly oldAgent: string | null;
  readonly newAgent: string | null;
  readonly changeId: string;
}

export type PreviewStatus =
  'present' | 'not_connected' | 'conflict' | 'quit_first' | 'unreadable' | 'not_found';

export type PreviewResult =
  | { readonly kind: 'change'; readonly change: AppChange }
  | { readonly kind: 'status'; readonly status: PreviewStatus }
  | { readonly kind: 'not_available' }
  | { readonly kind: 'session_expired' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed' };

export type ApplyRefusal =
  | 'changed'
  | 'quit_first'
  | 'agent_mismatch'
  | 'write_failed'
  | 'not_applied'
  | 'agent_changed'
  | 'unknown';

export type ApplyResult =
  | { readonly kind: 'done' }
  | { readonly kind: 'refused'; readonly reason: ApplyRefusal }
  | { readonly kind: 'rejected' | 'required' | 'busy' | 'session_expired' | 'offline' | 'failed' }
  | { readonly kind: 'wait'; readonly seconds: number };

export interface AppsApi {
  list(): Promise<AppsListResult>;
  currentAgent(): Promise<CurrentAgentResult>;
  preview(app: string, agent: string): Promise<PreviewResult>;
  /** The stored passkey, when this browser can use it (Touch ID); otherwise the backup code. */
  passkey(): Promise<PasskeyInfo | undefined>;
  apply(changeId: string, proof: PresenceProof): Promise<ApplyResult>;
}

export interface AppsApiOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

function pageToken(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;
const agentOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' && AGENT_NAME.test(v) ? v : undefined;

interface Answer {
  readonly status: number;
  readonly json: Record<string, unknown> | undefined;
}

async function jsonOf(res: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await res.json();
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** One app of the list, or undefined when it is not exactly the server's fixed shape. */
function detectedApp(item: unknown): DetectedApp | undefined {
  if (!isObject(item)) return undefined;
  const id = str(item['app'], 32);
  const name = str(item['name'], 64);
  const path = str(item['path'], 256);
  const state = STATES.find((s) => s === item['state']);
  const agent = item['agent'];
  if (
    id === undefined ||
    !APP_ID.test(id) ||
    name === undefined ||
    path === undefined ||
    state === undefined ||
    (agent !== undefined && (typeof agent !== 'string' || !AGENT_NAME.test(agent)))
  ) {
    return undefined;
  }
  return {
    id,
    name,
    path,
    state,
    quitFirst: item['quitFirst'] === true,
    ...(typeof agent === 'string' ? { agent } : {}),
  };
}

/** The preview's change, or undefined when it is not exactly the server's fixed shape. */
function appChange(app: string, json: Record<string, unknown>): AppChange | undefined {
  const kind = (['connect', 'move', 'disconnect'] as const).find((k) => k === json['kind']);
  const changeId = json['changeId'];
  const name = str(json['name'], 64);
  const path = str(json['path'], 256);
  const folder = json['folder'];
  const oldEntry = json['oldEntry'];
  const newEntry = json['newEntry'];
  const oldAgent = agentOrNull(json['oldAgent']);
  const newAgent = agentOrNull(json['newAgent']);
  if (
    kind === undefined ||
    typeof changeId !== 'string' ||
    !CHANGE_ID.test(changeId) ||
    name === undefined ||
    path === undefined ||
    typeof folder !== 'string' ||
    !AGENT_NAME.test(folder) ||
    !(oldEntry === null || isObject(oldEntry)) ||
    !(newEntry === null || isObject(newEntry)) ||
    oldAgent === undefined ||
    newAgent === undefined
  ) {
    return undefined;
  }
  return { kind, app, name, path, folder, oldEntry, newEntry, oldAgent, newAgent, changeId };
}

const REFUSALS: readonly ApplyRefusal[] = [
  'changed',
  'quit_first',
  'agent_mismatch',
  'write_failed',
  'not_applied',
  'agent_changed',
];

export function createAppsApi(options: AppsApiOptions = {}): AppsApi {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const token = (): string => options.token ?? pageToken();

  async function get(path: string): Promise<Answer | 'offline'> {
    try {
      const res = await doFetch(path, {
        method: 'GET',
        headers: { [CSRF_HEADER]: token() },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      return { status: res.status, json: await jsonOf(res) };
    } catch {
      return 'offline';
    }
  }

  const owner = createOwnerClient({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.token === undefined ? {} : { token: options.token }),
  });

  return {
    async list() {
      const answer = await get(APPS_PATH);
      if (answer === 'offline') return { kind: 'offline' };
      if (answer.status === 501 || answer.json?.['error'] === 'no_agent') {
        return { kind: 'not_available' };
      }
      if (answer.status === 401) return { kind: 'session_expired' };
      const list = answer.json?.['apps'];
      if (answer.status !== 200 || !Array.isArray(list)) return { kind: 'failed' };
      const apps = (list as unknown[]).flatMap((item) => {
        const app = detectedApp(item);
        return app === undefined ? [] : [app];
      });
      return { kind: 'ok', apps, desktopRunning: answer.json?.['desktopRunning'] === true };
    },

    async currentAgent() {
      const answer = await get(AGENTS_PATH);
      if (answer === 'offline' || answer.status !== 200) return { kind: 'none' };
      const current = answer.json?.['current'];
      return answer.json?.['switchable'] === true &&
        typeof current === 'string' &&
        AGENT_NAME.test(current)
        ? { kind: 'ok', folder: current }
        : { kind: 'none' };
    },

    async preview(app, agent) {
      const query = `app=${encodeURIComponent(app)}&agent=${encodeURIComponent(agent)}`;
      const answer = await get(`${APPS_PREVIEW_PATH}?${query}`);
      if (answer === 'offline') return { kind: 'offline' };
      if (answer.status === 501 || answer.json?.['error'] === 'no_agent') {
        return { kind: 'not_available' };
      }
      if (answer.status === 401) return { kind: 'session_expired' };
      const json = answer.json;
      if (answer.status !== 200 || json === undefined) return { kind: 'failed' };
      if (json['status'] === 'change') {
        const change = appChange(app, json);
        return change === undefined ? { kind: 'failed' } : { kind: 'change', change };
      }
      const known = (
        ['present', 'not_connected', 'conflict', 'quit_first', 'unreadable', 'not_found'] as const
      ).find((s) => s === json['status']);
      return known === undefined ? { kind: 'failed' } : { kind: 'status', status: known };
    },

    passkey: () => owner.passkey(),

    async apply(changeId, proof) {
      if (!CHANGE_ID.test(changeId)) return { kind: 'failed' };
      const headers = new Headers({
        [CSRF_HEADER]: token(),
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-Input': base64url(JSON.stringify({ changeId })),
      });
      if (proof.kind === 'passkey') headers.set('X-AgentLink-Presence', 'passkey');
      const body = proof.kind === 'passkey' ? proof.body : new TextEncoder().encode(proof.code);
      let res: Response;
      try {
        res = await doFetch(APPS_APPLY_PATH, {
          method: 'POST',
          headers,
          body: body as BodyInit,
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        return { kind: 'offline' };
      } finally {
        // The proof (a passkey output or the typed code) is zeroed once fetch has it.
        body.fill(0);
      }
      const json = await jsonOf(res);
      const status = json?.['status'];
      const error = json?.['error'];
      if (res.status === 401) return { kind: 'session_expired' };
      if (res.status === 200 && status === 'done') return { kind: 'done' };
      if (res.status === 403 && status === 'presence_rejected') return { kind: 'rejected' };
      if (res.status === 403 && status === 'presence_required') return { kind: 'required' };
      if (res.status === 403) return { kind: 'session_expired' };
      if (res.status === 429) {
        const after = Number(res.headers.get('retry-after'));
        return { kind: 'wait', seconds: Number.isSafeInteger(after) && after > 0 ? after : 30 };
      }
      if (res.status === 409 && status === 'busy') return { kind: 'busy' };
      if (res.status === 409) {
        return { kind: 'refused', reason: REFUSALS.find((r) => r === error) ?? 'unknown' };
      }
      return { kind: 'failed' };
    },
  };
}
