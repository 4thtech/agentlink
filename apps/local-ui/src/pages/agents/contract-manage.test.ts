/* eslint-disable boundaries/no-bypass -- a contract test: it runs the page against the real server code of packages/node, which has no public entry for it */
// @vitest-environment node
// U3-h CONTRACT: Add and Rename against the REAL handlers of api/agents-manage.ts (U3-d), run with
// what the presence gate hands them: the JSON of X-AgentLink-Input exactly as the page sent it. The
// context is a small fake of the agent's own state; the route registry, the handlers, their input
// check and their answer words are the real ones. (The switch is in contract.test.ts, against the real
// approval server and app host.) Remove is asserted against U3-e's documented codes in api.test.ts.
import { describe, expect, it } from 'vitest';
import type { LocalUiContext } from '../../../../../packages/node/src/local-ui/context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
} from '../../../../../packages/node/src/local-ui/route-types.js';
import { createLocalUiRoutes } from '../../../../../packages/node/src/local-ui/routes.js';
import { createAgentsApi } from './api.js';

const SELF = '0x71c4000000000000000000000000000000009a2e';
const routes = createLocalUiRoutes().routes();
const find = (method: string, path: string) => {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found;
};

function fromBase64url(text: string): string {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64').toString('utf8');
}

function world(): LocalUiContext {
  const prepared = (label: string) => {
    const body = {
      v: 1,
      agent: SELF,
      owner: 'dd'.repeat(32),
      op: 'agent.label',
      params: { agent: SELF, label },
      nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
      issuedAt: 1_760_000_000,
      expiresAt: 1_760_000_600,
    };
    return { status: 'prepared', op: 'agent.label', body, jcs: JSON.stringify(body) };
  };
  return {
    client: {
      agentId: SELF,
      agent: {
        label: () => Promise.resolve({ status: 'verified', label: 'Personal' }),
        prepareLabel: (label: string) => Promise.resolve(prepared(label)),
      },
    },
    agentsManage: {
      current: () => 'personal',
      create: () => Promise.resolve({ name: 'home' }),
      settle: () => Promise.resolve(),
      labelSaved: () => Promise.resolve(),
    },
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.resolve({ status: 'applied', op: 'agent.label' }),
    now: () => 0,
  } as unknown as LocalUiContext;
}

const operation = {
  sign: (_review: unknown, reqs: readonly { kind: string; action?: unknown }[]) =>
    Promise.resolve(
      reqs.map((r) =>
        r.kind === 'owner-action'
          ? { kind: 'owner-action', signed: { body: r.action, sig: 'ab'.repeat(64) } }
          : { kind: 'typed-data', signature: '0x' },
      ),
    ),
  addAgent: () => Promise.resolve({ status: 'done' }),
} as unknown as LocalUiOwnerOperation;

/** The page's fetch, answered by the real route handler for its path. */
function handlerFetch(seen: { input?: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const headers = new Headers(init?.headers);
    const route = find(init?.method ?? 'GET', url.pathname);
    const raw = headers.get('X-AgentLink-Input');
    const parsed = raw === null ? undefined : JSON.parse(fromBase64url(raw));
    seen.input = parsed;
    const result =
      route.method === 'GET'
        ? await (route as LocalUiReadRoute).handler(world(), {
            params: {},
            query: url.searchParams,
          })
        : await (route as LocalUiOwnerRoute).handler(
            world(),
            { params: {}, query: new URLSearchParams(), input: parsed },
            operation,
          );
    return new Response(JSON.stringify(result.body), { status: result.status });
  }) as typeof fetch;
}

const proof = { kind: 'code', code: '123456' } as const;

describe('contract: the real Add and Rename handlers accept the page', () => {
  it('label-check says ok for a plain name and refused for one core would not sign', async () => {
    const api = createAgentsApi({ fetch: handlerFetch({}), token: 't' });
    expect(await api.labelCheck('Home agent')).toBe('ok');
    expect(await api.labelCheck('Work  agent')).toBe('refused');
  });
  it('rename {name, label} is accepted and read as done', async () => {
    const seen: { input?: unknown } = {};
    const api = createAgentsApi({ fetch: handlerFetch(seen), token: 't' });
    expect(await api.rename({ name: 'personal', label: 'Home' }, proof)).toEqual({ kind: 'done' });
    expect(seen.input).toEqual({ name: 'personal', label: 'Home' });
  });
  it('add {label} is accepted and read as done', async () => {
    const seen: { input?: unknown } = {};
    const api = createAgentsApi({ fetch: handlerFetch(seen), token: 't' });
    expect(await api.add({ label: 'Home' }, proof)).toEqual({ kind: 'done' });
    expect(seen.input).toEqual({ label: 'Home' });
  });
  it('the real refusals map: label_invalid, and another open agent is agent_changed', async () => {
    const api = createAgentsApi({ fetch: handlerFetch({}), token: 't' });
    expect(await api.rename({ name: 'personal', label: 'bad  label' }, proof)).toEqual({
      kind: 'label_invalid',
    });
    expect(await api.rename({ name: 'work', label: 'Home' }, proof)).toEqual({
      kind: 'agent_changed',
    });
  });
});
