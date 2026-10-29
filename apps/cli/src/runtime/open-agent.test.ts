// Opening an agent (M1-9k; 06 §6, 07 §9.1, §9.4; D-73 (3)). The Node pieces are doubles here: the
// real keychain and SQLite store are @4thtech-io/node's (keychain-native.test.ts, store-concurrency
// .test.ts cover two connections on one file). This suite checks the wiring: which backend, which
// file, which channel, and that every process opening the agent reaches the same store.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  type AgentLinkClient,
  type AgentLinkClientOptions,
  type Sealed,
  type StoreCipher,
} from '@4thtech-io/core';
import type { KeyStore } from '@4thtech-io/crypto';
import { encodeBase64url, encodeHex, randomBytes } from '@4thtech-io/crypto';
import { createLogger } from '@4thtech-io/log';
import type { AgentStore, KeyStoreBackendKind, KeychainProbe } from '@4thtech-io/node';
import { AgentFolderLockError, withAgentFolderExclusive } from '@4thtech-io/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordRevokedEntry, writeAgentConfig } from './agent-dir.js';
import { RUNTIME_MESSAGES } from './errors.js';
import { NO_AGENT_MESSAGE, openAgent, type RuntimeDeps } from './open-agent.js';

const NOW = 1_800_000_000;
const NO_KEYCHAIN_COPY =
  "This machine has no system keychain (common in containers, WSL and SSH sessions), so AgentLink can't protect your agent's identity here yet. To keep it in a passphrase-locked file instead, run `npx -y @4thtech-io/agentlink init --keystore file` yourself, in your own terminal.";

const silent = createLogger({ name: 'test', sink: () => undefined });
let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-open-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** One SQLite file per path, shared by every "process" that opens it (the double of the disk). */
class Disk {
  readonly files = new Map<string, MemoryStore>();
  storeAt(path: string): MemoryStore {
    let store = this.files.get(path);
    if (store === undefined) {
      store = new MemoryStore();
      this.files.set(path, store);
    }
    return store;
  }
}

interface Recorded {
  probes: number;
  keyStores: { backend: KeyStoreBackendKind; agentId: string }[];
  stores: { backend: KeyStoreBackendKind; agentId: string; path: string }[];
  clients: AgentLinkClientOptions[];
  closed: string[];
}

/** The Node pieces of one process, over a shared disk. */
function processDeps(
  disk: Disk,
  over: { probe?: KeychainProbe; clientAgentId?: (configured: string) => string } = {},
): { deps: RuntimeDeps; rec: Recorded } {
  const rec: Recorded = { probes: 0, keyStores: [], stores: [], clients: [], closed: [] };
  let opened = '';
  const deps: RuntimeDeps = {
    probeKeychain: () => {
      rec.probes += 1;
      return Promise.resolve(over.probe ?? { ok: true });
    },
    openKeyStore: (backend, agentId) => {
      rec.keyStores.push({ backend, agentId });
      opened = agentId;
      return Promise.resolve({
        close: () => {
          rec.closed.push('keyStore');
          return Promise.resolve();
        },
      } as unknown as KeyStore);
    },
    openStore: (backend, agentId, path) => {
      rec.stores.push({ backend, agentId, path });
      const store = disk.storeAt(path);
      const agentStore = {
        store: Object.assign(Object.create(store) as MemoryStore, {
          withInterProcessLock: <T>(fn: () => Promise<T> | T) => Promise.resolve(fn()),
          transaction: store.transaction.bind(store),
          close: () => Promise.resolve(),
        }),
        cipher: { indexDigest: () => Promise.resolve('') } as unknown as StoreCipher,
        policyMark: { read: () => Promise.resolve(0), raise: (v: number) => Promise.resolve(v) },
        close: () => {
          rec.closed.push('store');
          return Promise.resolve();
        },
      };
      return Promise.resolve(agentStore as unknown as AgentStore);
    },
    transport: () => () => ({}) as never,
    createClient: (options) => {
      rec.clients.push(options);
      const agentId = over.clientAgentId?.(opened) ?? opened;
      return Promise.resolve({
        agentId,
        close: () => {
          rec.closed.push('client');
        },
      } as unknown as AgentLinkClient);
    },
  };
  return { deps, rec };
}

const newAgentId = (): string => `0x${encodeHex(randomBytes(20))}`;

async function initAgent(name = 'default', keyStore: KeyStoreBackendKind = 'keychain') {
  const agentId = newAgentId();
  const paths = await writeAgentConfig(home, { v: 1, name, agentId, keyStore });
  return { agentId, paths };
}

const open = (deps: RuntimeDeps, agent?: string) =>
  openAgent({
    home,
    deps,
    clock: () => NOW,
    logger: silent,
    ...(agent === undefined ? {} : { agent }),
  });

