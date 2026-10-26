// M1-11s-c acceptance: the owner setup route, passkey-first owner creation on the first-run page
// (D-120 (1) and its follow-up; 04 §2.2, §2.3.1, §2.5, §2.8; 06 §7; 08 §1; I-1, I-4, I-7).
//
// - A third route kind, `presence: 'setup'`, handled by its own setupGate (never by ownerGate): only
//   POST, only under /api/ui/first-run/, one route per step, no page handler.
// - The gate checks loopback, exact Host and Origin, the session cookie, CSRF, fetch metadata, an
//   octet-stream body and the wrong-code backoff, then refuses `owner_exists` unless no owner exists
//   anywhere: no card names one, and none of the `owner`, `owner-passkey` or `owner-next` keychain
//   items exists (a partial earlier setup is never reused or overwritten, D-78).
// - Two steps, one passkey gesture: `begin` creates the owner seed and holds it in server memory for
//   at most SETUP_HOLD_MS, single-use and bound to the session; it returns only public WebAuthn
//   creation values (user.id = the owner's x-only Nostr key, 04 §2.3 step 2). `finish` checks the
//   creation response (clientData type, challenge and origin; rpIdHash, UP, UV, AT and the attested
//   credential ID) and the PRF output, then stores the owner under a new owner code (`ALKO`) and the
//   passkey (`ALKP`) and signs the agent's first card, all or nothing. The owner code is returned
//   once, for the page's collapsed "backup way to approve", and never logged.
// - The pending seed is wiped on expiry, on error, on completion and when the server closes.
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { stderr as processStderr, stdout as processStdout } from 'node:process';
import { join } from 'node:path';
import {
  AgentLinkClient,
  nostrTransport,
  type ApprovalChannel,
  type OwnerActionOutcome,
} from '@4thtech-io/core';
import {
  OWNER_SESSION_DEFAULT_TTL_MS,
  concatBytes,
  decodeBase64url,
  encodeBase64url,
  encodeHex0x,
  encodeUtf8,
  hkdfSha256,
  ownerPrfSalt,
  randomBytes,
  sha256,
  verifyAgentCard,
  type KeyStore,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import type { RelayConnector, RelaySocket, RelaySocketHandlers } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAgentStoreWith, type AgentStore } from '../agent-store.js';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerInternals,
  type ApprovalServerSource,
} from '../approval-server.js';
import { createKeychainAgent, openRecordedKeyStore } from '../keychain-keystore.js';
import type { KeychainBackend } from '../keychain.js';
import type { FirstAgentCard } from '../owner-init.js';
import {
  KeychainOwnerKeyStore,
  OWNER_ACCOUNT,
  OWNER_NEXT_ACCOUNT,
  OWNER_PASSKEY_ACCOUNT,
  newOwnerSeed,
} from '../owner-keystore.js';
import {
  SETUP_HOLD_MS,
  defaultOwnerFiles,
  encodeSetupRegistration,
  removeSetupFolders,
  type SetupFolders,
} from '../owner-setup.js';
import { LocalUiRouteRegistry, createLocalUiRoutes } from './routes.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const NOW = 1_800_000_000;
const ALPHA = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

/** An in-memory keychain with fault injection per account and operation. */
class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  failSet = new Set<string>();
  /** Accounts whose read-back returns other bytes after a set (another writer won the race). */
  swapAfterSet = new Set<string>();
  /** Accounts whose delete the keychain refuses. */
  failDelete = new Set<string>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    if (this.failSet.has(account)) throw new Error('keychain refused');
    this.items.set(
      account,
      this.swapAfterSet.has(account) ? randomBytes(value.length) : value.slice(),
    );
  }
  async delete(account: string): Promise<boolean> {
    await Promise.resolve();
    if (this.failDelete.has(account)) throw new Error('keychain refused');
    return this.items.delete(account);
  }
}

/** A relay connector that accepts every event (identity.init may publish). */
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

interface Agent {
  readonly keychain: MapKeychain;
  readonly agentId: string;
  readonly client: AgentLinkClient;
  readonly store: AgentStore;
  readonly keyStore: KeyStore;
}

let dir: string;
const agents: Agent[] = [];
const servers: ApprovalServer[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentlink-m1-11s-c-'));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const agent of agents.splice(0)) {
    await agent.keyStore.close();
    await agent.store.close();
  }
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** What `agentlink init` leaves: the agent identity in the keychain, a store, no card, no owner. */
async function initAgent(): Promise<Agent> {
  const keychain = new MapKeychain();
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith(
    'keychain',
    agentId,
    join(dir, `agent-${String(agents.length)}.sqlite`),
    {
      keychain,
    },
  );
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => NOW,
    transport: nostrTransport({ connector: quietRelays, addressCheck: 'platform' }),
    policyMark: store.policyMark,
  });
  const agent = { keychain, agentId, client, store, keyStore };
  agents.push(agent);
  return agent;
}

const firstCardOf = (agent: Agent, relays: readonly string[] = ALPHA): FirstAgentCard => ({
  agent: agent.agentId,
  name: 'Alice',
  relays,
  identity: agent.client.identity,
});

/** The approval server's source: the owner the stored card names, as the CLI derives it. */
const sourceOf = (agent: Agent): ApprovalServerSource => ({
  context: async () => {
    const view = await agent.client.identity.get();
    if (view === undefined) return undefined;
    return {
      agent: agent.agentId,
      owner: {
        ownerEvm: decodeHex0x(view.card.ownerEvm),
        ownerNostr: decodeHex0x(view.card.ownerNostr),
        ownerEnc: decodeHex0x(view.card.ownerEnc),
      },
    };
  },
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.resolve({ status: 'applied', op: 'contact.check' } as OwnerActionOutcome),
});

function decodeHex0x(hex: string): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

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

/** The file-KeyStore owner files of the test home (absent unless a test creates them). */
const testOwnerFiles = (): readonly string[] => defaultOwnerFiles(join(dir, 'home'));

