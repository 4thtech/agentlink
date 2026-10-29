// U3-i CONTRACT, server side: the REAL U3-f route handlers (as registered by createLocalUiRoutes)
// against the shared AI apps wire samples (@4thtech-io/types/ui-contract/apps). Each sample request
// goes in exactly as the page sends it (the query; the `{changeId}` input as the presence gate hands
// it over); the real answer must be the sample answer. The page side
// (apps/local-ui/src/pages/apps/contract.test.ts) asserts the client builds the same requests and
// reads the same answers, so the two cannot drift apart without one of them failing.
import type { PreparedOwnerAction } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import {
  APPS_APPLY_PATH,
  APPS_CHANGE,
  APPS_DISCONNECT_PATH,
  APPS_LIST,
  APPS_PATH,
  APPS_PREVIEW,
  APPS_PREVIEW_PATH,
  APPS_WORLD,
  type AppsUiAnswer,
} from '@4thtech-io/types/ui-contract/apps';
import { describe, expect, it } from 'vitest';
import type { OwnerReview, OwnerSignRequest } from '../owner-operation.js';
import type {
  LocalUiAiAppPlan,
  LocalUiAiApps,
  LocalUiAiAppWrite,
  LocalUiContext,
  LocalUiReadClient,
} from './context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiResult,
} from './route-types.js';
import { createLocalUiRoutes } from './routes.js';

const routes = createLocalUiRoutes().routes();
const route = (method: string, path: string) => {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found;
};

const entry = (folder: string): JsonObject => ({
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@4thtech-io/agentlink', 'mcp', '--agent', folder],
  env: {},
});

interface Fake {
  readonly app: string;
  readonly name: string;
  readonly path: string;
  readonly state: { kind: 'none' | 'foreign' | 'unreadable' } | { kind: 'agent'; agent: string };
  readonly quitFirst: boolean;
}
const FAKES: readonly Fake[] = [
  {
    app: 'claude-code',
    name: 'Claude Code',
    path: '~/.claude.json',
    state: { kind: 'agent', agent: 'personal' },
    quitFirst: false,
  },
  {
    app: 'codex',
    name: 'Codex',
    path: '~/.codex/config.toml',
    state: { kind: 'agent', agent: 'work' },
    quitFirst: false,
  },
  {
    app: 'cursor',
    name: 'Cursor',
    path: '~/.cursor/mcp.json',
    state: { kind: 'none' },
    quitFirst: false,
  },
  {
    app: 'claude-desktop',
    name: 'Claude Desktop',
    path: '~/Library/Application Support/Claude/claude_desktop_config.json',
    state: { kind: 'none' },
    quitFirst: true,
  },
  {
    app: 'windsurf',
    name: 'Windsurf',
    path: '~/.codeium/windsurf/mcp_config.json',
    state: { kind: 'foreign' },
    quitFirst: false,
  },
];

/** What the seam answers for each app in the world (the plan for the open agent). */
function planFor(app: string, agent: string, written: LocalUiAiAppWrite): LocalUiAiAppPlan {
  const fake = FAKES.find((f) => f.app === app) as Fake;
  const file = APPS_WORLD.files[app as keyof typeof APPS_WORLD.files];
  const base = { app, name: fake.name, path: fake.path, file, identity: '1:42' };
  const commit = () => Promise.resolve(written);
  if (fake.state.kind === 'agent' && fake.state.agent === agent) {
    return {
      ...base,
      status: 'change',
      kind: 'disconnect',
      oldEntry: entry(agent),
      newEntry: null,
      oldAgent: agent,
      newAgent: null,
      commit,
    };
  }
  if (fake.state.kind === 'agent') {
    return {
      ...base,
      status: 'change',
      kind: 'move',
      oldEntry: entry(fake.state.agent),
      newEntry: entry(agent),
      oldAgent: fake.state.agent,
      newAgent: agent,
      commit,
    };
  }
  if (fake.state.kind === 'none' && !fake.quitFirst) {
    return {
      ...base,
      status: 'change',
      kind: 'connect',
      oldEntry: null,
      newEntry: entry(agent),
      oldAgent: null,
      newAgent: agent,
      commit,
    };
  }
  return { status: fake.quitFirst ? 'quit_first' : 'conflict', app, name: fake.name };
}

