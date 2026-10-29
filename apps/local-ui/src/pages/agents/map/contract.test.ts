// @vitest-environment node
// U3-map CONTRACT, page side: the map's flow client against the shared wire samples
// (@4thtech-io/types/ui-contract/flow). The server side
// (packages/node/src/local-ui/ui-contract-flow.test.ts) runs the REAL flow route on the same samples
// and asserts it answers exactly them. Here the client must ask for exactly each sample request and
// read each sample answer as the outcome next to it. apps/local-ui never imports packages/node.
import {
  FLOW_BOB,
  FLOW_CAROL,
  FLOW_NOW,
  FLOW_PATH,
  FLOW_REQUESTS,
} from '@4thtech-io/types/ui-contract/flow';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../../api/client.js';
import { createFlowApi, firstSince } from './api.js';
import { flowPath } from './data.js';

interface Sent {
  readonly path: string;
  readonly search: string;
  readonly method: string;
}

function answering(answer: { readonly status: number; readonly body: unknown }) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    sent.push({ path: url.pathname, search: url.search, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { sent, api: createFlowApi(createApiClient({ fetch: fetchFn, token: 't' })) };
}

describe('contract (page): GET /api/ui/flow', () => {
  it('the path is the shared one', () => {
    expect(flowPath()).toBe(FLOW_PATH);
    expect(flowPath(FLOW_REQUESTS.later.since)).toBe(`${FLOW_PATH}${FLOW_REQUESTS.later.query}`);
  });

  it('the first read asks for the last 24 hours and reads the sample items', async () => {
    expect(firstSince(FLOW_NOW)).toBe(FLOW_REQUESTS.first.since);
    const t = answering(FLOW_REQUESTS.first.answer);
    const read = await t.api.read(FLOW_REQUESTS.first.since);
    expect(t.sent).toEqual([{ path: FLOW_PATH, search: FLOW_REQUESTS.first.query, method: 'GET' }]);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.flow.now).toBe(FLOW_NOW);
    expect(read.flow.cursor).toBe(FLOW_NOW - 60);
    expect(read.flow.items.map((i) => [i.contactId, i.direction, i.kind])).toEqual([
      [FLOW_BOB, 'in', 'message'],
      [FLOW_BOB, 'out', 'file'],
      [FLOW_CAROL, 'out', 'message'],
    ]);
  });

  it('a later read sends the cursor and reads the sample', async () => {
    const t = answering(FLOW_REQUESTS.later.answer);
    const read = await t.api.read(FLOW_REQUESTS.later.since);
    expect(t.sent[0]?.search).toBe(FLOW_REQUESTS.later.query);
    expect(read.kind === 'ok' && read.flow.items).toHaveLength(2);
  });

  it('the fixed 400 word is an error outcome, never a half answer', async () => {
    const t = answering(FLOW_REQUESTS.bad.answer);
    expect((await t.api.read(1)).kind).toBe('error');
  });

  it('an item that does not fit is left out, the rest is kept', async () => {
    const t = answering({
      status: 200,
      body: {
        now: FLOW_NOW,
        cursor: String(FLOW_NOW - 60),
        partial: false,
        items: [
          ...FLOW_REQUESTS.later.answer.body.items,
          { contactId: 'nope', direction: 'in', kind: 'message', state: 'received', at: 1 },
          { contactId: FLOW_BOB, direction: 'sideways', kind: 'message', state: 'sent', at: 1 },
        ],
      },
    });
    const read = await t.api.read(1);
    expect(read.kind === 'ok' && read.flow.items).toHaveLength(2);
  });
});
