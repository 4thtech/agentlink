// U3-g-b acceptance (S2; D-138; 08 §1 "Agents and AI apps in the app", first run v3; 04 §2.5
// "Several agents in one app", §2.8 "From the local app"; I-1, I-4, I-7): `ui` with no agent at all
// opens the app on Welcome. Contract tests against the real approval server as the app host.
//
// - The host starts with NO open agent (`host.initial` absent, `host.firstRun` present). It serves
//   the app shell (Welcome and first run) and the setup-time reads only: `GET /api/ui/first-run`,
//   `GET /api/ui/apps`, `GET /api/ui/agents/label-check`, `GET /api/ui/agents`, `GET /api/ui/health`.
// - Every other route (every agent-scoped read and write, and the approval API) is refused with one
//   fixed answer, 409 `no_agent`, after every guard (session, Host, Origin, CSRF, fetch metadata,
//   octet-stream, generation) and before any handler or presence check runs.
// - First run `begin` / `finish {label}` (the setup kind, unchanged gate) create the first agent
//   folder and the owner with one gesture, all or nothing, and open that agent in the same host,
//   port and session (the generation increases; no restart, no new link).
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLinkClient,
  checkInviteLink,
  decodeInviteLink,
  nostrTransport,
  type ApprovalChannel,
  type OwnerActionOutcome,
} from '@4thtech-io/core';
import {
  concatBytes,
  decodeBase64url,
  encodeBase64url,
  encodeUtf8,
  hkdfSha256,
  randomBytes,
  sha256,
  type KeyStore,
} from '@4thtech-io/crypto';
import type { RelayConnector, RelaySocket, RelaySocketHandlers } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from '../agent-store.js';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { createKeychainAgent, openRecordedKeyStore } from '../keychain-keystore.js';
import type { KeychainBackend } from '../keychain.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { OWNER_ACCOUNT } from '../owner-keystore.js';
import { defaultOwnerFiles, encodeSetupRegistration } from '../owner-setup.js';
import {
  FIRST_AGENT_LABEL,
  FIRST_AGENT_NAME,
  type AgentDirectory,
  type AgentDirectoryEntry,
  type AppHostAgent,
} from './app-host.js';
import { createLocalUiRoutes } from './routes.js';
import type { JoinCheck } from './join-desk.js';
import { CoreError } from '@4thtech-io/core';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const NOW = 1_800_000_000;
const ALPHA = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];
const BEGIN = '/api/ui/first-run/owner/begin';
const FINISH = '/api/ui/first-run/owner/finish';
const NO_AGENT = { status: 'no_agent' };

/** An in-memory keychain with fault injection per account. */
class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  failSet = new Set<string>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    if (this.failSet.has(account)) throw new Error('keychain refused');
    this.items.set(account, value.slice());
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    return this.items.delete(account);
  }
}

const quietRelays: RelayConnector = {
  open(_target, handlers: RelaySocketHandlers): RelaySocket {
    void Promise.resolve().then(() => handlers.onOpen());
    return {
      send: (text: string) => {
        const frame = JSON.parse(text) as unknown[];
        const push = (reply: unknown): void =>
          void Promise.resolve().then(() => handlers.onMessage(JSON.stringify(reply)));
        if (frame[0] === 'EVENT') push(['OK', (frame[1] as { id: string }).id, true, '']);
        if (frame[0] === 'REQ') push(['EOSE', frame[1]]);
      },
      close: () => undefined,
    };
  },
};

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

interface Response {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: `localhost:${String(port)}`, ...options.headers },
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

interface BeginBody {
  status: string;
  publicKey: { rpId: string; userId: string; challenge: string; prfSalt: string };
}

