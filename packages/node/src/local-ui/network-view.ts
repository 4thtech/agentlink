// NET-PROBE / NET-ROUTE (08 §1 Message network; 07 §4.2, §4.3; I-5, I-7): the local app's network
// view source, behind `GET /api/ui/network` (api/network.ts) and the live `network` event.
//
// - Lazy and bounded, like network-health.ts: a probe of the agent's own and legacy servers (core
//   `network.probe`, one fresh connection each, no login, 5 s bound) starts only when the view is
//   read (Advanced › Message network is open and visible), at most once per NETWORK_PROBE_MS, never
//   two at once. A read waits for a probe it started at most NETWORK_PROBE_WAIT_MS, then answers the
//   last result (or `checking`); the next read gets the new one. A paused agent is never probed.
// - The servers, counters (relay_stats, written by whichever process runs the passes) and contact
//   counts are read on every request; contacts' lists only for the expanded answer.
// - `mark()` is an opaque string for the event hub (numbers only): it changes when the counters
//   change or a probe finishes. It never names a server.
// - Never rejects; an error (and its text) is never kept or passed on.
import type { RelayStatsView } from '@4thtech-io/core';
import {
  NETWORK_NOT_RUNNING,
  networkBody,
  type LocalUiNetworkBody,
  type LocalUiNetworkProbe,
  type LocalUiNetworkSnapshot,
} from './api/network.js';

/** A probe starts at most this often while the view is read. */
export const NETWORK_PROBE_MS = 15_000;
/** How long one read waits for a probe it started before answering the last result. */
export const NETWORK_PROBE_WAIT_MS = 400;

/** The core calls the reader needs (`AgentLinkClient` fits). */
export interface NetworkViewClient {
  readonly network: {
    servers(): Promise<
      | {
          readonly paused: boolean;
          readonly mode: 'automatic' | 'custom';
          readonly own: readonly string[];
          readonly legacy: readonly string[];
          readonly legacyReadUntil: number;
        }
      | undefined
    >;
    probe(): Promise<
      readonly { readonly relay: string; readonly result: LocalUiNetworkProbe }[] | undefined
    >;
    stats(): Promise<readonly RelayStatsView[]>;
    contactReach(options: { readonly lists: boolean }): Promise<{
      readonly total: number;
      readonly sharing: number;
      readonly lists?: readonly {
        readonly contactId: string;
        readonly relays: readonly string[];
        readonly shared: number;
      }[];
    }>;
    statsMark(): Promise<string>;
  };
}

export interface NetworkViewOptions {
  /** The clock in milliseconds. */
  readonly now: () => number;
}

export interface NetworkViewReader {
  read(options: { readonly contactHosts: boolean }): Promise<LocalUiNetworkBody>;
  /** An opaque mark (numbers only), undefined when it cannot be read now. */
  mark(): Promise<string | undefined>;
}

/** `wss://host[:port]` of a URL (the stats key; core relayOrigin's rule, no URL parser). */
function originOf(url: string): string {
  const m = /^wss:\/\/([a-z0-9.-]+)(?::([0-9]+))?(?:\/.*)?$/.exec(url);
  if (m === null) return 'wss://invalid';
  return m[2] === undefined ? `wss://${m[1] as string}` : `wss://${m[1] as string}:${m[2]}`;
}

/** The reader for the open agent (LocalUiContext.network). */
export function createNetworkReader(
  client: NetworkViewClient,
  options: NetworkViewOptions,
): NetworkViewReader {
  let probes: Map<string, LocalUiNetworkProbe> | undefined;
  let checkedAt: number | undefined;
  let startedAt: number | undefined;
  let inFlight: Promise<void> | undefined;
  let generation = 0;

  const runProbe = (): Promise<void> => {
    startedAt = options.now();
    const run = (async () => {
      let answer: Awaited<ReturnType<NetworkViewClient['network']['probe']>>;
      try {
        answer = await client.network.probe();
      } catch {
        answer = undefined;
      }
      if (Array.isArray(answer)) {
        const next = new Map<string, LocalUiNetworkProbe>();
        for (const entry of answer.slice(0, 64)) {
          if (typeof entry?.relay === 'string' && typeof entry.result === 'object') {
            next.set(entry.relay, entry.result);
          }
        }
        probes = next;
        checkedAt = Math.floor(options.now() / 1000);
      }
      generation += 1;
    })().finally(() => {
      inFlight = undefined;
    });
    inFlight = run;
    return run;
  };

  const maybeProbe = async (): Promise<void> => {
    const now = options.now();
    const due = startedAt === undefined || now - startedAt >= NETWORK_PROBE_MS || now < startedAt;
    if (inFlight !== undefined || !due) return;
    const started = runProbe();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      started,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, NETWORK_PROBE_WAIT_MS);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  };

  const read = async (o: { readonly contactHosts: boolean }): Promise<LocalUiNetworkBody> => {
    try {
      const servers = await client.network.servers();
      if (servers === undefined) return NETWORK_NOT_RUNNING;
      if (!servers.paused) await maybeProbe();
      const [stats, reach] = await Promise.all([
        client.network.stats().catch(() => [] as readonly RelayStatsView[]),
        client.network
          .contactReach({ lists: o.contactHosts })
          .catch(() => ({ total: 0, sharing: 0 }) as const),
      ]);
      const byOrigin = new Map(stats.map((s) => [s.origin, s]));
      const list = [
        ...servers.own.map((relay) => ({ relay, kind: 'own' as const })),
        ...servers.legacy
          .filter((relay) => !servers.own.includes(relay))
          .map((relay) => ({ relay, kind: 'legacy' as const })),
      ];
      const snapshot: LocalUiNetworkSnapshot = {
        agent: servers.paused ? 'paused' : 'running',
        mode: servers.mode,
        checking: !servers.paused && inFlight !== undefined && probes === undefined,
        ...(checkedAt === undefined ? {} : { checkedAt }),
        servers: list.map(({ relay, kind }) => {
          const probe = servers.paused ? undefined : probes?.get(relay);
          const stat = byOrigin.get(originOf(relay));
          return {
            relay,
            kind,
            ...(probe === undefined ? {} : { probe }),
            ...(stat === undefined ? {} : { stats: stat }),
          };
        }),
        legacyReadUntil: servers.legacyReadUntil,
        contacts: { total: reach.total, sharing: reach.sharing },
        ...('lists' in reach && reach.lists !== undefined ? { contactLists: reach.lists } : {}),
      };
      return networkBody(snapshot, options.now(), o.contactHosts);
    } catch {
      return NETWORK_NOT_RUNNING; // fixed answer: the error (and its text) is never passed on
    }
  };

  const mark = async (): Promise<string | undefined> => {
    try {
      const stats = await client.network.statsMark();
      return typeof stats === 'string' ? `${generation}|${stats}` : undefined;
    } catch {
      return undefined;
    }
  };

  return { read, mark };
}
