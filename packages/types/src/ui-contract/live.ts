// The local app's live AI app status wire contract (W4-LIVE-STATUS; D-143; 08 §1 `GET /api/ui/events`
// and "Live AI-app status"): the stream's events and the allowlisted agent record that both the
// stream and `GET /api/ui/agents` carry, as types and typed samples. It is shared test data, not
// runtime logic:
//
// - packages/node (src/local-ui/ui-contract-live.test.ts) asserts the real hub and allowlist produce
//   exactly these field lists and that the sample stream text parses to the sample events;
// - apps/local-ui (U1-b, `api/live.ts`) reads the stream with `fetch` (never `EventSource`, which
//   cannot send the CSRF header), parses it as below, and updates the agents data its views already
//   use (the `agentlink:agents-changed` event).
//
// apps/local-ui may not import packages/node (package layering, tools/deps-check); both may import
// this subpath of @4thtech-io/types. Names here are filler.

/** `GET /api/ui/events`: send the page's CSRF header and `Accept: text/event-stream`; no query. */
export const EVENTS_PATH = '/api/ui/events';
export const EVENTS_ACCEPT = 'text/event-stream';

/** Per AI app (08 §1). */
export type LiveAppState = 'not_set_up' | 'not_running' | 'working' | 'ready' | 'idle';
/** Per agent (08 §1); `paused` comes with W4-PAUSE. */
export type LiveAgentState = 'paused' | 'working' | 'ready' | 'idle' | 'offline';

/** One AI app of an agent. `app` is an id of the 06 §7 table, or `other` ("Another AI app"). */
export interface LiveAppRecord {
  readonly app: string;
  readonly state: LiveAppState;
  /** Unix seconds: when the current state began; absent when unknown. */
  readonly since?: number;
  /** Unix seconds: when a session of this app last ran the agent; only while not live. */
  readonly lastSeenAt?: number;
}

/** One agent as the stream carries it (the allowlist; `GET /api/ui/agents` adds its own counts). */
export interface LiveAgentRecord {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly removing: boolean;
  readonly state: LiveAgentState;
  /** Unix seconds: the newest last seen of its apps, while offline (or paused). */
  readonly lastSeenAt?: number;
  readonly apps: readonly LiveAppRecord[];
}

/** 08 §1 "Allowlist": the only fields an agent and an app may carry. */
export const LIVE_AGENT_FIELDS = [
  'name',
  'label',
  'current',
  'removing',
  'state',
  'lastSeenAt',
  'apps',
] as const;
export const LIVE_APP_FIELDS = ['app', 'state', 'since', 'lastSeenAt'] as const;

/** `event: snapshot`: the whole state; the first event unless Last-Event-ID was resumable. */
export interface LiveSnapshotEvent {
  readonly generation: number;
  readonly current: string | null;
  readonly agents: readonly LiveAgentRecord[];
  readonly at: number;
}
/** `event: agents`: only the agents whose fields changed (each whole), and the names gone. */
export interface LiveAgentsEvent {
  readonly agents: readonly LiveAgentRecord[];
  readonly gone?: readonly string[];
  readonly at: number;
}
/** `event: generation`: after a switch. */
export interface LiveGenerationEvent {
  readonly generation: number;
  readonly current: string | null;
  readonly at: number;
}

/**
 * The stream's text format (08 §1): `retry: 2000` first, then blocks of `id: <boot>.<seq>`,
 * `event: <name>` and one `data: <JSON>` line, separated by a blank line; `: ping` comments every
 * 15 s. Send the last `id` seen as `Last-Event-ID` when reconnecting (backoff 1 s doubling to 30 s,
 * with jitter); an unknown one gets a `snapshot`. The page ignores event names it does not know. A
 * 5th stream of one page session, or a 9th in all, is refused with 429 `{error: "busy"}`; each stream
 * ends after 30 min. Fallback (08 §1): after three failures within a minute, or without a streamed
 * `fetch` body, poll `GET /api/ui/agents` every 5 s while the tab is visible.
 */
export const LIVE_SAMPLE = {
  text:
    'retry: 2000\n\n' +
    'id: AAAAAAAA.0\nevent: snapshot\ndata: {"generation":1,"current":"default","agents":[' +
    '{"name":"default","label":"Personal","current":true,"removing":false,"state":"offline",' +
    '"lastSeenAt":1800000000,"apps":[{"app":"claude-code","state":"not_running","since":1800000000,' +
    '"lastSeenAt":1800000000}]}],"at":1800000100}\n\n' +
    ': ping\n\n' +
    'id: AAAAAAAA.1\nevent: agents\ndata: {"agents":[{"name":"default","label":"Personal",' +
    '"current":true,"removing":false,"state":"ready","apps":[{"app":"claude-code","state":"ready",' +
    '"since":1800000120}]}],"at":1800000120}\n\n',
  events: [
    {
      id: 'AAAAAAAA.0',
      event: 'snapshot',
      data: {
        generation: 1,
        current: 'default',
        agents: [
          {
            name: 'default',
            label: 'Personal',
            current: true,
            removing: false,
            state: 'offline',
            lastSeenAt: 1_800_000_000,
            apps: [
              {
                app: 'claude-code',
                state: 'not_running',
                since: 1_800_000_000,
                lastSeenAt: 1_800_000_000,
              },
            ],
          },
        ],
        at: 1_800_000_100,
      } satisfies LiveSnapshotEvent,
    },
    {
      id: 'AAAAAAAA.1',
      event: 'agents',
      data: {
        agents: [
          {
            name: 'default',
            label: 'Personal',
            current: true,
            removing: false,
            state: 'ready',
            apps: [{ app: 'claude-code', state: 'ready', since: 1_800_000_120 }],
          },
        ],
        at: 1_800_000_120,
      } satisfies LiveAgentsEvent,
    },
  ],
} as const;