interface Harness {
  readonly server: ApprovalServer;
  readonly port: number;
  readonly origin: string;
  readonly events: ApprovalServerEvent[];
  /** Every seed `begin` created, as handed out (the server must wipe it in place). */
  readonly seeds: Uint8Array[];
  clock: number;
  session(): Promise<Session>;
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

async function harness(
  agent: Agent,
  options: {
    setup?: false;
    firstCard?: FirstAgentCard;
    internals?: ApprovalServerInternals;
    ownerFiles?: readonly string[];
  } = {},
): Promise<Harness> {
  const opened: string[] = [];
  const events: ApprovalServerEvent[] = [];
  const seeds: Uint8Array[] = [];
  const state = { clock: 1_000_000 };
  const server = await startApprovalServerWith(
    {
      source: sourceOf(agent),
      onEvent: (event) => void events.push(event),
      localUi:
        options.setup === false
          ? {}
          : {
              ownerSetup: {
                firstCard: options.firstCard ?? firstCardOf(agent),
                // IR-M1-11s-c-1 L-6: a test home, never the real ~/.agentlink.
                ownerFiles: options.ownerFiles ?? testOwnerFiles(),
              },
            },
    },
    {
      keychain: agent.keychain,
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      now: () => state.clock,
      ownerKdf: KDF,
      newOwnerSeed: () => {
        const created = newOwnerSeed();
        seeds.push(created.seed);
        return created;
      },
      ...options.internals,
    },
  );
  servers.push(server);
  const h: Harness = {
    server,
    port: server.port,
    origin: server.origin,
    events,
    seeds,
    get clock() {
      return state.clock;
    },
    set clock(value: number) {
      state.clock = value;
    },
    async session() {
      const at = opened.length;
      await server.open();
      const token = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
      const res = await send(server.port, `/?t=${token}`);
      expect(res.status).toBe(303);
      const cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      const page = await send(server.port, '/', { headers: { Cookie: cookie } });
      const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
      return { cookie, csrf: csrf ?? '' };
    },
  };
  return h;
}

const BEGIN = '/api/ui/first-run/owner/begin';
const FINISH = '/api/ui/first-run/owner/finish';

function post(
  h: Harness,
  path: string,
  session: Session,
  body: Uint8Array | undefined,
  headers: Record<string, string | undefined> = {},
): Promise<Response> {
  const all: Record<string, string | undefined> = {
    Cookie: session.cookie,
    Origin: h.origin,
    'X-AgentLink-CSRF': session.csrf,
    'Content-Type': 'application/octet-stream',
    'Sec-Fetch-Site': 'same-origin',
    ...headers,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (v !== undefined) clean[k] = v;
  return send(h.port, path, {
    method: 'POST',
    headers: clean,
    ...(body === undefined ? {} : { body }),
  });
}

interface BeginBody {
  status: string;
  expiresInMs: number;
  fingerprint: string;
  publicKey: {
    rpId: string;
    rpName: string;
    userId: string;
    userName: string;
    challenge: string;
    prfSalt: string;
  };
}

async function begin(h: Harness, session: Session): Promise<BeginBody> {
  const res = await post(h, BEGIN, session, new Uint8Array(0));
  expect(res.status).toBe(200);
  return JSON.parse(res.body) as BeginBody;
}

/** A virtual platform authenticator: one navigator.credentials.create with prf.eval (one gesture). */
class Authenticator {
  readonly credentialId = randomBytes(16);
  readonly #prfSecret = randomBytes(32);
  constructor(
    readonly options: {
      prf?: boolean;
      rpId?: string;
      uv?: boolean;
      at?: boolean;
      attestedId?: Uint8Array;
    } = {},
  ) {}

  prf(salt: Uint8Array): Uint8Array {
    return hkdfSha256(this.#prfSecret, salt, encodeUtf8('virtual-authenticator-prf'), 32);
  }

  /** What the page sends to `finish` after the create ceremony. */
  create(
    options: BeginBody['publicKey'],
    clientData: { type?: string; challenge?: string; origin: string },
  ): Uint8Array {
    let flags = 0x01;
    if (this.options.uv ?? true) flags |= 0x04;
    if (this.options.at ?? true) flags |= 0x40;
    const attested = this.options.attestedId ?? this.credentialId;
    const authenticatorData = concatBytes(
      sha256(encodeUtf8(this.options.rpId ?? options.rpId)),
      new Uint8Array([flags]),
      new Uint8Array([0, 0, 0, 1]),
      new Uint8Array(16), // AAGUID ("none" attestation)
      new Uint8Array([attested.length >> 8, attested.length & 0xff]),
      attested,
      new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26]), // a COSE key prefix: not parsed
    );
    const clientDataJSON = encodeUtf8(
      JSON.stringify({
        type: clientData.type ?? 'webauthn.create',
        challenge: clientData.challenge ?? options.challenge,
        origin: clientData.origin,
        crossOrigin: false,
      }),
    );
    return encodeSetupRegistration({
      credentialId: this.credentialId,
      authenticatorData,
      clientDataJSON,
      prfOutput:
        this.options.prf === false ? new Uint8Array(0) : this.prf(decodeBase64url(options.prfSalt)),
    });
  }
}

const allZero = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

const ownerOf = (begun: BeginBody, agent: Agent): Promise<OwnerPublicKeys | undefined> =>
  sourceOf(agent)
    .context()
    .then((c) => {
      if (c !== undefined) expect(encodeBase64url(c.owner.ownerNostr)).toBe(begun.publicKey.userId);
      return c?.owner;
    });

const setupEvents = (h: Harness): string[] =>
  h.events.flatMap((e) => (e.kind === 'owner_setup' ? [e.outcome] : []));

describe('the setup route kind (M1-11s-c; registry rules)', () => {
  const ok = () => Promise.resolve({ status: 200, body: {} });

  it('registers begin and finish as setup routes in the default registry, beside the page stub', () => {
    const routes = createLocalUiRoutes().routes();
    const setup = routes.filter((r) => r.presence === 'setup');
    expect(setup.map((r) => [r.method, r.path, 'step' in r ? r.step : undefined])).toEqual([
      ['POST', BEGIN, 'begin'],
      ['POST', FINISH, 'finish'],
    ]);
    expect(createLocalUiRoutes().match('POST', BEGIN)).toMatchObject({ route: { step: 'begin' } });
  });

  it('accepts a setup route only as a POST under /api/ui/first-run/, once per step, without a handler', () => {
    const registry = new LocalUiRouteRegistry();
    const bad = [
      { method: 'GET', path: '/api/ui/first-run/x', presence: 'setup', step: 'begin' },
      { method: 'PUT', path: '/api/ui/first-run/x', presence: 'setup', step: 'begin' },
      { method: 'POST', path: '/api/ui/rules/x', presence: 'setup', step: 'begin' },
      { method: 'POST', path: '/api/ui/first-run', presence: 'setup', step: 'begin' },
      { method: 'POST', path: '/api/ui/first-run/x', presence: 'setup', step: 'other' },
      {
        method: 'POST',
        path: '/api/ui/first-run/x',
        presence: 'setup',
        step: 'begin',
        handler: ok,
      },
      { method: 'POST', path: '/api/ui/first-run/x', presence: 'maybe', handler: ok },
    ];
    for (const route of bad)
      expect(() => registry.register(route as never)).toThrow(/local UI route/);
    registry.register({
      method: 'POST',
      path: '/api/ui/first-run/a',
      presence: 'setup',
      step: 'begin',
    });
    expect(() =>
      registry.register({
        method: 'POST',
        path: '/api/ui/first-run/b',
        presence: 'setup',
        step: 'begin',
      }),
    ).toThrow(/local UI route/);
    expect(registry.routes()).toHaveLength(1);
  });
});

describe('owner setup on the first-run page (M1-11s-c; D-120 (1); 04 §2.2, §2.3.1, §2.5)', () => {
  it('creates the owner with one passkey gesture, a backup owner code shown once, and a verified first card', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const begun = await begin(h, s);
    expect(begun.status).toBe('ready');
    expect(begun.expiresInMs).toBe(SETUP_HOLD_MS);
    expect(SETUP_HOLD_MS).toBeLessThanOrEqual(120_000);
    expect(begun.publicKey.rpId).toBe('localhost');
    expect(decodeBase64url(begun.publicKey.prfSalt)).toEqual(ownerPrfSalt());
    expect(decodeBase64url(begun.publicKey.userId)).toHaveLength(32);
    expect(decodeBase64url(begun.publicKey.challenge)).toHaveLength(32);
    // Begin persists nothing: the seed lives in server memory only.
    expect([...agent.keychain.items.keys()].filter((a) => a.startsWith('owner'))).toEqual([]);
    expect(await agent.client.identity.get()).toBeUndefined();

    const authenticator = new Authenticator();
    const res = await post(
      h,
      FINISH,
      s,
      authenticator.create(begun.publicKey, { origin: h.origin }),
    );
    expect(res.status).toBe(200);
    const done = JSON.parse(res.body) as {
      status: string;
      passkey: boolean;
      ownerCode: string;
      fingerprint: string;
    };
    expect(done.status).toBe('done');
    expect(done.passkey).toBe(true);
    expect(done.fingerprint).toBe(begun.fingerprint);
    expect(done.ownerCode).toMatch(/^[A-Z2-9]{4}( [A-Z2-9]{4}){5}$/);

    // The first card verifies and names this agent and the owner whose key was user.id.
    const view = await agent.client.identity.get();
    if (view === undefined) throw new Error('no card after setup');
    expect(verifyAgentCard(view.card, view.cardSig, view.cardAgentSig)).toBe(true);
    expect(view.card.agentEvm).toBe(agent.agentId);
    expect(view.card.ownerNostr).toBe(encodeHex0x(decodeBase64url(begun.publicKey.userId)));
    const owner = await ownerOf(begun, agent);
    if (owner === undefined) throw new Error('no owner');

    // The owner code (ALKO) and the passkey (ALKP) each unlock that owner.
    const store = await KeychainOwnerKeyStore.open(agent.keychain, owner);
    const byCode = await store.unlock(
      { kind: 'passphrase', secret: encodeUtf8(done.ownerCode) },
      { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
    );
    await byCode.close();
    const byPasskey = await store.unlock(
      { kind: 'passkey-prf', prfOutput: authenticator.prf(ownerPrfSalt()) },
      { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
    );
    await byPasskey.close();
    await store.close();
    expect(agent.keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(true);

    // The pending seed was wiped on completion, and the hold is single-use.
    expect(h.seeds).toHaveLength(1);
    expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);
    const again = await post(
      h,
      FINISH,
      s,
      authenticator.create(begun.publicKey, { origin: h.origin }),
    );
    expect(again.status).toBe(409);
    expect(again.body).not.toContain(done.ownerCode);
    expect(setupEvents(h)).toEqual(['ready', 'done', 'not_pending']);
  }, 60_000);

  it('never logs the owner code: no event, console line or stream write carries it (canary)', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    // Spies only (IR-M1-11s-c-1 L-5): the canary reads what anything writes to the process's
    // streams (the same objects as process.stdout and process.stderr); it writes nothing itself.
    const stdout = vi.spyOn(processStdout, 'write');
    const stderr = vi.spyOn(processStderr, 'write');
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const begun = await begin(h, s);
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator().create(begun.publicKey, { origin: h.origin }),
    );
    const { ownerCode } = JSON.parse(res.body) as { ownerCode: string };
    const compact = ownerCode.replaceAll(' ', '');
    const written = [
      JSON.stringify(h.events),
      ...lines,
      ...stdout.mock.calls.map((c) => String(c[0])),
      ...stderr.mock.calls.map((c) => String(c[0])),
    ].join('\n');
    expect(compact).toHaveLength(24);
    expect(written).not.toContain(compact);
    expect(written).not.toContain(ownerCode);
    expect(written).not.toContain(compact.slice(0, 8));
  }, 60_000);

  it('stores only the owner code when the authenticator has no PRF, and still signs the card', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const begun = await begin(h, s);
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator({ prf: false }).create(begun.publicKey, { origin: h.origin }),
    );
    expect(res.status).toBe(200);
    const done = JSON.parse(res.body) as { passkey: boolean; ownerCode: string };
    expect(done.passkey).toBe(false);
    expect(agent.keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect(agent.keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(false);
    const view = await agent.client.identity.get();
    expect(view !== undefined && verifyAgentCard(view.card, view.cardSig, view.cardAgentSig)).toBe(
      true,
    );
  }, 60_000);
});