describe('openAgent (M1-9k)', () => {
  it('close() closes the client (relay connections) first, then the store and the KeyStore, once', async () => {
    await initAgent();
    const { deps, rec } = processDeps(new Disk());
    const result = await open(deps);
    if (result.status !== 'ok') throw new Error('not opened');
    await result.agent.close();
    await result.agent.close();
    expect(rec.closed).toEqual(['client', 'store', 'keyStore']);
  });

  it('opens the default agent with its recorded backend, store file, policy mark and the M1a channel', async () => {
    const disk = new Disk();
    const { agentId, paths } = await initAgent();
    const { deps, rec } = processDeps(disk);
    const result = await open(deps);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.agent.name).toBe('default');
    expect(result.agent.agentId).toBe(agentId);
    expect(rec.probes).toBe(1);
    expect(rec.keyStores).toEqual([{ backend: 'keychain', agentId }]);
    expect(rec.stores).toEqual([{ backend: 'keychain', agentId, path: paths.store }]);
    const options = rec.clients[0]!;
    expect(options.approvals).toBe(result.agent.approvals);
    expect(options.policyMark).toBeDefined();
    expect(options.transport).toBeDefined();
    // The 4thTech drop's origin (M1-9d-1): its file links show as `drop`, any other as `own`.
    expect(options.dropOrigins).toEqual(['https://drop.agentlink.4thtech.io']);
    // The Node files platform and the allowed-folder check of `path` arguments (M1-9d-1).
    expect(options.files).toBeDefined();
    expect(result.agent.files).toBeDefined();
    expect(Object.keys(result.agent.approvals).sort()).toEqual(['request', 'status']);
  });

  it('two processes opening the agent share one store file (06 §6)', async () => {
    const disk = new Disk();
    await initAgent();
    const first = processDeps(disk);
    const second = processDeps(disk);
    const a = await open(first.deps);
    const b = await open(second.deps);
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('not opened');
    expect(first.rec.stores[0]!.path).toBe(second.rec.stores[0]!.path);
    expect(disk.files.size).toBe(1);

    // A request the server's core stores is visible to the other process's channel, and only as
    // `pending`: nothing passes between them except through the store.
    const store = disk.storeAt(first.rec.stores[0]!.path);
    const approvalId = `apr_${encodeBase64url(randomBytes(16))}`;
    await store.transaction((tx) =>
      tx.insert('approvals', {
        approval_id: approvalId,
        action_json: 'test-sealed:a' as Sealed,
        scope_json: null,
        answers_envelope_id: null,
        scope_key: null,
        source: 'owner',
        policy_hash: null,
        signed_decision: null,
        signed_cancel: null,
        summary: 'test-sealed:s' as Sealed,
        status: 'approved', // edited: a cache, never authority
        expires_at: NOW + 600,
        created_at: NOW,
        decided_at: null,
      }),
    );
    expect(await b.agent.approvals.status(approvalId)).toEqual({ state: 'pending' });
    expect(await a.agent.approvals.status(approvalId)).toEqual({ state: 'pending' });
  });

  it('a named agent opens its own folder; agents never share a store', async () => {
    const disk = new Disk();
    await initAgent('default');
    const { paths } = await initAgent('work');
    const { deps, rec } = processDeps(disk);
    const result = await open(deps, 'work');
    expect(result.status).toBe('ok');
    expect(rec.stores[0]!.path).toBe(paths.store);
    expect(rec.stores[0]!.path).not.toBe(
      join(home, '.agentlink', 'agents', 'default', 'store.sqlite'),
    );
  });

  it('no keychain → needs_setup with the 07 §9.4 copy; nothing is opened', async () => {
    const disk = new Disk();
    await initAgent();
    const fix = 'Unlock your keychain (over SSH: `security unlock-keychain`), then try again.';
    const { deps, rec } = processDeps(disk, { probe: { ok: false, reason: 'unavailable', fix } });
    const result = await open(deps);
    expect(result).toEqual({
      status: 'needs_setup',
      reason: 'no_keychain',
      message: NO_KEYCHAIN_COPY,
      fix,
    });
    expect(rec.keyStores).toEqual([]);
    expect(rec.stores).toEqual([]);
    expect(disk.files.size).toBe(0);
  });

  it('no agent set up → needs_setup `no_agent`; nothing is created', async () => {
    const disk = new Disk();
    const { deps, rec } = processDeps(disk);
    expect(await open(deps)).toEqual({
      status: 'needs_setup',
      reason: 'no_agent',
      message: NO_AGENT_MESSAGE,
    });
    expect(rec.probes + rec.keyStores.length + rec.stores.length).toBe(0);
  });

  it('refuses an invalid agent name with a fixed error, before touching the disk', async () => {
    const { deps, rec } = processDeps(new Disk());
    for (const name of ['-x', 'Work', 'work\n', '../default', 'a b']) {
      await expect(open(deps, name)).rejects.toThrow(RUNTIME_MESSAGES.agent_name_invalid);
    }
    expect(rec.probes).toBe(0);
  });

  it('a recorded file backend is opened only as recorded: no probe, no fallback', async () => {
    const disk = new Disk();
    const { agentId } = await initAgent('default', 'file');
    const { deps, rec } = processDeps(disk);
    await open(deps);
    expect(rec.probes).toBe(0);
    expect(rec.keyStores).toEqual([{ backend: 'file', agentId }]);
  });

  it('keys that are not the recorded agent are refused, and everything opened is closed', async () => {
    const disk = new Disk();
    await initAgent();
    const { deps, rec } = processDeps(disk, { clientAgentId: () => newAgentId() });
    await expect(open(deps)).rejects.toThrow(RUNTIME_MESSAGES.agent_config_invalid);
    expect(rec.closed.sort()).toEqual(['client', 'keyStore', 'store']);
  });

  it('close() closes the store and the KeyStore once', async () => {
    const disk = new Disk();
    await initAgent();
    const { deps, rec } = processDeps(disk);
    const result = await open(deps);
    if (result.status !== 'ok') throw new Error('not opened');
    await Promise.all([result.agent.close(), result.agent.close()]);
    expect(rec.closed.sort()).toEqual(['client', 'keyStore', 'store']);
  });
});

