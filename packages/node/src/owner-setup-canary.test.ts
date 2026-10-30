// M1-11s-c-b (IR-M1-11s-c-2 L-8): the owner setup canary covers the seed and the PRF output, not only
// the owner code (04 §2.2, §2.3.1; I-1, I-7).
//
// Decision (L-8): the canary seed is not a real seed. A real owner seed is 32 bytes from the CSPRNG
// (newOwnerSeed); the canary seed is the 32 printable ASCII bytes of CANARY_SEED_TEXT, built here
// and handed to setup through the approval server's `newOwnerSeed` test seam. It is never CSPRNG
// output, so no real owner's seed is ever handled by this test, and it is recognisable in every form
// a leak could take: raw text, hex, `0x` hex, base64, base64url and a decimal byte list. The PRF
// output is a canary of the same kind (CANARY_PRF_TEXT).
//
// What is checked: through the whole route (begin, finish, success and each failure), no event,
// console line, stdout/stderr write, HTTP response (body and headers) or thrown error carries the
// seed or the PRF output in any of those forms, and no event, console line or stream write carries
// the owner code. And completeOwnerSetup refuses a seed that does not derive the owner keys it was
// given, before any keychain write.
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stderr as processStderr, stdout as processStdout } from 'node:process';
import { AgentLinkClient, nostrTransport, type ApprovalChannel } from '@4thtech-io/core';
import {
  KEY_LABELS,
  MASTER_SEED_LENGTH,
  concatBytes,
  decodeBase64url,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  sha256,
  type KeyStore,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { derivePublicKey } from '@4thtech-io/crypto/keystore';
import type { RelayConnector, RelaySocket, RelaySocketHandlers } from '@4thtech-io/transport-nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAgentStoreWith, type AgentStore } from './agent-store.js';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
} from './approval-server.js';
import { NodeKeyStoreError } from './errors.js';
import { createKeychainAgent, openRecordedKeyStore } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import type { FirstAgentCard } from './owner-init.js';
import { OWNER_ACCOUNT, OWNER_PASSKEY_ACCOUNT, newOwnerSeed } from './owner-keystore.js';
import { completeOwnerSetup, defaultOwnerFiles, encodeSetupRegistration } from './owner-setup.js';
import { TEST_APP } from './local-ui-app.fixture.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const NOW = 1_800_000_000;
const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];

/** 32 printable ASCII bytes: never CSPRNG output, so never a real owner's seed (L-8). */
const CANARY_SEED_TEXT = 'AGENTLINK-CANARY-NOT-A-REAL-SEED';
/** 32 printable ASCII bytes standing in for the authenticator's PRF output. */
const CANARY_PRF_TEXT = 'AGENTLINK-CANARY-NOT-A-PRF-VALUE';

const canarySeed = (): Uint8Array => encodeUtf8(CANARY_SEED_TEXT);
const canaryPrf = (): Uint8Array => encodeUtf8(CANARY_PRF_TEXT);

/** The owner public keys of a seed at epoch 0 (04 §2.1), as newOwnerSeed computes them. */
function keysOf(seed: Uint8Array): OwnerPublicKeys {
  const evm = derivePublicKey(seed, KEY_LABELS.evm, 0);
  const nostr = derivePublicKey(seed, KEY_LABELS.nostr, 0);
  const enc = derivePublicKey(seed, KEY_LABELS.enc, 0);
  if (
    evm.label !== KEY_LABELS.evm ||
    nostr.label !== KEY_LABELS.nostr ||
    enc.label !== KEY_LABELS.enc
  ) {
    throw new Error('unreachable');
  }
  return { ownerEvm: evm.address, ownerNostr: nostr.publicKey, ownerEnc: enc.publicKey };
}

/** Every form a leaked byte string could take in text. */
function forms(bytes: Uint8Array): string[] {
  const hex = encodeHex(bytes);
  return [
    new TextDecoder().decode(bytes),
    hex,
    hex.toUpperCase(),
    `0x${hex}`,
    Buffer.from(bytes).toString('base64'),
    encodeBase64url(bytes),
    Array.from(bytes).join(','),
    // M1-11s-c-e: a typed array that reaches an event or a log line unconverted.
    // JSON.stringify(Uint8Array) writes an index object: {"0":65,"1":71,…}.
    JSON.stringify(bytes),
    JSON.stringify(bytes.subarray(0, 8)).slice(0, -1),
    // util.inspect (console.log, %o) writes `65, 71, …` with spaces, wrapped every few numbers.
    Array.from(bytes).join(', '),
    Array.from(bytes.subarray(0, 8)).join(', '),
    // A prefix catches a truncated or wrapped value.
    hex.slice(0, 16),
    new TextDecoder().decode(bytes.subarray(0, 12)),
  ];
}

function expectNoCanary(text: string): void {
  for (const form of [...forms(canarySeed()), ...forms(canaryPrf())]) {
    expect(text).not.toContain(form);
  }
}

