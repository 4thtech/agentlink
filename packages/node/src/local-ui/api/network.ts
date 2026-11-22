// NET-ROUTE (08 §1 `GET /api/ui/network`; 07 §4.3; 04 §4; 06 §4; I-4, I-5, I-7; owner D1, 19 Nov
// 2026): the read behind Advanced › Message network (Under the hood only).
//
// A read route (presence: false) behind the server's session cookie, CSRF header, exact Host, Origin
// and fetch-metadata checks, like every /api/ui/ read; not an MCP tool, and no tool reaches it. One
// query is known: `contacts=hosts` (exactly once) adds each contact's server hosts; anything else is
// 400 `invalid_query`.
//
// One fixed, allowlisted answer, built field by field (nothing of the source object is passed on):
//   { agent: 'running' | 'paused' | 'not_running' | 'needs_setup',
//     mode: 'automatic' | 'custom' | null,      // automatic: every own server is a default one
//     checking: boolean,                        // a probe runs and none has finished yet
//     checkedAt: unixSec | null,                // the last finished probe
//     servers: [ { host,                        // origin host only; ':port' only when not 443
//                  roles: ['send','read'] | ['read'],
//                  kind: 'own' | 'legacy',
//                  state: 'ready' | 'slow' | 'unreachable' | 'blocked' | 'unknown',
//                  connectMs, roundTripMs: int | null,
//                  signInRequired, paymentRequired: boolean | null,
//                  publishedOk, publishedFailed, received: int,   // the rolling day window
//                  countsSince, lastOkAt: unixSec | null,
//                  lastError: fixed class | null,
//                  contacts: int } ],                 // contacts listing it; at most 26 servers
//     legacyReadUntil: unixSec | null,
//     contacts: { total, sharing },             // counts: contacts sharing at least one server
//     updateWouldDrop: int,                     // D-157 (2): own servers a pending contact-details
//                                               // update would leave out (only the first 8 are kept)
//     mixIn: boolean,                           // 0.5.15: the list holds default servers
//     announceDefault: boolean,                 // 0.5.15: false after the announce opt-out
//     change: null | 'paused' | 'rotation_pending', // 0.5.15: why changing servers is off now
//     previousUntil: unixSec | null,            // 0.5.15: the latest end of the leaving servers
//     sharedLink: { on: boolean, programs: int }, // RELAY-SHARED-CONN: counts only (D-159)
//     contactHosts?: [ { ref, servers, shared, hosts: [host] } ] } // only with contacts=hosts
// Hosts (D1): the origin host only, never the scheme, a path, a query or credentials; a contact's
// hosts are inbound content (I-5): only lowercase DNS text that passes the relay URL rule (04 §4)
// and is at most NETWORK_MAX_HOST_LENGTH characters is answered, anything else is left out; plain
// text for the page, never markup, a link or a NIP-11 field. Never a key, an event or message id, a
// relay's own text, or an error's text.
import type { JsonObject } from '@4thtech-io/crypto';
import { isAllowedRelayUrl } from '@4thtech-io/types';
import type { LocalUiContext } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

export const NETWORK_PATH = '/api/ui/network';
/** Servers answered: an own list carried by a card (16) plus the two legacy ones, with room. */
export const NETWORK_MAX_SERVERS = 26;
/** Hosts answered per contact (a contact's card carries at most 16). */
export const NETWORK_MAX_CONTACT_HOSTS = 16;
/** Contacts answered in the expanded view. */
export const NETWORK_MAX_CONTACTS = 64;
/** The longest host answered (a DNS name is at most 253 characters). */
export const NETWORK_MAX_HOST_LENGTH = 253;
/** A counter above this is not answered (a plain whole number the page can show). */
const MAX_COUNT = 1_000_000_000;
/** A time or duration further ahead than this (clock skew) is dropped. */
const FUTURE_SLACK_SECONDS = 300;
/** A duration above this many milliseconds is not a probe's (its bound is 5 s). */
const MAX_MS = 60_000;

