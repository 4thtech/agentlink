// The local app's Agents wire contract (U3-h; 08 §1, b11 §29): the requests the page sends and the
// answers the server gives, as typed samples. It is shared test data, not runtime logic. Both sides
// test against it, so neither can drift alone:
//
// - packages/node (src/local-ui/ui-contract-agents.test.ts) drives the REAL app host and route
//   handlers with each `request` and asserts the real answer is the sample `answer`;
// - apps/local-ui (src/pages/agents/contract.test.ts) asserts its client builds exactly each
//   `request` and reads each `answer` as the outcome word next to it.
//
// apps/local-ui may not import packages/node (package layering, tools/deps-check); both may import
// this subpath of @4thtech-io/types. Names and labels here are filler, never a real agent.
import type { LiveAgentState, LiveAppRecord } from './live.js';

/** `POST /api/ui/agents/switch`: an octet-stream body of this JSON; the generation is a number. */
export interface AgentsSwitchBody {
  readonly name: string;
  readonly generation: number;
}
/** `POST /api/ui/agents` input (X-AgentLink-Input): exactly `{label}`. */
export interface AgentsAddInput {
  readonly label: string;
  /** W4-ONE-TOUCH (D-140): the AI app the same gesture connects (an id of 06 §7). */
  readonly app?: string;
}
/** W4-ONE-TOUCH (D-140): `POST /api/ui/agents` input: exactly `{nonce}` (the begin nonce). */
export interface AgentsAddFinishInput {
  readonly nonce: string;
}
/** `POST /api/ui/agents/label` input: exactly `{name, label}`. */
export interface AgentsRenameInput {
  readonly name: string;
  readonly label: string;
}
/** `POST /api/ui/agents/remove` input (U3-e): `{name, typedLabel}`, `anyway: true` only when set. */
export interface AgentsRemoveInput {
  readonly name: string;
  readonly typedLabel: string;
  readonly anyway?: true;
}

/** A presence or switch answer word (`{status}`), or a route refusal (`{error}`; U3-d, U3-e). */
export type UiWordBody =
  { readonly status: string; readonly [extra: string]: unknown } | { readonly error: string };

export interface UiAnswer<B = UiWordBody> {
  readonly status: number;
  readonly body: B;
}

/** One agent row of `GET /api/ui/agents` as the app host answers it. */
export interface AgentsListRow {
  readonly name: string;
  readonly label: string;
  /** A verified `agent.label` exists (U3-j). */
  readonly labelled: boolean;
  readonly current: boolean;
  readonly available: boolean;
  readonly removing: boolean;
  readonly contacts: number | null;
  /** W4-LIVE-STATUS (D-143): a live MCP session row of this agent (never the lease). */
  readonly running: boolean;
  /** W4-LIVE-STATUS: the live state, last seen and per AI app state (ui-contract/live.ts). */
  readonly state: LiveAgentState;
  readonly lastSeenAt?: number;
  readonly apps: readonly LiveAppRecord[];
}
export interface AgentsListBody {
  readonly switchable: true;
  readonly generation: number;
  readonly current: string | null;
  readonly label: string | null;
  readonly agents: readonly AgentsListRow[];
}

export const AGENTS_PATH = '/api/ui/agents';
export const AGENTS_SWITCH_PATH = '/api/ui/agents/switch';
export const AGENTS_LABEL_PATH = '/api/ui/agents/label';
export const AGENTS_LABEL_CHECK_PATH = '/api/ui/agents/label-check';
export const AGENTS_REMOVE_PATH = '/api/ui/agents/remove';
/** W4-RENAME-REACHES-CONTACTS (D-141): "Contacts still see {cardName}" (a read, no presence). */
export const AGENTS_CARD_NAME_PATH = '/api/ui/agents/card-name';
/** W4-PAUSE (D-143 (5); 08 §1): Pause (its own kind, no presence) and Resume (presence). */
export const AGENTS_PAUSE_PATH = '/api/ui/agents/pause';
export const AGENTS_RESUME_PATH = '/api/ui/agents/resume';
/** Every owner operation and the switch send this type (the presence body; the switch's JSON). */
export const OCTET_STREAM = 'application/octet-stream';

/**
 * The app-host world the samples assume: two agents, `default` (open) and `work`, contacts 1, not
 * running, no AI app, generation 1. The node test builds exactly this directory.
 */
export const AGENTS_WORLD = {
  generation: 1,
  agents: [
    { name: 'default', label: 'Personal' },
    { name: 'work', label: 'Work' },
  ],
} as const;