function world(written: LocalUiAiAppWrite = 'written') {
  const reviews: OwnerReview[] = [];
  const desk: LocalUiAiApps = {
    list: () => Promise.resolve({ desktopRunning: true, apps: FAKES }),
    plan: (app, agent) => Promise.resolve(planFor(app, agent, written)),
    agentIdOf: () => Promise.resolve(APPS_WORLD.agentId),
  };
  const client = {
    agentId: APPS_WORLD.agentId,
    agent: { label: () => Promise.resolve({ status: 'verified', label: 'Personal' }) },
    apps: {
      prepare: (op: string, app: string, changeId: string) =>
        Promise.resolve({
          status: 'prepared',
          op,
          body: {
            v: 1,
            agent: APPS_WORLD.agentId,
            owner: 'dd'.repeat(32),
            op,
            params: { app, agent: APPS_WORLD.agentId, changeId },
            nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
            issuedAt: 1_760_000_000,
            expiresAt: 1_760_000_600,
          },
        } as unknown as PreparedOwnerAction),
    },
  } as unknown as LocalUiReadClient;
  const context = {
    client,
    aiApps: desk,
    agentsManage: { current: () => APPS_WORLD.openAgent },
    ownerContext: () => Promise.resolve({ agent: APPS_WORLD.agentId } as never),
    applyOwnerAction: (signed: { body: JsonObject }) =>
      Promise.resolve({ status: 'applied', op: signed.body['op'] }),
    now: () => 1_760_000_000_000,
  } as unknown as LocalUiContext;
  const operation: LocalUiOwnerOperation = {
    sign: (review, requests: readonly OwnerSignRequest[]) => {
      reviews.push(review);
      return Promise.resolve(
        requests.map((r) => ({
          kind: 'owner-action',
          signed: { body: (r as { action: JsonObject }).action, sig: 'ee'.repeat(64) },
        })) as never,
      );
    },
  };
  return { context, operation, reviews };
}

const plain = (result: LocalUiResult): AppsUiAnswer => ({
  status: result.status,
  body: JSON.parse(JSON.stringify(result.body)) as unknown,
});

describe('contract (server): the real U3-f handlers answer the AI apps samples', () => {
  it('GET /api/ui/apps answers the sample list', async () => {
    const { context } = world();
    const r = route('GET', APPS_PATH) as LocalUiReadRoute;
    expect(plain(await r.handler(context, { params: {}, query: new URLSearchParams() }))).toEqual(
      APPS_LIST.answer,
    );
  });

  it.each(['connect', 'move', 'disconnect', 'quitFirst', 'conflict'] as const)(
    'GET preview (%s): the query is {app, agent} and the answer is the sample',
    async (kind) => {
      const { context } = world();
      const sample = APPS_PREVIEW[kind];
      const r = route('GET', APPS_PREVIEW_PATH) as LocalUiReadRoute;
      const query = new URLSearchParams(sample.query);
      expect(plain(await r.handler(context, { params: {}, query }))).toEqual(sample.answer);
    },
  );

  const apply = async (
    path: string,
    kind: keyof typeof APPS_PREVIEW,
    input: unknown,
    written?: LocalUiAiAppWrite,
  ) => {
    const w = world(written);
    const preview = route('GET', APPS_PREVIEW_PATH) as LocalUiReadRoute;
    await preview.handler(w.context, {
      params: {},
      query: new URLSearchParams(APPS_PREVIEW[kind].query),
    });
    const r = route('POST', path) as LocalUiOwnerRoute;
    const answer = plain(
      await r.handler(
        w.context,
        { params: {}, query: new URLSearchParams(), input: JSON.parse(JSON.stringify(input)) },
        w.operation,
      ),
    );
    return { answer, reviews: w.reviews };
  };

  it('apply takes exactly {changeId}, signs the sample statement and answers done', async () => {
    const { answer, reviews } = await apply(APPS_APPLY_PATH, 'connect', APPS_CHANGE.applyInput);
    expect(answer).toEqual(APPS_CHANGE.done.answer);
    expect(reviews[0]?.lines).toEqual([APPS_CHANGE.statements.connect]);
  });

  it('moving an app is the same apply route with the move statement', async () => {
    const input = { changeId: APPS_PREVIEW.move.answer.body.changeId };
    const { reviews } = await apply(APPS_APPLY_PATH, 'move', input);
    expect(reviews[0]?.lines).toEqual([APPS_CHANGE.statements.move]);
  });

  it('disconnect takes exactly {changeId} and signs the sample statement', async () => {
    const { answer, reviews } = await apply(
      APPS_DISCONNECT_PATH,
      'disconnect',
      APPS_CHANGE.disconnectInput,
    );
    expect(answer).toEqual({ status: 200, body: { status: 'done', app: 'claude-code' } });
    expect(reviews[0]?.lines).toEqual([APPS_CHANGE.statements.disconnect]);
  });

  it('a change that is not previewed, or a write that fails, arrives as the sample {error} words', async () => {
    const unknown = { changeId: 'a'.repeat(64) };
    const stale = await apply(APPS_APPLY_PATH, 'connect', unknown);
    expect(stale.answer).toEqual(APPS_CHANGE.refusals[0]?.answer);
    const quit = await apply(APPS_APPLY_PATH, 'connect', APPS_CHANGE.applyInput, 'quit_first');
    expect(quit.answer).toEqual(APPS_CHANGE.refusals[1]?.answer);
    const failed = await apply(APPS_APPLY_PATH, 'connect', APPS_CHANGE.applyInput, 'failed');
    expect(failed.answer).toEqual(APPS_CHANGE.refusals[4]?.answer);
    const mismatch = await apply(
      APPS_APPLY_PATH,
      'connect',
      APPS_CHANGE.applyInput,
      'agent_mismatch',
    );
    expect(mismatch.answer).toEqual(APPS_CHANGE.refusals[3]?.answer);
  });
});
