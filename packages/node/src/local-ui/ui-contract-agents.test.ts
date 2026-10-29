// U3-h CONTRACT, server side: the REAL app host and route handlers against the shared Agents wire
// samples (@4thtech-io/types/ui-contract/agents). Each sample request goes in exactly as the page
// sends it; the real answer must be the sample answer. The page side
// (apps/local-ui/src/pages/agents/contract.test.ts) asserts the client builds the same requests and
// reads the same answers, so the two cannot drift apart without one of them failing.
//
// - The switch and the list go through the real approval server and app host (session cookie, CSRF,
//   Origin, octet-stream body `{name, generation}` with a number generation).
// - Label-check, Add and Rename go through the real route handlers of api/agents-manage.ts, fed what
//   the presence gate hands them (the JSON of X-AgentLink-Input); the context is a small fake of the
//   agent's own state.
// - Remove is the real route at the sample path (U3-e); its documented statuses are the server's.
import { encodeUtf8 } from '@4thtech-io/crypto';
import {
  AGENTS_LABEL_CHECK,
  AGENTS_LABEL_CHECK_PATH,
  AGENTS_LABEL_PATH,
  AGENTS_LIST,
  AGENTS_OWNER,
  AGENTS_PATH,
  AGENTS_REMOVE,
  AGENTS_REMOVE_PATH,
  AGENTS_SWITCH,
  AGENTS_SWITCH_PATH,
  AGENTS_WORLD,
  OCTET_STREAM,
  type UiAnswer,
} from '@4thtech-io/types/ui-contract/agents';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerInternals,
  type ApprovalServerSource,
} from '../approval-server.js';
import { REMOVE_STATUS, type RemoveOutcome } from './api/agents-remove.js';
import type { AgentDirectory, AgentDirectoryEntry, AppHostAgent } from './app-host.js';
import type { LocalUiContext } from './context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiResult,
} from './route-types.js';
import { createLocalUiRoutes } from './routes.js';

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title>' +
  '<script type="module" crossorigin src="/assets/index-Bx3f9a2Q.js"></script></head>' +
  '<body><div id="root"></div></body></html>';

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** The real approval server as the app host, in AGENTS_WORLD; a fetch with the page's session. */
async function host() {
  const written: string[] = [];
  const entries = new Map<string, AgentDirectoryEntry>(
    AGENTS_WORLD.agents.map((a) => [
      a.name,
      { name: a.name, label: a.label, available: true, removing: false },
    ]),
  );
  const source = (): ApprovalServerSource => ({
    context: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: () => Promise.reject(new Error('never')),
  });
  const agent = (name: string): AppHostAgent => ({
    name,
    label: entries.get(name)?.label ?? name,
    source: source(),
    // Each agent's verified label is its world label (U3-d: the open agent is named by it).
    localUi: {
      client: {
        agentId: '0x' + '42'.repeat(20),
        ownerActions: {
          loadLabel: () =>
            Promise.resolve({ status: 'verified', label: entries.get(name)?.label ?? name }),
        },
      } as never,
    },
    close: () => Promise.resolve(),
  });
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: () => Promise.resolve({ contacts: 1, running: false }),
    writeLabel: () => Promise.reject(new Error('never')),
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: (name) => {
      written.push(name);
      return Promise.resolve();
    },
  };
  const opened: string[] = [];
  const internals: ApprovalServerInternals = {
    opener: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    notifier: () => Promise.resolve(true),
    openOwnerStore: () => Promise.reject(new Error('no owner store')),
  };
  const first = AGENTS_WORLD.agents[0].name;
  const server = await startApprovalServerWith(
    {
      source: agent(first).source,
      localUi: {
        assets: {
          files: new Map<string, Uint8Array>([
            ['index.html', encodeUtf8(INDEX_HTML)],
            ['assets/index-Bx3f9a2Q.js', encodeUtf8('console.log(1);')],
          ]),
        },
      },
      host: { directory, initial: agent(first), open: (name) => Promise.resolve(agent(name)) },
    },
    internals,
  );
  servers.push(server);
  await server.open();
  const link = new URL(opened[0] ?? '');
  const entry = await fetch(`${server.origin}/?t=${link.searchParams.get('t') ?? ''}`, {
    redirect: 'manual',
  });
  const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const page = await (await fetch(`${server.origin}/`, { headers: { Cookie: cookie } })).text();
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page)?.[1] ?? '';
  const send = async (path: string, init: RequestInit = {}): Promise<UiAnswer<unknown>> => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    headers.set('Origin', server.origin);
    headers.set('X-AgentLink-CSRF', csrf);
    const res = await fetch(`${server.origin}${path}`, { ...init, headers });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { send, written };
}

