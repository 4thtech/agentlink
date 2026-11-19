// NET-UI-A: the Message network read (`GET /api/ui/network`, packages/node/src/local-ui/api/network.ts;
// the shape is pinned as NETWORK_SHAPE in its test), checked before use. Everything is read field by
// field; a contact's hosts are inbound content (I-5): only plain lowercase DNS text of a bounded
// length is kept, anything else is dropped, and the page renders it as React text, never a link or
// markup. No scheme, path, key or message identifier is read.
export const NETWORK_PATH = '/api/ui/network';
export const NETWORK_CONTACTS_PATH = '/api/ui/network?contacts=hosts';
/** The backend probes at most once per 15 s (NETWORK_PROBE_MS): the page never asks faster. */
export const NETWORK_POLL_MS = 15_000;
/** An event-driven read waits at least this long after the last one. */
export const NETWORK_EVENT_MIN_MS = 5_000;
/** The live store announces the stream's `network` event with this window event. */
export const NETWORK_CHANGED = 'agentlink:network-changed';

export type NetworkAgent = 'running' | 'paused' | 'not_running' | 'needs_setup';
export type ServerHealth = 'ready' | 'slow' | 'unreachable' | 'blocked' | 'unknown';

export interface NetworkServer {
  readonly host: string;
  readonly sends: boolean;
  readonly kind: 'own' | 'legacy';
  readonly state: ServerHealth;
  readonly connectMs: number | null;
  readonly roundTripMs: number | null;
  readonly signInRequired: boolean | null;
  readonly paymentRequired: boolean | null;
  readonly publishedOk: number;
  readonly publishedFailed: number;
  readonly received: number;
  readonly lastOkAt: number | null;
  /** Contacts using this server too, when the route says (else derived from the expanded answer). */
  readonly contacts: number | null;
}

export interface NetworkContactHosts {
  readonly ref: string;
  readonly servers: number;
  readonly shared: number;
  readonly hosts: readonly string[];
}

export interface NetworkAnswer {
  readonly agent: NetworkAgent;
  readonly mode: 'automatic' | 'custom' | null;
  readonly checking: boolean;
  readonly checkedAt: number | null;
  readonly servers: readonly NetworkServer[];
  readonly legacyReadUntil: number | null;
  readonly contacts: { readonly total: number; readonly sharing: number };
  readonly contactHosts?: readonly NetworkContactHosts[];
}

const AGENTS: ReadonlySet<string> = new Set(['running', 'paused', 'not_running', 'needs_setup']);
const STATES: ReadonlySet<string> = new Set(['ready', 'slow', 'unreachable', 'blocked', 'unknown']);
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
const REF = /^0x[0-9a-f]{40}$/;
const MAX_SERVERS = 26;
const MAX_CONTACTS = 64;
const MAX_HOSTS = 16;
const MAX_COUNT = 1_000_000_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_COUNT ? v : 0;
const countOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_COUNT ? v : null;
/** Unix seconds (before the year 2100). */
const time = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 4_102_444_800 ? v : null;
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** A host as plain text, or undefined (never a link, never markup). */
export function plainHost(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 260 && HOST.test(v) ? v : undefined;
}

function server(v: unknown): NetworkServer | undefined {
  if (!isObject(v)) return undefined;
  const host = plainHost(v['host']);
  const state = v['state'];
  const kind = v['kind'];
  if (host === undefined || typeof state !== 'string' || !STATES.has(state)) return undefined;
  if (kind !== 'own' && kind !== 'legacy') return undefined;
  const roles = Array.isArray(v['roles']) ? (v['roles'] as unknown[]) : [];
  return {
    host,
    sends: roles.includes('send'),
    kind,
    state: state as ServerHealth,
    connectMs: countOrNull(v['connectMs']),
    roundTripMs: countOrNull(v['roundTripMs']),
    signInRequired: flag(v['signInRequired']),
    paymentRequired: flag(v['paymentRequired']),
    publishedOk: count(v['publishedOk']),
    publishedFailed: count(v['publishedFailed']),
    received: count(v['received']),
    lastOkAt: time(v['lastOkAt']),
    contacts: countOrNull(v['contacts']),
  };
}

function contactHosts(v: unknown): NetworkContactHosts | undefined {
  if (!isObject(v)) return undefined;
  const ref = v['ref'];
  if (typeof ref !== 'string' || !REF.test(ref) || !Array.isArray(v['hosts'])) return undefined;
  const hosts = (v['hosts'] as unknown[])
    .map(plainHost)
    .filter((h): h is string => h !== undefined)
    .slice(0, MAX_HOSTS);
  return { ref, servers: count(v['servers']), shared: count(v['shared']), hosts };
}

/** The answer, or undefined when it is not the expected shape. */
export function parseNetwork(data: unknown): NetworkAnswer | undefined {
  if (!isObject(data)) return undefined;
  const agent = data['agent'];
  if (typeof agent !== 'string' || !AGENTS.has(agent) || !Array.isArray(data['servers'])) {
    return undefined;
  }
  const mode = data['mode'];
  const contacts = isObject(data['contacts']) ? data['contacts'] : {};
  const total = count(contacts['total']);
  const sharing = Math.min(count(contacts['sharing']), total);
  const servers = (data['servers'] as unknown[])
    .slice(0, MAX_SERVERS)
    .map(server)
    .filter((s): s is NetworkServer => s !== undefined);
  const hosts = Array.isArray(data['contactHosts'])
    ? (data['contactHosts'] as unknown[])
        .slice(0, MAX_CONTACTS)
        .map(contactHosts)
        .filter((c): c is NetworkContactHosts => c !== undefined)
    : undefined;
  return {
    agent: agent as NetworkAgent,
    mode: mode === 'automatic' || mode === 'custom' ? mode : null,
    checking: data['checking'] === true,
    checkedAt: time(data['checkedAt']),
    servers,
    legacyReadUntil: time(data['legacyReadUntil']),
    contacts: { total, sharing },
    ...(hosts === undefined ? {} : { contactHosts: hosts }),
  };
}

export type NetworkSummary =
  | 'checking'
  | 'empty'
  | 'healthy'
  | 'one_slow'
  | 'some_slow'
  | 'one_down'
  | 'some_down'
  | 'all_down';

/** The headline state of a running agent's own servers (the old read-only ones never count). */
export function summarize(answer: NetworkAnswer): NetworkSummary {
  const own = answer.servers.filter((s) => s.kind === 'own');
  if (own.length === 0 || own.every((s) => s.state === 'unknown')) {
    return answer.checking ? 'checking' : 'empty';
  }
  const down = own.filter((s) => s.state === 'unreachable' || s.state === 'blocked').length;
  const slow = own.filter((s) => s.state === 'slow').length;
  if (down === own.length) return 'all_down';
  if (down === 1) return 'one_down';
  if (down > 1) return 'some_down';
  if (slow === 1) return 'one_slow';
  if (slow > 1) return 'some_slow';
  return 'healthy';
}

/** 48 ms, 1.9 s. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