/** A virtual platform authenticator: one navigator.credentials.create with prf.eval. */
class Authenticator {
  readonly credentialId = randomBytes(16);
  readonly #prfSecret = randomBytes(32);
  create(options: BeginBody['publicKey'], origin: string): Uint8Array {
    const flags = 0x01 | 0x04 | 0x40;
    const authenticatorData = concatBytes(
      sha256(encodeUtf8(options.rpId)),
      new Uint8Array([flags]),
      new Uint8Array([0, 0, 0, 1]),
      new Uint8Array(16),
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26]),
    );
    const clientDataJSON = encodeUtf8(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    return encodeSetupRegistration({
      credentialId: this.credentialId,
      authenticatorData,
      clientDataJSON,
      prfOutput: hkdfSha256(
        this.#prfSecret,
        decodeBase64url(options.prfSalt),
        encodeUtf8('virtual-authenticator-prf'),
        32,
      ),
    });
  }
}

const input = (value: unknown): string => encodeBase64url(encodeUtf8(JSON.stringify(value)));

let dir: string;
const servers: ApprovalServer[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-u3-g-b-'));
  await mkdir(join(dir, 'home'), { recursive: true });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/** The owner's computer with no agent at all yet, behind a fake AgentDirectory. */
interface World {
  readonly keychain: MapKeychain;
  readonly entries: Map<string, AgentDirectoryEntry>;
  readonly log: string[];
  readonly labels: [string, string][];
  readonly current: string[];
  readonly clients: Map<string, AgentLinkClient>;
  readonly directory: AgentDirectory;
  open(name: string): Promise<AppHostAgent | undefined>;
}

function world(): World {
  const keychain = new MapKeychain();
  const entries = new Map<string, AgentDirectoryEntry>();
  const ids = new Map<string, string>();
  const log: string[] = [];
  const labels: [string, string][] = [];
  const current: string[] = [];
  const clients = new Map<string, AgentLinkClient>();
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: () => Promise.resolve({ contacts: 0, running: false }),
    writeLabel: (name, label) => {
      labels.push([name, label]);
      const entry = entries.get(name);
      if (entry !== undefined) entries.set(name, { ...entry, label });
      return Promise.resolve();
    },
    create: async (label, options) => {
      log.push(`create ${label} as ${String(options?.name)}`);
      const agentId = await createKeychainAgent(keychain);
      // The CLI names the folder `options.name`, else a slug of the label (U3-d).
      const name = options?.name ?? 'slug-of-label';
      ids.set(name, agentId);
      entries.set(name, { name, label: name, available: true, removing: false });
      return name;
    },
    discardNew: (name) => {
      log.push(`discard ${name}`);
      entries.delete(name);
      ids.delete(name);
      return Promise.resolve();
    },
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: (name) => {
      current.push(name);
      return Promise.resolve();
    },
  };
  const open = async (name: string): Promise<AppHostAgent | undefined> => {
    const agentId = ids.get(name);
    const entry = entries.get(name);
    if (agentId === undefined || entry === undefined || entry.removing) return undefined;
    log.push(`open ${name}`);
    const store: AgentStore = await openAgentStoreWith(
      'keychain',
      agentId,
      join(dir, `${name}.sqlite`),
      { keychain },
    );
    const keyStore: KeyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
    const client = await AgentLinkClient.create({
      keyStore,
      store: store.store,
      cipher: store.cipher,
      approvals,
      clock: () => NOW,
      transport: nostrTransport({ connector: quietRelays, addressCheck: 'platform' }),
      policyMark: store.policyMark,
    });
    clients.set(name, client);
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      log.push(`close ${name}`);
      await keyStore.close();
      await store.close();
    };
    cleanups.push(close);
    const source: ApprovalServerSource = {
      context: async () => {
        const view = await client.identity.get();
        if (view === undefined) return undefined;
        const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
        return {
          agent: agentId,
          owner: {
            ownerEvm: hex(view.card.ownerEvm),
            ownerNostr: hex(view.card.ownerNostr),
            ownerEnc: hex(view.card.ownerEnc),
          },
        };
      },
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      apply: () =>
        Promise.resolve({ status: 'applied', op: 'contact.check' } as OwnerActionOutcome),
    };
    return {
      name,
      label: entry.label,
      source,
      localUi: { client },
      firstCard: {
        agent: agentId,
        name,
        relays: ALPHA,
        identity: client.identity,
        firstPolicy: { actions: client.ownerActions },
      },
      close,
    };
  };
  return { keychain, entries, log, labels, current, clients, directory, open };
}

