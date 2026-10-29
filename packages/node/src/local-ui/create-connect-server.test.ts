// W4-ONE-TOUCH acceptance (S2; D-140; 04 §2.3.1, §2.5 "One entry", §2.5.1 `app.connect`, §2.8
// "Create an agent and connect its AI app with one gesture"; 06 §7; 08 §1; 11 §5.8; I-4, I-7).
// Contract tests against the real approval server as the app host, with real keychain items, real
// agent stores and core, and a virtual WebAuthn authenticator with a real credential key and PRF
// (VirtualPrfAuthenticator): nothing is signed by the test, every owner signature is the server's.
//
// - First run: begin `{label, app}` makes the owner seed and the first agent's seed in memory and
//   plans the app's change for the new agentId; ONE passkey create signs the card, the policy, the
//   label and the app.connect; the entry is written last. Finish takes only `{nonce}`.
// - New agent: begin `{label, app}` (no presence) then `POST /api/ui/agents` `{nonce}` with ONE
//   passkey get (or the backup code) creates the agent and connects the app.
// - A plan cannot be replayed (single use), split (finish takes no subset) or extended (finish
//   takes nothing but the nonce; the restricted session is unit-tested in owner-add-agent-plan).
// - Timeout (120 s), a changed file (refused before anything is signed), a wrong proof (the plan is
//   kept; the third ends it) and a failed entry write (the agent is kept: created_not_connected).
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLinkClient, nostrTransport, type ApprovalChannel } from '@4thtech-io/core';
import { AGENTS_OWNER } from '@4thtech-io/types/ui-contract/agents';
import {
  decodeBase64url,
  encodeBase64url,
  encodeUtf8,
  type JsonObject,
  type KeyStore,
} from '@4thtech-io/crypto';
import { newWebauthnTestCredential } from '@4thtech-io/crypto/testing';
import type { RelayConnector, RelaySocket, RelaySocketHandlers } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openAgentStoreWith, type AgentStore } from '../agent-store.js';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerSource,
} from '../approval-server.js';
import { createKeychainAgent, openRecordedKeyStore } from '../keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from '../keychain.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { OWNER_ACCOUNT } from '../owner-keystore.js';
import { defaultOwnerFiles, encodeSetupRegistration } from '../owner-setup.js';
import { encodePayConfirmAssertion } from '../pay-confirm.js';
import { VirtualPrfAuthenticator } from '../passkey-authenticator.fixture.js';
import type { AgentDirectory, AgentDirectoryEntry, AppHostAgent } from './app-host.js';
import type { LocalUiAiAppPlan, LocalUiAiApps } from './context.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const NOW = 1_800_000_000;
const ALPHA = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];
const BEGIN = '/api/ui/first-run/owner/begin';
const FINISH = '/api/ui/first-run/owner/finish';
const AGENT_BEGIN = '/api/ui/agents/begin';
const AGENT_FINISH = '/api/ui/agents';

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
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

const input = (value: unknown): string => encodeBase64url(encodeUtf8(JSON.stringify(value)));
const json = (res: Response): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;

interface PublicKeyCreate {
  rpId: string;
  userId: string;
  challenge: string;
  prfSalt: string;
}

/** navigator.credentials.create through the virtual authenticator, as the page sends it. */
function createResponse(
  auth: VirtualPrfAuthenticator,
  pk: PublicKeyCreate,
  origin: string,
  challenge = pk.challenge,
): Uint8Array {
  const made = auth.create(decodeBase64url(pk.userId), decodeBase64url(pk.prfSalt));
  const clientDataJSON = encodeUtf8(
    JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }),
  );
  return encodeSetupRegistration({
    credentialId: made.credentialId,
    authenticatorData: made.authenticatorData,
    clientDataJSON,
    prfOutput: made.prfOutput,
  });
}

interface PublicKeyGet {
  rpId: string;
  challenge: string;
  allowCredentials: string[];
  prfSalt: string;
}

/** navigator.credentials.get with the begin's challenge, signed by the authenticator's own key. */
function getResponse(
  auth: VirtualPrfAuthenticator,
  pk: PublicKeyGet,
  origin: string,
  challenge = pk.challenge,
): Uint8Array {
  const got = auth.get(decodeBase64url(pk.prfSalt));
  const clientDataJSON = encodeUtf8(
    JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
  );
  return encodePayConfirmAssertion({
    credentialId: got.credentialId,
    authenticatorData: got.authenticatorData,
    clientDataJSON,
    signature: auth.sign(got.authenticatorData, clientDataJSON),
    userHandle: got.userHandle,
    prfOutput: got.prfOutput,
  });
}

