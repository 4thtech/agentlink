// NET-PRECHECK (08 §1 `POST /api/ui/network/test`; 04 §4; 07 §4.2, §4.3 "Use your own servers"; I-4,
// I-5, I-7): the server Test behind Advanced › Message network › Your servers (Under the hood).
//
// The net-test kind (route-types.ts): behind the page session, the CSRF header, exact Host, Origin
// and fetch metadata like every /api/ui/ write, with no owner presence, because it changes nothing:
// no store write, no policy, no card, and nothing is signed with an ID key (the transport's test
// event is signed by a throwaway key made and wiped inside @4thtech-io/crypto; no key is even read).
// Not an MCP tool; no tool or `nextStep` reaches it.
//
// Body: exactly `{servers: [string, ...]}`, 1 to 8 strings of at most 256 characters, as the owner
// typed them; anything else is 400 `invalid`, with nothing echoed. Answer 200:
//   { results: [ { host: string | null,   // origin host (':port' only when not 443), only when
//                                          // the address passed the URL rule
//                  outcome: 'ready' | 'slow' | 'sign_in' | 'refused',
//                  reason: null | 'not_accepted' | 'not_kept' | 'unreachable' | 'not_allowed' |
//                          'too_small' | 'invalid',
//                  roundTripMs: int | null,
//                  signInRequired, paymentRequired: boolean | null } ] }  // one per entry, in order
// Built field by field from the transport's fixed enums: never a server's text, an address, a key
// or an error's text. Limits: one test at a time and PRECHECK_RATE_LIMIT (10) tests a minute for
// this process (stricter than the spec's per page session); over either, 429 `{error: 'busy'}`.
// Each server's test ends by PRECHECK_SERVER_TIMEOUT_MS (10 s). Nothing is logged.
import type { JsonObject } from '@4thtech-io/crypto';
import {
  PRECHECK_MAX_SERVERS,
  PrecheckRateLimit,
  precheckServers,
  type HostResolver,
  type Nip11Fetcher,
  type PrecheckOptions,
  type PrecheckResult,
  type RelayConnector,
} from '@4thtech-io/transport-nostr';
import { nodeHostResolver, nodeNip11Fetcher } from '../../relay-io.js';
import {
  processCheckServed,
  processPoolConnector,
  processSharedLinkView,
  type SharedLinkView,
} from '../../shared-relay-process.js';
import { SHARED_LINK_OFF, sharedLinkOf } from './network.js';
import {
  NETWORK_TEST_MAX_BODY_BYTES,
  NETWORK_TEST_PATH,
  type LocalUiNetworkTestRoute,
  type LocalUiResult,
} from '../route-types.js';

export { NETWORK_TEST_MAX_BODY_BYTES, NETWORK_TEST_PATH };
/** At most this many addresses per test (07 §4.3: an own list is 2 to 8 servers). */
export const NETWORK_TEST_MAX_SERVERS = PRECHECK_MAX_SERVERS;
/** The longest address accepted: the relay URL rule's own cap (04 §4). */
const MAX_URL_CHARS = 256;

/** The relay I/O the test uses. Production: the Node connector, resolver and NIP-11 fetcher. */
export interface NetworkTestIo {
  readonly resolver: HostResolver;
  readonly connector: RelayConnector & { close?(): void };
  readonly nip11?: Nip11Fetcher;
  /** RELAY-SHARED-CONN (D-159 (9)): the shared link's check lane, when it is on. */
  readonly checkServed?: PrecheckOptions['checkServed'];
  /** RELAY-SHARED-CONN (08 §1): the shared state answered beside the results. Absent: off. */
  readonly sharedLink?: () => Promise<SharedLinkView>;
}

const INVALID: LocalUiResult = Object.freeze({
  status: 400,
  body: Object.freeze({ error: 'invalid' }),
});
/** 08 §1: one test more than the limit, or one while another runs, is `429 busy`. */
const BUSY: LocalUiResult = Object.freeze({
  status: 429,
  body: Object.freeze({ error: 'busy' }),
});

/** The body's addresses, or undefined: exactly `{servers}`, 1 to 8 strings of at most 256 chars. */
function addressesOf(body: JsonObject): readonly string[] | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'servers') return undefined;
  const servers = body.servers;
  if (!Array.isArray(servers) || servers.length === 0) return undefined;
  if (servers.length > NETWORK_TEST_MAX_SERVERS) return undefined;
  const out: string[] = [];
  for (const entry of servers) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_URL_CHARS) {
      return undefined;
    }
    out.push(entry);
  }
  return out;
}