/** An in-memory keychain with fault injection per account. */
class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  readonly sets: string[] = [];
  failSet = new Set<string>();
  async get(account: string): Promise<Uint8Array | null> {
    await Promise.resolve();
    return this.items.get(account)?.slice() ?? null;
  }
  async set(account: string, value: Uint8Array): Promise<void> {
    await Promise.resolve();
    this.sets.push(account);
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
  dir = await mkdtemp(join(tmpdir(), 'agentlink-m1-11s-c-b-'));
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

async function initAgent(): Promise<Agent> {
  const keychain = new MapKeychain();
  const agentId = await createKeychainAgent(keychain);
  const store = await openAgentStoreWith(
    'keychain',
    agentId,
    join(dir, `agent-${String(agents.length)}.sqlite`),
    { keychain },
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

const firstCardOf = (agent: Agent): FirstAgentCard => ({
  agent: agent.agentId,
  name: 'Alice',
  relays: RELAYS,
  identity: agent.client.identity,
});

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

/** Everything the process could write while setup runs: console methods and the two streams. */
function captureOutput(): () => string {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
  }
  // Spies only: they read what anything writes to the process's streams and write nothing.
  const stdout = vi.spyOn(processStdout, 'write');
  const stderr = vi.spyOn(processStderr, 'write');
  return () =>
    [
      ...lines,
      ...stdout.mock.calls.map((c) => String(c[0])),
      ...stderr.mock.calls.map((c) => String(c[0])),
    ].join('\n');
}

interface CanaryRun {
  readonly events: ApprovalServerEvent[];
  readonly responses: Response[];
  /** The seed as setup held it (the server wipes it in place). */
  readonly held: Uint8Array[];
  readonly finish: Response;
}

const BEGIN = '/api/ui/first-run/owner/begin';
const FINISH = '/api/ui/first-run/owner/finish';

/** One full setup through the route with the canary seed and PRF output. */
async function canarySetup(agent: Agent): Promise<CanaryRun> {
  const opened: string[] = [];
  const events: ApprovalServerEvent[] = [];
  const responses: Response[] = [];
  const held: Uint8Array[] = [];
  const server = await startApprovalServerWith(
    {
      source: {
        context: () => Promise.resolve(undefined),
        list: () => Promise.resolve([]),
        get: () => Promise.resolve(undefined),
        apply: () => Promise.reject(new Error('not used')),
      },
      onEvent: (event) => void events.push(event),
      // M1-11b-2c: the page (and its CSRF token) is the app's; a minimal bundle stands in.
      localUi: {
        assets: TEST_APP,
        ownerSetup: {
          firstCard: firstCardOf(agent),
          ownerFiles: defaultOwnerFiles(join(dir, 'home')),
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
      now: () => 1_000_000,
      ownerKdf: KDF,
      newOwnerSeed: () => {
        const seed = canarySeed();
        held.push(seed);
        return { seed, keys: keysOf(canarySeed()) };
      },
    },
  );
  servers.push(server);
  const record = (res: Response): Response => {
    responses.push(res);
    return res;
  };
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const landing = record(await send(server.port, `/?t=${token}`));
  const cookie = (landing.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = record(await send(server.port, '/', { headers: { Cookie: cookie } }));
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const post = async (path: string, body: Uint8Array, input?: unknown): Promise<Response> =>
    record(
      await send(server.port, path, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: server.origin,
          'X-AgentLink-CSRF': csrf,
          'Content-Type': 'application/octet-stream',
          'Sec-Fetch-Site': 'same-origin',
          ...(input === undefined
            ? {}
            : { 'X-AgentLink-Input': encodeBase64url(encodeUtf8(JSON.stringify(input))) }),
        },
        body,
      }),
    );
  const begun = await post(BEGIN, new Uint8Array(0));
  expect(begun.status).toBe(200);
  const { publicKey, nonce } = JSON.parse(begun.body) as {
    publicKey: { rpId: string; challenge: string };
    nonce: string;
  };
  const credentialId = encodeUtf8('canary-credential');
  const authenticatorData = concatBytes(
    sha256(encodeUtf8(publicKey.rpId)),
    new Uint8Array([0x01 | 0x04 | 0x40]),
    new Uint8Array([0, 0, 0, 1]),
    new Uint8Array(16),
    new Uint8Array([0, credentialId.length]),
    credentialId,
    new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26]),
  );
  const clientDataJSON = encodeUtf8(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: publicKey.challenge,
      origin: server.origin,
      crossOrigin: false,
    }),
  );
  expect(decodeBase64url(publicKey.challenge)).toHaveLength(32);
  const finish = await post(
    FINISH,
    encodeSetupRegistration({
      credentialId,
      authenticatorData,
      clientDataJSON,
      prfOutput: canaryPrf(),
    }),
    // W4-ONE-TOUCH (04 §2.8): finish carries only the begin nonce.
    { nonce },
  );
  return { events, responses, held, finish };
}

