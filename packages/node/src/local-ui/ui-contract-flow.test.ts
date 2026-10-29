// U3-map CONTRACT, server side: the REAL flow route (as the default registry serves it) against the
// shared wire samples (@4thtech-io/types/ui-contract/flow). The world is core's flow read over a
// small fake store that honours `since`; each sample request goes in exactly as the map sends it and
// the real answer must equal the sample answer. The page side
// (apps/local-ui/src/pages/agents/map/contract.test.ts) reads the same samples, so neither side can
// drift alone. Nothing but the allowlisted metadata may leave: the world's hostile `text` field must
// not appear.
import {
  FLOW_NOW,
  FLOW_PATH,
  FLOW_REQUESTS,
  FLOW_WORLD,
} from '@4thtech-io/types/ui-contract/flow';
import { describe, expect, it, vi } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from './context.js';
import type { LocalUiReadRoute, LocalUiResult } from './route-types.js';
import { createLocalUiRoutes } from './routes.js';

function context(): LocalUiContext {
  const client = {
    agentId: 'a',
    getProof: vi.fn(),
    messages: {
      conversations: () => Promise.reject(new Error('not used')),
      list: () => Promise.reject(new Error('not used')),
      pulseTimes: () => Promise.reject(new Error('not used')),
      flowEvents: (since: number, until: number) =>
        Promise.resolve({
          events: FLOW_WORLD.events.filter((e) => e.at >= since && e.at <= until),
          capped: FLOW_WORLD.capped,
        }),
    },
  } as unknown as LocalUiReadClient;
  return {
    client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => FLOW_NOW * 1000,
  };
}

async function get(query: string): Promise<LocalUiResult> {
  const hit = createLocalUiRoutes().match('GET', FLOW_PATH);
  if (hit === undefined || hit === 'method') throw new Error('flow route is not registered');
  const route = hit.route as LocalUiReadRoute;
  return route.handler(context(), { params: {}, query: new URLSearchParams(query) });
}

describe('GET /api/ui/flow: the wire the Agents map sends and reads', () => {
  it('the first read (last 24 hours) answers the sample, items newest first', async () => {
    const res = await get(FLOW_REQUESTS.first.query);
    expect(res).toEqual(FLOW_REQUESTS.first.answer);
  });

  it('a later read (the cursor) answers the sample', async () => {
    const res = await get(FLOW_REQUESTS.later.query);
    expect(res).toEqual(FLOW_REQUESTS.later.answer);
  });

  it('a bad since is the fixed 400 word', async () => {
    const res = await get(FLOW_REQUESTS.bad.query);
    expect(res).toEqual(FLOW_REQUESTS.bad.answer);
  });

  it('never carries content: only the allowlisted keys, nothing of the hostile field', async () => {
    const res = await get(FLOW_REQUESTS.first.query);
    expect(JSON.stringify(res)).not.toContain('SAMPLE-HOSTILE-CONTENT');
    const body = res.body as { items: Record<string, unknown>[] };
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['at', 'contactId', 'direction', 'kind', 'state']);
    }
  });
});