/** A one-app AI apps desk over an in-memory config file (the CLI desk's contract, 06 §7). */
class FakeDesk implements LocalUiAiApps {
  entry: { agent: string } | null = null;
  identity = 1;
  desktopRunning = false;
  failWrite = false;
  writes = 0;
  constructor(readonly agentIdOf: (name: string) => Promise<string | undefined>) {}
  list() {
    return Promise.resolve({ apps: [], desktopRunning: false });
  }
  plan(app: string, agent: string): Promise<LocalUiAiAppPlan> {
    if (app !== 'claude-code') return Promise.resolve({ status: 'not_found', app, name: '' });
    if (this.desktopRunning) {
      return Promise.resolve({ status: 'quit_first', app, name: 'Claude Code' });
    }
    const entryOf = (name: string): JsonObject => ({
      command: 'npx',
      args: [
        '-y',
        '@4thtech-io/agentlink',
        'mcp',
        ...(name === 'default' ? [] : ['--agent', name]),
      ],
    });
    const before = this.entry;
    const identity = String(this.identity);
    const kind = before === null ? 'connect' : before.agent === agent ? 'disconnect' : 'move';
    return Promise.resolve({
      status: 'change',
      kind,
      app,
      name: 'Claude Code',
      path: '~/.claude.json',
      file: '/home/test/.claude.json',
      oldEntry: before === null ? null : entryOf(before.agent),
      newEntry: kind === 'disconnect' ? null : entryOf(agent),
      oldAgent: before?.agent ?? null,
      newAgent: kind === 'disconnect' ? null : agent,
      identity,
      commit: async (agentId: string) => {
        if (String(this.identity) !== identity) return 'changed';
        if (this.failWrite) return 'failed';
        if ((await this.agentIdOf(agent)) !== agentId) return 'agent_mismatch';
        this.entry = { agent };
        this.identity += 1;
        this.writes += 1;
        return 'written';
      },
    });
  }
}

let dir: string;
const servers: ApprovalServer[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-w4-one-touch-'));
  await mkdir(join(dir, 'home'), { recursive: true });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

interface World {
  readonly keychain: MapKeychain;
  readonly entries: Map<string, AgentDirectoryEntry>;
  readonly ids: Map<string, string>;
  readonly clients: Map<string, AgentLinkClient>;
  readonly directory: AgentDirectory;
  readonly desk: FakeDesk;
  /** Keys the directory made itself (never when the server passes its held keys). */
  readonly ownKeys: string[];
  open(name: string): Promise<AppHostAgent | undefined>;
}

function world(): World {
  const keychain = new MapKeychain();
  const entries = new Map<string, AgentDirectoryEntry>();
  const ids = new Map<string, string>();
  const clients = new Map<string, AgentLinkClient>();
  const ownKeys: string[] = [];
  const desk = new FakeDesk((name) => Promise.resolve(ids.get(name)));
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: () => Promise.resolve({ contacts: 0, running: false }),
    writeLabel: (name, label) => {
      const entry = entries.get(name);
      if (entry !== undefined) entries.set(name, { ...entry, label });
      return Promise.resolve();
    },
    create: async (_label, options) => {
      const name = options?.name ?? 'slug';
      if (entries.has(name)) throw new Error('agent_exists');
      let agentId: string;
      if (options?.createKeys !== undefined) agentId = await options.createKeys();
      else {
        agentId = await createKeychainAgent(keychain);
        ownKeys.push(agentId);
      }
      ids.set(name, agentId);
      entries.set(name, { name, label: name, available: true, removing: false });
      return name;
    },
    nameFor: (label, reserved) => {
      const base =
        label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'agent';
      let name = base;
      for (let n = 2; entries.has(name) || reserved.includes(name); n += 1) name = `${base}-${n}`;
      return Promise.resolve(name);
    },
    discardNew: (name) => {
      entries.delete(name);
      ids.delete(name);
      return Promise.resolve();
    },
    markRemoving: () => Promise.reject(new Error('never')),
    removeFolder: () => Promise.reject(new Error('never')),
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
  };
  const open = async (name: string): Promise<AppHostAgent | undefined> => {
    const agentId = ids.get(name);
    const entry = entries.get(name);
    if (agentId === undefined || entry === undefined) return undefined;
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
      await keyStore.close();
      await store.close();
    };
    cleanups.push(close);
    const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));
    const source: ApprovalServerSource = {
      context: async () => {
        const view = await client.identity.get();
        if (view === undefined) return undefined;
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
      apply: (signed) => client.ownerActions.apply(signed),
    };
    return {
      name,
      label: entry.label,
      source,
      localUi: { client, aiApps: desk },
      firstCard: {
        agent: agentId,
        name,
        relays: ALPHA,
        identity: client.identity,
        firstPolicy: { actions: client.ownerActions, home: join(dir, 'home') },
      },
      close,
    };
  };
  return { keychain, entries, ids, clients, directory, desk, ownKeys, open };
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
  generation: string;
}