// U3-c (06 §6 "Open agents and removal"): every process that opens an agent holds the shared folder
// lock until close, so a removal (exclusive) is refused with in_use while it is open.
describe('openAgent holds the shared agent folder lock (U3-c)', () => {
  const exclusive = (dir: string) =>
    withAgentFolderExclusive(dir, () => 'taken').catch((error: unknown) =>
      error instanceof AgentFolderLockError ? error.code : error,
    );

  it('removal is refused while the agent is open, by one process or two, and allowed after close', async () => {
    const { paths } = await initAgent();
    const disk = new Disk();
    const first = await open(processDeps(disk).deps);
    const second = await open(processDeps(disk).deps);
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('not opened');
    expect(await exclusive(paths.dir)).toBe('in_use');
    await first.agent.close();
    expect(await exclusive(paths.dir)).toBe('in_use');
    await second.agent.close();
    expect(await exclusive(paths.dir)).toBe('taken');
  });

  it('the lock is released when opening fails or answers needs_setup', async () => {
    const { paths } = await initAgent();
    const noKeychain = processDeps(new Disk(), {
      probe: { ok: false, reason: 'unavailable', message: 'x', fix: 'y' } as never,
    });
    await open(noKeychain.deps).catch(() => undefined);
    expect(await exclusive(paths.dir)).toBe('taken');
    const wrongKeys = processDeps(new Disk(), { clientAgentId: () => newAgentId() });
    await open(wrongKeys.deps).catch(() => undefined);
    expect(await exclusive(paths.dir)).toBe('taken');
  });

  it('an agent being removed (lock held exclusive) does not open', async () => {
    const { paths } = await initAgent();
    const code = await withAgentFolderExclusive(paths.dir, () =>
      open(processDeps(new Disk()).deps).then(
        () => 'opened',
        (error: unknown) => (error as { code?: unknown }).code,
      ),
    );
    expect(code).toBe('agent_open_failed');
  });
});

// U3-e GAP A (04 §2.5 step 3, D-58): a retired agent is never opened as usable, by any process
// (`agentlink mcp`, CLI commands, a leftover AI app entry); only its own removal opens it.
describe('openAgent refuses a retired agent (U3-e)', () => {
  it('refuses an agent marked removing in config.json, before any key or store is opened', async () => {
    const agentId = newAgentId();
    await writeAgentConfig(home, {
      v: 1,
      name: 'work',
      agentId,
      keyStore: 'keychain',
      removing: true,
    });
    const { deps, rec } = processDeps(new Disk());
    const result = await open(deps, 'work');
    expect(result).toMatchObject({ status: 'needs_setup', reason: 'agent_removing' });
    if (result.status === 'needs_setup') expect(result.message).not.toContain(agentId);
    expect(rec.keyStores).toEqual([]);
    expect(rec.stores).toEqual([]);
  });

  it('refuses an agent in the owner revoked list even without the mark, and holds no lock', async () => {
    const { agentId, paths } = await initAgent('work');
    await recordRevokedEntry(home, agentId, 'any text: damaged or not, it counts');
    const { deps, rec } = processDeps(new Disk());
    expect(await open(deps, 'work')).toMatchObject({
      status: 'needs_setup',
      reason: 'agent_removing',
    });
    expect(rec.keyStores).toEqual([]);
    expect(await withAgentFolderExclusive(paths.dir, () => 'taken')).toBe('taken');
  });

  it("the removal's own open (with its folder lock) still opens the retired agent", async () => {
    const { agentId } = await initAgent('work');
    await recordRevokedEntry(home, agentId, 'x');
    const { deps } = processDeps(new Disk());
    const result = await openAgent({
      home,
      deps,
      clock: () => NOW,
      logger: silent,
      agent: 'work',
      folderLock: () => ({ release: () => undefined }),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') await result.agent.close();
  });
});
