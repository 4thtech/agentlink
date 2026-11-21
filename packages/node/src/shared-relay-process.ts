// RELAY-SHARED-CONN L4 (D-159 (1), (8), (9), (11); 07 §4.2 "One relay link per computer"; 08 §1
// "who hosts it"; 11 §5.15): one shared relay link per process.
//
// - A long-running program (the MCP process, the desktop host) starts it once, before it opens any
//   agent (`startProcessRelayLink`); one-shot commands never do, so they keep their own direct
//   connections and never take part in the election.
// - Each agent's RelayPool gets `processPoolConnector(mayAuthenticate)`: a client connector of its own
//   on the link (its own login policy, its own check batches) with the direct fallback, or the
//   direct connector when sharing is off or was never started.
// - `takeOver` (the desktop host): when another program holds the link, ask it to hand over (after
//   the token proof) and bind without the random delay (the APP-CONTINUITY pattern).
// - `closeProcessRelayLink` on process exit: the endpoint is unbound, every channel closed; the
//   others re-race.
// - Status for the network view and `doctor`: a boolean and a count only (I-7), never a path, a
//   program's name or an ID. Nothing here turns sharing on or off: AGENTLINK_SHARED_RELAYS does
//   (no route, page or MCP tool, I-4).
import type { AddressCheck, RelayConnector, SharedCheckOutcome } from '@4thtech-io/transport-nostr';
import { nodeHostResolver, nodeRelayConnector } from './relay-io.js';
import { ensureLinkToken, type EndpointPlatform } from './shared-relay-endpoint.js';
import {
  SharedRelayLink,
  createRelayConnectorWith,
  sharedRelaysEnabled,
  type CreateRelayConnectorOptions,
  type RelayConnectorChoice,
} from './shared-relay-link.js';

export interface ProcessRelayLinkOptions extends CreateRelayConnectorOptions, EndpointPlatform {
  /** The desktop host: ask a program that holds the link to hand it over, then bind. */
  readonly takeOver?: boolean;
  /** Test seams: the direct connector and the address check (default: the Node ones). */
  readonly direct?: RelayConnector;
  readonly addressCheck?: AddressCheck;
}

/** What the network view and the server test show (08 §1 `sharedLink`). */
export interface SharedLinkView {
  readonly on: boolean;
  readonly programs: number;
}

let started: Promise<RelayConnectorChoice> | undefined;
let current: RelayConnectorChoice | undefined;

/**
 * Starts this process's shared relay link once (later calls answer the same one). Never rejects: a
 * link that cannot start leaves the process on its own connections.
 */
export function startProcessRelayLink(
  options: ProcessRelayLinkOptions,
): Promise<RelayConnectorChoice> {
  started ??= (async () => {
    const direct = options.direct ?? nodeRelayConnector();
    let choice: RelayConnectorChoice;
    try {
      choice = await createRelayConnectorWith({
        ...options,
        direct,
        addressCheck: options.addressCheck ?? { resolver: nodeHostResolver() },
      });
    } catch {
      choice = { connector: direct, link: undefined, shared: undefined, forPool: () => direct };
    }
    const link = choice.link;
    if (options.takeOver === true && link !== undefined) {
      try {
        if ((await link.start()) === 'client' && (await link.requestYield())) await link.start();
      } catch {
        // the hand-over is a preference: the link works either way
      }
    }
    current = choice;
    return choice;
  })();
  return started;
}

/**
 * The connector for one more RelayPool in this process (one per agent). Close it (`close()`, when it
 * has one) when that pool closes, so its channel to the link ends too.
 */
export function processPoolConnector(
  mayAuthenticate: (relayUrl: string) => boolean,
): RelayConnector {
  return current?.forPool(mayAuthenticate) ?? nodeRelayConnector();
}

/**
 * The check lane of this process's link for the server test (a channel of its own per check, never
 * logged in, closed after), or undefined when sharing is off or not started.
 */
export function processCheckServed():
  ((relay: string, eventId: string) => Promise<SharedCheckOutcome>) | undefined {
  const link = current?.link;
  if (link === undefined) return undefined;
  return async (relay, eventId) => {
    const lane = link.newConnector(() => false);
    try {
      return await lane.checkServed(relay, eventId);
    } finally {
      lane.close();
    }
  };
}

/** The shared state for the network view and the server test: counts only. */
export async function processSharedLinkView(): Promise<SharedLinkView> {
  const link = current?.link;
  if (link === undefined || link.role === 'closed') return { on: false, programs: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounded: a slow answer never holds up the network view (the count is then 0).
    const status = await Promise.race([
      link.status(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), VIEW_WAIT_MS);
      }),
    ]);
    return { on: true, programs: status?.programs ?? 0 };
  } catch {
    return { on: true, programs: 0 };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** How long the network view waits for the link's count. */
const VIEW_WAIT_MS = 1_000;

/** Ends this process's link (process exit). Safe to call more than once, or without a start. */
export async function closeProcessRelayLink(): Promise<void> {
  const pending = started;
  started = undefined;
  current = undefined;
  const choice = await pending?.catch(() => undefined);
  await choice?.link?.close().catch(() => undefined);
}

/**
 * For `agentlink doctor`, which never joins the link: `{on: false}` when sharing is off; `{on: true,
 * programs}` when a program holds the link and proved the token (0 when none does); `{on: true}`
 * when the link could not be checked (doctor then says this program uses its own connections).
 */
export async function probeSharedRelayLink(
  options: Pick<CreateRelayConnectorOptions, 'home' | 'cliVersion' | 'env'> & EndpointPlatform,
): Promise<{ readonly on: boolean; readonly programs?: number }> {
  if (!sharedRelaysEnabled(options.env ?? process.env)) return { on: false };
  const token = await ensureLinkToken(options.home).catch(() => undefined);
  if (token === undefined) return { on: true };
  const link = new SharedRelayLink({
    ...options,
    token,
    direct: nodeRelayConnector(),
    addressCheck: { resolver: nodeHostResolver() },
  });
  try {
    const status = await link.probeStatus();
    if (status === 'none') return { on: true, programs: 0 };
    return status === undefined ? { on: true } : { on: true, programs: status };
  } catch {
    return { on: true };
  } finally {
    await link.close().catch(() => undefined);
  }
}