interface Harness {
  readonly server: ApprovalServer;
  readonly origin: string;
  readonly w: World;
  clock: number;
  session(): Promise<Session>;
  post(
    path: string,
    s: Session,
    body?: Uint8Array,
    extra?: Record<string, string>,
  ): Promise<Response>;
}

async function harness(): Promise<Harness> {
  const w = world();
  const opened: string[] = [];
  const h = { clock: NOW * 1000 } as { clock: number };
  const server = await startApprovalServerWith(
    {
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
        firstRun: {
          home: join(dir, 'home'),
          ownerFiles: defaultOwnerFiles(join(dir, 'home')),
          aiApps: w.desk,
        },
      },
    },
    {
      keychain: w.keychain,
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      ownerKdf: KDF,
      now: () => h.clock,
    },
  );
  servers.push(server);
  const base = (s: Session): Record<string, string> => ({
    Cookie: s.cookie,
    'X-AgentLink-CSRF': s.csrf,
    'Sec-Fetch-Site': 'same-origin',
  });
  return Object.assign(h, {
    server,
    origin: server.origin,
    w,
    async session(): Promise<Session> {
      const at = opened.length;
      await server.openFirstRun();
      const link = new URL(opened[at] ?? '');
      const res = await send(server.port, `${link.pathname}${link.search}`);
      const cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      const page = await send(server.port, '/first-run', { headers: { Cookie: cookie } });
      const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
      const generation = /<meta name="agentlink-generation" content="([0-9]+)">/.exec(
        page.body,
      )?.[1];
      return { cookie, csrf: csrf ?? '', generation: generation ?? '' };
    },
    async post(
      path: string,
      s: Session,
      body = new Uint8Array(0),
      extra: Record<string, string> = {},
    ) {
      const res = await send(server.port, path, {
        method: 'POST',
        headers: {
          ...base(s),
          Origin: server.origin,
          'Content-Type': 'application/octet-stream',
          'X-AgentLink-Generation': s.generation,
          ...extra,
        },
        body,
      });
      // The page adopts the generation the server stamps (generation.ts).
      const g = res.headers['x-agentlink-generation'];
      if (typeof g === 'string') s.generation = g;
      return res;
    },
  });
}

interface Begun {
  status: string;
  nonce: string;
  statement: {
    label: string;
    agentFingerprint: string;
    ownerFingerprint: string;
    folder: string;
    app?: { app: string; name: string; kind: string; newEntry: JsonObject | null };
  };
  publicKey: PublicKeyCreate & PublicKeyGet;
}

async function firstRunBegin(h: Harness, s: Session, value: unknown): Promise<Response> {
  return h.post(BEGIN, s, new Uint8Array(0), { 'X-AgentLink-Input': input(value) });
}

async function firstRunFinish(h: Harness, s: Session, nonce: string, body: Uint8Array) {
  return h.post(FINISH, s, body, { 'X-AgentLink-Input': input({ nonce }) });
}

/** A whole first run with one gesture; the owner code and the authenticator for later steps. */
async function setUp(
  h: Harness,
  s: Session,
  value: unknown = { label: 'Home base', app: 'claude-code' },
): Promise<{ auth: VirtualPrfAuthenticator; finish: Response; begun: Begun }> {
  const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
  const begin = await firstRunBegin(h, s, value);
  expect(begin.status).toBe(200);
  const begun = json(begin) as unknown as Begun;
  const finish = await firstRunFinish(
    h,
    s,
    begun.nonce,
    createResponse(auth, begun.publicKey, h.origin),
  );
  return { auth, finish, begun };
}