interface Harness {
  readonly server: ApprovalServer;
  readonly port: number;
  readonly origin: string;
  readonly w: World;
  readonly events: ApprovalServerEvent[];
  /** Every URL handed to the OS opener (U3-invite). */
  readonly opened: string[];
  /** A page session: the cookie, the CSRF token and the generation the page was built against. */
  session(): Promise<{ cookie: string; csrf: string; generation: string; page: Response }>;
  get(path: string, s: { cookie: string; csrf: string }): Promise<Response>;
  post(
    path: string,
    s: { cookie: string; csrf: string; generation: string },
    body?: Uint8Array,
    extra?: Record<string, string>,
  ): Promise<Response>;
}

async function harness(
  options: { firstRun?: false; w?: World; waitingInvite?: string; checkInvite?: JoinCheck } = {},
): Promise<Harness> {
  const w = options.w ?? world();
  const opened: string[] = [];
  const events: ApprovalServerEvent[] = [];
  const server = await startApprovalServerWith(
    {
      // With no agent open the host serves no agent's source (U3-c NO_AGENT_SOURCE).
      source: {
        context: () => Promise.reject(new Error('never')),
        list: () => Promise.reject(new Error('never')),
        get: () => Promise.reject(new Error('never')),
        apply: () => Promise.reject(new Error('never')),
      },
      localUi: { assets: TEST_APP },
      host: {
        directory: w.directory,
        open: (name) => w.open(name),
        ...(options.firstRun === false
          ? {}
          : {
              firstRun: {
                // A test home, never the real ~/.agentlink.
                home: join(dir, 'home'),
                ownerFiles: defaultOwnerFiles(join(dir, 'home')),
              },
            }),
        // U3-invite: `join` on a computer with no agent folder at all.
        ...(options.waitingInvite === undefined ? {} : { waitingInvite: options.waitingInvite }),
      },
      onEvent: (event) => void events.push(event),
    },
    {
      keychain: w.keychain,
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      ownerKdf: KDF,
      // Never the real ~/.agentlink: the owner store opens on the test keychain only.
      ...(options.checkInvite === undefined ? {} : { checkInvite: options.checkInvite }),
    },
  );
  servers.push(server);
  const base = (s: { cookie: string; csrf: string }): Record<string, string> => ({
    Cookie: s.cookie,
    'X-AgentLink-CSRF': s.csrf,
    'Sec-Fetch-Site': 'same-origin',
  });
  return {
    server,
    port: server.port,
    origin: server.origin,
    w,
    opened,
    events,
    async session() {
      const at = opened.length;
      await server.openFirstRun();
      const link = new URL(opened[at] ?? '');
      expect(link.pathname).toBe('/first-run');
      const res = await send(server.port, `${link.pathname}${link.search}`);
      expect(res.status).toBe(303);
      const cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      const page = await send(server.port, '/first-run', { headers: { Cookie: cookie } });
      const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
      const generation = /<meta name="agentlink-generation" content="([0-9]+)">/.exec(
        page.body,
      )?.[1];
      return { cookie, csrf: csrf ?? '', generation: generation ?? '', page };
    },
    get: (path, s) => send(server.port, path, { headers: base(s) }),
    post: (path, s, body = new Uint8Array(0), extra = {}) =>
      send(server.port, path, {
        method: 'POST',
        headers: {
          ...base(s),
          Origin: server.origin,
          'Content-Type': 'application/octet-stream',
          'X-AgentLink-Generation': s.generation,
          ...extra,
        },
        body,
      }),
  };
}

