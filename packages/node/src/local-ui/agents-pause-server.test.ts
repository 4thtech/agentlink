// W4-PAUSE (S2; D-143 (5); 08 §1 `POST /api/ui/agents/pause`, `POST /api/ui/agents/resume`, "Pause
// an agent"; 04 §2.5 "Live status and Pause", §2.5.1 `agent.resume`; I-4; proposed, owner confirms
// at merge).
//
// - Pause is a named route kind of its own (`presence: 'pause'`), only at its fixed path, with no
//   handler and no owner presence: the server's pause gate checks the session, CSRF, Origin, fetch
//   metadata, octet-stream type and the generation in its body (exactly `{generation}`), and writes
//   only the open agent's pause row. Outside the app host it answers `not_available`.
// - Resume is a presence route: refused with `not_paused` before the gesture when the agent is not
//   paused; after the gesture it signs exactly `agent.resume` {agent} for the open agent and core
//   verifies and applies it.
// - `GET /api/ui/agents` shows a paused agent's state as `paused` (the allowlist of 08 §1).
import { encodeUtf8 } from '@4thtech-io/crypto';
import {
  AGENTS_PAUSE,
  AGENTS_PAUSE_PATH as SAMPLE_PAUSE_PATH,
  AGENTS_RESUME,
  AGENTS_RESUME_PATH as SAMPLE_RESUME_PATH,
  AGENTS_WORLD,
  OCTET_STREAM,
} from '@4thtech-io/types/ui-contract/agents';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerInternals,
  type ApprovalServerSource,
} from '../approval-server.js';
import type { AgentDirectory, AgentDirectoryEntry, AppHostAgent } from './app-host.js';
import type { LocalUiContext } from './context.js';
import type { LocalUiOwnerOperation, LocalUiOwnerRoute, LocalUiResult } from './route-types.js';
import { AGENTS_PAUSE_PATH, AGENTS_RESUME_PATH, createLocalUiRoutes } from './routes.js';

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title>' +
  '<script type="module" crossorigin src="/assets/index-Bx3f9a2Q.js"></script></head>' +
  '<body><div id="root"></div></body></html>';
