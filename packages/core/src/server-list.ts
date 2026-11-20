// NET-OWNER-SET (S2; D-158 (2), (3), (4), (5), (7); 07 §4.3 "Use your own servers"; 04 §4; I-4,
// I-7): the core list builder of a server-list change. Pure functions: nothing here tests, signs,
// stores or logs. The owner flow (node owner-relay-migration.ts signServerChange) signs exactly the
// list built here, after the app process tested every server again (transport precheckServers).
//
// - The owner's own servers: 1 to 6 with the mix-in ("Also use AgentLink's automatic servers"),
//   2 to 8 without; each passes the relay URL rule (public `wss://` DNS names only, 04 §4) and is
//   unique by origin.
// - The test outcomes (07 §4.3): `ready`; `slow` counts as ready (a warning); `sign_in` is allowed
//   only when at least 2 other servers of the list are ready (a warning); `refused` refuses the list.
//   At least 2 of the owner's own must be ready: the mixed-in servers never make up for them.
// - The mix-in adds up to 2 of the release's default servers that tested ready and are not already
//   listed, after the own ones; they count toward the 8.
// - The announce opt-out (`announce: false`) only with the mix-in off (D-158 (7)).
// - Leaving servers (M1-7j): every server that leaves stays readable for 30 days; at most 16, a
//   change that needs more is refused with the time from which it fits.
import { DEFAULT_RELAYS, relayOrigin } from '@4thtech-io/transport-nostr';
import { isAllowedRelayUrl } from '@4thtech-io/types';
import { TooManyPreviousError, nextLeaving, type LeavingServer } from './leaving-servers.js';

/** A list holds at most this many servers, the mixed-in ones included (D-158 (2)). */
export const SERVER_LIST_MAX = 8;
/** ...and at least this many; also the own servers that must be ready. */
export const SERVER_LIST_MIN = 2;
/** The default servers the mix-in adds. */
export const MIX_IN_SERVERS = 2;
/** The own servers allowed with the mix-in on (8 - 2). */
export const OWN_WITH_MIX_IN_MAX = SERVER_LIST_MAX - MIX_IN_SERVERS;

/** "Use AgentLink's automatic servers": the release's default set (07 §4.3 "Reset"). */
export const AUTOMATIC_SERVERS: readonly string[] = DEFAULT_RELAYS;

/** One server's test outcome (transport precheckServers; fixed values only). */
export type ServerTestOutcome = 'ready' | 'slow' | 'sign_in' | 'refused';

export interface TestedServer {
  readonly url: string;
  readonly outcome: ServerTestOutcome;
  /** NIP-11 `payment_required` (a warning only). */
  readonly paid?: boolean;
}

export interface PlannedServer extends TestedServer {
  readonly role: 'own' | 'automatic';
}

/** Fixed warning codes the review shows (11 §5.14 words them). */
export type ServerListWarning =
  'slow' | 'sign_in' | 'paid' | 'mix_in_off' | 'mix_in_short' | 'announce_off';

export interface ServerListPlan {
  readonly servers: readonly PlannedServer[];
  /** The card's list, in order: exactly what the owner signs. */
  readonly relays: readonly string[];
  readonly announceDefault: boolean;
  readonly warnings: readonly ServerListWarning[];
}

export type ServerListBuild =
  | { readonly status: 'ok'; readonly plan: ServerListPlan }
  | { readonly status: 'refused'; readonly reason: 'not_ready' | 'mix_in_on' };

const isReady = (o: ServerTestOutcome): boolean => o === 'ready' || o === 'slow';

/**
 * The owner's own servers as typed, or undefined when the list is not 1 to 6 (mix-in on) or 2 to 8
 * (off) strings that each pass the relay URL rule and are unique by origin.
 */
export function parseOwnServers(raw: unknown, automatic: boolean): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const min = automatic ? 1 : SERVER_LIST_MIN;
  const max = automatic ? OWN_WITH_MIX_IN_MAX : SERVER_LIST_MAX;
  if (raw.length < min || raw.length > max) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isAllowedRelayUrl(entry)) return undefined;
    const origin = relayOrigin(entry);
    if (origin === 'wss://invalid' || seen.has(origin)) return undefined;
    seen.add(origin);
    out.push(entry);
  }
  return Object.freeze(out);
}