const HOST_URL = /^wss:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\/[^?#]*)?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const REF = /^0x[0-9a-f]{40}$/;

const ERROR_CLASSES: ReadonlySet<string> = new Set([
  'invalid_url',
  'blocked_address',
  'resolve_failed',
  'connect_failed',
  'connect_timeout',
  'too_large',
  'rejected',
  'ok_timeout',
  'auth_failed',
  'closed',
  'subscription_closed',
  'connection_lost',
  'too_many_events',
]);

export type LocalUiNetworkAgent = 'running' | 'paused' | 'not_running' | 'needs_setup';
export type LocalUiNetworkState = 'ready' | 'slow' | 'unreachable' | 'blocked' | 'unknown';

/** One probe result as the source hands it (untrusted shape, checked here). */
export interface LocalUiNetworkProbe {
  readonly state: string;
  readonly connectMs: number | null;
  readonly roundTripMs: number | null;
  readonly authRequired: boolean | null;
  readonly paymentRequired: boolean | null;
  /** NET-VIEW-0514-1: asked over the pool's open connection (a timeout there is slow, not down). */
  readonly reused?: boolean;
}

/** One server's counters as the source hands them (untrusted shape, checked here). */
export interface LocalUiNetworkStats {
  readonly origin: string;
  readonly since: number;
  readonly publishedOk: number;
  readonly publishedFailed: number;
  readonly received: number;
  readonly lastOkAt: number | null;
  readonly lastError: string | null;
}

/** What the reader (network-view.ts) assembles; every field is checked again here. */
export interface LocalUiNetworkSnapshot {
  readonly agent: 'running' | 'paused' | 'not_running';
  readonly mode?: 'automatic' | 'custom';
  readonly checking?: boolean;
  readonly checkedAt?: number;
  readonly servers: readonly {
    readonly relay: string;
    readonly kind: 'own' | 'legacy';
    /** Active contacts whose card lists this server (counts only). */
    readonly contacts?: number;
    readonly probe?: LocalUiNetworkProbe;
    readonly stats?: LocalUiNetworkStats;
  }[];
  readonly legacyReadUntil?: number;
  /** D-157 (2): own entries the pending contact-details update would leave out. */
  readonly updateDrops?: number;
  readonly contacts?: { readonly total: number; readonly sharing: number };
  /** 0.5.15 (08 §1 additions; D-158, NET-ANNOUNCE-OPTOUT). Absent: false, true, null, null. */
  readonly mixIn?: boolean;
  readonly announceDefault?: boolean;
  readonly previousUntil?: number;
  readonly change?: null | 'paused' | 'rotation_pending';
  /** RELAY-SHARED-CONN (08 §1): this computer's shared server connection. Absent: off. */
  readonly sharedLink?: { readonly on: boolean; readonly programs: number };
  readonly contactLists?: readonly {
    readonly contactId: string;
    readonly relays: readonly string[];
    readonly shared: number;
  }[];
}

export interface LocalUiNetworkServer extends JsonObject {
  readonly host: string;
  readonly roles: readonly ('send' | 'read')[];
  readonly kind: 'own' | 'legacy';
  readonly state: LocalUiNetworkState;
  readonly connectMs: number | null;
  readonly roundTripMs: number | null;
  readonly signInRequired: boolean | null;
  readonly paymentRequired: boolean | null;
  readonly publishedOk: number;
  readonly publishedFailed: number;
  readonly received: number;
  readonly countsSince: number | null;
  readonly lastOkAt: number | null;
  readonly lastError: string | null;
  /** Active contacts whose card lists this server (a count; never who). */
  readonly contacts: number;
}

export interface LocalUiNetworkContactHosts extends JsonObject {
  readonly ref: string;
  readonly servers: number;
  readonly shared: number;
  readonly hosts: readonly string[];
}

/** The route's answer body. */
export interface LocalUiNetworkBody extends JsonObject {
  readonly agent: LocalUiNetworkAgent;
  readonly mode: 'automatic' | 'custom' | null;
  readonly checking: boolean;
  readonly checkedAt: number | null;
  readonly servers: readonly LocalUiNetworkServer[];
  readonly legacyReadUntil: number | null;
  readonly contacts: { readonly total: number; readonly sharing: number };
  /** D-157 (2): own servers the pending "Update your contact details" would leave out (0: none). */
  readonly updateWouldDrop: number;
  /** 0.5.15 (08 §1): true when the own list holds default servers (the mix-in). */
  readonly mixIn: boolean;
  /** 0.5.15: false only after the owner's announce opt-out (D-158 (7)). */
  readonly announceDefault: boolean;
  /** 0.5.15: why changing servers is off now (C7b). */
  readonly change: null | 'paused' | 'rotation_pending';
  /** 0.5.15: the latest end of the leaving servers (unix seconds), or null. */
  readonly previousUntil: number | null;
  /** RELAY-SHARED-CONN (08 §1, 11 §5.15): a boolean and a count only. */
  readonly sharedLink: LocalUiSharedLink;
  readonly contactHosts?: readonly LocalUiNetworkContactHosts[];
}

/** `sharedLink` of the network answer and the server test answer (08 §1). */
export interface LocalUiSharedLink extends JsonObject {
  readonly on: boolean;
  readonly programs: number;
}

/** Programs answered at most (the link serves 32; room for a bigger cap later). */
const MAX_PROGRAMS = 1_000;

/** The allowlisted `sharedLink`: `{on, programs}` only; off (0) for anything that is not that. */
export function sharedLinkOf(value: unknown): LocalUiSharedLink {
  if (typeof value !== 'object' || value === null) return SHARED_LINK_OFF;
  const { on, programs } = value as { on?: unknown; programs?: unknown };
  if (on !== true) return SHARED_LINK_OFF;
  const n =
    typeof programs === 'number' &&
    Number.isSafeInteger(programs) &&
    programs >= 0 &&
    programs <= MAX_PROGRAMS
      ? programs
      : 0;
  return Object.freeze({ on: true, programs: n });
}

export const SHARED_LINK_OFF: LocalUiSharedLink = Object.freeze({ on: false, programs: 0 });

/**
 * D1: the origin host of a relay URL, `host` or `host:port` (port only when it is not 443), or null
 * for anything that is not a plain relay URL under the relay rule (04 §4), whatever its source.
 */
export function networkHost(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 300 || !isAllowedRelayUrl(url)) return null;
  const m = HOST_URL.exec(url);
  if (m === null) return null;
  const host = m[1] as string;
  if (host.length > NETWORK_MAX_HOST_LENGTH || !host.includes('.')) return null;
  if (!host.split('.').every((label) => LABEL.test(label))) return null;
  if (m[2] === undefined) return host;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port === 443 ? host : `${host}:${port}`;
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_COUNT
    ? value
    : 0;

const ms = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MS
    ? value
    : null;

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const time = (value: unknown, nowMs: number): number | null => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value > Math.floor(nowMs / 1000) + FUTURE_SLACK_SECONDS ? null : value;
};