const SELF = '0x71c4000000000000000000000000000000009a2e';

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** The real approval server as the app host; the open agent's pause row is `state.paused`. */
async function host(options: { host?: false } = {}) {
  const state = { paused: false, pauses: 0 };
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
  const first = AGENTS_WORLD.agents[0].name;
  const client = {
    agentId: SELF,
    ownerActions: {
      loadLabel: () => Promise.resolve({ status: 'verified', label: 'Personal' }),
    },
    pause: {
      read: () =>
        Promise.resolve(
          state.paused ? { status: 'paused', pausedAt: 1_800_000_000 } : { status: 'running' },
        ),
      pause: () => {
        state.pauses += 1;
        const was = state.paused;
        state.paused = true;
        return Promise.resolve(was ? 'already' : 'paused');
      },
    },
  };
  const agent = (name: string): AppHostAgent => ({
    name,
    label: entries.get(name)?.label ?? name,
    source: source(),
    localUi: { client: client as never },
    close: () => Promise.resolve(),
  });
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    // The open agent's pause row, as the read-only peek reads it.
    stats: (name) =>
      Promise.resolve({
        contacts: 1,
        running: false,
        sessions: [],
        lastSeen: [],
        ...(name === first && state.paused ? { paused: true as const } : {}),
      }),
    writeLabel: () => Promise.reject(new Error('never')),
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
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
  const server = await startApprovalServerWith(
    {
      source: agent(first).source,
      localUi: {
        ...(options.host === false ? { client: client as never } : {}),
        assets: {
          files: new Map<string, Uint8Array>([
            ['index.html', encodeUtf8(INDEX_HTML)],
            ['assets/index-Bx3f9a2Q.js', encodeUtf8('console.log(1);')],
          ]),
        },
      },
      ...(options.host === false
        ? {}
        : {
            host: {
              directory,
              initial: agent(first),
              open: (name) => Promise.resolve(agent(name)),
            },
          }),
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
  const send = async (
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const headers = new Headers(init.headers);
    headers.set('Cookie', cookie);
    headers.set('Origin', server.origin);
    headers.set('X-AgentLink-CSRF', csrf);
    const res = await fetch(`${server.origin}${path}`, { ...init, headers });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const generation = async (): Promise<number> =>
    (await send('/api/ui/agents')).body['generation'] as number;
  const pause = (body: unknown, extra: Record<string, string> = {}, query = '') =>
    send(`${AGENTS_PAUSE_PATH}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': OCTET_STREAM, ...extra },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { send, state, generation, pause, first };
}

describe('the pause kind (08 §1; presence: "pause")', () => {
  it('is registered once, as a POST at its fixed path, with no handler', () => {
    const routes = createLocalUiRoutes().routes();
    const kinds = routes.filter((r) => r.presence === 'pause');
    expect(kinds.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${AGENTS_PAUSE_PATH}`]);
    expect(AGENTS_PAUSE_PATH).toBe('/api/ui/agents/pause');
    expect('handler' in (kinds[0] ?? {})).toBe(false);
  });

  it('another path or a second pause route cannot be registered', () => {
    const registry = createLocalUiRoutes();
    expect(() =>
      registry.register({ method: 'POST', path: '/api/ui/agents/pause-all', presence: 'pause' }),
    ).toThrow();
    expect(() =>
      registry.register({ method: 'POST', path: AGENTS_PAUSE_PATH, presence: 'pause' }),
    ).toThrow();
  });

  it('pauses the open agent with one click (no presence) and shows it as paused', async () => {
    const h = await host();
    const answer = await h.pause({ generation: await h.generation() });
    expect(answer).toEqual({ status: 200, body: { status: 'paused' } });
    expect(h.state).toEqual({ paused: true, pauses: 1 });
    const list = await h.send('/api/ui/agents');
    const row = (list.body['agents'] as { name: string; state: string }[]).find(
      (a) => a.name === h.first,
    );
    expect(row?.state).toBe('paused');
    // A second click changes nothing and answers the same.
    expect(await h.pause({ generation: await h.generation() })).toEqual({
      status: 200,
      body: { status: 'paused' },
    });
  });

  it('refuses anything but exactly {generation}: extra keys, a query, a presence header', async () => {
    const h = await host();
    const generation = await h.generation();
    for (const [body, extra, query] of [
      [{ generation, name: h.first }, {}, ''],
      [{}, {}, ''],
      [{ generation: String(generation) }, {}, ''],
      ['not json', {}, ''],
      [{ generation }, {}, '?x=1'],
      [{ generation }, { 'X-AgentLink-Presence': 'passkey' }, ''],
      [{ generation }, { 'X-AgentLink-Input': 'e30' }, ''],
    ] as const) {
      const answer = await h.pause(body, extra, query);
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ status: 'invalid' });
    }
    expect(h.state.pauses).toBe(0);
  });

  it('a stale generation is agent_changed and pauses nothing', async () => {
    const h = await host();
    const answer = await h.pause({ generation: (await h.generation()) + 7 });
    expect(answer.status).toBe(409);
    expect(answer.body['status']).toBe('agent_changed');
    expect(h.state.pauses).toBe(0);
  });

  it('needs the octet-stream type and the CSRF header like every write', async () => {
    const h = await host();
    const generation = await h.generation();
    const json = await h.send(AGENTS_PAUSE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ generation }),
    });
    expect(json.status).toBe(415);
    expect(h.state.pauses).toBe(0);
  });

  it('outside the app host it answers not_available', async () => {
    const h = await host({ host: false });
    const answer = await h.pause({ generation: 1 });
    expect(answer.status).toBe(501);
    expect(h.state.pauses).toBe(0);
  });
});