/** `GET /api/ui/agents` in AGENTS_WORLD (the open agent's verified label is the host's). */
export const AGENTS_LIST = {
  answer: {
    status: 200,
    body: {
      switchable: true,
      generation: 1,
      current: 'default',
      label: 'Personal',
      agents: [
        {
          name: 'default',
          label: 'Personal',
          labelled: true,
          current: true,
          available: true,
          removing: false,
          contacts: 1,
          running: false,
          state: 'offline',
          apps: [],
        },
        {
          name: 'work',
          label: 'Work',
          labelled: false,
          current: false,
          available: true,
          removing: false,
          contacts: 1,
          running: false,
          state: 'offline',
          apps: [],
        },
      ],
    },
  } satisfies UiAnswer<AgentsListBody>,
  names: ['default', 'work'],
} as const;

/** The switch in AGENTS_WORLD: accepted at the current generation, `agent_changed` at a stale one. */
export const AGENTS_SWITCH = {
  accepted: {
    body: { name: 'work', generation: 1 } satisfies AgentsSwitchBody,
    answer: {
      status: 200,
      body: { status: 'done', generation: 2, current: 'work' },
    } satisfies UiAnswer,
    outcome: 'done',
    written: ['work'],
  },
  stale: {
    body: { name: 'work', generation: 99 } satisfies AgentsSwitchBody,
    answer: { status: 409, body: { status: 'agent_changed' } } satisfies UiAnswer,
    outcome: 'agent_changed',
  },
} as const;

/** W4-PAUSE: `POST /api/ui/agents/pause`: an octet-stream body of exactly this JSON. */
export interface AgentsPauseBody {
  readonly generation: number;
}

/**
 * W4-PAUSE (D-143 (5); 08 §1 "Pause an agent"): Pause is one click with no Touch ID: an octet-stream
 * body `{generation}` (a number), no `X-AgentLink-Input`, no presence header. A second Pause answers
 * the same. The agents list and the events stream then carry `state: 'paused'` for the agent.
 */
export const AGENTS_PAUSE = {
  accepted: {
    body: { generation: 1 } satisfies AgentsPauseBody,
    answer: { status: 200, body: { status: 'paused' } } satisfies UiAnswer,
  },
  stale: {
    body: { generation: 99 } satisfies AgentsPauseBody,
    answer: { status: 409, body: { status: 'agent_changed' } } satisfies UiAnswer,
  },
  invalid: {
    answer: { status: 400, body: { status: 'invalid' } } satisfies UiAnswer,
  },
} as const;

/**
 * W4-PAUSE (04 §2.5.1 `agent.resume`; 08 §1): Resume with Touch ID is a presence route like Rename:
 * `X-AgentLink-Generation`, `X-AgentLink-Input` of `{}`, the presence proof as the body. It is
 * refused with `not_paused` before the gesture when the agent is not paused.
 */
export const AGENTS_RESUME = {
  input: {},
  resumed: { answer: { status: 200, body: { status: 'resumed' } } satisfies UiAnswer },
  notPaused: { answer: { status: 409, body: { error: 'not_paused' } } satisfies UiAnswer },
} as const;

/** `GET label-check?label=`: what core would sign, before Touch ID. */
export const AGENTS_LABEL_CHECK = {
  ok: {
    label: 'Home agent',
    answer: { status: 200, body: { status: 'ok' } } satisfies UiAnswer,
    outcome: 'ok',
  },
  refused: {
    label: 'Work  agent',
    answer: {
      status: 200,
      body: { status: 'refused', reason: 'label_invalid' },
    } satisfies UiAnswer,
    outcome: 'refused',
  },
} as const;

/**
 * The owner operations of U3-d, run as the presence gate hands them over (the input JSON). The world:
 * the open agent is `personal`, its verified label and its card's name are `Personal`, and it has 2
 * active contacts; Add creates `home`.
 *
 * W4-RENAME-REACHES-CONTACTS (D-141): a label that differs from the card's name renames for the
 * contacts too (one gesture rotates the card); the answer adds `contacts`, how many will be told
 * ("Renamed. Your contacts will see {label} next time they're online.", 11 §5.8). A label equal to
 * the card's name changes only the label (`renameLabelOnly`). Before the gesture: `rename_limited`
 * with `retryAt` (unix seconds; "You can rename {label} again at {time}.") and `rotation_pending`.
 */