describe('setup is refused when any owner exists, including a partial one (D-78; 04 §2.8)', () => {
  const partials: [string, (agent: Agent) => Promise<void>][] = [
    ['an owner item', async (a) => a.keychain.set(OWNER_ACCOUNT, randomBytes(90))],
    [
      'only an owner-passkey item',
      async (a) => a.keychain.set(OWNER_PASSKEY_ACCOUNT, randomBytes(116)),
    ],
    [
      'only a staged owner-next item',
      async (a) => a.keychain.set(OWNER_NEXT_ACCOUNT, randomBytes(90)),
    ],
  ];
  for (const [what, plant] of partials) {
    it(`refuses begin with ${what}, before any seed is made`, async () => {
      const agent = await initAgent();
      await plant(agent);
      const before = new Map(agent.keychain.items);
      const h = await harness(agent);
      const s = await h.session();
      const res = await post(h, BEGIN, s, new Uint8Array(0));
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ status: 'owner_exists' });
      expect(h.seeds).toHaveLength(0);
      expect(agent.keychain.items).toEqual(before);
    });
  }

  it('refuses begin when the agent card already names an owner', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const begun = await begin(h, s);
    await post(h, FINISH, s, new Authenticator().create(begun.publicKey, { origin: h.origin }));
    // Another keychain view without the owner items (another device's keychain), same card.
    for (const account of [OWNER_ACCOUNT, OWNER_PASSKEY_ACCOUNT])
      agent.keychain.items.delete(account);
    const res = await post(h, BEGIN, s, new Uint8Array(0));
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'owner_exists' });
    expect(h.seeds).toHaveLength(1);
  }, 60_000);

  it('refuses finish when an owner item appeared after begin, wipes the hold and keeps that item', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const begun = await begin(h, s);
    const planted = randomBytes(90);
    await agent.keychain.set(OWNER_PASSKEY_ACCOUNT, planted);
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator().create(begun.publicKey, { origin: h.origin }),
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'owner_exists' });
    expect(agent.keychain.items.get(OWNER_PASSKEY_ACCOUNT)).toEqual(planted);
    expect(agent.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);
    expect(await agent.client.identity.get()).toBeUndefined();
  });

  it('answers 503 unavailable when the caller did not wire owner setup', async () => {
    const agent = await initAgent();
    const h = await harness(agent, { setup: false });
    const s = await h.session();
    const res = await post(h, BEGIN, s, new Uint8Array(0));
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'unavailable' });
  });
});