// ---- Resume (presence; signs agent.resume) -------------------------------------------------------

const resumeRoute = (): LocalUiOwnerRoute => {
  const found = createLocalUiRoutes()
    .routes()
    .find((r) => r.method === 'POST' && r.path === AGENTS_RESUME_PATH);
  if (found === undefined || found.presence !== true) throw new Error('no resume route');
  return found;
};

function world(state: { paused: boolean; applied?: string }): LocalUiContext {
  const body = {
    v: 1,
    agent: SELF,
    owner: 'dd'.repeat(32),
    op: 'agent.resume',
    params: { agent: SELF },
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    issuedAt: 1_760_000_000,
    expiresAt: 1_760_000_600,
  };
  return {
    client: {
      agentId: SELF,
      agent: {
        label: () => Promise.resolve({ status: 'verified', label: 'Personal' }),
        prepareLabel: () => Promise.reject(new Error('never')),
        pauseState: () =>
          Promise.resolve(
            state.paused ? { status: 'paused', pausedAt: 1_760_000_000 } : { status: 'running' },
          ),
        prepareResume: () =>
          Promise.resolve(
            state.paused
              ? { status: 'prepared', op: 'agent.resume', body, jcs: JSON.stringify(body) }
              : { status: 'refused', op: 'agent.resume', reason: 'not_paused' },
          ),
      },
    },
    applyOwnerAction: (signed: { body: { op: string } }) => {
      state.applied = signed.body.op;
      state.paused = false;
      return Promise.resolve({ status: 'applied', op: 'agent.resume' });
    },
    now: () => 0,
  } as unknown as LocalUiContext;
}

function signer() {
  const signed: unknown[] = [];
  const review: unknown[] = [];
  const operation = {
    sign: (shown: unknown, reqs: readonly { kind: string; action?: unknown }[]) => {
      review.push(shown);
      for (const r of reqs) signed.push(r.action);
      return Promise.resolve(
        reqs.map((r) => ({
          kind: 'owner-action',
          signed: { body: r.action, sig: 'ab'.repeat(64) },
        })),
      );
    },
  } as unknown as LocalUiOwnerOperation;
  return { operation, signed, review };
}

const plain = (result: LocalUiResult | undefined) =>
  result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as unknown);

const request = (input?: unknown) => ({
  params: {},
  query: new URLSearchParams(),
  ...(input === undefined ? {} : { input: input as never }),
});

describe('contract (server): the Pause and Resume samples U5 builds on', () => {
  it('the paths are the shared ones', () => {
    expect(AGENTS_PAUSE_PATH).toBe(SAMPLE_PAUSE_PATH);
    expect(AGENTS_RESUME_PATH).toBe(SAMPLE_RESUME_PATH);
  });

  it('pause answers the samples: accepted, stale, invalid', async () => {
    const h = await host();
    const generation = await h.generation();
    expect(await h.pause({ generation: generation + 98 })).toEqual(AGENTS_PAUSE.stale.answer);
    expect(await h.pause({ generation, extra: 1 })).toEqual(AGENTS_PAUSE.invalid.answer);
    expect(await h.pause({ generation })).toEqual(AGENTS_PAUSE.accepted.answer);
  });

  it('resume answers the samples: resumed and not_paused', async () => {
    const paused = { paused: true } as { paused: boolean; applied?: string };
    const s = signer();
    const done = await resumeRoute().handler(
      world(paused),
      request(AGENTS_RESUME.input),
      s.operation,
    );
    expect(plain(done)).toEqual(AGENTS_RESUME.resumed.answer);
    const refusal = await resumeRoute().precheck?.(
      world({ paused: false }),
      request(AGENTS_RESUME.input),
    );
    expect(plain(refusal)).toEqual(AGENTS_RESUME.notPaused.answer);
  });
});

