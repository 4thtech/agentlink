// NET-OWNER-SET (S2; D-158; 08 §1 `POST /api/ui/network/servers`, `POST /api/ui/network/reset`,
// `GET /api/ui/network/progress`; 07 §4.3 "Use your own servers"; 04 §2.5, §2.6, §4; I-4, I-5, I-7):
// saving your own server list, and "Use AgentLink's automatic servers", in Advanced › Message
// network (Under the hood) only.
//
// - Both POSTs are owner routes (`presence: true`): behind the page session, the CSRF header, exact
//   Host, Origin and fetch metadata like every /api/ui/ write, then the presence gate, whose one-use
//   `changeServers` signs exactly one card at keyEpoch + 1 with exactly the reviewed list
//   (owner-relay-migration.ts signServerChange). The input travels in `X-AgentLink-Input`.
// - The review (`{…, review: true}`) is the route's precheck, before the presence gate: it signs and
//   writes nothing and needs no presence. The server tests every own server again (transport
//   precheckServers, never the page's results) and, with the mix-in, the default set; builds the
//   final list (core buildServerList: own in the owner's order, then up to 2 ready default servers,
//   within 8); the leaving servers with their ends (M1-7j); the contact count and fixed warnings:
//   `{servers: [{host, role, outcome}], leaving: [{host, until}], contacts, warnings}`.
// - The confirm (no `review`) runs the same checks and tests again in its precheck, before the
//   presence gate, and must match the review of the same input (`changed` otherwise, or when none
//   was made in the last 10 minutes). After the gesture the handler re-checks the agent's state and
//   hands the gate exactly that plan: `{status: 'done', contacts, leavingUntil}`.
// - Refusals, before anything is signed: 400 `invalid_list` (shape, count, duplicate, URL rule);
//   409 `not_ready`, `mix_in_on`, `same_list`, `too_many_previous` with `fitsFrom` (unix seconds),
//   `rotation_pending`, `agent_paused`, `changed`, `not_applied`; 429 `busy` while a test runs.
// - Reset: input `{}` (or `{review: true}`), the same path to the default set with the announce
//   choice on; `same_list` when already automatic with the choice on.
// - `GET /api/ui/network/progress` (read): the card-update outbox of the current key,
//   `{changedAt, contacts: {total, sent, waiting}, items: [{ref, name, state}], leavingUntil}` or
//   `{changedAt: null}`. Names under the name rule, plain text (I-5). Never a list, host or key.
//
// No MCP tool, tool argument, description or `nextStep` reaches these (I-4). Nothing is logged; no
// answer carries a server's own text, an error's text or a key (I-7).
import {
  AUTOMATIC_SERVERS,
  automaticServerPlan,
  buildServerList,
  isAutomaticList,
  parseOwnServers,
  planLeaving,
  type ServerListPlan,
  type TestedServer,
} from '@4thtech-io/core';
import { canonicalize, type JsonObject, type JsonValue } from '@4thtech-io/crypto';
import { precheckServers, relayOrigin, type PrecheckResult } from '@4thtech-io/transport-nostr';
import type { LocalUiContext, LocalUiServerListState } from '../context.js';
import {
  NOT_AVAILABLE,
  UI_INVALID_QUERY,
  UI_NOT_SET_UP,
  UI_UNAVAILABLE,
  type LocalUiOwnerOperation,
  type LocalUiOwnerRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';
import { nodeHostResolver, nodeNip11Fetcher, nodeRelayConnector } from '../../relay-io.js';
import type { NetworkTestIo } from './network-test.js';

export const NETWORK_SERVERS_PATH = '/api/ui/network/servers';
export const NETWORK_RESET_PATH = '/api/ui/network/reset';
export const NETWORK_PROGRESS_PATH = '/api/ui/network/progress';

/** A review stays usable for a confirm this long. */
export const REVIEW_TTL_MS = 10 * 60_000;
/** A confirm's tested plan waits for the presence gate this long. */
const CONFIRM_TTL_MS = 2 * 60_000;
/** Remembered reviews and confirms at most (one page session needs one). */
const MAX_REMEMBERED = 8;
/** The longest address accepted (the relay URL rule's own cap, 04 §4). */
const MAX_URL_CHARS = 256;
/** The longest contact name answered (the page shows plain text). */
const MAX_NAME_CHARS = 80;

const fixed = (status: number, error: string, extra: JsonObject = {}): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error, ...extra }) });
const INVALID_LIST = fixed(400, 'invalid_list');
const INVALID = fixed(400, 'invalid');
const BUSY = fixed(429, 'busy');
const refusal = (code: string): LocalUiResult => fixed(409, code);

