// U3-e acceptance: `POST /api/ui/agents/remove` in the app host (08 §1; 04 §2.5 "Removing an agent",
// §2.5.1 `agent.revoke` and "The owner's revoked list"; 06 §6 "Open agents and removal"; D-58,
// D-138; I-1, I-2, I-4, I-7).
//
// - Refused with `in_use` while any process has the agent open (the shared folder lock), before the
//   owner store is even opened; the agent the page showed is opened again, same generation.
// - The typed label must match; a stale generation is refused; the input is strict.
// - The one gesture always signs `agent.revoke {reason: "retired"}` for the agent's own ID (whatever
//   config.json's label says), records the exact signed text in the revoked list, writes the
//   `removing` mark before anything is sent or deleted, then (with contacts) seals the carriers with
//   the owner key of that same session, erases exactly the agent's keychain items (never the owner's)
//   and deletes the folder, inside the exclusive lock. Then the host opens another agent.
// - Undeliverable carriers stop before anything is deleted and are reported (`undeliverable`); the
//   agent stays retired ("Removal not finished") and `anyway: true` (a new gesture) goes on.
// - A failure at any step leaves what was done (crash test), and Try again finishes it.
// - Events carry fixed outcomes only: never a name, label, path or ID.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLinkClient,
  encodeStorageMark,
  verifyRevokedEntry,
  type ApprovalChannel,
} from '@4thtech-io/core';
import {
  TAGS,
  bip340Verify,
  decodeHex,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  taggedHash,
  type EnvelopeKeys,
  type KeyStore,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { holdAgentFolderShared, withAgentFolderExclusive } from '../agent-folder-lock.js';
import { openAgentStoreWith, type AgentStore } from '../agent-store.js';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { createKeychainAgent, openRecordedKeyStore } from '../keychain-keystore.js';
import { keychainAccount, type KeychainBackend } from '../keychain.js';
import { initOwnerWith } from '../owner-init.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { OwnerTerminal } from '../owner-terminal.js';
import {
  removeStatement,
  statementLabel,
  type AgentRemovalPort,
  type RemovalAgent,
} from './api/agents-remove.js';
import type { AgentDirectory, AgentDirectoryEntry, AppHostAgent } from './app-host.js';
import type { LocalUiAssets } from './context.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;
const RELAYS = ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'];
const OWNER_ACCOUNTS = ['owner', 'owner-passkey', 'owner-next'];

class MapKeychain implements KeychainBackend {
  readonly items = new Map<string, Uint8Array>();
  failDelete: string | undefined;
  get(account: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.items.get(account)?.slice() ?? null);
  }
  set(account: string, value: Uint8Array): Promise<void> {
    this.items.set(account, value.slice());
    return Promise.resolve();
  }
  delete(account: string): Promise<boolean> {
    if (account === this.failDelete) return Promise.reject(new Error('native'));
    return Promise.resolve(this.items.delete(account));
  }
}

const approvals: ApprovalChannel = {
  request: (request) => Promise.resolve({ approvalId: request.approvalId }),
  status: () => Promise.resolve({ state: 'pending' }),
};

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="agentlink-csrf" content="" /><title>AgentLink</title></head>' +
  '<body><div id="root"></div></body></html>';