/** The whole first run: begin {label} and finish {label} with one passkey gesture. */
async function firstRun(
  h: Harness,
  s: { cookie: string; csrf: string; generation: string },
  label: string | undefined = 'My agent',
): Promise<{ begin: Response; finish?: Response }> {
  const extra: Record<string, string> =
    label === undefined ? {} : { 'X-AgentLink-Input': input({ label }) };
  const begin = await h.post(BEGIN, s, new Uint8Array(0), extra);
  if (begin.status !== 200) return { begin };
  const begun = JSON.parse(begin.body) as BeginBody;
  const finish = await h.post(
    FINISH,
    s,
    new Authenticator().create(begun.publicKey, h.origin),
    extra,
  );
  return { begin, finish };
}

/** Every registered route with a concrete path (`:name` parameters filled in). */
function everyRoute(): { method: string; path: string }[] {
  return createLocalUiRoutes()
    .routes()
    .map((r) => ({ method: r.method, path: r.path.replace(/:[a-zA-Z]+/g, 'x1') }));
}

const SETUP_TIME = new Set([
  'GET /api/ui/first-run',
  'GET /api/ui/apps',
  'GET /api/ui/agents/label-check',
  'GET /api/ui/agents',
  'GET /api/ui/health',
  `POST ${BEGIN}`,
  `POST ${FINISH}`,
  // The switch kind keeps its own gate (U3-c): it answers `unknown_agent` here, never opens one.
  'POST /api/ui/agents/switch',
  // U3-e: the remove kind keeps its own gate; it needs no open agent (Remove anyway, 04 §2.5).
  'POST /api/ui/agents/remove',
  // U3-invite: the waiting invite is the host's, not an agent's: its read and "Not now" answer
  // during first run; the handoff kind runs before the session gate. Accept needs an agent.
  'GET /api/ui/join',
  'POST /api/ui/join/dismiss',
  'POST /api/ui/join/handoff',
]);