/** One result, copied field by field from the transport's fixed values. */
function resultOf(r: PrecheckResult): JsonObject {
  return {
    host: typeof r.host === 'string' ? r.host : null,
    outcome: r.outcome,
    reason: r.reason,
    roundTripMs:
      typeof r.roundTripMs === 'number' && Number.isSafeInteger(r.roundTripMs) && r.roundTripMs >= 0
        ? r.roundTripMs
        : null,
    signInRequired: typeof r.signInRequired === 'boolean' ? r.signInRequired : null,
    paymentRequired: typeof r.paymentRequired === 'boolean' ? r.paymentRequired : null,
  };
}

/**
 * RELAY-SHARED-CONN (D-159 (9)): with this process's shared link on, the test's write and reads go
 * over it (a connector of its own that never logs in) and its read by id through the check lane;
 * otherwise the Node connector, as before.
 */
const productionIo = (): NetworkTestIo => {
  const checkServed = processCheckServed();
  return {
    resolver: nodeHostResolver(),
    connector: processPoolConnector(() => false),
    nip11: nodeNip11Fetcher(),
    ...(checkServed === undefined ? {} : { checkServed }),
    sharedLink: processSharedLinkView,
  };
};

/** Runs the precheck over `io`, then closes the io's connector (its channel to the shared link). */
async function precheckWith(
  io: NetworkTestIo,
  servers: readonly string[],
): Promise<readonly PrecheckResult[]> {
  const { resolver, connector, nip11, checkServed } = io;
  try {
    return await precheckServers(servers, {
      resolver,
      connector,
      ...(nip11 === undefined ? {} : { nip11 }),
      ...(checkServed === undefined ? {} : { checkServed }),
    });
  } finally {
    try {
      connector.close?.();
    } catch {
      // a closed channel is closed already
    }
  }
}

/** The shared state for the answer: counts only, off when it cannot be read. */
async function sharedLinkFor(io: NetworkTestIo): Promise<JsonObject> {
  if (io.sharedLink === undefined) return SHARED_LINK_OFF;
  return sharedLinkOf(await io.sharedLink().catch(() => undefined));
}

/**
 * NET-OWNER-SET (IR L1): the one budget of server tests in this process: PRECHECK_RATE_LIMIT (10) a
 * minute and one at a time, shared by the Test, the server-list review and its confirm (each takes
 * one), so no route tests more than 04 §4 allows. Over either: 429 `busy`.
 */
export class PrecheckBudget {
  readonly #limit: PrecheckRateLimit;
  #running = false;

  constructor(now?: () => number) {
    this.#limit = new PrecheckRateLimit(now);
  }

  /** Runs `test` when one is allowed now, else answers 'busy' without running it. */
  async run<T>(test: () => Promise<T>): Promise<T | 'busy'> {
    if (this.#running) return 'busy';
    if (this.#limit.take() > 0) return 'busy';
    this.#running = true;
    try {
      return await test();
    } finally {
      this.#running = false;
    }
  }
}

/** The budget the app's routes share (routes.ts registers one Test and one server-list set). */
export const processPrecheckBudget = new PrecheckBudget();

/**
 * The net-test route over `io` (tests: local stand-in relays and a stub resolver) and `budget`
 * (default: the process budget it shares with the server-list routes).
 */
export function createNetworkTestRoute(
  io: () => NetworkTestIo = productionIo,
  budget: PrecheckBudget = new PrecheckBudget(),
): LocalUiNetworkTestRoute {
  return Object.freeze<LocalUiNetworkTestRoute>({
    method: 'POST',
    path: NETWORK_TEST_PATH,
    presence: 'net-test',
    handler: async (_context, body): Promise<LocalUiResult> => {
      const servers = addressesOf(body);
      if (servers === undefined) return INVALID;
      try {
        let shared: NetworkTestIo | undefined;
        const results = await budget.run(() => {
          shared = io();
          return precheckWith(shared, servers);
        });
        if (results === 'busy' || shared === undefined) return BUSY;
        return {
          status: 200,
          body: { results: results.map(resultOf), sharedLink: await sharedLinkFor(shared) },
        };
      } catch {
        return { status: 503, body: { error: 'unavailable' } };
      }
    },
  });
}

/**
 * NET-CLI (06 §8 `agentlink owner servers test`; 04 §4): the same test at the owner's terminal,
 * with the Node relay I/O and this process's one budget (`busy` over it). Takes 1 to 8 addresses of
 * at most 256 characters (`invalid` otherwise, nothing tested) and answers one fixed result per
 * address, in order. Changes nothing, signs nothing with an ID or owner key, needs no presence.
 */
export async function testOwnServers(
  servers: readonly string[],
): Promise<readonly PrecheckResult[] | 'busy' | 'invalid'> {
  const addresses = addressesOf({ servers: [...servers] });
  if (addresses === undefined) return 'invalid';
  return processPrecheckBudget.run(() => precheckWith(productionIo(), addresses));
}

/** The route the app registers (routes.ts): the Node relay I/O, one limit for the process. */
export const networkTestRoute: LocalUiNetworkTestRoute = createNetworkTestRoute(
  productionIo,
  processPrecheckBudget,
);