describe('resume (presence; signs agent.resume, 04 §2.5.1)', () => {
  it('is a presence route at its fixed path with a precheck', () => {
    const route = resumeRoute();
    expect(AGENTS_RESUME_PATH).toBe('/api/ui/agents/resume');
    expect(route.presence).toBe(true);
    expect(route.precheck).toBeTypeOf('function');
  });

  it('not paused: refused with not_paused before the gesture', async () => {
    const route = resumeRoute();
    const refusal = await route.precheck?.(world({ paused: false }), request());
    expect(plain(refusal)).toEqual({ status: 409, body: { error: 'not_paused' } });
  });

  it('paused: the precheck lets it on; the gesture signs exactly agent.resume {agent} and core applies it', async () => {
    const route = resumeRoute();
    const state = { paused: true } as { paused: boolean; applied?: string };
    expect(await route.precheck?.(world(state), request())).toBeUndefined();
    const s = signer();
    const result = await route.handler(world(state), request(), s.operation);
    expect(plain(result)).toEqual({ status: 200, body: { status: 'resumed' } });
    expect(s.signed).toHaveLength(1);
    expect(s.signed[0]).toMatchObject({ op: 'agent.resume', agent: SELF, params: { agent: SELF } });
    expect(JSON.stringify(s.review)).toContain('Resume Personal');
    expect(state.applied).toBe('agent.resume');
  });

  it('refuses any operation input (it takes none)', async () => {
    const s = signer();
    const result = await resumeRoute().handler(
      world({ paused: true }),
      request({ agent: SELF }),
      s.operation,
    );
    expect(result.status).toBe(400);
    expect(s.signed).toEqual([]);
  });

  it('checks not_paused again after the gesture and signs nothing then', async () => {
    const s = signer();
    const result = await resumeRoute().handler(world({ paused: false }), request(), s.operation);
    expect(plain(result)).toEqual({ status: 409, body: { error: 'not_paused' } });
    expect(s.signed).toEqual([]);
  });

  it('through the server, resume without presence is refused', async () => {
    const h = await host();
    h.state.paused = true;
    const answer = await h.send(AGENTS_RESUME_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': OCTET_STREAM,
        'X-AgentLink-Generation': String(await h.generation()),
      },
      body: '',
    });
    expect(answer.status).toBe(403);
    expect(h.state.paused).toBe(true);
  });
});

// IR-W4-PAUSE-SEC-1 L-1: an unreadable pause row is answered `unavailable` before the gesture (no
// Touch ID asked for nothing), and a failing apply after the gesture is a fixed answer, never a throw.
describe('resume: unreadable pause row and a failing apply (W4-PAUSE fix round)', () => {
  const UNAVAILABLE = { status: 503, body: { error: 'unavailable' } };

  function unreadable(): LocalUiContext {
    const base = world({ paused: true });
    const client = (base as unknown as { client: { agent: Record<string, unknown> } }).client;
    return {
      ...base,
      client: {
        ...client,
        agent: { ...client.agent, pauseState: () => Promise.resolve({ status: 'unreadable' }) },
      },
    } as unknown as LocalUiContext;
  }

  it('an unreadable row: precheck answers unavailable and the handler signs nothing', async () => {
    const route = resumeRoute();
    expect(plain(await route.precheck?.(unreadable(), request()))).toEqual(UNAVAILABLE);
    const s = signer();
    expect(plain(await route.handler(unreadable(), request(), s.operation))).toEqual(UNAVAILABLE);
    expect(s.signed).toEqual([]);
  });

  it('an apply that throws after the gesture is a fixed answer', async () => {
    const ctx = {
      ...world({ paused: true }),
      applyOwnerAction: () => Promise.reject(new Error('SQLITE_BUSY /Users/x/store.sqlite')),
    } as unknown as LocalUiContext;
    const s = signer();
    const result = await resumeRoute().handler(ctx, request(), s.operation);
    expect(plain(result)).toEqual(UNAVAILABLE);
    expect(JSON.stringify(result)).not.toContain('SQLITE');
  });
});