describe('the setup gate: session, CSRF, Origin, Host, fetch metadata and body (08 §1)', () => {
  it('refuses begin and finish without the session, CSRF, Origin or the octet-stream type', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    for (const path of [BEGIN, FINISH]) {
      const cases: [Record<string, string | undefined>, number][] = [
        [{ Cookie: undefined }, 401],
        [{ Cookie: 'agentlink_1=forged' }, 401],
        [{ 'X-AgentLink-CSRF': undefined }, 403],
        [{ 'X-AgentLink-CSRF': 'A'.repeat(43) }, 403],
        [{ Origin: undefined }, 403],
        [{ Origin: 'http://127.0.0.1:1' }, 403],
        [{ 'Sec-Fetch-Site': 'cross-site' }, 403],
        [{ 'Sec-Fetch-Site': 'same-site' }, 403],
        [{ 'Content-Type': 'text/plain' }, 415],
        [{ Host: `127.0.0.1:${String(h.port)}` }, 403],
      ];
      for (const [headers, status] of cases) {
        expect((await post(h, path, s, new Uint8Array(0), headers)).status).toBe(status);
      }
      expect((await send(h.port, path, { headers: { Cookie: s.cookie } })).status).toBe(405);
    }
    expect(h.seeds).toHaveLength(0);
    expect(setupEvents(h)).toEqual([]);
  });

  it('refuses a begin with a body (nothing secret or chosen goes in)', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const res = await post(h, BEGIN, s, encodeUtf8('hello'));
    expect(res.status).toBe(400);
    expect(h.seeds).toHaveLength(0);
  });
});

describe('the pending seed: short-lived, single-use, bound to the session (M1-11s-c)', () => {
  it('expires after SETUP_HOLD_MS: finish is refused and the seed was wiped', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const begun = await begin(h, s);
    expect(allZero(h.seeds[0] as Uint8Array)).toBe(false);
    h.clock += SETUP_HOLD_MS + 1;
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator().create(begun.publicKey, { origin: h.origin }),
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'expired' });
    expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);
    expect(agent.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    // After expiry a new begin works, with a new seed.
    const again = await begin(h, s);
    expect(again.publicKey.userId).not.toBe(begun.publicKey.userId);
  });

  it('wipes a held seed when a later request finds it expired, and when the server closes', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    await begin(h, s);
    h.clock += SETUP_HOLD_MS + 1;
    await send(h.port, '/api/ui/first-run', {
      headers: { Cookie: s.cookie, 'X-AgentLink-CSRF': s.csrf },
    });
    expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);

    const other = await harness(await initAgent());
    await begin(other, await other.session());
    expect(allZero(other.seeds[0] as Uint8Array)).toBe(false);
    await other.server.close();
    expect(allZero(other.seeds[0] as Uint8Array)).toBe(true);
  });

  it('refuses a second begin while one setup is in progress, from any session (fail closed)', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const a = await h.session();
    const b = await h.session();
    await begin(h, a);
    for (const s of [b, a]) {
      const res = await post(h, BEGIN, s, new Uint8Array(0));
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ status: 'busy' });
    }
    expect(h.seeds).toHaveLength(1);
  });

  it('is bound to the session that began it: another session cannot finish it', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const a = await h.session();
    const b = await h.session();
    const begun = await begin(h, a);
    const body = new Authenticator().create(begun.publicKey, { origin: h.origin });
    const res = await post(h, FINISH, b, body);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'not_pending' });
    expect(agent.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    // The rightful session still finishes.
    expect((await post(h, FINISH, a, body)).status).toBe(200);
  }, 60_000);

  it('refuses finish with no begin', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator().create(
        {
          rpId: 'localhost',
          rpName: '',
          userId: '',
          userName: '',
          challenge: 'x',
          prfSalt: encodeBase64url(ownerPrfSalt()),
        },
        { origin: h.origin },
      ),
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'not_pending' });
  });
});

describe('finish checks the passkey creation before anything is stored (04 §2.3.1)', () => {
  const bad: [string, (b: BeginBody, origin: string) => Uint8Array][] = [
    [
      'another challenge',
      (b, origin) =>
        new Authenticator().create(b.publicKey, {
          origin,
          challenge: encodeBase64url(randomBytes(32)),
        }),
    ],
    [
      'another origin',
      (b) => new Authenticator().create(b.publicKey, { origin: 'http://localhost:1' }),
    ],
    [
      'a get, not a create',
      (b, origin) => new Authenticator().create(b.publicKey, { origin, type: 'webauthn.get' }),
    ],
    [
      'another RP ID',
      (b, origin) => new Authenticator({ rpId: 'evil.example' }).create(b.publicKey, { origin }),
    ],
    [
      'no user verification',
      (b, origin) => new Authenticator({ uv: false }).create(b.publicKey, { origin }),
    ],
    [
      'no attested credential',
      (b, origin) => new Authenticator({ at: false }).create(b.publicKey, { origin }),
    ],
    [
      'another attested credential ID',
      (b, origin) =>
        new Authenticator({ attestedId: randomBytes(16) }).create(b.publicKey, { origin }),
    ],
    ['a malformed body', () => encodeUtf8('not a registration')],
  ];
  for (const [what, make] of bad) {
    it(`refuses ${what}: 403, nothing stored, the hold wiped and gone`, async () => {
      const agent = await initAgent();
      const h = await harness(agent);
      const s = await h.session();
      const begun = await begin(h, s);
      const res = await post(h, FINISH, s, make(begun, h.origin));
      expect(res.status).toBe(403);
      expect([...agent.keychain.items.keys()].filter((k) => k.startsWith('owner'))).toEqual([]);
      expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);
      expect(await agent.client.identity.get()).toBeUndefined();
      // Single-use: even the right response is refused now.
      const retry = await post(
        h,
        FINISH,
        s,
        new Authenticator().create(begun.publicKey, { origin: h.origin }),
      );
      expect(retry.status).toBe(409);
    });
  }
});

