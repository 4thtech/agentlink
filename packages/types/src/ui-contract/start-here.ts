// The local app's Start here wire contract (U3-j; B-11 §27.1, 08 §1): the reads Start here v2 makes
// (GET /api/ui/agents, GET /api/ui/apps, GET /api/ui/messages), as typed samples. It is shared test
// data, not runtime logic. Both sides test against it, so neither can drift alone:
//
// - packages/node (src/local-ui/ui-contract-start-here.test.ts) runs the REAL route handlers on each
//   `world` and asserts the real answer is the sample answer;
// - apps/local-ui (src/pages/home/start-here-api.contract.test.ts) asserts the page reads each
//   sample answer as the signal next to it.
//
// apps/local-ui may not import packages/node (package layering, tools/deps-check); both may import
// this subpath of @4thtech-io/types. Names and IDs here are filler.

/** A status and a JSON body, as the server answers. */
export interface UiAnswer<B = unknown> {
  readonly status: number;
  readonly body: B;
}

/** One agent row of `GET /api/ui/agents` (U3-c). */
export interface AgentsListRow {
  readonly name: string;
  readonly label: string;
  /** A verified `agent.label` exists (U3-d); false for an agent shown under its folder name. */
  readonly labelled: boolean;
  readonly current: boolean;
  readonly available: boolean;
  readonly removing: boolean;
  readonly contacts: number | null;
  readonly running: boolean;
  readonly apps: readonly string[];
}

export const START_HERE_AGENTS_PATH = '/api/ui/agents';
export const START_HERE_APPS_PATH = '/api/ui/apps';
export const START_HERE_MESSAGES_PATH = '/api/ui/messages';

/** What Start here shows for the open agent (apps/local-ui start-here.ts `AgentSignal`). */
export interface StartHereSignal {
  readonly named: boolean;
  readonly connected: boolean;
  readonly appName: string | null;
  readonly running: boolean;
}

/** The agents desk the node handler reads: the list as the app host gives it. */
export interface StartHereDesk {
  readonly generation: number;
  readonly current: string | null;
  readonly label: string | null;
  readonly agents: readonly AgentsListRow[];
}

/** One entry of the AI apps list (U3-f, 08 §1); only `state`, `agent`, `name` and `app` are read. */
export interface AppsListEntry {
  readonly app: string;
  readonly name: string;
  readonly path: string;
  readonly state: string;
  readonly agent: string | null;
  readonly quitFirst: boolean;
}

const row = (over: Partial<AgentsListRow> & { name: string }): AgentsListRow => ({
  label: over.name,
  labelled: false,
  current: false,
  available: true,
  removing: false,
  contacts: 0,
  running: false,
  apps: [],
  ...over,
});

const desk = (agents: readonly AgentsListRow[]): StartHereDesk => {
  const open = agents.find((a) => a.current);
  return { generation: 3, current: open?.name ?? null, label: open?.label ?? null, agents };
};

const listAnswer = (d: StartHereDesk): UiAnswer<unknown> => ({
  status: 200,
  body: { switchable: true, ...d, agents: d.agents.map((a) => ({ ...a, apps: [...a.apps] })) },
});

/** GET /api/ui/apps today: the U3-c stub (U3-f replaces it). Start here reads it as no AI app. */
export const START_HERE_APPS_STUB = {
  status: 501,
  body: { error: 'not_available' },
} as const satisfies UiAnswer;

interface AgentCase {
  readonly title: string;
  /** The desk, or null outside the app host (no desk: `{switchable: false}`). */
  readonly desk: StartHereDesk | null;
  readonly agentsAnswer: UiAnswer<unknown>;
  readonly appsAnswer: UiAnswer<unknown>;
  /** The signal, or null for "no signal" (never "done"). */
  readonly signal: StartHereSignal | null;
  /** False when the real server cannot give this apps answer (a failure); node skips it. */
  readonly appsFromServer: boolean;
}

const agentCase = (
  title: string,
  agents: readonly AgentsListRow[],
  signal: StartHereSignal,
): AgentCase => {
  const d = desk(agents);
  return {
    title,
    desk: d,
    agentsAnswer: listAnswer(d),
    appsAnswer: START_HERE_APPS_STUB,
    signal,
    appsFromServer: true,
  };
};