function stateOf(probe: unknown): LocalUiNetworkState {
  if (typeof probe !== 'object' || probe === null) return 'unknown';
  const { state, connectMs, reused } = probe as {
    state?: unknown;
    connectMs?: unknown;
    reused?: unknown;
  };
  switch (state) {
    case 'ready':
      return 'ready';
    case 'timeout':
      return ms(connectMs) === null && reused !== true ? 'unreachable' : 'slow';
    case 'unreachable':
      return 'unreachable';
    case 'blocked':
      return 'blocked';
    default:
      return 'unknown';
  }
}

function serverOf(raw: unknown, nowMs: number): LocalUiNetworkServer | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { relay, kind, probe, stats, contacts } = raw as Record<string, unknown>;
  if (kind !== 'own' && kind !== 'legacy') return undefined;
  const host = networkHost(relay);
  if (host === null) return undefined;
  const p = typeof probe === 'object' && probe !== null ? (probe as Record<string, unknown>) : {};
  const s = typeof stats === 'object' && stats !== null ? (stats as Record<string, unknown>) : {};
  const lastError =
    typeof s.lastError === 'string' && ERROR_CLASSES.has(s.lastError) ? s.lastError : null;
  return Object.freeze({
    host,
    roles: Object.freeze(kind === 'own' ? (['send', 'read'] as const) : (['read'] as const)),
    kind,
    state: stateOf(probe),
    connectMs: ms(p.connectMs),
    roundTripMs: ms(p.roundTripMs),
    signInRequired: flag(p.authRequired),
    paymentRequired: flag(p.paymentRequired),
    publishedOk: count(s.publishedOk),
    publishedFailed: count(s.publishedFailed),
    received: count(s.received),
    countsSince: time(s.since, nowMs),
    lastOkAt: time(s.lastOkAt, nowMs),
    lastError,
    contacts: count(contacts),
  });
}

function contactHostsOf(raw: unknown): LocalUiNetworkContactHosts | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { contactId, relays, shared } = raw as Record<string, unknown>;
  if (typeof contactId !== 'string' || !REF.test(contactId) || !Array.isArray(relays)) {
    return undefined;
  }
  const hosts: string[] = [];
  for (const relay of relays.slice(0, 64)) {
    if (hosts.length >= NETWORK_MAX_CONTACT_HOSTS) break;
    const host = networkHost(relay);
    if (host !== null && !hosts.includes(host)) hosts.push(host);
  }
  return Object.freeze({
    ref: contactId,
    servers: Math.min(count(relays.length), 64),
    shared: Math.min(count(shared), relays.length),
    hosts: Object.freeze(hosts),
  });
}