const bundle = (): LocalUiAssets => ({
  files: new Map<string, Uint8Array>([['index.html', encodeUtf8(INDEX_HTML)]]),
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

// --- The owner and the agents ---------------------------------------------------------------------

const keychain = new MapKeychain();
let owner: OwnerPublicKeys;
let code = '';
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentlink-u3e-'));
  const written: string[] = [];
  const shown = (): string =>
    (written.find((w) => w.startsWith('Your owner code: ')) ?? '').slice(
      'Your owner code: '.length,
    );
  const terminal: OwnerTerminal = {
    write: (text) => void written.push(text),
    readSecret: () => Promise.resolve(encodeUtf8(shown().slice(-4))),
    confirm: () => Promise.resolve(false),
    clearScreen: () => undefined,
  };
  ({ owner } = await initOwnerWith(
    keychain,
    terminal,
    { backend: 'keychain', env: {} },
    { kdf: KDF },
  ));
  code = shown();
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Agent {
  readonly name: string;
  readonly agentId: string;
  readonly dir: string;
  readonly client: AgentLinkClient;
  close(): Promise<void>;
}

const openedStores: { store: AgentStore; keyStore: KeyStore }[] = [];

async function makeAgent(name: string): Promise<Agent> {
  const agentId = await createKeychainAgent(keychain);
  const dir = join(root, `${name}-${agentId.slice(2, 10)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = await openAgentStoreWith('keychain', agentId, join(dir, 'store.sqlite'), {
    keychain,
  });
  const keyStore = await openRecordedKeyStore('keychain', agentId, { keychain });
  openedStores.push({ store, keyStore });
  const client = await AgentLinkClient.create({
    keyStore,
    store: store.store,
    cipher: store.cipher,
    approvals,
    clock: () => Math.floor(Date.now() / 1000),
    policyMark: store.policyMark,
  });
  const ownerStore = await KeychainOwnerKeyStore.open(keychain, owner);
  const session = await ownerStore.unlock({ kind: 'passphrase', secret: encodeUtf8(code) });
  try {
    await client.identity.init({ owner: session, ownerKeys: owner, name: 'Agent', relays: RELAYS });
  } finally {
    await session.close();
    await ownerStore.close();
  }
  // Own storage: the credential item and the mark that names it (04 §2.2).
  await keychain.set(keychainAccount(agentId, 's3:0123456789abcdef'), encodeUtf8('x'));
  await keychain.set(
    keychainAccount(agentId, 'storage-mark'),
    encodeStorageMark('0123456789abcdef'),
  );
  let closed = false;
  return {
    name,
    agentId,
    dir,
    client,
    close: async () => {
      if (closed) return;
      closed = true;
      await keyStore.close().catch(() => undefined);
      await store.close().catch(() => undefined);
    },
  };
}

afterEach(async () => {
  for (const { store, keyStore } of openedStores.splice(0)) {
    await keyStore.close().catch(() => undefined);
    await store.close().catch(() => undefined);
  }
});

const itemsOf = (agentId: string): string[] =>
  [...keychain.items.keys()].filter((a) => a === agentId || a.startsWith(`${agentId}:`));

// --- The world: directory, host agents, removal port ----------------------------------------------

interface Faults {
  record?: boolean;
  mark?: boolean;
  apps?: boolean;
  folder?: boolean;
  contacts?: number;
  delivery?: 'delivered' | 'undeliverable';
  /** Runs inside queueCarriers, while the gesture is live. */
  onCarriers?: (keys: EnvelopeKeys) => Promise<void>;
}

interface World {
  readonly work: Agent;
  readonly other: Agent;
  readonly log: string[];
  readonly revoked: Map<string, string>;
  readonly carriers: { text: string; keys: EnvelopeKeys }[];
  readonly entries: Map<string, AgentDirectoryEntry & { readonly agentId: string }>;
  readonly faults: Faults;
  readonly ownerStores: number[];
  readonly events: ApprovalServerEvent[];
  readonly server: ApprovalServer;
  cookie(): Promise<string>;
  csrf(cookie: string): Promise<string>;
}

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function world(): Promise<World> {
  const work = await makeAgent('work');
  const other = await makeAgent('default');
  const agents = new Map([
    ['work', work],
    ['default', other],
  ]);
  const log: string[] = [];
  const revoked = new Map<string, string>();
  const carriers: { text: string; keys: EnvelopeKeys }[] = [];
  const faults: Faults = {};
  const ownerStores: number[] = [];
  const events: ApprovalServerEvent[] = [];
  const marked = new Set<string>();
  const entries = new Map<string, AgentDirectoryEntry & { readonly agentId: string }>([
    [
      'default',
      {
        name: 'default',
        label: 'Personal',
        available: true,
        removing: false,
        agentId: other.agentId,
      },
    ],
    [
      'work',
      { name: 'work', label: 'Work', available: true, removing: false, agentId: work.agentId },
    ],
  ]);
  const entryOf = (name: string): AgentDirectoryEntry | undefined => {
    const e = entries.get(name);
    if (e === undefined) return undefined;
    return {
      name: e.name,
      label: e.label,
      available: true,
      removing: marked.has(name) || revoked.has(e.agentId),
    };
  };
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.keys()].map((n) => entryOf(n) as AgentDirectoryEntry)),
    read: (name) => Promise.resolve(entryOf(name)),
    stats: () => Promise.resolve({ contacts: 0, running: false }),
    writeLabel: () => Promise.reject(new Error('not here')),
    markRemoving: (name) => {
      if (faults.mark === true) return Promise.reject(new Error('disk'));
      log.push(`mark ${name}`);
      marked.add(name);
      return Promise.resolve();
    },
    removeFolder: (name) => {
      if (faults.folder === true) return Promise.reject(new Error('disk'));
      log.push(`removeFolder ${name}`);
      entries.delete(name);
      return Promise.resolve();
    },
    readCurrent: () => Promise.resolve(undefined),
    writeCurrent: () => Promise.resolve(),
  };
  const sourceOf = (agent: Agent): ApprovalServerSource => ({
    context: () => Promise.resolve({ agent: agent.agentId, owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: () => Promise.reject(new Error('never')),
  });
  /** The app host's open agent holds the shared folder lock, as openAgent does. */
  const hostAgent = (name: string): AppHostAgent => {
    const agent = agents.get(name) as Agent;
    const lock = holdAgentFolderShared(agent.dir);
    log.push(`open ${name}`);
    return {
      name,
      label: entries.get(name)?.label ?? name,
      source: sourceOf(agent),
      localUi: {},
      close: () => {
        log.push(`close ${name}`);
        lock.release();
        return Promise.resolve();
      },
    };
  };
  const port: AgentRemovalPort = {
    exclusive: (name, fn) => withAgentFolderExclusive((agents.get(name) as Agent).dir, fn),
    open: (name) => {
      const agent = agents.get(name);
      if (agent === undefined) return Promise.resolve(undefined);
      // As openAgent: without the seed and the store key the agent does not open (identity_missing).
      if (
        !keychain.items.has(agent.agentId) ||
        !keychain.items.has(keychainAccount(agent.agentId, 'store-key'))
      ) {
        log.push(`removal-open-failed ${name}`);
        return Promise.resolve(undefined);
      }
      log.push(`removal-open ${name}`);
      const real = agent.client.removal;
      const removal = {
        facts: async () => ({ ...(await real.facts()), contacts: faults.contacts ?? 0 }),
        prepareRevoke: () => real.prepareRevoke(),
        queueCarriers: async (text: string, keys: EnvelopeKeys) => {
          carriers.push({ text, keys });
          await faults.onCarriers?.(keys);
          return ['carrier'];
        },
        deliver: () => Promise.resolve(faults.delivery ?? 'delivered'),
      };
      return Promise.resolve<RemovalAgent>({
        client: { removal } as unknown as AgentLinkClient,
        context: () => Promise.resolve({ agent: agent.agentId, owner }),
        close: () => {
          log.push(`removal-close ${name}`);
          return Promise.resolve();
        },
      });
    },
    keys: (name) => {
      const agent = agents.get(name);
      return Promise.resolve(
        agent === undefined
          ? undefined
          : { agentId: agent.agentId, backend: 'keychain' as const, keystoreDir: join(root, 'ks') },
      );
    },
    readRevoked: (agentId) => {
      const text = revoked.get(agentId);
      return Promise.resolve(text === undefined ? { kind: 'none' } : { kind: 'entry', text });
    },
    recordRevoked: (agentId, text) => {
      if (faults.record === true) return Promise.reject(new Error('disk'));
      log.push('record');
      if (!revoked.has(agentId)) revoked.set(agentId, text);
      return Promise.resolve();
    },
    removeAppEntries: (name) => {
      if (faults.apps === true) return Promise.reject(new Error('apps'));
      log.push(`apps ${name}`);
      return Promise.resolve();
    },
  };
  const opened: string[] = [];
  const initial = hostAgent('work');
  const server = await startApprovalServerWith(
    {
      source: initial.source,
      localUi: { assets: bundle() },
      onEvent: (event) => events.push(event),
      host: {
        directory,
        initial,
        open: (name) => Promise.resolve(entries.has(name) ? hostAgent(name) : undefined),
        removal: port,
      },
    },
    {
      keychain,
      openOwnerStore: (expected) => {
        ownerStores.push(1);
        return KeychainOwnerKeyStore.open(keychain, expected);
      },
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
    },
  );
  servers.push(server);
  return {
    work,
    other,
    log,
    revoked,
    carriers,
    entries,
    faults,
    ownerStores,
    events,
    server,
    async cookie() {
      const at = opened.length;
      await server.open();
      const fresh = new URL(opened[at] ?? '').searchParams.get('t') ?? '';
      const res = await send(server.port, `/?t=${fresh}`);
      return (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    },
    async csrf(cookie) {
      const res = await send(server.port, '/', { headers: { Cookie: cookie } });
      return /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(res.body)?.[1] ?? '';
    },
  };
}

async function remove(
  w: World,
  input: unknown,
  options: { presence?: string; generation?: string } = {},
): Promise<Response & { json: Record<string, unknown> }> {
  const cookie = await w.cookie();
  const csrf = await w.csrf(cookie);
  const res = await send(w.server.port, '/api/ui/agents/remove', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: w.server.origin,
      'X-AgentLink-CSRF': csrf,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-Generation': options.generation ?? '1',
      'X-AgentLink-Input': encodeBase64url(encodeUtf8(JSON.stringify(input))),
    },
    body: encodeUtf8(options.presence ?? code),
  });
  return { ...res, json: JSON.parse(res.body) as Record<string, unknown> };
}

const generationOf = async (w: World): Promise<string | undefined> => {
  const cookie = await w.cookie();
  const res = await send(w.server.port, '/api/ui/agents', {
    headers: { Cookie: cookie, 'X-AgentLink-CSRF': await w.csrf(cookie) },
  });
  return res.headers['x-agentlink-generation'] as string | undefined;
};

/** No event carries a name, label, folder or agent ID (I-7). */
function expectFixedEvents(w: World): void {
  const text = JSON.stringify(w.events);
  for (const secret of [w.work.agentId, w.work.agentId.slice(2), 'Work', 'work', w.work.dir]) {
    expect(text).not.toContain(secret);
  }
}

describe('POST /api/ui/agents/remove: refusals before the gesture (U3-e)', () => {
  it('refuses with in_use while another process has the agent open, before the owner store is opened', async () => {
    const w = await world();
    // Another process (an `agentlink mcp` server) has the agent open: it holds the shared lock.
    const mcp = holdAgentFolderShared(w.work.dir);
    try {
      const res = await remove(w, { name: 'work', typedLabel: 'Work' });
      expect(res.status).toBe(409);
      expect(res.json).toEqual({ status: 'in_use' });
    } finally {
      mcp.release();
    }
    expect(w.ownerStores).toEqual([]);
    expect(w.revoked.size).toBe(0);
    expect(w.log).not.toContain('mark work');
    // The app had closed its own hold to test; it opened the same agent again, same generation.
    expect(w.log).toEqual(['open work', 'close work', 'open work']);
    expect(await generationOf(w)).toBe('1');
    expect(itemsOf(w.work.agentId)).toHaveLength(4);
    expectFixedEvents(w);
  });

  it('refuses a wrong typed label, an unknown agent and malformed input without touching anything', async () => {
    const w = await world();
    for (const [input, status, outcome] of [
      [{ name: 'work', typedLabel: 'work' }, 409, 'label_mismatch'],
      [{ name: 'work', typedLabel: 'Work ' }, 409, 'label_mismatch'],
      [{ name: 'nobody', typedLabel: 'Nobody' }, 404, 'unknown_agent'],
      [{ name: 'work' }, 400, 'invalid'],
      [{ name: 'work', typedLabel: 'Work', extra: 1 }, 400, 'invalid'],
      [{ name: 'Work!', typedLabel: 'Work' }, 400, 'invalid'],
      [{ name: 'work', typedLabel: 'Work', anyway: false }, 400, 'invalid'],
      ['work', 400, 'invalid'],
    ] as const) {
      const res = await remove(w, input);
      expect(res.status, JSON.stringify(input)).toBe(status);
      expect(res.json).toEqual({ status: outcome });
    }
    expect(w.ownerStores).toEqual([]);
    expect(w.log).toEqual(['open work']);
  });

  it('refuses a stale generation with agent_changed before anything', async () => {
    const w = await world();
    const res = await remove(w, { name: 'work', typedLabel: 'Work' }, { generation: '5' });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ status: 'agent_changed' });
    expect(w.ownerStores).toEqual([]);
    expect(w.log).toEqual(['open work']);
  });

  it('a wrong owner code signs nothing and opens the agent again', async () => {
    const w = await world();
    const res = await remove(w, { name: 'work', typedLabel: 'Work' }, { presence: '0000-0000' });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ status: 'presence_rejected' });
    expect(w.revoked.size).toBe(0);
    expect(w.log).not.toContain('mark work');
    expect(w.log.at(-1)).toBe('open work');
    expect(itemsOf(w.work.agentId)).toHaveLength(4);
  });
});

describe('POST /api/ui/agents/remove: the removal (U3-e, 04 §2.5 steps 2 to 7)', () => {
  it('signs and records the revoke, marks, erases exactly the agent keys, deletes the folder, then opens another agent', async () => {
    const w = await world();
    const ownerBefore = OWNER_ACCOUNTS.filter((a) => keychain.items.has(a));
    expect(ownerBefore.length).toBeGreaterThan(0);
    const res = await remove(w, { name: 'work', typedLabel: 'Work' });
    expect(res.json).toEqual({ status: 'removed' });
    expect(res.status).toBe(200);
    // The revoked list holds the exact signed agent.revoke, for the agent's own ID.
    const text = w.revoked.get(w.work.agentId) as string;
    const checked = verifyRevokedEntry(text, w.work.agentId, `0x${encodeHex(owner.ownerNostr)}`);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.signed.body.params).toEqual({ reason: 'retired' });
    // Order: record, mark, apps, then the folder; the keys are gone, the owner's and others stay.
    const steps = w.log.filter((l) => /^(record|mark|apps|removeFolder)/.test(l));
    expect(steps).toEqual(['record', 'mark work', 'apps work', 'removeFolder work']);
    expect(itemsOf(w.work.agentId)).toEqual([]);
    expect(OWNER_ACCOUNTS.filter((a) => keychain.items.has(a))).toEqual(ownerBefore);
    expect(itemsOf(w.other.agentId).length).toBeGreaterThan(0);
    // No contacts: nothing is sent.
    expect(w.carriers).toEqual([]);
    // The host opened the other agent, with a new generation.
    expect(w.log.at(-1)).toBe('open default');
    expect(await generationOf(w)).toBe('2');
    expect(w.events).toContainEqual({ kind: 'remove', outcome: 'removed' });
    expectFixedEvents(w);
  });

  it('the label in config.json never changes what is signed: the revoke binds the folder agent ID', async () => {
    const w = await world();
    const e = w.entries.get('work');
    if (e === undefined) throw new Error('no entry');
    w.entries.set('work', { ...e, label: 'Personal' });
    const res = await remove(w, { name: 'work', typedLabel: 'Personal' });
    expect(res.json).toEqual({ status: 'removed' });
    const text = w.revoked.get(w.work.agentId) as string;
    expect(verifyRevokedEntry(text, w.work.agentId).ok).toBe(true);
    expect(verifyRevokedEntry(text, w.other.agentId).ok).toBe(false);
    expect(itemsOf(w.other.agentId).length).toBeGreaterThan(0);
  });

  it('with contacts, seals the carriers with the owner key of the same gesture', async () => {
    const w = await world();
    w.faults.contacts = 2;
    const res = await remove(w, { name: 'work', typedLabel: 'Work' });
    expect(res.json).toEqual({ status: 'removed' });
    expect(w.carriers).toHaveLength(1);
    const [carrier] = w.carriers;
    expect(carrier?.text).toBe(w.revoked.get(w.work.agentId));
    // The keys are gone once the gesture ended: they sealed only during it.
    await expect(carrier?.keys.signEnvelopeHash(new Uint8Array(32))).rejects.toThrow();
  });

  it('the carrier keys sign with the owner key and never decrypt', async () => {
    const w = await world();
    w.faults.contacts = 1;
    let checked = false;
    w.faults.onCarriers = async (keys) => {
      const hash = new Uint8Array(32).fill(7);
      const sig = await keys.signEnvelopeHash(hash);
      checked = bip340Verify(
        owner.ownerNostr,
        taggedHash(TAGS.envelope, hash),
        decodeHex(sig, { length: 64 }),
      );
      await expect(keys.nip44Decrypt('11'.repeat(32), 'x')).rejects.toThrow();
      await expect(keys.unwrapCek({} as never, new Uint8Array(16))).rejects.toThrow();
      await expect(
        keys.signNostr({ kind: 1, content: '', tags: [], created_at: 1 } as never),
      ).rejects.toThrow();
    };
    const res = await remove(w, { name: 'work', typedLabel: 'Work' });
    expect(res.json).toEqual({ status: 'removed' });
    expect(checked).toBe(true);
  });

  it('undeliverable carriers stop before anything is deleted; Remove anyway is a new gesture that finishes', async () => {
    const w = await world();
    w.faults.contacts = 1;
    w.faults.delivery = 'undeliverable';
    const res = await remove(w, { name: 'work', typedLabel: 'Work' });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ status: 'undeliverable' });
    // Retired (recorded and marked), but nothing deleted.
    expect(w.revoked.has(w.work.agentId)).toBe(true);
    expect(w.log).toContain('mark work');
    expect(w.log).not.toContain('removeFolder work');
    expect(itemsOf(w.work.agentId)).toHaveLength(4);
    // The page can ask: no other agent was opened, the generation is the same.
    expect(w.log.filter((l) => l.startsWith('open '))).toEqual(['open work']);
    expect(await generationOf(w)).toBe('1');
    const first = w.revoked.get(w.work.agentId);
    const again = await remove(w, { name: 'work', typedLabel: 'Work', anyway: true });
    expect(again.json).toEqual({ status: 'removed' });
    // The stored revoke is never replaced; the same one is sent again.
    expect(w.revoked.get(w.work.agentId)).toBe(first);
    expect(w.carriers.map((c) => c.text)).toEqual([first, first]);
    expect(itemsOf(w.work.agentId)).toEqual([]);
    expect(w.log.at(-1)).toBe('open default');
  });

  it('GAP B: keys erased but the folder not deleted: Try again finishes steps 6 and 7 only', async () => {
    const w = await world();
    w.faults.folder = true;
    const res = await remove(w, { name: 'work', typedLabel: 'Work' });
    expect(res.json).toEqual({ status: 'failed' });
    expect(itemsOf(w.work.agentId)).toEqual([]);
    const recorded = w.revoked.get(w.work.agentId);
    w.faults.folder = false;
    const retry = await remove(
      w,
      { name: 'work', typedLabel: 'Work' },
      { generation: (await generationOf(w)) ?? '1' },
    );
    expect(retry.json).toEqual({ status: 'removed' });
    expect(w.log).toContain('removal-open-failed work');
    expect(w.log.filter((l) => l === 'removeFolder work')).toEqual(['removeFolder work']);
    // The recorded entry is kept; nothing more is sent.
    expect(w.revoked.get(w.work.agentId)).toBe(recorded);
    expect(w.carriers).toEqual([]);
    // A wrong owner code still signs nothing on this path.
    expectFixedEvents(w);
  });

  it('GAP B: an agent whose store does not open and that is not retired is never finished', async () => {
    const w = await world();
    keychain.items.delete(w.work.agentId);
    const res = await remove(w, { name: 'work', typedLabel: 'Work' });
    expect(res.json).toEqual({ status: 'failed' });
    expect(w.ownerStores).toEqual([]);
    expect(w.log).not.toContain('removeFolder work');
  });

  it('crash test: a failure at each step leaves what was done, and Try again finishes', async () => {
    for (const fault of ['record', 'mark', 'apps', 'keys', 'folder'] as const) {
      const w = await world();
      if (fault === 'keys') keychain.failDelete = `${w.work.agentId}:store-key`;
      else w.faults[fault] = true;
      const res = await remove(w, { name: 'work', typedLabel: 'Work' });
      expect(res.status, fault).toBe(500);
      expect(res.json, fault).toEqual({ status: 'failed' });
      const recorded = w.revoked.has(w.work.agentId);
      expect(recorded, fault).toBe(fault !== 'record');
      // Nothing is deleted before the mark, and the keys go only after the AI app entries.
      if (fault === 'record' || fault === 'mark' || fault === 'apps') {
        expect(itemsOf(w.work.agentId), fault).toHaveLength(4);
      }
      expect(w.log, fault).not.toContain('removeFolder work');
      // A retired agent is never opened again as usable.
      if (recorded) expect(w.log.at(-1), fault).toBe('open default');
      else expect(w.log.at(-1), fault).toBe('open work');
      expect(w.events, fault).toContainEqual(
        expect.objectContaining({ kind: 'remove', outcome: 'failed' }),
      );
      // Try again (a new gesture with the typed label) finishes it.
      keychain.failDelete = undefined;
      w.faults.record = false;
      w.faults.mark = false;
      w.faults.apps = false;
      w.faults.folder = false;
      const retry = await remove(
        w,
        { name: 'work', typedLabel: 'Work' },
        {
          generation: (await generationOf(w)) ?? '1',
        },
      );
      expect(retry.json, fault).toEqual({ status: 'removed' });
      expect(itemsOf(w.work.agentId), fault).toEqual([]);
      expectFixedEvents(w);
    }
  });
});

describe('the statement before the gesture (04 §2.5, 11 §5)', () => {
  it("names the agent's verified label (U3-d), else the folder name; never the unsigned config label", async () => {
    const client = (reading: unknown) =>
      ({
        ownerActions: {
          loadLabel: () =>
            reading instanceof Error ? Promise.reject(reading) : Promise.resolve(reading),
        },
      }) as unknown as AgentLinkClient;
    expect(await statementLabel(client({ status: 'verified', label: 'Work' }), 'work')).toBe(
      'Work',
    );
    expect(await statementLabel(client({ status: 'unverified' }), 'work')).toBe('work');
    expect(await statementLabel(client({ status: 'none' }), 'work')).toBe('work');
    expect(await statementLabel(client(new Error('store')), 'work')).toBe('work');
  });

  it('names the label and the folder, and says it is retired for good', () => {
    const lines = removeStatement('Work', 'work', 2);
    expect(lines[0]).toContain('Work');
    expect(lines.join(' ')).toContain('Agent folder: work');
    expect(lines.join(' ')).toContain('cannot be restored');
    expect(lines.join(' ')).toContain('contacts are told');
    expect(removeStatement('Work', 'work', 0).join(' ')).not.toContain('are told');
    // Remove anyway: the contacts could not be told, and the statement says so.
    const anyway = removeStatement('Work', 'work', 2, true).join(' ');
    expect(anyway).not.toContain('are told');
    expect(anyway).toContain("can't be told");
    for (const word of ['wallet', 'gas', 'seed phrase', 'transaction']) {
      expect(lines.join(' ').toLowerCase()).not.toContain(word);
    }
  });
});

beforeEach(() => {
  keychain.failDelete = undefined;
});