describe('contract (server): the real app host answers the Agents samples', () => {
  it('GET /api/ui/agents answers the sample list', async () => {
    const { send } = await host();
    expect(await send(AGENTS_PATH)).toEqual(AGENTS_LIST.answer);
  });

  it('the switch: octet-stream {name, generation (a number)} is accepted and opens the other agent', async () => {
    const { send, written } = await host();
    const answer = await send(AGENTS_SWITCH_PATH, {
      method: 'POST',
      headers: { 'Content-Type': OCTET_STREAM },
      body: JSON.stringify(AGENTS_SWITCH.accepted.body),
    });
    expect(answer).toEqual(AGENTS_SWITCH.accepted.answer);
    expect(written).toEqual(AGENTS_SWITCH.accepted.written);
  });

  it('a stale generation is agent_changed, not a format error', async () => {
    const { send, written } = await host();
    const answer = await send(AGENTS_SWITCH_PATH, {
      method: 'POST',
      headers: { 'Content-Type': OCTET_STREAM },
      body: JSON.stringify(AGENTS_SWITCH.stale.body),
    });
    expect(answer).toEqual(AGENTS_SWITCH.stale.answer);
    expect(written).toEqual([]);
  });
});

const SELF = '0x71c4000000000000000000000000000000009a2e';
const routes = createLocalUiRoutes().routes();
const route = (method: string, path: string) => {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (found === undefined) throw new Error(`no route ${method} ${path}`);
  return found;
};

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
      current: () => AGENTS_OWNER.openAgent,
      create: () => Promise.resolve({ name: AGENTS_OWNER.createdAgent }),
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

const plain = (result: LocalUiResult): UiAnswer<unknown> => ({
  status: result.status,
  body: JSON.parse(JSON.stringify(result.body)) as unknown,
});

const read = async (path: string, query: URLSearchParams) =>
  plain(await (route('GET', path) as LocalUiReadRoute).handler(world(), { params: {}, query }));

/** What the presence gate hands an owner route: the input JSON exactly as the page sent it. */
const ownerCall = async (path: string, input: unknown) =>
  plain(
    await (route('POST', path) as LocalUiOwnerRoute).handler(
      world(),
      { params: {}, query: new URLSearchParams(), input: JSON.parse(JSON.stringify(input)) },
      operation,
    ),
  );

describe('contract (server): the real U3-d handlers answer the owner samples', () => {
  it('label-check: ok for a plain name, refused for one core would not sign', async () => {
    for (const sample of [AGENTS_LABEL_CHECK.ok, AGENTS_LABEL_CHECK.refused]) {
      const query = new URLSearchParams({ label: sample.label });
      expect(await read(AGENTS_LABEL_CHECK_PATH, query)).toEqual(sample.answer);
    }
  });

  it('rename takes exactly {name, label}', async () => {
    const { input, answer } = AGENTS_OWNER.rename;
    expect(await ownerCall(AGENTS_LABEL_PATH, input)).toEqual(answer);
  });

  it('add takes exactly {label}', async () => {
    const { input, answer } = AGENTS_OWNER.add;
    expect(await ownerCall(AGENTS_PATH, input)).toEqual(answer);
  });

  it('the refusals arrive as {error}: label_invalid, and another agent than the open one is agent_changed', async () => {
    for (const sample of AGENTS_OWNER.refusals) {
      expect(await ownerCall(AGENTS_LABEL_PATH, sample.input)).toEqual(sample.answer);
    }
  });

  it('remove is the real route (presence "remove") and its statuses are the documented ones (U3-e)', () => {
    const remove = route('POST', AGENTS_REMOVE_PATH) as { presence: unknown };
    expect(remove.presence).toBe('remove');
    for (const sample of AGENTS_REMOVE.documented) {
      const word = (sample.answer.body as { status: string }).status;
      // `busy` is answered by the owner gate (409); the rest are the remove route's own outcomes.
      const expected = word === 'busy' ? 409 : REMOVE_STATUS[word as RemoveOutcome];
      expect(sample.answer.status, word).toBe(expected);
    }
  });
});