describe('U3-g-b: ui with no agent at all serves Welcome', () => {
  it('the host starts with no open agent and serves the first-run page with its generation', async () => {
    const h = await harness();
    const s = await h.session();
    expect(s.page.status).toBe(200);
    expect(s.csrf).not.toBe('');
    expect(s.generation).toBe('1');
    expect(s.page.headers['x-agentlink-generation']).toBe('1');
    // No agent is open: no label header.
    expect(s.page.headers['x-agentlink-agent']).toBeUndefined();
    expect(h.w.log).toEqual([]);
  });

  it('answers the setup-time reads', async () => {
    const h = await harness();
    const s = await h.session();
    const state = await h.get('/api/ui/first-run', s);
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ owner: 'missing' });
    const check = await h.get(
      `/api/ui/agents/label-check?label=${encodeURIComponent('My agent')}`,
      s,
    );
    expect(check.status).toBe(200);
    expect(JSON.parse(check.body)).toEqual({ status: 'ok' });
    const list = await h.get('/api/ui/agents', s);
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toMatchObject({ current: null, agents: [] });
    // U3-f fills GET /api/ui/apps; with no agent it is reached (never the no-agent refusal).
    const apps = await h.get('/api/ui/apps', s);
    expect(JSON.parse(apps.body)).not.toEqual(NO_AGENT);
    const health = await h.get('/api/ui/health', s);
    expect(health.status).toBe(200);
  });

  it('keeps every guard on the setup-time reads (session, Host, Origin, CSRF, fetch metadata)', async () => {
    const h = await harness();
    const s = await h.session();
    const path = '/api/ui/first-run';
    expect((await send(h.port, path, { headers: { 'X-AgentLink-CSRF': s.csrf } })).status).toBe(
      401,
    );
    expect((await h.get(path, { cookie: s.cookie, csrf: 'x' })).status).toBe(403);
    const wrongHost = await send(h.port, path, {
      headers: {
        Cookie: s.cookie,
        'X-AgentLink-CSRF': s.csrf,
        Host: `127.0.0.1:${String(h.port)}`,
      },
    });
    expect(wrongHost.status).toBe(403);
    const crossSite = await send(h.port, path, {
      headers: { Cookie: s.cookie, 'X-AgentLink-CSRF': s.csrf, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    const otherOrigin = await send(h.port, path, {
      headers: { Cookie: s.cookie, 'X-AgentLink-CSRF': s.csrf, Origin: 'http://localhost:1' },
    });
    expect(otherOrigin.status).toBe(403);
  });
});

describe('U3-g-b: agent routes are refused while no agent is open', () => {
  it('every agent-scoped route answers the fixed 409 no_agent, and no handler or agent runs', async () => {
    const h = await harness();
    const s = await h.session();
    const routes = everyRoute().filter((r) => !SETUP_TIME.has(`${r.method} ${r.path}`));
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) {
      const res =
        route.method === 'GET'
          ? await h.get(`${route.path}`, s)
          : await h.post(route.path, s, encodeUtf8('{}'));
      expect({ route, status: res.status, body: JSON.parse(res.body) as unknown }).toEqual({
        route,
        status: 409,
        body: NO_AGENT,
      });
    }
    expect(h.w.log).toEqual([]);
    expect(h.events.some((e) => e.kind === 'rejected' && e.reason === 'no_agent')).toBe(true);
  });

  it('the remove kind is not refused as no_agent (U3-e: Remove anyway runs with none open)', async () => {
    const h = await harness();
    const s = await h.session();
    const res = await h.post('/api/ui/agents/remove', s, encodeUtf8('{}'));
    expect(JSON.parse(res.body)).not.toEqual(NO_AGENT);
    expect(h.w.log).toEqual([]);
  });

  it('the approval API is refused the same way', async () => {
    const h = await harness();
    const s = await h.session();
    const list = await h.get('/api/approvals', s);
    expect(list.status).toBe(409);
    expect(JSON.parse(list.body)).toEqual(NO_AGENT);
    const id = `apr_${'A'.repeat(22)}`;
    const decide = await h.post(`/api/approvals/${id}/approve`, s);
    expect(decide.status).toBe(409);
    expect(JSON.parse(decide.body)).toEqual(NO_AGENT);
  });

  it('the guards run first: a missing session is 401, a stale generation is agent_changed', async () => {
    const h = await harness();
    const s = await h.session();
    expect((await send(h.port, '/api/ui/contacts')).status).toBe(401);
    const stale = await h.post('/api/ui/agents', { ...s, generation: '7' }, encodeUtf8('{}'));
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toEqual({ status: 'agent_changed' });
    const wrongType = await h.post('/api/ui/agents', s, encodeUtf8('{}'), {
      'Content-Type': 'application/json',
    });
    expect(wrongType.status).toBe(415);
  });

  it('a switch with no agent signs nothing and opens nothing (unknown_agent)', async () => {
    const h = await harness();
    const s = await h.session();
    const res = await h.post(
      '/api/ui/agents/switch',
      s,
      encodeUtf8(JSON.stringify({ name: 'default', generation: 1 })),
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ status: 'unknown_agent' });
    expect(h.w.log).toEqual([]);
  });
});