export const AGENTS_OWNER = {
  openAgent: 'personal',
  createdAgent: 'home',
  cardName: 'Personal',
  contacts: 2,
  rename: {
    input: { name: 'personal', label: 'Home' } satisfies AgentsRenameInput,
    answer: {
      status: 200,
      body: { status: 'done', label: 'Home', contacts: 2 },
    } satisfies UiAnswer,
    outcome: 'done',
  },
  renameLabelOnly: {
    input: { name: 'personal', label: 'Personal' } satisfies AgentsRenameInput,
    answer: { status: 200, body: { status: 'done', label: 'Personal' } } satisfies UiAnswer,
    outcome: 'done',
  },
  renameRefusals: [
    {
      input: { name: 'personal', label: 'Home' } satisfies AgentsRenameInput,
      answer: {
        status: 409,
        body: { error: 'rename_limited', retryAt: 1_800_086_400 },
      } satisfies UiAnswer,
      outcome: 'rename_limited',
    },
    {
      input: { name: 'personal', label: 'Home' } satisfies AgentsRenameInput,
      answer: { status: 409, body: { error: 'rotation_pending' } } satisfies UiAnswer,
      outcome: 'rotation_pending',
    },
  ],
  /**
   * W4-ONE-TOUCH (D-140; 08 §1): two calls and one gesture. `begin` (`POST /api/ui/agents/begin`,
   * no presence) answers the statement, the nonce and the plan-bound challenge; `finish`
   * (`POST /api/ui/agents`) takes only the nonce and the proof. The values are shapes: the real
   * nonce, fingerprints and challenge are the server's.
   */
  add: {
    beginPath: '/api/ui/agents/begin',
    input: { label: 'Home', app: 'claude-code' } satisfies AgentsAddInput,
    begin: {
      status: 200,
      body: {
        status: 'ready',
        nonce: 'N'.repeat(43),
        statement: {
          label: 'Home',
          agentFingerprint: '1A2B·3C4D',
          ownerFingerprint: '7F3A·19C2',
          folder: 'home',
          app: {
            app: 'claude-code',
            name: 'Claude Code',
            kind: 'connect',
            path: '~/.claude.json',
            oldEntry: null,
            newEntry: {
              command: 'npx',
              args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', 'home'],
            },
            oldAgent: null,
          },
        },
        expiresInMs: 120000,
        publicKey: {
          rpId: 'localhost',
          challenge: 'C'.repeat(43),
          allowCredentials: ['Q3JlZA'],
          userVerification: 'required',
          timeoutMs: 120000,
          prfSalt: 'U2FsdA',
        },
      },
    } satisfies UiAnswer,
    finishInput: { nonce: 'N'.repeat(43) } satisfies AgentsAddFinishInput,
    answer: {
      status: 200,
      body: { status: 'done', name: 'home', label: 'Home', app: 'claude-code' },
    } satisfies UiAnswer,
    outcome: 'done',
    notConnected: {
      status: 200,
      body: { status: 'created_not_connected', name: 'home', label: 'Home', app: 'claude-code' },
    } satisfies UiAnswer,
  },
  refusals: [
    {
      input: { name: 'personal', label: 'bad  label' } satisfies AgentsRenameInput,
      answer: { status: 400, body: { error: 'label_invalid' } } satisfies UiAnswer,
      outcome: 'label_invalid',
    },
    {
      input: { name: 'work', label: 'Home' } satisfies AgentsRenameInput,
      answer: { status: 409, body: { error: 'agent_changed' } } satisfies UiAnswer,
      outcome: 'agent_changed',
    },
  ],
} as const;

/**
 * W4-RENAME-REACHES-CONTACTS (D-141, Decision 46): `GET /api/ui/agents/card-name` for the open agent.
 * `differs`: its verified label is not the name in its card (renamed before D-141); the Agents row
 * shows once "Contacts still see {cardName}" with "Update contacts", which posts the rename route with
 * the current label (one gesture). `same`: nothing to update.
 */
export const AGENTS_CARD_NAME = {
  differs: {
    answer: { status: 200, body: { status: 'differs', cardName: 'My agent' } } satisfies UiAnswer,
    outcome: 'differs',
  },
  same: {
    answer: { status: 200, body: { status: 'same' } } satisfies UiAnswer,
    outcome: 'same',
  },
} as const;

/**
 * Remove (U3-e). The real route answers `{status}` with these codes (the server's remove gate;
 * `REMOVE_STATUS` in the node package). `stub` is the 501 `not_available` answer of a host without
 * the removal seam: the page still maps it.
 */
export const AGENTS_REMOVE = {
  input: { name: 'work', typedLabel: 'Work' } satisfies AgentsRemoveInput,
  stub: { status: 501, outcome: 'not_available' },
  documented: [
    { answer: { status: 200, body: { status: 'removed' } }, outcome: 'done' },
    { answer: { status: 409, body: { status: 'undeliverable' } }, outcome: 'contacts_unreachable' },
    { answer: { status: 409, body: { status: 'label_mismatch' } }, outcome: 'label_mismatch' },
    { answer: { status: 404, body: { status: 'unknown_agent' } }, outcome: 'unknown_agent' },
    { answer: { status: 400, body: { status: 'invalid' } }, outcome: 'invalid' },
    { answer: { status: 409, body: { status: 'in_use' } }, outcome: 'in_use' },
    { answer: { status: 409, body: { status: 'agent_changed' } }, outcome: 'agent_changed' },
    { answer: { status: 409, body: { status: 'busy' } }, outcome: 'busy' },
  ] satisfies readonly { answer: UiAnswer; outcome: string }[],
} as const;
