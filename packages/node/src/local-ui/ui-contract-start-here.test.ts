// U3-j CONTRACT, server side: the REAL route handlers of the Start here reads (GET /api/ui/agents,
// /api/ui/apps, /api/ui/messages) against the shared samples (@4thtech-io/types/ui-contract/
// start-here). Each sample world goes in; the real answer must be the sample answer. The page side
// (apps/local-ui/src/pages/home/start-here-api.contract.test.ts) asserts the page reads the same
// answers as the signal next to them, so neither side can drift alone.
import {
  START_HERE_AGENTS_PATH,
  START_HERE_AGENT_CASES,
  START_HERE_APPS_PATH,
  START_HERE_APPS_STUB,
  START_HERE_MESSAGES_PATH,
  START_HERE_REPLY_CASES,
  type StartHereConversation,
  type StartHereDesk,
  type UiAnswer,
} from '@4thtech-io/types/ui-contract/start-here';
import { describe, expect, it } from 'vitest';
import type { LocalUiContext } from './context.js';
import type { LocalUiReadRoute } from './route-types.js';
import { createLocalUiRoutes } from './routes.js';

const routes = createLocalUiRoutes().routes();
const read = (path: string): LocalUiReadRoute => {
  const found = routes.find((r) => r.method === 'GET' && r.path === path);
  if (found === undefined) throw new Error(`no route GET ${path}`);
  return found as LocalUiReadRoute;
};

/** The agent's state the handlers read: the agents desk (null: outside the app host), messages. */
function context(
  desk: StartHereDesk | null,
  conversations: readonly StartHereConversation[] = [],
): LocalUiContext {
  return {
    agents: desk === null ? undefined : { list: () => Promise.resolve(desk) },
    client: {
      agentId: 'a',
      getProof: () => Promise.reject(new Error('unused')),
      messages: {
        conversations: () => Promise.resolve(conversations),
        list: () => Promise.reject(new Error('unused')),
      },
    },
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => 0,
  } as unknown as LocalUiContext;
}

async function answer(path: string, ctx: LocalUiContext): Promise<UiAnswer> {
  const result = await read(path).handler(ctx, { params: {}, query: new URLSearchParams() });
  return { status: result.status, body: JSON.parse(JSON.stringify(result.body)) as unknown };
}

describe('contract (server): the real agents and apps reads answer the Start here samples', () => {
  for (const sample of START_HERE_AGENT_CASES) {
    it(sample.title, async () => {
      const ctx = context(sample.desk);
      expect(await answer(START_HERE_AGENTS_PATH, ctx)).toEqual(sample.agentsAnswer);
      expect(await answer(START_HERE_APPS_PATH, ctx)).toEqual(sample.appsAnswer);
    });
  }

  it('GET /api/ui/apps is still the U3-c stub (U3-f fills it)', async () => {
    expect(await answer(START_HERE_APPS_PATH, context(null))).toEqual(START_HERE_APPS_STUB);
  });
});

describe('contract (server): the real messages read answers the reply samples', () => {
  for (const sample of START_HERE_REPLY_CASES) {
    it(sample.title, async () => {
      const ctx = context(null, sample.conversations);
      expect(await answer(START_HERE_MESSAGES_PATH, ctx)).toEqual(sample.answer);
    });
  }
});