describe('U3-g-b: first run creates the first agent and opens it in the host', () => {
  it('begin and finish {label} create the agent and the owner with one gesture and open it', async () => {
    const h = await harness();
    const s = await h.session();
    const { begin, finish } = await firstRun(h, s, 'My agent');
    expect(begin.status).toBe(200);
    // Nothing is created before the gesture.
    expect(finish?.status).toBe(200);
    const done = JSON.parse(finish?.body ?? '{}') as { status: string; label?: string };
    expect(done.status).toBe('done');
    expect(done.label).toBe('saved');
    // The agent was created only at finish, opened for its first card, closed, then opened again
    // as the host's agent.
    expect(h.w.log).toEqual([
      'create My agent as default',
      'open default',
      'close default',
      'open default',
    ]);
    expect(h.w.labels).toEqual([['default', 'My agent']]);
    expect(h.w.current).toEqual(['default']);
    // The answer carries the new generation and the agent's verified label.
    expect(finish?.headers['x-agentlink-generation']).toBe('2');
    expect(decodeURIComponent(String(finish?.headers['x-agentlink-agent']))).toBe('My agent');
    // IR-U3-g-b-1 H-1: only this answer is marked, so the page adopts generation 2 (no reload).
    expect(finish?.headers['x-agentlink-generation-adopted']).toBe('1');
    expect(begin.headers['x-agentlink-generation-adopted']).toBeUndefined();
    // The card, its first policy and its first label are signed and verified by core.
    const client = h.w.clients.get('default');
    expect(await client?.identity.get()).toBeDefined();
    expect(await client?.ownerActions.loadLabel()).toEqual({
      status: 'verified',
      label: 'My agent',
    });
    expect((await client?.ownerActions.loadPolicy())?.mode).toBe('signed');
  }, 60_000);

  it('after first run the same session serves the agent: no restart, no new link', async () => {
    const h = await harness();
    const s = await h.session();
    await firstRun(h, s);
    const state = await h.get('/api/ui/first-run', s);
    expect(JSON.parse(state.body)).toEqual({ owner: 'set_up' });
    const list = await h.get('/api/ui/agents', s);
    expect(JSON.parse(list.body)).toMatchObject({ current: 'default', generation: 2 });
    const contacts = await h.get('/api/ui/contacts', s);
    expect(JSON.parse(contacts.body)).not.toEqual(NO_AGENT);
    // A page still built against the no-agent generation is refused before anything acts.
    const stale = await h.post('/api/ui/agents', s, encodeUtf8('{}'));
    expect(JSON.parse(stale.body)).toEqual({ status: 'agent_changed' });
    // A second first run is refused: an owner exists now.
    const again = await h.post(BEGIN, { ...s, generation: '2' }, new Uint8Array(0), {
      'X-AgentLink-Input': input({ label: 'Second' }),
    });
    expect(again.status).toBe(503);
  }, 60_000);

  it('the first agent folder is `default` whatever its label (D5: its AI app entry needs no --agent)', async () => {
    const h = await harness();
    const s = await h.session();
    const { finish } = await firstRun(h, s, 'Claude Code agent');
    expect(finish?.status).toBe(200);
    expect(FIRST_AGENT_NAME).toBe('default');
    expect(h.w.log[0]).toBe('create Claude Code agent as default');
    expect(h.w.labels).toEqual([['default', 'Claude Code agent']]);
    expect(h.w.current).toEqual(['default']);
    expect(decodeURIComponent(String(finish?.headers['x-agentlink-agent']))).toBe(
      'Claude Code agent',
    );
  }, 60_000);

  it(`with no label the first agent is named "${FIRST_AGENT_LABEL}"`, async () => {
    const h = await harness();
    const s = await h.session();
    const { finish } = await firstRun(h, s, undefined);
    expect(finish?.status).toBe(200);
    expect(h.w.log[0]).toBe(`create ${FIRST_AGENT_LABEL} as default`);
    expect(h.w.labels).toEqual([['default', FIRST_AGENT_LABEL]]);
  }, 60_000);

  it('U3-d-b: contacts see the name the owner typed ("Ana"), never the folder `default`', async () => {
    const h = await harness();
    const s = await h.session();
    const { finish } = await firstRun(h, s, 'Ana');
    expect(finish?.status).toBe(200);
    expect(h.w.current).toEqual(['default']);
    const client = h.w.clients.get('default');
    if (client === undefined) throw new Error('no client');
    // The card is signed over the typed label (nameHash) at creation, with one gesture.
    expect((await client.identity.signedCard()).name).toBe('Ana');
    const { inviteUrl } = await client.pairing.createInvite();
    expect((await decodeInviteLink(inviteUrl)).name).toBe('Ana');
    // What a peer sees after Accept step 1 (both card signatures and the nameHash checked).
    const peer = await checkInviteLink(inviteUrl, NOW);
    expect(peer.contact.display).toEqual({
      name: 'Ana',
      label: 'self-declared',
      nameSource: 'counterparty',
    });
  }, 60_000);

  it(`U3-d-b: with no label typed, contacts see "${FIRST_AGENT_LABEL}", not the folder`, async () => {
    const h = await harness();
    const s = await h.session();
    const { finish } = await firstRun(h, s, undefined);
    expect(finish?.status).toBe(200);
    const client = h.w.clients.get('default');
    if (client === undefined) throw new Error('no client');
    expect((await client.identity.signedCard()).name).toBe(FIRST_AGENT_LABEL);
  }, 60_000);

  it('refuses a label that is not restricted before any seed or folder exists', async () => {
    const h = await harness();
    const s = await h.session();
    const { begin } = await firstRun(h, s, 'Work  agent');
    expect(begin.status).toBe(400);
    expect(JSON.parse(begin.body)).toEqual({ status: 'label_invalid' });
    expect(h.w.log).toEqual([]);
  });

  it('all or nothing: when the owner cannot be stored, the new agent is removed again', async () => {
    const h = await harness();
    h.w.keychain.failSet.add(OWNER_ACCOUNT);
    const s = await h.session();
    const { finish } = await firstRun(h, s);
    expect(finish?.status).toBe(500);
    expect(JSON.parse(finish?.body ?? '{}')).toMatchObject({ status: 'failed' });
    expect(finish?.headers['x-agentlink-generation-adopted']).toBeUndefined();
    expect(h.w.log).toEqual([
      'create My agent as default',
      'open default',
      'close default',
      'discard default',
    ]);
    expect(h.w.entries.size).toBe(0);
    expect(h.w.current).toEqual([]);
    // Still no agent: the host and its generation are unchanged.
    const list = await h.get('/api/ui/agents', s);
    expect(JSON.parse(list.body)).toMatchObject({ current: null, generation: 1 });
    expect(JSON.parse((await h.get('/api/ui/contacts', s)).body)).toEqual(NO_AGENT);
  }, 60_000);

  it('a wrong passkey answer creates no agent', async () => {
    const h = await harness();
    const s = await h.session();
    const begin = await h.post(BEGIN, s, new Uint8Array(0));
    const begun = JSON.parse(begin.body) as BeginBody;
    const forged = new Authenticator().create(
      { ...begun.publicKey, challenge: encodeBase64url(randomBytes(32)) },
      h.origin,
    );
    const finish = await h.post(FINISH, s, forged);
    expect(finish.status).toBe(403);
    expect(h.w.log).toEqual([]);
  });

  it('begin is refused while any agent folder exists (even one being removed)', async () => {
    const w = world();
    w.entries.set('old', { name: 'old', label: 'Old', available: true, removing: true });
    const h = await harness({ w });
    const s = await h.session();
    const begin = await h.post(BEGIN, s, new Uint8Array(0));
    expect(begin.status).toBe(409);
    expect(JSON.parse(begin.body)).toEqual({ status: 'owner_exists' });
    expect(w.log).toEqual([]);
  });

  it('begin is refused when an owner already exists on this computer', async () => {
    const w = world();
    w.keychain.items.set(OWNER_ACCOUNT, new Uint8Array([1, 2, 3]));
    const h = await harness({ w });
    const s = await h.session();
    const begin = await h.post(BEGIN, s, new Uint8Array(0));
    expect(begin.status).toBe(409);
    expect(JSON.parse(begin.body)).toEqual({ status: 'owner_exists' });
  });

  it('GET /api/ui/first-run answers the real state: an owner without an agent folder is set_up', async () => {
    const w = world();
    w.keychain.items.set(OWNER_ACCOUNT, new Uint8Array([1, 2, 3]));
    const h = await harness({ w });
    const s = await h.session();
    const state = await h.get('/api/ui/first-run', s);
    expect(JSON.parse(state.body)).toEqual({ owner: 'set_up' });
  });

  it('GET /api/ui/first-run is set_up while any agent folder exists (first run is refused)', async () => {
    const w = world();
    w.entries.set('old', { name: 'old', label: 'Old', available: true, removing: true });
    const h = await harness({ w });
    const s = await h.session();
    expect(JSON.parse((await h.get('/api/ui/first-run', s)).body)).toEqual({ owner: 'set_up' });
  });

  it('without host.firstRun no agent is created from the page (503 unavailable)', async () => {
    const h = await harness({ firstRun: false });
    const s = await h.session();
    const begin = await h.post(BEGIN, s, new Uint8Array(0));
    expect(begin.status).toBe(503);
    expect(JSON.parse(begin.body)).toEqual({ status: 'unavailable' });
    expect(h.w.log).toEqual([]);
  });
});