const allZero = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

const everything = (run: CanaryRun, output: string): string =>
  [
    JSON.stringify(run.events),
    ...run.responses.map((r) => `${JSON.stringify(r.headers)}\n${r.body}`),
    output,
  ].join('\n');

describe('the owner setup canary uses a seed that is not a real seed (M1-11s-c-b; L-8)', () => {
  it('the canary seed and PRF output are 32 printable ASCII bytes, not CSPRNG output', () => {
    expect(canarySeed()).toHaveLength(MASTER_SEED_LENGTH);
    expect(canaryPrf()).toHaveLength(32);
    for (const byte of [...canarySeed(), ...canaryPrf()]) {
      expect(byte).toBeGreaterThanOrEqual(0x20);
      expect(byte).toBeLessThan(0x7f);
    }
    // A real seed is not of this form (here: one drawn by newOwnerSeed), and the canary still
    // derives owner keys, so setup runs on it unchanged.
    const real = newOwnerSeed();
    expect(new TextDecoder().decode(real.seed)).not.toBe(CANARY_SEED_TEXT);
    expect(keysOf(canarySeed()).ownerNostr).toHaveLength(32);
  });

  it('a completed setup logs, emits and answers neither the seed nor the PRF output, and never logs the code', async () => {
    const output = captureOutput();
    const agent = await initAgent();
    const run = await canarySetup(agent);
    expect(run.finish.status).toBe(200);
    const done = JSON.parse(run.finish.body) as { status: string; ownerCode: string };
    expect(done.status).toBe('done');
    expect(agent.keychain.items.has(OWNER_PASSKEY_ACCOUNT)).toBe(true);
    // The canary went through setup and was wiped in place.
    expect(run.held).toHaveLength(1);
    expect(allZero(run.held[0] as Uint8Array)).toBe(true);
    const written = output();
    expectNoCanary(everything(run, written));
    // The owner code is in the finish body once, by design (D-120 follow-up); nowhere else.
    const compact = done.ownerCode.replaceAll(' ', '');
    const logged = [JSON.stringify(run.events), written].join('\n');
    expect(logged).not.toContain(compact);
    expect(logged).not.toContain(done.ownerCode);
    expect(logged).not.toContain(compact.slice(0, 8));
  }, 60_000);

  const failures: [string, string][] = [
    ['the owner item write is refused', OWNER_ACCOUNT],
    ['the passkey item write is refused', OWNER_PASSKEY_ACCOUNT],
  ];
  for (const [name, account] of failures) {
    it(`a failed setup (${name}) carries neither the seed nor the PRF output anywhere`, async () => {
      const output = captureOutput();
      const agent = await initAgent();
      agent.keychain.failSet.add(account);
      const run = await canarySetup(agent);
      expect(run.finish.status).toBe(500);
      expect(JSON.parse(run.finish.body)).not.toHaveProperty('ownerCode');
      expect(allZero(run.held[0] as Uint8Array)).toBe(true);
      expect([...agent.keychain.items.keys()].filter((a) => a.startsWith('owner'))).toEqual([]);
      expectNoCanary(everything(run, output()));
    }, 60_000);
  }
});

describe('completeOwnerSetup refuses a seed that is not the owner it was given (M1-11s-c-b)', () => {
  const identity = (): FirstAgentCard['identity'] => ({
    get: () => Promise.resolve(undefined),
    init: () => Promise.reject(new Error('not reached')),
  });
  const first = (): FirstAgentCard => ({
    agent: `0x${'11'.repeat(20)}`,
    name: 'Alice',
    relays: RELAYS,
    identity: identity(),
  });

  for (const withPrf of [true, false]) {
    it(`refuses before any keychain write, and its error carries no canary (${withPrf ? 'with' : 'without'} PRF)`, async () => {
      const keychain = new MapKeychain();
      const other = newOwnerSeed();
      const seed = canarySeed();
      const prfOutput = withPrf ? canaryPrf() : new Uint8Array(0);
      let caught: unknown;
      try {
        await completeOwnerSetup(
          keychain,
          {
            seed,
            keys: other.keys,
            credentialId: encodeUtf8('canary-credential'),
            prfOutput,
            firstCard: first(),
          },
          { kdf: KDF, ownerFiles: defaultOwnerFiles(join(dir, 'home')) },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(NodeKeyStoreError);
      expect((caught as NodeKeyStoreError).code).toBe('owner_card_failed');
      expect(keychain.sets).toEqual([]);
      expect(keychain.items.size).toBe(0);
      // The caller's seed and PRF output are not modified (the caller wipes them).
      expect(new TextDecoder().decode(seed)).toBe(CANARY_SEED_TEXT);
      const error = caught as Error & { cause?: unknown };
      expectNoCanary(
        [error.message, String(error.stack), JSON.stringify(error), String(error.cause)].join('\n'),
      );
    }, 60_000);
  }
});
