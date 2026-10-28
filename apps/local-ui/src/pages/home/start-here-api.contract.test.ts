// @vitest-environment node
// U3-j CONTRACT (S1): the Start here reads against the REAL handlers of packages/node (the Agents
// list, the AI apps list, the Messages list), not hand-written answer shapes. The page's client is
// pointed at a fetch that hands each request to the real route handler and returns exactly the
// status and JSON the server would send. The assertions are that the page parses what the real
// handlers answer, and that a stub (`not_available`) or an empty list is "not done", never "done".
import { beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api/client.js';
import { parseAgentSignal, readAgentSignal, readReplied } from './start-here-api.js';

// The node package is loaded by path at run time: apps/local-ui does not depend on it (package
// layering), and its sources lie outside this package's TypeScript root. Shapes below are the
// minimum this test builds; the handlers themselves are the real ones.
interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler?: (
    context: unknown,
    request: { params: Record<string, string>; query: URLSearchParams },
  ) => Promise<{ status: number; body: unknown }>;
}
const NODE = new URL('../../../../../packages/node/src/local-ui/api/', import.meta.url).href;
/* eslint-disable boundaries/no-bypass -- a contract test: it loads the real route handlers of packages/node by path (no public entry; the layering forbids a dependency) */
let routes: readonly Route[] = [];
beforeAll(async () => {
  const load = async (name: string, key: string): Promise<readonly Route[]> =>
    ((await import(/* @vite-ignore */ `${NODE}${name}.ts`)) as Record<string, readonly Route[]>)[
      key
    ] ?? [];
  routes = [
    ...(await load('agents', 'agentsRoutes')),
    ...(await load('apps', 'appsRoutes')),
    ...(await load('messages', 'messagesRoutes')),
  ].filter((r) => r.method === 'GET' && r.handler !== undefined);
});

type Context = Record<string, unknown>;
interface AgentRow {
  name: string;
  label: string;
  current: boolean;
  available: boolean;
  removing: boolean;
  contacts: number | null;
  running: boolean;
  apps: readonly string[];
}
interface Conversation {
  contactId: string;
  display: { name: string; nameSource: string; label: string };
  lastAt: number | null;
  lastInAt: number | null;
}

const BOB = `0x${'b0'.repeat(20)}`;

function row(over: Partial<AgentRow> & { name: string }): AgentRow {
  return {
    label: over.name,
    current: false,
    available: true,
    removing: false,
    contacts: 0,
    running: false,
    apps: [],
    ...over,
  };
}

function context(rows: readonly AgentRow[], conversations: readonly Conversation[]): Context {
  const current = rows.find((r) => r.current);
  const desk = {
    list: () =>
      Promise.resolve({
        generation: 3,
        current: current?.name ?? null,
        label: current?.label ?? null,
        agents: rows,
      }),
  };
  const client = {
    agentId: 'a',
    getProof: () => Promise.reject(new Error('unused')),
    messages: {
      conversations: () => Promise.resolve(conversations),
      list: () => Promise.reject(new Error('unused')),
    },
  };
  return {
    agents: desk,
    client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => 0,
  };
}

/** A fetch that gives each GET to the real handler and answers as the server would. */
function realFetch(ctx: Context): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://127.0.0.1');
    const found = routes.find((r) => r.path === url.pathname);
    if (found === undefined) return new Response('{}', { status: 404 });
    const result = await found.handler?.(ctx, { params: {}, query: url.searchParams });
    if (result === undefined) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const client = (ctx: Context) => createApiClient({ fetch: realFetch(ctx), token: 't' });

describe('contract: the agent signal from the real GET /api/ui/agents and /api/ui/apps', () => {
  it('a new agent with a label and no AI app: named, not connected (apps stub is not_available)', async () => {
    const ctx = context([row({ name: 'work', label: 'Work', current: true })], []);
    expect(await readAgentSignal(client(ctx))).toEqual({
      named: true,
      connected: false,
      appName: null,
      running: false,
    });
  });

  it('an unlabeled leftover agent is not named', async () => {
    const ctx = context([row({ name: 'default', label: 'default', current: true })], []);
    const signal = await readAgentSignal(client(ctx));
    expect(signal?.named).toBe(false);
  });

  it('an agent with an AI app entry and a running lease: connected with the app name, Running', async () => {
    const ctx = context(
      [
        row({
          name: 'work',
          label: 'Work',
          current: true,
          running: true,
          apps: ['claude-code'],
        }),
        row({ name: 'other', label: 'Other', apps: ['codex'] }),
      ],
      [],
    );
    expect(await readAgentSignal(client(ctx))).toEqual({
      named: true,
      connected: true,
      appName: 'Claude Code',
      running: true,
    });
  });

  it('follows the OPEN agent, not the first one in the list', async () => {
    const ctx = context(
      [
        row({ name: 'a', label: 'A', apps: ['codex'] }),
        row({ name: 'b', label: 'B', current: true }),
      ],
      [],
    );
    expect((await readAgentSignal(client(ctx)))?.connected).toBe(false);
  });

  it('outside the app host (switchable false) or with no answer there is no signal, never "done"', async () => {
    const ctx = { ...context([], []), agents: undefined };
    expect(await readAgentSignal(client(ctx))).toBeUndefined();
    const down = createApiClient({
      fetch: (() => Promise.reject(new Error('offline'))) as typeof fetch,
      token: 't',
    });
    expect(await readAgentSignal(down)).toBeUndefined();
  });
});

describe('the apps list shape of GET /api/ui/apps (U3-f, 08 §1) enriches the agent signal', () => {
  const agents = {
    switchable: true,
    generation: 1,
    current: 'work',
    label: 'Work',
    agents: [{ name: 'work', label: 'Work', current: true, running: false, apps: [] }],
  };

  it('an entry that runs this agent counts, with its fixed name', () => {
    const apps = {
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
      ],
    };
    expect(parseAgentSignal(agents, apps)).toMatchObject({ connected: true, appName: 'Cursor' });
  });

  it('not_available, an empty list, or junk is not done', () => {
    for (const apps of [undefined, { error: 'not_available' }, { apps: [] }, { apps: 'x' }, 7]) {
      expect(parseAgentSignal(agents, apps)).toMatchObject({ connected: false, appName: null });
    }
  });

  it('an app name or id from anywhere else is plain text, shortened, never markup', () => {
    const odd = { ...agents, agents: [{ ...agents.agents[0], apps: ['<b>x</b>'.repeat(30)] }] };
    const signal = parseAgentSignal(odd, undefined);
    expect(signal?.connected).toBe(true);
    expect((signal?.appName ?? '').length).toBeLessThanOrEqual(40);
  });
});

describe('contract: the reply from the real GET /api/ui/messages', () => {
  const conv = (lastInAt: number | null): Conversation => ({
    contactId: BOB,
    display: { name: 'Bob', nameSource: 'owner', label: 'self-declared' },
    lastAt: 1_800_000_100,
    lastInAt,
  });

  it('true when a conversation has a stored inbound message', async () => {
    expect(await readReplied(client(context([], [conv(1_800_000_050)])))).toBe(true);
  });

  it('false when nothing inbound is stored yet', async () => {
    expect(await readReplied(client(context([], [conv(null)])))).toBe(false);
    expect(await readReplied(client(context([], [])))).toBe(false);
  });

  it('no answer when the read fails', async () => {
    const down = createApiClient({
      fetch: (() => Promise.resolve(new Response('{}', { status: 503 }))) as typeof fetch,
      token: 't',
    });
    expect(await readReplied(down)).toBeUndefined();
  });
});