describe('finish is all or nothing: a failure at any step leaves no owner (rollback)', () => {
  async function failingFinish(
    agent: Agent,
    prepare: (agent: Agent) => void,
    firstCard?: FirstAgentCard,
  ): Promise<{ res: Response; h: Harness }> {
    const h = await harness(agent, firstCard === undefined ? {} : { firstCard });
    const s = await h.session();
    const begun = await begin(h, s);
    prepare(agent);
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator().create(begun.publicKey, { origin: h.origin }),
    );
    return { res, h };
  }

  const nothingLeft = async (agent: Agent, h: Harness): Promise<void> => {
    expect([...agent.keychain.items.keys()].filter((k) => k.startsWith('owner'))).toEqual([]);
    expect(await agent.client.identity.get()).toBeUndefined();
    expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);
  };

  it('the owner item cannot be written', async () => {
    const agent = await initAgent();
    const { res, h } = await failingFinish(agent, (a) => a.keychain.failSet.add(OWNER_ACCOUNT));
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ status: 'failed', reason: 'rolled_back' });
    await nothingLeft(agent, h);
  });

  it('the owner item reads back as another writer’s: that item is kept, nothing of ours stays', async () => {
    const agent = await initAgent();
    const { res, h } = await failingFinish(agent, (a) =>
      a.keychain.swapAfterSet.add(OWNER_ACCOUNT),
    );
    expect(res.status).toBe(500);
    // The bytes there are not this run's: never deleted (IR-M1-8h-1 L2).
    expect(agent.keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect(agent.keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(false);
    expect(await agent.client.identity.get()).toBeUndefined();
    expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);
  });

  it('the passkey item cannot be written: the owner item is removed again', async () => {
    const agent = await initAgent();
    const { res, h } = await failingFinish(agent, (a) =>
      a.keychain.failSet.add(OWNER_PASSKEY_ACCOUNT),
    );
    expect(res.status).toBe(500);
    await nothingLeft(agent, h);
  }, 60_000);

  it('the passkey item reads back wrong: the owner item is removed, the other bytes kept', async () => {
    const agent = await initAgent();
    const { res, h } = await failingFinish(agent, (a) =>
      a.keychain.swapAfterSet.add(OWNER_PASSKEY_ACCOUNT),
    );
    expect(res.status).toBe(500);
    expect(agent.keychain.items.has(OWNER_ACCOUNT)).toBe(false);
    expect(await agent.client.identity.get()).toBeUndefined();
    expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);
  }, 60_000);

  it('the first card cannot be signed: both items are removed and a new setup works', async () => {
    const agent = await initAgent();
    // Two identical relays: core refuses the card after both items were stored.
    const { res, h } = await failingFinish(
      agent,
      () => undefined,
      firstCardOf(agent, ['wss://one.relay-alpha.net', 'wss://one.relay-alpha.net']),
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ status: 'failed', reason: 'rolled_back' });
    expect(res.body).not.toMatch(/[A-Z2-9]{4} [A-Z2-9]{4}/);
    await nothingLeft(agent, h);
    expect(setupEvents(h)).toEqual(['ready', 'failed']);
    expect(h.events.at(-1)).toEqual({
      kind: 'owner_setup',
      outcome: 'failed',
      reason: 'rolled_back',
    });
  }, 60_000);

  it('a card for another agent is refused by the one-card session and rolled back', async () => {
    const agent = await initAgent();
    const other = await initAgent();
    const crossed: FirstAgentCard = { ...firstCardOf(agent), identity: other.client.identity };
    const { res, h } = await failingFinish(agent, () => undefined, crossed);
    expect(res.status).toBe(500);
    await nothingLeft(agent, h);
    expect(await other.client.identity.get()).toBeUndefined();
  }, 60_000);

  it('a rollback the keychain refuses is reason keychain (items may remain)', async () => {
    const agent = await initAgent();
    const { res } = await failingFinish(
      agent,
      (a) => a.keychain.failDelete.add(OWNER_ACCOUNT),
      firstCardOf(agent, ['wss://one.relay-alpha.net', 'wss://one.relay-alpha.net']),
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ status: 'failed', reason: 'keychain' });
  }, 60_000);
});