/**
 * The agent's store as it is now: the `app:claude-code` record core keeps for an applied
 * app.connect (07 §3.4) and the number of used owner-action nonces.
 */
async function storeState(h: Harness, name: string): Promise<{ app: boolean; nonces: number }> {
  const agentId = h.w.ids.get(name) as string;
  const st = await openAgentStoreWith('keychain', agentId, join(dir, `${name}.sqlite`), {
    keychain: h.w.keychain,
  });
  try {
    return await st.store.transaction((tx) => ({
      app: tx.get('local_owner_actions', { record: 'app:claude-code' }) !== undefined,
      nonces: tx.count('owner_action_nonces'),
    }));
  } finally {
    await st.close();
  }
}

describe('W4-ONE-TOUCH first run: one passkey create creates the owner, the agent and connects the app', () => {
  it('begin {label, app} answers the statement, a nonce and a plan-bound challenge; one gesture does it all', async () => {
    const h = await harness();
    const s = await h.session();
    const { auth, finish, begun } = await setUp(h, s);
    expect(begun.statement).toMatchObject({
      label: 'Home base',
      folder: 'default',
      app: { app: 'claude-code', name: 'Claude Code', kind: 'connect' },
    });
    expect(begun.statement.app?.newEntry).toEqual({
      command: 'npx',
      args: ['-y', '@4thtech-io/agentlink', 'mcp'],
    });
    expect(begun.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(finish.status).toBe(200);
    const done = json(finish);
    expect(done).toMatchObject({ status: 'done', app: 'claude-code', label: 'saved' });
    expect(typeof done['ownerCode']).toBe('string');
    // Exactly one gesture: the passkey create.
    expect(auth.gestures).toBe(1);
    // The agent exists with the keys held since begin (the directory made none itself).
    expect(h.w.entries.get('default')).toMatchObject({ label: 'Home base' });
    expect(h.w.ownKeys).toEqual([]);
    // The entry runs the new agent's folder, written once, after everything else.
    expect(h.w.desk.entry).toEqual({ agent: 'default' });
    expect(h.w.desk.writes).toBe(1);
    // The label and the card name are the plan's.
    const client = h.w.clients.get('default') as AgentLinkClient;
    expect(await client.ownerActions.loadLabel()).toEqual({
      status: 'verified',
      label: 'Home base',
    });
    // Policy, label and app.connect: three signed objects, each with its own used nonce.
    expect(await storeState(h, 'default')).toEqual({ app: true, nonces: 3 });
  });

  it('finish takes only {nonce}: a label, an app or anything else beside it is refused', async () => {
    const h = await harness();
    const s = await h.session();
    const begun = json(
      await firstRunBegin(h, s, { label: 'A', app: 'claude-code' }),
    ) as unknown as Begun;
    for (const extra of [
      { nonce: begun.nonce, label: 'A' },
      { nonce: begun.nonce, app: 'codex' },
      { label: 'A' },
      {},
    ]) {
      const res = await h.post(FINISH, s, new Uint8Array(0), { 'X-AgentLink-Input': input(extra) });
      expect(res.status).toBe(400);
      expect(json(res)['status']).toBe('invalid');
    }
    // Nothing was consumed: the right finish still works.
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const ok = await firstRunFinish(
      h,
      s,
      begun.nonce,
      createResponse(auth, begun.publicKey, h.origin),
    );
    expect(json(ok)['status']).toBe('done');
  });

  it('a replayed finish is refused (single use) and writes nothing more', async () => {
    const h = await harness();
    const s = await h.session();
    const { auth, begun } = await setUp(h, s);
    const again = await firstRunFinish(
      h,
      s,
      begun.nonce,
      createResponse(auth, begun.publicKey, h.origin),
    );
    // The first agent is open now and has an owner: setup is refused (503 unavailable, or 409).
    expect([409, 503]).toContain(again.status);
    expect(h.w.desk.writes).toBe(1);
  });

  it('a response for another challenge is rejected and keeps the plan; the third ends it', async () => {
    const h = await harness();
    const s = await h.session();
    const begun = json(
      await firstRunBegin(h, s, { label: 'A', app: 'claude-code' }),
    ) as unknown as Begun;
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const wrong = encodeBase64url(new Uint8Array(32).fill(7));
    const first = await firstRunFinish(
      h,
      s,
      begun.nonce,
      createResponse(auth, begun.publicKey, h.origin, wrong),
    );
    expect(first.status).toBe(403);
    expect(json(first)['status']).toBe('presence_rejected');
    // The plan is kept: the right answer with the same nonce still works.
    const ok = await firstRunFinish(
      h,
      s,
      begun.nonce,
      createResponse(auth, begun.publicKey, h.origin),
    );
    expect(json(ok)['status']).toBe('done');
  });

  it('three rejected answers end the plan: nothing is created', async () => {
    const h = await harness();
    const s = await h.session();
    const begun = json(
      await firstRunBegin(h, s, { label: 'A', app: 'claude-code' }),
    ) as unknown as Begun;
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const wrong = encodeBase64url(new Uint8Array(32).fill(7));
    const answers: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await firstRunFinish(
        h,
        s,
        begun.nonce,
        createResponse(auth, begun.publicKey, h.origin, wrong),
      );
      answers.push(String(json(res)['status']));
      // The wrong-code backoff of every presence route applies; skip its wait.
      h.clock += 120_000 / 4;
    }
    expect(answers).toEqual(['presence_rejected', 'presence_rejected', 'tries_exhausted']);
    expect(h.w.entries.size).toBe(0);
    expect(h.w.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
  });

  it('times out after 120 s: expired, nothing created, the folder name released', async () => {
    const h = await harness();
    const s = await h.session();
    const begun = json(
      await firstRunBegin(h, s, { label: 'A', app: 'claude-code' }),
    ) as unknown as Begun;
    h.clock += 121_000;
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const res = await firstRunFinish(
      h,
      s,
      begun.nonce,
      createResponse(auth, begun.publicKey, h.origin),
    );
    expect(res.status).toBe(409);
    expect(json(res)['status']).toBe('expired');
    expect(h.w.entries.size).toBe(0);
    expect(h.w.desk.writes).toBe(0);
  });

  it('a file changed between begin and finish is refused before anything is signed', async () => {
    const h = await harness();
    const s = await h.session();
    const begun = json(
      await firstRunBegin(h, s, { label: 'A', app: 'claude-code' }),
    ) as unknown as Begun;
    h.w.desk.identity += 1;
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const res = await firstRunFinish(
      h,
      s,
      begun.nonce,
      createResponse(auth, begun.publicKey, h.origin),
    );
    expect(res.status).toBe(409);
    expect(json(res)['status']).toBe('changed');
    expect(h.w.entries.size).toBe(0);
    expect(h.w.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
  });

  it('a failed entry write keeps the owner and the agent: created_not_connected, with the owner code', async () => {
    const h = await harness();
    const s = await h.session();
    h.w.desk.failWrite = true;
    const { finish, begun } = await setUp(h, s);
    expect(finish.status).toBe(200);
    const body = json(finish);
    expect(body).toMatchObject({ status: 'created_not_connected', app: 'claude-code' });
    expect(typeof body['ownerCode']).toBe('string');
    expect(h.w.entries.has('default')).toBe(true);
    expect(h.w.desk.entry).toBeNull();
    expect(begun.statement.folder).toBe('default');
    // The stored app.connect is recorded as not applied: no `app:` record is left, while its nonce
    // (with the label's and the policy's) stays used, so it can never be applied later.
    expect(await storeState(h, 'default')).toEqual({ app: false, nonces: 3 });
  });

  it('Claude Desktop running refuses begin (quit_first) before any seed exists', async () => {
    const h = await harness();
    const s = await h.session();
    h.w.desk.desktopRunning = true;
    const res = await firstRunBegin(h, s, { label: 'A', app: 'claude-code' });
    expect(res.status).toBe(409);
    expect(json(res)['status']).toBe('quit_first');
  });

  it('a new begin from the same page replaces the held plan; another page is refused', async () => {
    const h = await harness();
    const s = await h.session();
    const one = json(
      await firstRunBegin(h, s, { label: 'A', app: 'claude-code' }),
    ) as unknown as Begun;
    const two = json(
      await firstRunBegin(h, s, { label: 'B', app: 'claude-code' }),
    ) as unknown as Begun;
    expect(two.nonce).not.toBe(one.nonce);
    const other = await h.session();
    const busy = await firstRunBegin(h, other, { label: 'C' });
    expect(busy.status).toBe(409);
    expect(json(busy)['status']).toBe('busy');
    // The replaced plan's nonce no longer finishes.
    const auth = new VirtualPrfAuthenticator({ credential: newWebauthnTestCredential() });
    const stale = await firstRunFinish(
      h,
      s,
      one.nonce,
      createResponse(auth, one.publicKey, h.origin),
    );
    expect(stale.status).toBe(409);
    const ok = await firstRunFinish(h, s, two.nonce, createResponse(auth, two.publicKey, h.origin));
    expect(json(ok)['status']).toBe('done');
    expect(h.w.entries.get('default')?.label).toBe('B');
  });

  it('without an app ("Not now") one gesture creates the owner and the agent, and writes no entry', async () => {
    const h = await harness();
    const s = await h.session();
    const { finish } = await setUp(h, s, { label: 'Solo' });
    expect(json(finish)['status']).toBe('done');
    expect(json(finish)['app']).toBeUndefined();
    expect(h.w.desk.writes).toBe(0);
  });
});

describe('W4-ONE-TOUCH New agent: one gesture creates the agent and connects its AI app', () => {
  async function owned(): Promise<{
    h: Harness;
    s: Session;
    auth: VirtualPrfAuthenticator;
    code: string;
  }> {
    const h = await harness();
    const s = await h.session();
    const { auth, finish } = await setUp(h, s, { label: 'Home base' });
    expect(json(finish)['status']).toBe('done');
    const code = String(json(finish)['ownerCode']).replace(/[^A-Za-z0-9]/g, '');
    return { h, s, auth, code };
  }

  const agentBegin = (h: Harness, s: Session, value: unknown) =>
    h.post(AGENT_BEGIN, s, new Uint8Array(0), { 'X-AgentLink-Input': input(value) });
  const agentFinish = (h: Harness, s: Session, nonce: string, body: Uint8Array, passkey: boolean) =>
    h.post(AGENT_FINISH, s, body, {
      'X-AgentLink-Input': input({ nonce }),
      ...(passkey ? { 'X-AgentLink-Presence': 'passkey' } : {}),
    });

  it('begin then ONE passkey get creates the agent and moves Claude Code to it', async () => {
    const { h, s, auth } = await owned();
    h.w.desk.entry = { agent: 'default' };
    const before = auth.gestures;
    const begin = await agentBegin(h, s, { label: 'Work', app: 'claude-code' });
    expect(begin.status).toBe(200);
    const begun = json(begin) as unknown as Begun;
    expect(begun.statement).toMatchObject({ label: 'Work', folder: 'work', app: { kind: 'move' } });
    expect(begun.publicKey.allowCredentials).toHaveLength(1);
    const res = await agentFinish(
      h,
      s,
      begun.nonce,
      getResponse(auth, begun.publicKey, h.origin),
      true,
    );
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      status: 'done',
      name: 'work',
      label: 'Work',
      app: 'claude-code',
    });
    expect(auth.gestures - before).toBe(1);
    expect(h.w.desk.entry).toEqual({ agent: 'work' });
    expect(h.w.entries.get('work')).toMatchObject({ label: 'Work' });
    expect(h.w.ownKeys).toEqual([]);
  });

  it('contract: the real answers have exactly the shape of the shared samples (ui-contract/agents)', async () => {
    const { h, s, auth } = await owned();
    const sample = AGENTS_OWNER.add;
    const begin = await agentBegin(h, s, sample.input);
    const body = json(begin);
    const keys = (v: unknown): string[] => Object.keys(v as object).sort();
    expect(begin.status).toBe(sample.begin.status);
    expect(keys(body)).toEqual(keys(sample.begin.body));
    expect(keys(body['statement'])).toEqual(keys(sample.begin.body.statement));
    expect(keys((body['statement'] as { app: unknown }).app)).toEqual(
      keys(sample.begin.body.statement.app),
    );
    expect(keys(body['publicKey'])).toEqual(keys(sample.begin.body.publicKey));
    const begun = body as unknown as Begun;
    const done = await agentFinish(
      h,
      s,
      begun.nonce,
      getResponse(auth, begun.publicKey, h.origin),
      true,
    );
    expect({ status: done.status, body: json(done) }).toEqual(sample.answer);
  });

  it('the backup code works too; a wrong code keeps the plan', async () => {
    const { h, s, code } = await owned();
    const begun = json(
      await agentBegin(h, s, { label: 'Work', app: 'claude-code' }),
    ) as unknown as Begun;
    const wrong = await agentFinish(
      h,
      s,
      begun.nonce,
      encodeUtf8('WRONGWRONGWRONGWRONGWRON'),
      false,
    );
    expect(wrong.status).toBe(403);
    expect(json(wrong)['status']).toBe('presence_rejected');
    h.clock += 30_000;
    const ok = await agentFinish(h, s, begun.nonce, encodeUtf8(code), false);
    expect(json(ok)).toMatchObject({ status: 'done', name: 'work' });
    expect(h.w.desk.entry).toEqual({ agent: 'work' });
  });

  it('a get for another challenge is rejected; a replayed finish is refused', async () => {
    const { h, s, auth } = await owned();
    const begun = json(
      await agentBegin(h, s, { label: 'Work', app: 'claude-code' }),
    ) as unknown as Begun;
    const other = encodeBase64url(new Uint8Array(32).fill(9));
    const bad = await agentFinish(
      h,
      s,
      begun.nonce,
      getResponse(auth, begun.publicKey, h.origin, other),
      true,
    );
    expect(json(bad)['status']).toBe('presence_rejected');
    const body = getResponse(auth, begun.publicKey, h.origin);
    const ok = await agentFinish(h, s, begun.nonce, body.slice(), true);
    expect(json(ok)['status']).toBe('done');
    const replay = await agentFinish(h, s, begun.nonce, body, true);
    expect(replay.status).toBe(409);
    expect(json(replay)['status']).toBe('not_pending');
  });

  it('finish takes only {nonce}; begin from another page is refused while a plan is held', async () => {
    const { h, s, auth } = await owned();
    const begun = json(
      await agentBegin(h, s, { label: 'Work', app: 'claude-code' }),
    ) as unknown as Begun;
    const extended = await h.post(AGENT_FINISH, s, getResponse(auth, begun.publicKey, h.origin), {
      'X-AgentLink-Input': input({ nonce: begun.nonce, label: 'Other' }),
      'X-AgentLink-Presence': 'passkey',
    });
    expect(extended.status).toBe(400);
    const other = await h.session();
    const busy = await agentBegin(h, other, { label: 'Elsewhere' });
    expect(json(busy)['status']).toBe('busy');
  });

  it('a failed entry write keeps the agent and answers created_not_connected', async () => {
    const { h, s, auth } = await owned();
    h.w.desk.failWrite = true;
    const begun = json(
      await agentBegin(h, s, { label: 'Work', app: 'claude-code' }),
    ) as unknown as Begun;
    const res = await agentFinish(
      h,
      s,
      begun.nonce,
      getResponse(auth, begun.publicKey, h.origin),
      true,
    );
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({
      status: 'created_not_connected',
      name: 'work',
      app: 'claude-code',
    });
    expect(h.w.entries.has('work')).toBe(true);
    expect(h.w.desk.entry).toBeNull();
    // The agent's keys are in the keychain (it is complete and usable).
    const agentId = h.w.ids.get('work') as string;
    expect(h.w.keychain.items.has(keychainAccount(agentId, 'seed'))).toBe(true);
  });

  it('times out after 120 s and a changed file is refused before signing', async () => {
    const { h, s, auth } = await owned();
    const one = json(
      await agentBegin(h, s, { label: 'Work', app: 'claude-code' }),
    ) as unknown as Begun;
    h.clock += 121_000;
    const late = await agentFinish(
      h,
      s,
      one.nonce,
      getResponse(auth, one.publicKey, h.origin),
      true,
    );
    expect(json(late)['status']).toBe('expired');
    const two = json(
      await agentBegin(h, s, { label: 'Work', app: 'claude-code' }),
    ) as unknown as Begun;
    h.w.desk.identity += 1;
    const changed = await agentFinish(
      h,
      s,
      two.nonce,
      getResponse(auth, two.publicKey, h.origin),
      true,
    );
    expect(json(changed)['status']).toBe('changed');
    expect(h.w.entries.has('work')).toBe(false);
  });
});