/** The agent signal from the real agents read plus the apps stub. */
export const START_HERE_AGENT_CASES: readonly AgentCase[] = [
  agentCase(
    'a new agent with a label and no AI app: named, not connected',
    [row({ name: 'work', label: 'Work', labelled: true, current: true })],
    { named: true, connected: false, appName: null, running: false },
  ),
  agentCase(
    'an unlabeled leftover agent is not named',
    [row({ name: 'default', label: 'default', current: true })],
    { named: false, connected: false, appName: null, running: false },
  ),
  agentCase(
    'a verified label that equals the folder name still counts as named',
    [row({ name: 'work', label: 'work', labelled: true, current: true })],
    { named: true, connected: false, appName: null, running: false },
  ),
  agentCase(
    'a label text that differs from the folder name is not named without a verified label',
    [row({ name: 'work', label: 'Work', labelled: false, current: true })],
    { named: false, connected: false, appName: null, running: false },
  ),
  agentCase(
    'an AI app id and a running lease: connected with the fixed app name, running',
    [
      row({ name: 'work', label: 'Work', current: true, running: true, apps: ['claude-code'] }),
      row({ name: 'other', label: 'Other', apps: ['codex'] }),
    ],
    { named: true, connected: true, appName: 'Claude Code', running: true },
  ),
  agentCase(
    'follows the OPEN agent, not the first one in the list',
    [
      row({ name: 'a', label: 'A', apps: ['codex'] }),
      row({ name: 'b', label: 'B', current: true }),
    ],
    { named: true, connected: false, appName: null, running: false },
  ),
  {
    title: 'outside the app host the card still works: no one to name, connect from what is read',
    desk: null,
    agentsAnswer: { status: 200, body: { switchable: false, agents: [] } },
    appsAnswer: START_HERE_APPS_STUB,
    signal: { named: true, connected: false, appName: null, running: false },
    appsFromServer: true,
  },
  {
    title: 'a failed AI apps read is no signal (the step says it could not check), never "none"',
    desk: desk([row({ name: 'work', label: 'Work', labelled: true, current: true })]),
    agentsAnswer: listAnswer(desk([row({ name: 'work', label: 'Work', labelled: true, current: true })])),
    appsAnswer: { status: 503, body: { error: 'unavailable' } },
    signal: null,
    appsFromServer: false,
  },
];

/**
 * The AI apps list shape of U3-f (08 §1), documented until U3-f replaces the stub: an entry counts
 * only when `state === 'connected' && agent === <the open agent>`, shown by its `name`. U3-f's
 * builder adds the node side of these samples.
 */
export const START_HERE_APPS_LIST = {
  agents: {
    switchable: true,
    generation: 1,
    current: 'work',
    label: 'Work',
    agents: [row({ name: 'work', label: 'Work', labelled: true, current: true })],
  },
  connected: {
    apps: {
      desktopRunning: false,
      apps: [
        {
          app: 'cursor',
          name: 'Cursor',
          path: '~/.cursor/mcp.json',
          state: 'connected',
          agent: 'work',
          quitFirst: false,
        },
        {
          app: 'codex',
          name: 'Codex',
          path: '~/.codex/config.toml',
          state: 'connected',
          agent: 'other',
          quitFirst: false,
        },
      ] satisfies readonly AppsListEntry[],
    },
    appName: 'Cursor',
  },
  /** Answers that are "not done": no answer, the stub body, an empty list, junk. */
  notDone: [undefined, START_HERE_APPS_STUB.body, { apps: [] }, { apps: 'x' }, 7] as const,
} as const;

/** A conversation as the agent's store gives it to the messages handler. */
export interface StartHereConversation {
  readonly contactId: string;
  readonly display: { readonly name: string; readonly nameSource: string; readonly label: string };
  readonly lastAt: number | null;
  readonly lastInAt: number | null;
}

const BOB = `0x${'b0'.repeat(20)}`;
const conversation = (lastInAt: number | null): StartHereConversation => ({
  contactId: BOB,
  display: { name: 'Bob', nameSource: 'owner', label: 'self-declared' },
  lastAt: 1_800_000_100,
  lastInAt,
});
const messagesAnswer = (lastInAt: number | null): UiAnswer<unknown> => ({
  status: 200,
  body: { conversations: [{ contactId: BOB, name: 'Bob', lastAt: 1_800_000_100, lastInAt }] },
});

/** "Replied" from the real GET /api/ui/messages: true only for a stored inbound message. */
export const START_HERE_REPLY_CASES = [
  {
    title: 'a conversation with a stored inbound message',
    conversations: [conversation(1_800_000_050)],
    answer: messagesAnswer(1_800_000_050),
    replied: true,
  },
  {
    title: 'nothing inbound stored yet',
    conversations: [conversation(null)],
    answer: messagesAnswer(null),
    replied: false,
  },
  {
    title: 'no conversation',
    conversations: [],
    answer: { status: 200, body: { conversations: [] } },
    replied: false,
  },
] as const satisfies readonly {
  title: string;
  conversations: readonly StartHereConversation[];
  answer: UiAnswer<unknown>;
  replied: boolean;
}[];
