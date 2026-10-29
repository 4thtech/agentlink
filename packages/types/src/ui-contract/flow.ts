// The local app's live connections read (U3-map; b11 §32; U3-flow): `GET /api/ui/flow`, as typed
// samples. Shared test data, not runtime logic. Both sides test against it:
//
// - packages/node (src/local-ui/ui-contract-flow.test.ts) runs the REAL flow route handler on
//   `FLOW_WORLD` and each request, and asserts the real answer is the sample answer;
// - apps/local-ui (src/pages/agents/map/contract.test.ts) asserts the page asks for exactly each
//   request and reads each answer as the sample outcome.
//
// apps/local-ui may not import packages/node (tools/deps-check); both may import this subpath.
// Contact IDs here are filler addresses, never a real agent. No content rides on a flow answer.

export const FLOW_PATH = '/api/ui/flow';

/** The server's clock in the sample world, in whole unix seconds. */
export const FLOW_NOW = 1_800_000_000;
export const FLOW_BOB = `0x${'b0'.repeat(20)}`;
export const FLOW_CAROL = `0x${'c0'.repeat(20)}`;

export interface FlowItemSample {
  readonly contactId: string;
  readonly direction: 'in' | 'out';
  readonly kind: 'message' | 'file';
  readonly state: 'received' | 'queued' | 'sent' | 'not_delivered';
  readonly at: number;
}
export interface FlowAnswerBody {
  readonly now: number;
  readonly cursor: string;
  readonly items: readonly FlowItemSample[];
  readonly partial: boolean;
}

/**
 * What the agent's store holds, as core's flow read hands it over. Carol's event carries a field the
 * answer must never show (the handler copies an allowlist).
 */
export const FLOW_WORLD = {
  events: [
    { contactId: FLOW_BOB, direction: 'in', kind: 'message', state: 'received', at: FLOW_NOW - 5 },
    { contactId: FLOW_BOB, direction: 'out', kind: 'file', state: 'queued', at: FLOW_NOW - 20 },
    {
      contactId: FLOW_CAROL,
      direction: 'out',
      kind: 'message',
      state: 'sent',
      at: FLOW_NOW - 3600,
      text: 'SAMPLE-HOSTILE-CONTENT',
    },
  ],
  capped: false,
} as const;

const ITEMS: readonly FlowItemSample[] = [
  { contactId: FLOW_BOB, direction: 'in', kind: 'message', state: 'received', at: FLOW_NOW - 5 },
  { contactId: FLOW_BOB, direction: 'out', kind: 'file', state: 'queued', at: FLOW_NOW - 20 },
  { contactId: FLOW_CAROL, direction: 'out', kind: 'message', state: 'sent', at: FLOW_NOW - 3600 },
];

/** The map's first read asks for the last 24 hours; later reads send the answer's cursor. */
export const FLOW_REQUESTS = {
  first: {
    since: FLOW_NOW - 86_400,
    query: `?since=${String(FLOW_NOW - 86_400)}`,
    answer: {
      status: 200,
      body: {
        now: FLOW_NOW,
        cursor: String(FLOW_NOW - 60),
        items: ITEMS,
        partial: false,
      } satisfies FlowAnswerBody,
    },
  },
  later: {
    since: FLOW_NOW - 60,
    query: `?since=${String(FLOW_NOW - 60)}`,
    answer: {
      status: 200,
      body: {
        now: FLOW_NOW,
        cursor: String(FLOW_NOW - 60),
        items: ITEMS.slice(0, 2),
        partial: false,
      } satisfies FlowAnswerBody,
    },
  },
  bad: {
    query: '?since=abc',
    answer: { status: 400, body: { error: 'bad_request' } },
  },
} as const;