/** The answer for no agent (or none set up). */
export const NETWORK_NEEDS_SETUP: LocalUiNetworkBody = Object.freeze({
  agent: 'needs_setup',
  mode: null,
  checking: false,
  checkedAt: null,
  servers: Object.freeze([]),
  legacyReadUntil: null,
  contacts: Object.freeze({ total: 0, sharing: 0 }),
  updateWouldDrop: 0,
  mixIn: false,
  announceDefault: true,
  change: null,
  previousUntil: null,
  sharedLink: SHARED_LINK_OFF,
});

/** The answer when the agent's state could not be read. */
export const NETWORK_NOT_RUNNING: LocalUiNetworkBody = Object.freeze({
  ...NETWORK_NEEDS_SETUP,
  agent: 'not_running',
});

/** The allowlisted answer for one snapshot (see the header). */
export function networkBody(
  snapshot: LocalUiNetworkSnapshot,
  nowMs: number,
  contactHosts: boolean,
): LocalUiNetworkBody {
  if (typeof snapshot !== 'object' || snapshot === null) return NETWORK_NOT_RUNNING;
  const agent = snapshot.agent;
  if (agent !== 'running' && agent !== 'paused' && agent !== 'not_running') {
    return NETWORK_NOT_RUNNING;
  }
  const servers: LocalUiNetworkServer[] = [];
  const raw = Array.isArray(snapshot.servers) ? snapshot.servers : [];
  for (const entry of raw) {
    if (servers.length >= NETWORK_MAX_SERVERS) break;
    const server = serverOf(entry, nowMs);
    if (server !== undefined && !servers.some((s) => s.host === server.host)) servers.push(server);
  }
  const c = snapshot.contacts;
  const total = count(c?.total);
  const contacts = Object.freeze({ total, sharing: Math.min(count(c?.sharing), total) });
  const mode = snapshot.mode === 'automatic' || snapshot.mode === 'custom' ? snapshot.mode : null;
  const body: LocalUiNetworkBody = {
    agent,
    mode,
    checking: snapshot.checking === true && agent === 'running',
    checkedAt: time(snapshot.checkedAt, nowMs),
    servers: Object.freeze(servers),
    legacyReadUntil:
      typeof snapshot.legacyReadUntil === 'number' &&
      Number.isInteger(snapshot.legacyReadUntil) &&
      snapshot.legacyReadUntil > 0
        ? snapshot.legacyReadUntil
        : null,
    contacts,
    updateWouldDrop: Math.min(count(snapshot.updateDrops), 16),
    mixIn: snapshot.mixIn === true,
    announceDefault: snapshot.announceDefault !== false,
    // A paused agent always says so; a change still finishing only while running.
    change:
      agent === 'paused'
        ? 'paused'
        : snapshot.change === 'rotation_pending' || snapshot.change === 'paused'
          ? snapshot.change
          : null,
    previousUntil:
      typeof snapshot.previousUntil === 'number' &&
      Number.isInteger(snapshot.previousUntil) &&
      snapshot.previousUntil > 0
        ? snapshot.previousUntil
        : null,
    sharedLink: sharedLinkOf(snapshot.sharedLink),
  };
  if (!contactHosts) return Object.freeze(body);
  const rows: LocalUiNetworkContactHosts[] = [];
  for (const entry of Array.isArray(snapshot.contactLists) ? snapshot.contactLists : []) {
    if (rows.length >= NETWORK_MAX_CONTACTS) break;
    const row = contactHostsOf(entry);
    if (row !== undefined) rows.push(row);
  }
  return Object.freeze({ ...body, contactHosts: Object.freeze(rows) });
}

/** `contacts=hosts` exactly once, or nothing; anything else is undefined (400). */
function expandOf(query: URLSearchParams): boolean | undefined {
  const keys = [...query.keys()];
  if (keys.length === 0) return false;
  if (keys.length === 1 && keys[0] === 'contacts' && query.get('contacts') === 'hosts') return true;
  return undefined;
}

/** GET /api/ui/network. */
export async function networkStatus(
  context: LocalUiContext,
  request: LocalUiRequest,
): Promise<LocalUiResult> {
  const contactHosts = expandOf(request.query);
  if (contactHosts === undefined) return UI_INVALID_QUERY;
  if (context.network === undefined) return { status: 200, body: NETWORK_NEEDS_SETUP };
  try {
    return { status: 200, body: await context.network({ contactHosts }) };
  } catch {
    return UI_UNAVAILABLE; // fixed answer: the error (and its text) is never passed on
  }
}

const networkRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: NETWORK_PATH,
  presence: false,
  handler: (context: LocalUiContext, request: LocalUiRequest) => networkStatus(context, request),
});

export const networkRoutes: readonly LocalUiRoute[] = Object.freeze([networkRoute]);
