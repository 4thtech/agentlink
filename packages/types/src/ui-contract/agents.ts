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

/** `POST /api/ui/agents/switch`: an octet-stream body of this JSON; the generation is a number. */
export interface AgentsSwitchBody {
  readonly name: string;
  readonly generation: number;
}
/** `POST /api/ui/agents` input (X-AgentLink-Input): exactly `{label}`. */
export interface AgentsAddInput {
  readonly label: string;
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
  readonly current: boolean;
  readonly available: boolean;
  readonly removing: boolean;
  readonly contacts: number | null;
  readonly running: boolean;
  readonly apps: readonly string[];
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
          current: true,
          available: true,
          removing: false,
          contacts: 1,
          running: false,
          apps: [],
        },
        {
          name: 'work',
          label: 'Work',
          current: false,
          available: true,
          removing: false,
          contacts: 1,
          running: false,
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
 * the open agent is `personal`; Add creates `home`.
 */
export const AGENTS_OWNER = {
  openAgent: 'personal',
  createdAgent: 'home',
  rename: {
    input: { name: 'personal', label: 'Home' } satisfies AgentsRenameInput,
    answer: { status: 200, body: { status: 'done', label: 'Home' } } satisfies UiAnswer,
    outcome: 'done',
  },
  add: {
    input: { label: 'Home' } satisfies AgentsAddInput,
    answer: {
      status: 200,
      body: { status: 'done', name: 'home', label: 'Home' },
    } satisfies UiAnswer,
    outcome: 'done',
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
 * Remove (U3-e). The route is registered and answers 501 `not_available` until U3-e lands; the
 * documented answers are what the page maps (U3-e fills the node side of these when it replaces the
 * stub).
 */
export const AGENTS_REMOVE = {
  input: { name: 'work', typedLabel: 'Work' } satisfies AgentsRemoveInput,
  stub: { status: 501, outcome: 'not_available' },
  documented: [
    { answer: { status: 200, body: { status: 'removed' } }, outcome: 'done' },
    { answer: { status: 409, body: { status: 'undeliverable' } }, outcome: 'contacts_unreachable' },
    { answer: { status: 409, body: { status: 'label_mismatch' } }, outcome: 'label_mismatch' },
    { answer: { status: 409, body: { status: 'agent_removing' } }, outcome: 'agent_removing' },
    { answer: { status: 409, body: { status: 'in_use' } }, outcome: 'in_use' },
    { answer: { status: 404, body: { status: 'unknown_agent' } }, outcome: 'unknown_agent' },
  ] satisfies readonly { answer: UiAnswer; outcome: string }[],
} as const;