// U3-invite fix round (IR-U3-invite-2 BLOCKING): `agentlink join` on a computer with NO agent folder
// at all. The no-agent host holds the waiting invite; the opener goes to first run because no owner
// exists yet (not because an agent's `ownerSetup` is set); first run v3 creates the agent and the
// owner; then the invite is still waiting and the join screen opens.
describe('U3-invite: join with an empty agent folder ends on the waiting invite', () => {
  const LINK = `https://agentlink.4thtech.io/i#${'Q'.repeat(48)}`;
  const INVITE_ID = 'AQEBAQEBAQEBAQEBAQEBAQ';
  const check: JoinCheck = (link) =>
    link === LINK
      ? Promise.resolve({
          inviteId: INVITE_ID,
          contact: {
            id: `0x${'1a'.repeat(20)}`,
            display: { name: 'Marko', label: 'self-declared', nameSource: 'counterparty' },
            ownerFingerprint: { short: '7F3A·19C2', long: 'AB'.repeat(32) },
            pairing: 'pending',
            safetyCodeChecked: false,
          } as never,
          expiresAt: NOW + 86_400 * 3 + 1_000_000_000,
        })
      : Promise.reject(new CoreError('invite_invalid', 'x'));

  it('openJoin goes to first run while no owner exists; the invite waits through it; then the join screen', async () => {
    const h = await harness({ waitingInvite: LINK, checkInvite: check });
    expect(await h.server.openJoin()).toBe(true);
    expect(new URL(h.opened.at(-1) ?? '').pathname).toBe('/first-run');
    const s = await h.session();
    // The join read answers with no agent open (only the display fields, never the link).
    const before = await h.get('/api/ui/join', s);
    expect(before.status).toBe(200);
    expect(JSON.parse(before.body)).toMatchObject({ state: 'waiting', inviteId: INVITE_ID });
    expect(before.body).not.toContain('Q'.repeat(20));
    const { finish } = await firstRun(h, s, 'My agent');
    expect(finish?.status).toBe(200);
    // After first run: an owner exists and the agent is open; the invite is still waiting.
    const after = await h.get('/api/ui/join', s);
    expect(JSON.parse(after.body)).toMatchObject({ state: 'waiting', inviteId: INVITE_ID });
    expect(await h.server.openJoin()).toBe(true);
    expect(new URL(h.opened.at(-1) ?? '').pathname).toBe('/settings/join');
    expect(JSON.stringify(h.events)).not.toContain('Q'.repeat(20));
  }, 60_000);

  it('"Not now" works with no agent open (the invite kind, nothing signed)', async () => {
    const h = await harness({ waitingInvite: LINK, checkInvite: check });
    const s = await h.session();
    const res = await h.post('/api/ui/join/dismiss', s, encodeUtf8('{}'));
    expect(res.status).toBe(200);
    expect(JSON.parse((await h.get('/api/ui/join', s)).body)).toEqual({ state: 'none' });
  });
});