describe('IR-M1-11s-c-1 M-1: card read-back unknown keeps the owner and still hands out its code', () => {
  /** The agent's identity service, whose read-back fails once the card was issued. */
  function flakyReadBack(agent: Agent): FirstAgentCard {
    let issued = false;
    return {
      ...firstCardOf(agent),
      identity: {
        get: () => (issued ? Promise.reject(new Error('store busy')) : agent.client.identity.get()),
        init: async (input) => {
          const view = await agent.client.identity.init(input);
          issued = true;
          return view;
        },
      },
    };
  }

  for (const prf of [true, false]) {
    it(`returns done_unconfirmed with the owner code, which unlocks the kept owner (PRF ${String(prf)})`, async () => {
      const agent = await initAgent();
      const h = await harness(agent, { firstCard: flakyReadBack(agent) });
      const s = await h.session();
      const begun = await begin(h, s);
      const res = await post(
        h,
        FINISH,
        s,
        new Authenticator({ prf }).create(begun.publicKey, { origin: h.origin }),
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as {
        status: string;
        ownerCode: string;
        passkey: boolean;
        fingerprint: string;
      };
      expect(body.status).toBe('done_unconfirmed');
      expect(body.passkey).toBe(prf);
      expect(body.fingerprint).toBe(begun.fingerprint);
      expect(body.ownerCode).toMatch(/^[A-Z2-9]{4}( [A-Z2-9]{4}){5}$/);
      // The owner was kept, and the human is not locked out: the code unlocks it.
      expect(agent.keychain.items.has(OWNER_ACCOUNT)).toBe(true);
      const owner = await ownerOf(begun, agent);
      if (owner === undefined) throw new Error('no card');
      const store = await KeychainOwnerKeyStore.open(agent.keychain, owner);
      const session = await store.unlock(
        { kind: 'passphrase', secret: encodeUtf8(body.ownerCode) },
        { ttlMs: OWNER_SESSION_DEFAULT_TTL_MS },
      );
      await session.close();
      await store.close();
      expect(h.events.at(-1)).toEqual({
        kind: 'owner_setup',
        outcome: 'done_unconfirmed',
        fingerprint: begun.fingerprint,
      });
      expect(JSON.stringify(h.events)).not.toContain(body.ownerCode);
      expect(allZero(h.seeds[0] as Uint8Array)).toBe(true);
    }, 60_000);
  }
});

describe('IR-M1-11s-c-1 L-2: the done event names the owner fingerprint (for the CLI line)', () => {
  it('emits done with the public fingerprint shown at begin', async () => {
    const agent = await initAgent();
    const h = await harness(agent);
    const s = await h.session();
    const begun = await begin(h, s);
    await post(h, FINISH, s, new Authenticator().create(begun.publicKey, { origin: h.origin }));
    expect(h.events.filter((e) => e.kind === 'owner_setup')).toEqual([
      { kind: 'owner_setup', outcome: 'ready' },
      { kind: 'owner_setup', outcome: 'done', fingerprint: begun.fingerprint },
    ]);
  }, 60_000);
});

describe('IR-M1-11s-c-1 L-6: a file-KeyStore owner refuses setup too (D-78)', () => {
  for (const name of ['owner.alko', 'owner.alkp']) {
    it(`refuses begin when ~/.agentlink/keystore/${name} exists, before any seed`, async () => {
      const agent = await initAgent();
      const files = testOwnerFiles();
      const target = files.find((f) => f.endsWith(name)) ?? '';
      await mkdir(join(dir, 'home', '.agentlink', 'keystore'), { recursive: true });
      await writeFile(target, randomBytes(90));
      const h = await harness(agent, { ownerFiles: files });
      const res = await post(h, BEGIN, await h.session(), new Uint8Array(0));
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toEqual({ status: 'owner_exists' });
      expect(h.seeds).toHaveLength(0);
    });
  }

  it('defaults to the owner files under the home folder', () => {
    // Built with node:path `join` so the expectation uses the platform separator (Windows CI).
    expect(defaultOwnerFiles('/home/u')).toEqual([
      join('/home/u', '.agentlink', 'keystore', 'owner.alko'),
      join('/home/u', '.agentlink', 'keystore', 'owner.alkp'),
    ]);
  });
});

describe('IR-M1-11s-c-1 M-2: the wrong-code backoff holds setup back first (429 before owner_exists)', () => {
  it('answers 429 wait with Retry-After after failed presence, creates no seed', async () => {
    const agent = await initAgent();
    const routes = createLocalUiRoutes();
    routes.register({
      method: 'POST',
      path: '/api/ui/test/check',
      presence: true,
      handler: () => Promise.resolve({ status: 200, body: {} }),
    });
    const h = await harness(agent, { internals: { routes } });
    const s = await h.session();
    // An owner exists (set up here), so setup alone would answer owner_exists.
    const begun = await begin(h, s);
    expect(
      (await post(h, FINISH, s, new Authenticator().create(begun.publicKey, { origin: h.origin })))
        .status,
    ).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      const wrong = await post(h, '/api/ui/test/check', s, encodeUtf8('WRONGCODEWRONGCODEWRONGC'));
      expect(wrong.status).toBe(403);
    }
    const res = await post(h, BEGIN, s, new Uint8Array(0));
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const body = JSON.parse(res.body) as { status: string; retryAfter: number };
    expect(body.status).toBe('wait');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(h.events.at(-1)).toEqual({ kind: 'owner_setup', outcome: 'wait' });
    expect(h.seeds).toHaveLength(1);
    // Finish is held back the same way.
    expect((await post(h, FINISH, s, new Uint8Array(0))).status).toBe(429);
  }, 60_000);
});