/**
 * The final list from the servers tested again: the own ones in the owner's order, then (mix-in on)
 * up to 2 ready default servers not already listed. Refused when an own server is refused, fewer
 * than 2 own are ready, a `sign_in` server lacks 2 other ready ones, or the opt-out comes with the
 * mix-in on.
 */
export function buildServerList(input: {
  readonly own: readonly TestedServer[];
  readonly automatic: boolean;
  readonly announce: boolean;
  readonly defaults: readonly TestedServer[];
}): ServerListBuild {
  if (input.automatic && !input.announce) {
    return Object.freeze({ status: 'refused', reason: 'mix_in_on' });
  }
  const notReady = Object.freeze({ status: 'refused', reason: 'not_ready' } as const);
  if (input.own.some((s) => s.outcome === 'refused')) return notReady;
  if (input.own.filter((s) => isReady(s.outcome)).length < SERVER_LIST_MIN) return notReady;
  const servers: PlannedServer[] = input.own.map((s) => Object.freeze({ ...s, role: 'own' }));
  const warnings = new Set<ServerListWarning>();
  if (input.automatic) {
    const listed = new Set(servers.map((s) => relayOrigin(s.url)));
    const mixed = input.defaults
      .filter((s) => isReady(s.outcome) && !listed.has(relayOrigin(s.url)))
      .slice(0, MIX_IN_SERVERS);
    if (mixed.length < MIX_IN_SERVERS) warnings.add('mix_in_short');
    for (const s of mixed) servers.push(Object.freeze({ ...s, role: 'automatic' }));
  } else {
    warnings.add('mix_in_off');
  }
  if (servers.length > SERVER_LIST_MAX) return notReady;
  const ready = servers.filter((s) => isReady(s.outcome)).length;
  for (const s of servers) {
    if (s.outcome === 'sign_in') {
      // `ready` counts every ready server of the list; this one is not among them.
      if (ready < SERVER_LIST_MIN) return notReady;
      warnings.add('sign_in');
    }
    if (s.outcome === 'slow') warnings.add('slow');
    if (s.paid === true) warnings.add('paid');
  }
  if (!input.announce) warnings.add('announce_off');
  return Object.freeze({
    status: 'ok',
    plan: Object.freeze({
      servers: Object.freeze(servers),
      relays: Object.freeze(servers.map((s) => s.url)),
      announceDefault: input.announce,
      warnings: Object.freeze([...warnings]),
    }),
  });
}

/** The automatic list as a plan (a reset): the default set, the announce choice on. */
export function automaticServerPlan(): ServerListPlan {
  return Object.freeze({
    servers: Object.freeze(
      AUTOMATIC_SERVERS.map((url) =>
        Object.freeze({ url, outcome: 'ready' as const, role: 'automatic' as const }),
      ),
    ),
    relays: AUTOMATIC_SERVERS,
    announceDefault: true,
    warnings: Object.freeze([]),
  });
}

/** Whether a list holds only default servers (`mode: automatic`, 07 §4.3). */
export function isAutomaticList(relays: readonly string[]): boolean {
  return relays.every((r) => DEFAULT_RELAYS.includes(r));
}

export type LeavingPlan =
  | { readonly status: 'ok'; readonly leaving: readonly LeavingServer[] }
  | {
      readonly status: 'refused';
      readonly reason: 'too_many_previous';
      /** Unix seconds from which the same change fits; absent when no time would. */
      readonly fitsAt?: number;
    };

/**
 * The leaving servers after a change from `oldList` to `newList` at `now` (M1-7j nextLeaving), or
 * the `too_many_previous` refusal with the time it fits from.
 */
export function planLeaving(
  prev: readonly LeavingServer[],
  oldList: readonly string[],
  newList: readonly string[],
  now: number,
): LeavingPlan {
  try {
    return Object.freeze({ status: 'ok', leaving: nextLeaving(prev, oldList, newList, now) });
  } catch (error) {
    if (!(error instanceof TooManyPreviousError)) throw error;
    return Object.freeze({
      status: 'refused',
      reason: 'too_many_previous',
      ...(error.fitsAt === undefined ? {} : { fitsAt: error.fitsAt }),
    });
  }
}