/** One parsed request: the servers route or the reset, a review or a confirm. */
interface Ask {
  readonly kind: 'servers' | 'reset';
  readonly review: boolean;
  readonly own: readonly string[];
  readonly automatic: boolean;
  readonly announce: boolean;
}

const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{servers, automatic, announce[, review: true]}` exactly, else undefined. */
function serversAsk(input: JsonValue | undefined): Ask | LocalUiResult {
  if (!isObject(input)) return INVALID_LIST;
  const { servers, automatic, announce, review, ...rest } = input;
  if (Object.keys(rest).length > 0) return INVALID_LIST;
  if (typeof automatic !== 'boolean' || typeof announce !== 'boolean') return INVALID_LIST;
  if (review !== undefined && review !== true) return INVALID_LIST;
  if (!Array.isArray(servers) || servers.length > 8) return INVALID_LIST;
  if (servers.some((s) => typeof s !== 'string' || s.length > MAX_URL_CHARS)) return INVALID_LIST;
  const own = parseOwnServers(servers, automatic);
  if (own === undefined) return INVALID_LIST;
  return Object.freeze({ kind: 'servers', review: review === true, own, automatic, announce });
}

/** `{}` or `{review: true}` exactly. */
function resetAsk(input: JsonValue | undefined): Ask | LocalUiResult {
  if (input !== undefined && !isObject(input)) return INVALID;
  const { review, ...rest } = input ?? {};
  if (Object.keys(rest).length > 0 || (review !== undefined && review !== true)) return INVALID;
  return Object.freeze({
    kind: 'reset',
    review: review === true,
    own: AUTOMATIC_SERVERS,
    automatic: true,
    announce: true,
  });
}

const keyOf = (ask: Ask): string =>
  canonicalize({
    kind: ask.kind,
    servers: [...ask.own],
    automatic: ask.automatic,
    announce: ask.announce,
  });

const hostOf = (url: string): string => relayOrigin(url).slice('wss://'.length);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The agent's state refusals (before and after presence), else undefined. */
function stateRefusal(state: LocalUiServerListState): LocalUiResult | undefined {
  if (state.paused) return refusal('agent_paused');
  if (state.sendState === 'rotation_pending' || state.sendState === 'key_epoch_mismatch') {
    return refusal('rotation_pending');
  }
  if (state.sendState !== 'ready') return refusal('not_applied');
  return undefined;
}

const outcomeOf = (r: PrecheckResult | undefined): TestedServer['outcome'] =>
  r === undefined ? 'refused' : r.outcome;

/** A tested plan and what the review answers for it. */
interface Planned {
  readonly plan: ServerListPlan;
  readonly body: JsonObject;
}

const productionIo = (): NetworkTestIo => ({
  resolver: nodeHostResolver(),
  connector: nodeRelayConnector(),
  nip11: nodeNip11Fetcher(),
});

/** A small bounded memory of plans by request key. */
class Remembered {
  readonly #items = new Map<string, { readonly plan: ServerListPlan; readonly at: number }>();
  readonly #ttl: number;

  constructor(ttl: number) {
    this.#ttl = ttl;
  }

  set(key: string, plan: ServerListPlan, at: number): void {
    this.#items.delete(key);
    this.#items.set(key, { plan, at });
    while (this.#items.size > MAX_REMEMBERED) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }
  }

  get(key: string, now: number): ServerListPlan | undefined {
    const got = this.#items.get(key);
    if (got === undefined || now - got.at > this.#ttl || got.at > now) return undefined;
    return got.plan;
  }

  take(key: string, now: number): ServerListPlan | undefined {
    const plan = this.get(key, now);
    this.#items.delete(key);
    return plan;
  }
}

const samePlan = (a: ServerListPlan, b: ServerListPlan): boolean =>
  sameList(a.relays, b.relays) &&
  a.announceDefault === b.announceDefault &&
  a.servers.every((s, i) => s.role === b.servers[i]?.role);

/**
 * The server-list routes over `io` (tests: a stub resolver and in-memory relays). The app registers
 * one set (`networkServersRoutes`), so the memory of reviews and the one-test-at-a-time guard are
 * per process.
 */
export function createNetworkServersRoutes(
  io: () => NetworkTestIo = productionIo,
): readonly LocalUiRoute[] {
  const reviewed = new Remembered(REVIEW_TTL_MS);
  const confirmed = new Remembered(CONFIRM_TTL_MS);
  let testing = false;

  /** Tests the own servers again (and the default set for the mix-in), then builds the plan. */
  async function tested(ask: Ask): Promise<ServerListPlan | LocalUiResult> {
    if (ask.kind === 'reset') return automaticServerPlan();
    if (ask.automatic && !ask.announce) return refusal('mix_in_on');
    if (testing) return BUSY;
    testing = true;
    let own: readonly PrecheckResult[];
    let defaults: readonly PrecheckResult[] = [];
    try {
      const { resolver, connector, nip11 } = io();
      const options = { resolver, connector, ...(nip11 === undefined ? {} : { nip11 }) };
      [own, defaults] = await Promise.all([
        precheckServers(ask.own, options),
        ask.automatic ? precheckServers(AUTOMATIC_SERVERS, options) : Promise.resolve([]),
      ]);
    } finally {
      testing = false;
    }
    const built = buildServerList({
      own: ask.own.map((url, i) => ({
        url,
        outcome: outcomeOf(own[i]),
        paid: own[i]?.paymentRequired === true,
      })),
      automatic: ask.automatic,
      announce: ask.announce,
      defaults: AUTOMATIC_SERVERS.map((url, i) => ({
        url,
        outcome: outcomeOf(defaults[i]),
        paid: defaults[i]?.paymentRequired === true,
      })),
    });
    if (built.status === 'refused') return refusal(built.reason);
    return built.plan;
  }

  /** Every check before the gesture, then the tested plan with its review answer. */
  async function planned(context: LocalUiContext, ask: Ask): Promise<Planned | LocalUiResult> {
    const port = context.serverList;
    if (port === undefined || context.client === undefined) return UI_NOT_SET_UP;
    const state = await port.state();
    const refused = stateRefusal(state);
    if (refused !== undefined) return refused;
    if (ask.kind === 'reset' && isAutomaticList(state.relays) && state.announceDefault) {
      return refusal('same_list');
    }
    if (ask.kind === 'servers' && !ask.automatic && sameList(ask.own, state.relays)) {
      return refusal('same_list');
    }
    const plan = await tested(ask);
    if (!('relays' in plan)) return plan;
    if (sameList(plan.relays, state.relays)) return refusal('same_list');
    const now = Math.floor(context.now() / 1000);
    const leaving = planLeaving(state.leaving, state.relays, plan.relays, now);
    if (leaving.status === 'refused') {
      return leaving.fitsAt === undefined
        ? refusal('too_many_previous')
        : fixed(409, 'too_many_previous', { fitsFrom: leaving.fitsAt });
    }
    const contacts = await port.contacts();
    return Object.freeze({
      plan,
      body: {
        servers: plan.servers.map((s) => ({
          host: hostOf(s.url),
          role: s.role,
          outcome: s.outcome,
        })),
        leaving: leaving.leaving.map((e) => ({ host: hostOf(e.url), until: e.until })),
        contacts,
        warnings: [...plan.warnings],
      },
    });
  }

  /** The precheck: the review's answer, or a confirm's refusal (undefined lets it on to presence). */
  async function precheck(
    context: LocalUiContext,
    request: LocalUiRequest,
    parse: (input: JsonValue | undefined) => Ask | LocalUiResult,
  ): Promise<LocalUiResult | undefined> {
    const ask = parse(request.input);
    if (!('kind' in ask)) return ask;
    try {
      const got = await planned(context, ask);
      if (!('plan' in got)) return got;
      const key = keyOf(ask);
      const at = context.now();
      if (ask.review) {
        reviewed.set(key, got.plan, at);
        return { status: 200, body: got.body };
      }
      const seen = reviewed.get(key, at);
      if (seen === undefined || !samePlan(seen, got.plan)) return refusal('changed');
      confirmed.set(key, got.plan, at);
      return undefined;
    } catch {
      // Never the error's text: it could name a host or an address (I-7).
      return UI_UNAVAILABLE;
    }
  }

  /** The handler, after the presence gate: exactly the plan the precheck tested. */
  async function confirm(
    context: LocalUiContext,
    request: LocalUiRequest,
    owner: LocalUiOwnerOperation,
    parse: (input: JsonValue | undefined) => Ask | LocalUiResult,
  ): Promise<LocalUiResult> {
    const ask = parse(request.input);
    if (!('kind' in ask)) return ask;
    if (ask.review) return INVALID;
    const port = context.serverList;
    if (port === undefined) return UI_NOT_SET_UP;
    const plan = confirmed.take(keyOf(ask), context.now());
    if (plan === undefined) return refusal('changed');
    const state = await port.state();
    const refused = stateRefusal(state);
    if (refused !== undefined) return refused;
    if (sameList(plan.relays, state.relays)) return refusal('same_list');
    if (owner.changeServers === undefined) return NOT_AVAILABLE;
    const outcome = await owner.changeServers({
      relays: plan.relays,
      announceDefault: plan.announceDefault,
    });
    if (outcome.status === 'refused') {
      return outcome.reason === 'too_many_previous' && outcome.fitsAt !== undefined
        ? fixed(409, 'too_many_previous', { fitsFrom: outcome.fitsAt })
        : refusal(outcome.reason);
    }
    reviewed.take(keyOf(ask), context.now());
    return {
      status: 200,
      body: { status: 'done', contacts: outcome.contacts, leavingUntil: outcome.leavingUntil },
    };
  }

  const ownerRoute = (
    path: string,
    parse: (input: JsonValue | undefined) => Ask | LocalUiResult,
  ): LocalUiOwnerRoute =>
    Object.freeze<LocalUiOwnerRoute>({
      method: 'POST',
      path,
      presence: true,
      precheck: (context, request) => precheck(context, request, parse),
      handler: (context, request, owner) => confirm(context, request, owner, parse),
    });

  const progressRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
    method: 'GET',
    path: NETWORK_PROGRESS_PATH,
    presence: false,
    handler: async (context, request) => {
      if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
      const port = context.serverList;
      if (port === undefined) return UI_NOT_SET_UP;
      let progress;
      try {
        progress = await port.progress();
      } catch {
        return UI_UNAVAILABLE;
      }
      if (progress.changedAt === null) return { status: 200, body: { changedAt: null } };
      return {
        status: 200,
        body: {
          changedAt: progress.changedAt,
          contacts: { total: progress.total, sent: progress.sent, waiting: progress.waiting },
          items: progress.items.slice(0, 64).map((i) => ({
            ref: i.ref,
            // Plain text under the name rule (I-5): no control characters, bounded.
            name: [...i.name.replace(/\p{Cc}/gu, '')].slice(0, MAX_NAME_CHARS).join(''),
            state: i.state,
          })),
          leavingUntil: progress.leavingUntil,
        },
      };
    },
  });

  return Object.freeze([
    ownerRoute(NETWORK_SERVERS_PATH, serversAsk),
    ownerRoute(NETWORK_RESET_PATH, resetAsk),
    progressRoute,
  ]);
}

/** The routes the app registers (routes.ts): the Node relay I/O, one memory for the process. */
export const networkServersRoutes: readonly LocalUiRoute[] = createNetworkServersRoutes();