// M1-UX-FIRSTRUN-V2 acceptance (D-130 (1), (2); 08 §1 first run v2; 04 §2.5 one owner flow; 06 §3;
// I-1, I-4, I-7): the one passkey gesture of the first run also signs the agent's first policy, the
// 06 §3 defaults with the real `~/AgentLink/Send` allowed. `begin` prepares the folders (Send, Inbox,
// Proofs, 0700) before the gesture and refuses a Send folder that is a link (at either level), not a
// folder, or not empty, before any seed exists. A failure after the card leaves no policy and removes
// the folders this run created. The backup code reaches only the finish answer.
describe('M1-UX-FIRSTRUN-V2: one gesture sets up the owner, the card and the first policy', () => {
  const home = (): string => join(dir, 'home');
  const sendPath = (): string => join(home(), 'AgentLink', 'Send');

  async function withHome(): Promise<string> {
    await mkdir(home(), { recursive: true });
    return realpath(home());
  }

  const withPolicy = (agent: Agent): FirstAgentCard => ({
    ...firstCardOf(agent),
    firstPolicy: { actions: agent.client.ownerActions, home: home() },
  });

  interface DoneBody {
    status: string;
    passkey: boolean;
    ownerCode: string;
    fingerprint: string;
    sendFolder?: string;
    computerName?: string;
  }

  async function runSetup(
    agent: Agent,
    options: {
      firstCard?: FirstAgentCard;
      prf?: boolean;
      internals?: ApprovalServerInternals;
    } = {},
  ): Promise<{ h: Harness; s: Session; begun: BeginBody; res: Response; done: DoneBody }> {
    const h = await harness(agent, {
      firstCard: options.firstCard ?? withPolicy(agent),
      ...(options.internals === undefined ? {} : { internals: options.internals }),
    });
    const s = await h.session();
    const begun = await begin(h, s);
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator({ prf: options.prf ?? true }).create(begun.publicKey, { origin: h.origin }),
    );
    return { h, s, begun, res, done: JSON.parse(res.body) as DoneBody };
  }

  it('one confirmation: a verified card, a signed first policy with Send allowed, and the folders', async () => {
    const real = await withHome();
    const agent = await initAgent();
    const { h, res, done, begun } = await runSetup(agent);
    expect(res.status).toBe(200);
    expect(done.status).toBe('done');
    expect(done.passkey).toBe(true);
    expect(done.sendFolder).toBe('allowed');

    const view = await agent.client.identity.get();
    expect(view !== undefined && verifyAgentCard(view.card, view.cardSig, view.cardAgentSig)).toBe(
      true,
    );
    const effective = await agent.client.ownerActions.loadPolicy();
    expect(effective.mode).toBe('signed');
    if (effective.mode !== 'signed') return;
    expect(effective.version).toBe(1);
    const folder = join(real, 'AgentLink', 'Send');
    expect(effective.policy.files.allowedFolders).toEqual([folder]);

    // Send, Inbox and Proofs: real folders, 0700, Send empty.
    for (const name of ['Send', 'Inbox', 'Proofs']) {
      const stats = await lstat(join(real, 'AgentLink', name));
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      if (process.platform !== 'win32') expect(stats.mode & 0o777).toBe(0o700);
    }
    expect(await readdir(folder)).toEqual([]);
    // The done event carries fixed values only (never the code or the path).
    expect(h.events.filter((e) => e.kind === 'owner_setup').at(-1)).toEqual({
      kind: 'owner_setup',
      outcome: 'done',
      fingerprint: begun.fingerprint,
      sendFolder: 'allowed',
    });
    expect(JSON.stringify(h.events)).not.toContain(folder);
  }, 60_000);

  it('without PRF the backup code is the way to approve, and the first policy is still signed', async () => {
    await withHome();
    const agent = await initAgent();
    const { done } = await runSetup(agent, { prf: false });
    expect(done.status).toBe('done');
    expect(done.passkey).toBe(false);
    expect(done.sendFolder).toBe('allowed');
    expect(agent.keychain.items.has(OWNER_ACCOUNT)).toBe(true);
    expect(agent.keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(false);
    expect((await agent.client.ownerActions.loadPolicy()).mode).toBe('signed');
  }, 60_000);

  it('names the computer for the password manager entry, plain and short, never anything else', async () => {
    await withHome();
    const agent = await initAgent();
    const { done } = await runSetup(agent, {
      internals: { hostname: () => 'Talis-MacBook-Pro.local' },
    });
    expect(done.computerName).toBe('Talis-MacBook-Pro');
    const other = await initAgent();
    await rm(join(home(), 'AgentLink'), { recursive: true, force: true });
    const second = await runSetup(other, {
      internals: { hostname: () => 'bad\u0007name‮' },
    });
    expect(second.done.computerName).toBe('this computer');
  }, 60_000);

  const refusedFolders: [string, () => Promise<void>, readonly string[] | undefined][] = [
    [
      'Send is a link',
      async () => {
        await mkdir(join(dir, 'elsewhere'), { recursive: true });
        await mkdir(join(home(), 'AgentLink'), { recursive: true });
        await symlink(join(dir, 'elsewhere'), sendPath());
      },
      [],
    ],
    [
      'AgentLink is a link',
      async () => {
        await mkdir(join(dir, 'elsewhere', 'Send'), { recursive: true });
        await symlink(join(dir, 'elsewhere'), join(home(), 'AgentLink'));
      },
      ['Send'],
    ],
    [
      'Send is a file',
      async () => {
        await mkdir(join(home(), 'AgentLink'), { recursive: true });
        await writeFile(sendPath(), 'x');
      },
      undefined,
    ],
  ];
  for (const [what, plant, elsewhere] of refusedFolders) {
    it(`refuses begin before the gesture when ${what}: no seed, nothing stored`, async () => {
      await withHome();
      await plant();
      const agent = await initAgent();
      const h = await harness(agent, { firstCard: withPolicy(agent) });
      const s = await h.session();
      const res = await post(h, BEGIN, s, new Uint8Array(0));
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toEqual({
        status: 'folder_refused',
        reason: 'folder_unavailable',
      });
      expect(h.seeds).toHaveLength(0);
      expect([...agent.keychain.items.keys()].filter((k) => k.startsWith('owner'))).toEqual([]);
      expect(await agent.client.identity.get()).toBeUndefined();
      // Nothing was created through the link.
      if (elsewhere !== undefined) expect(await readdir(join(dir, 'elsewhere'))).toEqual(elsewhere);
    });
  }

  it('refuses begin when Send already holds files, and touches none of them', async () => {
    await withHome();
    await mkdir(sendPath(), { recursive: true });
    await writeFile(join(sendPath(), 'tax-return.pdf'), 'private');
    const agent = await initAgent();
    const h = await harness(agent, { firstCard: withPolicy(agent) });
    const res = await post(h, BEGIN, await h.session(), new Uint8Array(0));
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ status: 'folder_refused', reason: 'folder_not_empty' });
    expect(h.seeds).toHaveLength(0);
    expect(await readdir(sendPath())).toEqual(['tax-return.pdf']);
    expect((await agent.client.ownerActions.loadPolicy()).mode).toBe('defaults');
  });

  it('a policy refused after the card leaves no policy and removes the folders it created', async () => {
    await withHome();
    const agent = await initAgent();
    const firstCard: FirstAgentCard = {
      ...firstCardOf(agent),
      firstPolicy: {
        actions: {
          preparePolicyEdit: (patch, opts) =>
            agent.client.ownerActions.preparePolicyEdit(patch, opts),
          apply: () => Promise.resolve({ status: 'refused', reason: 'bad_signature' } as never),
        },
        home: home(),
      },
    };
    const { res, done } = await runSetup(agent, { firstCard });
    expect(res.status).toBe(200);
    expect(done.status).toBe('done');
    expect(done.sendFolder).toBe('not_allowed');
    // The card is kept (its owner too); no policy; nothing half-written on disk.
    expect(await agent.client.identity.get()).toBeDefined();
    expect((await agent.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    await expect(lstat(join(home(), 'AgentLink'))).rejects.toThrow();
  }, 60_000);

  it('a card that is not signed rolls everything back, folders included', async () => {
    await withHome();
    const agent = await initAgent();
    const firstCard: FirstAgentCard = {
      ...withPolicy(agent),
      relays: ['wss://one.relay-alpha.net', 'wss://one.relay-alpha.net'],
    };
    const { res } = await runSetup(agent, { firstCard });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ status: 'failed', reason: 'rolled_back' });
    expect([...agent.keychain.items.keys()].filter((k) => k.startsWith('owner'))).toEqual([]);
    expect((await agent.client.ownerActions.loadPolicy()).mode).toBe('defaults');
    await expect(lstat(join(home(), 'AgentLink'))).rejects.toThrow();
  }, 60_000);

  it('an expired hold removes the folders begin created', async () => {
    await withHome();
    const agent = await initAgent();
    const h = await harness(agent, { firstCard: withPolicy(agent) });
    const s = await h.session();
    const begun = await begin(h, s);
    expect((await lstat(sendPath())).isDirectory()).toBe(true);
    h.clock += SETUP_HOLD_MS + 1;
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator().create(begun.publicKey, { origin: h.origin }),
    );
    expect(JSON.parse(res.body)).toEqual({ status: 'expired' });
    await vi.waitFor(async () => {
      await expect(lstat(join(home(), 'AgentLink'))).rejects.toThrow();
    });
  });

  it('agent side: without the browser session nothing begins and no folder is made', async () => {
    await withHome();
    const agent = await initAgent();
    const h = await harness(agent, { firstCard: withPolicy(agent) });
    const s = await h.session();
    // A same-user process without the session cookie, or without the page's CSRF token.
    for (const headers of [{ Cookie: undefined }, { 'X-AgentLink-CSRF': undefined }]) {
      const res = await post(h, BEGIN, s, new Uint8Array(0), headers);
      expect([401, 403]).toContain(res.status);
    }
    expect(h.seeds).toHaveLength(0);
    await expect(lstat(join(home(), 'AgentLink'))).rejects.toThrow();
  });

  it('agent side: a replayed finish signs nothing more and never shows the code again', async () => {
    await withHome();
    const agent = await initAgent();
    const h = await harness(agent, { firstCard: withPolicy(agent) });
    const s = await h.session();
    const begun = await begin(h, s);
    const body = new Authenticator().create(begun.publicKey, { origin: h.origin });
    const first = await post(h, FINISH, s, body.slice());
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const { ownerCode, sendFolder } = JSON.parse(first.body) as DoneBody;
    expect(sendFolder).toBe('allowed');
    const compact = ownerCode.replaceAll(' ', '');

    const replay = await post(h, FINISH, s, body);
    expect(replay.status).toBe(409);
    const again = await post(h, BEGIN, s, new Uint8Array(0));
    expect(JSON.parse(again.body)).toEqual({ status: 'owner_exists' });
    const status = await send(h.port, '/api/ui/first-run', {
      headers: { Cookie: s.cookie, 'X-AgentLink-CSRF': s.csrf },
    });
    const effective = await agent.client.ownerActions.loadPolicy();
    expect(effective.mode === 'signed' ? effective.version : 0).toBe(1);
    // Backup-code canary: after the one display answer, no answer or event carries it.
    for (const later of [replay.body, again.body, status.body, JSON.stringify(h.events)]) {
      expect(later).not.toContain(compact);
      expect(later).not.toContain(ownerCode);
      expect(later).not.toContain(compact.slice(0, 8));
    }
  }, 60_000);

  // M1-UX-FIRSTRUN-V2-b L-1 (IR-M1-UX-FIRSTRUN-V2-1): a dropped setup's folder removal finishes
  // before a new begin prepares the folders, so the new setup never loses its Send folder.
  it('L-1: a begin straight after a dropped setup keeps Send, and finish allows it', async () => {
    const real = await withHome();
    const agent = await initAgent();
    let removed = false;
    const slowRemoval = async (folders: SetupFolders | undefined): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await removeSetupFolders(folders);
      removed = true;
    };
    const h = await harness(agent, {
      firstCard: withPolicy(agent),
      internals: { removeSetupFolders: slowRemoval },
    });
    const s = await h.session();
    await begin(h, s);
    h.clock += SETUP_HOLD_MS + 1;
    // This begin sweeps the expired hold; it waits for that hold's folders to be gone first.
    const begun = await begin(h, s);
    expect(removed).toBe(true);
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator().create(begun.publicKey, { origin: h.origin }),
    );
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as DoneBody).sendFolder).toBe('allowed');
    const effective = await agent.client.ownerActions.loadPolicy();
    expect(effective.mode === 'signed' ? effective.policy.files.allowedFolders : []).toEqual([
      join(real, 'AgentLink', 'Send'),
    ]);
    expect((await lstat(join(real, 'AgentLink', 'Send'))).isDirectory()).toBe(true);
  }, 60_000);

  // L-1, across processes: a terminal `owner init` (another process) may adopt the Send folder this
  // hold created. Once any owner exists, a failed or dropped setup leaves the folders alone.
  it('L-1: an owner set up elsewhere during the hold keeps the folders when finish fails', async () => {
    await withHome();
    const agent = await initAgent();
    const h = await harness(agent, { firstCard: withPolicy(agent) });
    const s = await h.session();
    const begun = await begin(h, s);
    await agent.keychain.set(OWNER_ACCOUNT, randomBytes(90));
    const res = await post(
      h,
      FINISH,
      s,
      new Authenticator().create(begun.publicKey, { origin: h.origin }),
    );
    expect(JSON.parse(res.body)).toEqual({ status: 'owner_exists' });
    expect((await lstat(sendPath())).isDirectory()).toBe(true);
  }, 60_000);

  it('L-1: an owner set up elsewhere during the hold keeps the folders when the hold expires', async () => {
    await withHome();
    const agent = await initAgent();
    const h = await harness(agent, { firstCard: withPolicy(agent) });
    const s = await h.session();
    await begin(h, s);
    await agent.keychain.set(OWNER_ACCOUNT, randomBytes(90));
    h.clock += SETUP_HOLD_MS + 1;
    const again = await post(h, BEGIN, s, new Uint8Array(0));
    expect(JSON.parse(again.body)).toEqual({ status: 'owner_exists' });
    expect((await lstat(sendPath())).isDirectory()).toBe(true);
  }, 60_000);

  // M1-UX-FIRSTRUN-V2-b L-2 and the post-sign re-check (IR-M1-36b-2-d-1): the Send folder begin
  // checked is pinned (real path, device, inode); a same-user swap for another empty folder at the
  // same path before the first policy applies leaves no policy.
  it('L-2: Send replaced between begin and the first policy applies nothing', async () => {
    await withHome();
    const agent = await initAgent();
    const applied: object[] = [];
    const firstCard: FirstAgentCard = {
      ...firstCardOf(agent),
      firstPolicy: {
        actions: {
          preparePolicyEdit: async (patch, opts) => {
            await rename(sendPath(), `${sendPath()}-moved`);
            await mkdir(sendPath(), { mode: 0o700 });
            return agent.client.ownerActions.preparePolicyEdit(patch, opts);
          },
          apply: (input) => {
            applied.push(input);
            return agent.client.ownerActions.apply(input);
          },
        },
        home: home(),
      },
    };
    const { res, done } = await runSetup(agent, { firstCard });
    expect(res.status).toBe(200);
    expect(done.status).toBe('done');
    expect(done.sendFolder).toBe('not_allowed');
    expect(applied).toEqual([]);
    expect((await agent.client.ownerActions.loadPolicy()).mode).toBe('defaults');
  }, 60_000);

  it('L-2: Inbox and Proofs are made only beside the Send folder that was checked', async () => {
    const real = await withHome();
    const agent = await initAgent();
    const h = await harness(agent, { firstCard: withPolicy(agent) });
    await begin(h, await h.session());
    for (const name of ['Send', 'Inbox', 'Proofs']) {
      const stats = await lstat(join(real, 'AgentLink', name));
      expect(stats.isDirectory() && !stats.isSymbolicLink()).toBe(true);
      expect(await realpath(join(real, 'AgentLink', name))).toBe(join(real, 'AgentLink', name));
    }
  });
});
