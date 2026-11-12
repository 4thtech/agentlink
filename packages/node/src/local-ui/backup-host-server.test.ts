// WP-R2b (D-147 (2), (6), (7); 04 §2.3.3 "In the local app", "Kit record", "Check that my kit opens";
// §2.5 "One entry", "KeyStore isolation"): Back up in the app host saves one kit of every keychain ID
// of this owner, through the real presence gate, the real owner store (unlockForExport) and the real
// KeyExportControl.
//
// - At most ONE agent's KeyStore and store are open in the host at any time: the open ID's core
//   prepares and applies its own `backup.export`; then the host's slot closes it, opens each other ID
//   alone (prepare, sign, apply, close), and opens the first ID again. Its core is never duplicated
//   and nothing is opened before the owner's gesture.
// - If any `backup.export` is refused, nothing is sealed, no record is written and every core this
//   operation opened is closed; the open ID is open again.
// - A file-KeyStore ID is not included and the answer names it.
// - `GET /api/ui/backup` answers the real record (it survives a restart); `POST /api/ui/backup/reveal`
//   takes no presence and no input and reveals only the recorded kit file.
// - The answer's `check` is the restore engine's export handle: Check opens exactly that kit.
// - Nothing new is logged: no event, console line or answer carries the code, a path or a seed.
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  buildOwnerActionBody,
  newOwnerActionNonce,
  rowKeyOf,
  type OwnerActionOutcome,
} from '@4thtech-io/core';
import {
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  type JsonObject,
  type RecoveryKitStoreSink,
} from '@4thtech-io/crypto';
import { openRecoveryKit } from '@4thtech-io/crypto/keystore';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerSigValid, ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { keychainAccount } from '../keychain.js';
import { createKeychainAgent } from '../keychain-keystore.js';
import { readKitRecord } from '../kit-record.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import { SqliteStore } from '../sqlite-store.js';
import { createAgentStoreCipher } from '../store-cipher.js';
import { sampleRow } from '../store-rows.fixture.js';
import { BACKUP_REVEAL_PATH } from './api/backup.js';
import { RESTORE_PATHS } from './api/restore.js';
import type { AgentDirectory, AgentDirectoryEntry, AppHostAgent } from './app-host.js';
import { BACKUP_EXPORT_PATH, BACKUP_PATH, createLocalUiRoutes } from './routes.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

let world: OwnerWorld;
let second: string;
beforeAll(async () => {
  world = await ownerWorld('agentlink-wp-r2b-host-');
  second = await createKeychainAgent(world.keychain);
});
afterAll(() => {
  world.cleanup();
});

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function memorySink(parts: Uint8Array[]): RecoveryKitStoreSink {
  return {
    write: (b) => void parts.push(b.slice()),
    commit: () => undefined,
    discard: () => undefined,
  };
}

/**
 * A real agent store for `agentId` (its identity row, a card naming this owner, `people` active
 * contacts), sealed with that ID's own store key from the keychain, so Check's store checks pass.
 */
async function storeAt(dir: string, agentId: string, people: number): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.sqlite');
  const storeKey = (await world.keychain.get(keychainAccount(agentId, 'store-key'))) as Uint8Array;
  const store = await SqliteStore.open(path);
  const cipher = await createAgentStoreCipher(storeKey);
  const row = await sampleRow('identity', 0, cipher);
  const card = JSON.stringify({
    card: { ownerNostr: encodeHex0x(world.owner.ownerNostr), keyEpoch: row.key_epoch },
    cardSig: 'x',
    cardAgentSig: null,
  });
  const sealed = await cipher.seal(
    { table: 'identity', column: 'agent_card_json', rowKey: rowKeyOf([agentId]) },
    card,
  );
  const contacts: Record<string, unknown>[] = [];
  for (let i = 0; i < people; i += 1) {
    contacts.push({ ...(await sampleRow('contacts', i, cipher)), status: 'active' });
  }
  await store.transaction((tx) => {
    tx.insert('identity', { ...row, agent_id: agentId, agent_card_json: sealed });
    for (const contact of contacts) tx.insert('contacts', contact as never);
  });
  await store.close();
  cipher.close();
  return path;
}

/** A plain store file (the file-KeyStore ID's; never sealed into a kit). */
function plainStoreAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'store.sqlite');
  const db = new Database(path);
  db.exec('CREATE TABLE contacts (contact_id TEXT, status TEXT);');
  db.close();
  return path;
}

/**
 * The world of one test: three IDs on disk (`default` and `work` in the keychain, `files` a
 * file-KeyStore ID) plus one being removed; every core open and close is counted (the KeyStore spy).
 */
async function idsWorld(home: string, over: { refuseWork?: boolean } = {}) {
  const log: string[] = [];
  const open = new Set<string>();
  let most = 0;
  /** At every step of an ID's core: it is the only one open. */
  const violations: string[] = [];
  const step = (name: string, what: string) => {
    log.push(`${what} ${name}`);
    if (open.size !== 1 || !open.has(name)) violations.push(`${what} ${name} with [${[...open]}]`);
  };
  const ids = {
    default: {
      agentId: world.agentId,
      store: await storeAt(join(home, '.agentlink', 'agents', 'default'), world.agentId, 2),
    },
    work: {
      agentId: second,
      store: await storeAt(join(home, '.agentlink', 'agents', 'work'), second, 5),
    },
    files: {
      agentId: `0x${'ab'.repeat(20)}`,
      store: plainStoreAt(join(home, '.agentlink', 'agents', 'files')),
    },
  } as const;
  type Name = keyof typeof ids;
  /** Each ID's applied backup.export bodies, kept across restarts (the store). */
  const applied: Record<Name, JsonObject[]> = { default: [], work: [], files: [] };
  const entries = new Map<string, AgentDirectoryEntry>([
    ['default', { name: 'default', label: 'Personal', available: true, removing: false }],
    ['broken', { name: 'broken', label: 'broken', available: false, removing: false }],
    // A file-KeyStore ID (config.json records `file`): named, never opened (no passphrase here).
    [
      'files',
      { name: 'files', label: 'Files', available: true, removing: false, keyStore: 'file' },
    ],
    ['old', { name: 'old', label: 'Old', available: true, removing: true }],
    ['work', { name: 'work', label: 'Work', labelled: true, available: true, removing: false }],
  ]);
  const directory: AgentDirectory = {
    list: () => Promise.resolve([...entries.values()]),
    read: (name) => Promise.resolve(entries.get(name)),
    stats: (name) =>
      Promise.resolve(
        name === 'old'
          ? undefined
          : { contacts: name === 'work' ? 5 : name === 'default' ? 2 : 1, running: false },
      ),
    writeLabel: () => Promise.resolve(),
    markRemoving: () => Promise.reject(new Error('no')),
    removeFolder: () => Promise.reject(new Error('no')),
    readCurrent: () => Promise.resolve('default'),
    writeCurrent: () => Promise.resolve(),
  };
  const agent = (name: Name): AppHostAgent => {
    if (open.has(name)) violations.push(`${name} opened twice`);
    open.add(name);
    most = Math.max(most, open.size);
    log.push(`open ${name}`);
    const { agentId, store } = ids[name];
    const refuse = name === 'work' && over.refuseWork === true;
    const source: ApprovalServerSource = {
      context: () => Promise.resolve({ agent: agentId, owner: world.owner }),
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
      apply: (signed) => {
        step(name, 'apply');
        const body = signed.body as JsonObject;
        if (
          refuse ||
          body['op'] !== 'backup.export' ||
          body['agent'] !== agentId ||
          !ownerSigValid(world.owner, body, signed.sig)
        ) {
          return Promise.resolve({ status: 'refused', op: 'backup.export', reason: 'x' } as never);
        }
        applied[name].push(body);
        return Promise.resolve({ status: 'applied', op: 'backup.export' } as OwnerActionOutcome);
      },
    };
    const client = {
      agentId,
      ownerActions: {
        loadLabel: () =>
          Promise.resolve(
            name === 'work' ? { status: 'verified', label: 'Work' } : { status: 'none' },
          ),
        prepareBackupExport: (kitId: string, contents: 'full' | 'identity') => {
          step(name, 'prepare');
          const issuedAt = Math.floor(Date.now() / 1000);
          const { body, jcs } = buildOwnerActionBody({
            agent: agentId,
            owner: encodeHex(world.owner.ownerNostr),
            op: 'backup.export',
            params: { kitId, contents },
            nonce: newOwnerActionNonce(),
            issuedAt,
            expiresAt: issuedAt + 600,
          } as never);
          return Promise.resolve({ status: 'prepared', op: 'backup.export', body, jcs });
        },
        // As core: the exact signed save (its body) and its kitId (IR L-3).
        backupExportRecorded: (signed: { body: JsonObject }, kitId: string) =>
          Promise.resolve(
            applied[name].some(
              (b) =>
                JSON.stringify(b) === JSON.stringify(signed.body) &&
                (b['params'] as JsonObject)['kitId'] === kitId,
            ),
          ),
      },
    };
    return {
      name,
      label: entries.get(name)?.label ?? name,
      source,
      localUi: {
        client: client as never,
        // A file-KeyStore ID has no recovery-kit source (the CLI's deps.ts gives keychain IDs only).
        ...(name === 'files'
          ? {}
          : {
              recoveryKit: { agentId, name, storePath: store, home, kdf: KDF },
            }),
      },
      close: () => {
        log.push(`close ${name}`);
        open.delete(name);
        return Promise.resolve();
      },
    };
  };
  /**
   * IR L-4: the keychain the server and the export control read. Each read of an ID's seed (the
   * seal) is logged with the agents open at that moment: only the open ID may be open then.
   */
  const keychain = {
    get: async (account: string) => {
      for (const id of [world.agentId, second]) {
        if (account === keychainAccount(id, 'seed')) {
          log.push(`seal-read ${id === world.agentId ? 'default' : 'work'}`);
          if (open.size > 1 || [...open].some((n) => n !== 'default')) {
            violations.push(`seal read with [${[...open]}]`);
          }
        }
      }
      return world.keychain.get(account);
    },
    set: (account: string, value: Uint8Array) => world.keychain.set(account, value),
    delete: (account: string) => world.keychain.delete(account),
  };
  return {
    log,
    open,
    applied,
    violations,
    directory,
    keychain,
    agent,
    get most() {
      return most;
    },
  };
}

type IdsWorld = Awaited<ReturnType<typeof idsWorld>>;

let homes = 0;
async function harness(
  over: {
    refuseWork?: boolean;
    home?: string;
    ids?: IdsWorld;
    /** IR M-1: the open of `work` hangs until this resolves (a keychain prompt, owner away). */
    hangWork?: Promise<void>;
    /** The open ID cannot be opened again after the walk. */
    noReopen?: boolean;
    /** The open ID's reopen after the walk hangs until this resolves. */
    hangReopen?: Promise<void>;
  } = {},
) {
  homes += 1;
  const home = over.home ?? join(world.root, `home-${String(homes)}`);
  mkdirSync(join(home, 'Downloads'), { recursive: true });
  const ids = over.ids ?? (await idsWorld(home, over));
  const initial = ids.agent('default');
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const revealed: [string, string][] = [];
  const server = await startApprovalServerWith(
    {
      source: initial.source,
      localUi: { assets: TEST_APP },
      onEvent: (event) => void events.push(event),
      host: {
        directory: ids.directory,
        initial,
        open: async (name) => {
          if (name !== 'default' && name !== 'work' && name !== 'files') return undefined;
          if (name === 'work' && over.hangWork !== undefined) await over.hangWork;
          if (name === 'default' && over.noReopen === true) return undefined;
          if (name === 'default' && over.hangReopen !== undefined) await over.hangReopen;
          return ids.agent(name);
        },
      },
    },
    {
      keychain: ids.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(ids.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      fileRevealer: (path, folder) => {
        revealed.push([path, folder]);
        return Promise.resolve(true);
      },
      restore: { home, kdf: KDF },
      backupWalk: { stepMs: 300, settleMs: 100, reopenMs: 200 },
    },
  );
  servers.push(server);
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(server.port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(server.port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const headers = (more: Record<string, string> = {}) => ({
    Cookie: cookie,
    Origin: server.origin,
    'X-AgentLink-CSRF': csrf,
    'Content-Type': 'application/octet-stream',
    'Sec-Fetch-Site': 'same-origin',
    'X-AgentLink-Generation': '1',
    ...more,
  });
  return {
    server,
    home,
    ids,
    events,
    revealed,
    headers,
    exportKit: (code: string) =>
      send(server.port, BACKUP_EXPORT_PATH, {
        method: 'POST',
        headers: headers({ 'X-AgentLink-Input': 'e30' }),
        body: encodeUtf8(code),
      }),
    read: () =>
      send(server.port, BACKUP_PATH, {
        headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf, 'Sec-Fetch-Site': 'same-origin' },
      }),
    reveal: (more: Record<string, string> = {}, body?: Uint8Array) =>
      send(server.port, BACKUP_REVEAL_PATH, {
        method: 'POST',
        headers: headers(more),
        ...(body === undefined ? {} : { body }),
      }),
  };
}

interface Saved {
  status: string;
  file: string;
  folder: string;
  code: string;
  covers: { name: string; label: string }[];
  notIncluded?: { name: string; label: string; reason: string }[];
  check: string;
}

describe('Back up covers every ID of this owner, one core open at a time (WP-R2b)', () => {
  it('one gesture saves one kit of every keychain ID; at most one KeyStore and store open at every step', async () => {
    const log = vi.spyOn(console, 'log');
    const info = vi.spyOn(console, 'info');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const h = await harness();
    try {
      // Nothing of another ID is opened before the gesture.
      expect(h.ids.log).toEqual(['open default']);
      await h.read();
      expect(h.ids.log).toEqual(['open default']);

      const res = await h.exportKit(world.code);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as Saved;
      expect(body.status).toBe('saved');
      expect(body.covers).toEqual([
        { name: 'default', label: 'default' },
        { name: 'work', label: 'Work' },
      ]);
      // IR L-1: each ID left out with its reason; the one being removed is skipped.
      expect(body.notIncluded).toEqual([
        { name: 'broken', label: 'broken', reason: 'could_not_open' },
        { name: 'files', label: 'Files', reason: 'file_keystore' },
      ]);

      // The KeyStore spy: never two open, the open ID never opened twice, in this exact order.
      expect(h.ids.violations).toEqual([]);
      expect(h.ids.most).toBe(1);
      expect(h.ids.log).toEqual([
        'open default',
        'prepare default',
        'apply default',
        'close default',
        'open work',
        'prepare work',
        'apply work',
        'close work',
        'open default',
        // IR L-4: the seal reads each ID's items with only the open ID open.
        'seal-read default',
        'seal-read work',
      ]);
      expect([...h.ids.open]).toEqual(['default']);
      expect(h.ids.applied.default).toHaveLength(1);
      expect(h.ids.applied.work).toHaveLength(1);
      expect(h.ids.applied.files).toEqual([]);
      const kitId = (h.ids.applied.default[0]?.['params'] as JsonObject)['kitId'];
      expect((h.ids.applied.work[0]?.['params'] as JsonObject)['kitId']).toBe(kitId);

      // One file, both keychain IDs.
      const path = join(h.home, 'Downloads', body.file);
      const kit = await openRecoveryKit(
        new Uint8Array(readFileSync(path)),
        { secret: encodeUtf8(body.code), source: 'prompt' },
        { createStoreSink: () => memorySink([]), expectedOwnerNostr: world.owner.ownerNostr },
      );
      try {
        expect(kit.agents.map((a) => a.agentId).sort()).toEqual([world.agentId, second].sort());
      } finally {
        kit.wipe();
      }

      // The page still shows the same ID: same generation, `default` open.
      const agents = await send(h.server.port, '/api/ui/agents', {
        headers: {
          Cookie: h.headers().Cookie,
          'X-AgentLink-CSRF': h.headers()['X-AgentLink-CSRF'],
          'Sec-Fetch-Site': 'same-origin',
        },
      });
      expect(agents.headers['x-agentlink-generation']).toBe('1');
      expect((JSON.parse(agents.body) as { current: string }).current).toBe('default');

      // Nothing new is logged: no console line, and no event or answer beyond the save itself
      // carries the code, the kit's path, the home folder or an ID's seed.
      const seed = await world.keychain.get(keychainAccount(world.agentId, 'seed'));
      const seed2 = await world.keychain.get(keychainAccount(second, 'seed'));
      const scan = [
        JSON.stringify(h.events),
        ...[log, info, warn, error].flatMap((spy) => spy.mock.calls.map((c) => JSON.stringify(c))),
        readFileSync(join(h.home, '.agentlink', 'kit-record.json'), 'utf8'),
      ].join('\n');
      expect(scan).not.toContain(body.code);
      expect(scan).not.toContain(body.code.replace(/-/g, ''));
      expect(JSON.stringify(h.events)).not.toContain(h.home);
      for (const s of [seed, seed2]) {
        expect(s).not.toBeNull();
        expect(scan).not.toContain(encodeHex(s as Uint8Array));
        expect(scan).not.toContain(encodeBase64url(s as Uint8Array));
      }
      expect(res.body).not.toContain(h.home);
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('a backup.export refused midway: nothing sealed, no record, every opened core closed, the open ID open again', async () => {
    const h = await harness({ refuseWork: true });
    const res = await h.exportKit(world.code);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_applied' });
    expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
    expect(await readKitRecord(join(h.home, '.agentlink'))).toEqual({ status: 'none' });
    expect(readdirSync(join(h.home, '.agentlink')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(h.ids.violations).toEqual([]);
    expect(h.ids.most).toBe(1);
    expect(h.ids.log.slice(-2)).toEqual(['close work', 'open default']);
    expect([...h.ids.open]).toEqual(['default']);
    // The status still says no kit.
    expect(JSON.parse((await h.read()).body)).toMatchObject({ record: 'none', state: 'none' });
  });

  it('a wrong master code opens no other ID and signs nothing', async () => {
    const h = await harness();
    const res = await h.exportKit('AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(res.status).toBe(403);
    expect(h.ids.log).toEqual(['open default']);
    expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
  });

  it('GET /api/ui/backup answers the real record, and it survives a restart', async () => {
    const h = await harness();
    expect(JSON.parse((await h.read()).body)).toEqual({
      export: 'available',
      record: 'none',
      state: 'none',
      lastKit: null,
      missing: null,
    });
    const saved = JSON.parse((await h.exportKit(world.code)).body) as Saved;
    expect(saved.status).toBe('saved');
    const after = JSON.parse((await h.read()).body) as Record<string, unknown>;
    const expected = {
      export: 'available',
      record: 'saved',
      // `files` is an ID of this owner the kit does not cover.
      state: 'out_of_date',
      lastKit: {
        at: expect.any(Number) as number,
        covers: [
          { name: 'default', label: 'default' },
          { name: 'work', label: 'Work' },
        ],
        peopleAtSave: 7,
      },
      missing: {
        ids: [
          { name: 'broken', label: 'broken' },
          { name: 'files', label: 'Files' },
        ],
        people: 0,
      },
    };
    expect(after).toEqual(expected);
    expect(JSON.stringify(after)).not.toContain(h.home);

    // A restart: a new server over the same home and stores reads the same record.
    await Promise.all(servers.splice(0).map((s) => s.close()));
    const again = await harness({ home: h.home, ids: h.ids });
    expect(JSON.parse((await again.read()).body)).toEqual(after);
  });

  it('the answer`s check is the restore engine`s export handle: Check opens exactly that kit, once', async () => {
    const h = await harness();
    const saved = JSON.parse((await h.exportKit(world.code)).body) as Saved;
    const check = () =>
      send(h.server.port, RESTORE_PATHS.check, {
        method: 'POST',
        headers: h.headers({
          'X-AgentLink-Input': encodeBase64url(encodeUtf8(JSON.stringify({ handle: saved.check }))),
        }),
        body: encodeUtf8(saved.code),
      });
    const first = await check();
    expect(first.status).toBe(200);
    const summary = (JSON.parse(first.body) as { summary: { ids: { name: string }[] } }).summary;
    expect(summary.ids.map((i) => i.name).sort()).toEqual(['default', 'work']);
    expect(first.body).not.toContain(saved.code);
    // Single use.
    expect((await check()).status).not.toBe(200);
  });
});

describe('Back up is bounded when another ID does not open (WP-R2b, IR M-1)', () => {
  it('a peer open that hangs: answered within the limit, nothing sealed, the open ID restored, the peer closed when it arrives', async () => {
    let answer: () => void = () => undefined;
    const prompt = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const h = await harness({ hangWork: prompt });
    const started = Date.now();
    const res = await h.exportKit(world.code);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_applied' });
    expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
    expect(await readKitRecord(join(h.home, '.agentlink'))).toEqual({ status: 'none' });
    expect([...h.ids.open]).toEqual(['default']);
    expect(h.ids.applied.work).toEqual([]);
    // Reads work again at once.
    expect((await h.read()).status).toBe(200);
    // The owner answers the prompt later: that ID is opened and closed, never kept or used.
    answer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.ids.log.slice(-2)).toEqual(['open work', 'close work']);
    expect([...h.ids.open]).toEqual(['default']);
    expect(h.ids.log).not.toContain('prepare work');
  });

  it('the open ID cannot be opened again: the kit is saved, the host has none open and a new generation', async () => {
    const h = await harness({ noReopen: true });
    const res = await h.exportKit(world.code);
    expect(res.status).toBe(200);
    expect([...h.ids.open]).toEqual([]);
    expect(h.ids.violations).toEqual([]);
    const agents = await send(h.server.port, '/api/ui/agents', {
      headers: {
        Cookie: h.headers().Cookie,
        'X-AgentLink-CSRF': h.headers()['X-AgentLink-CSRF'],
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    expect(agents.headers['x-agentlink-generation']).toBe('2');
    expect((JSON.parse(agents.body) as { current: string | null }).current).toBeNull();
  });
});

describe('the open ID restarting after a save (WP-R2b, IR round 2)', () => {
  it('a reopen that hangs: the save answers, requests fail closed with a plain restarting answer, then the ID is back', async () => {
    let done: () => void = () => undefined;
    const reopen = new Promise<void>((resolve) => {
      done = resolve;
    });
    const h = await harness({ hangReopen: reopen });
    const started = Date.now();
    const res = await h.exportKit(world.code);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.status).toBe(200);
    const read = () =>
      send(h.server.port, '/api/ui/contacts', {
        headers: {
          Cookie: h.headers().Cookie,
          'X-AgentLink-CSRF': h.headers()['X-AgentLink-CSRF'],
          'Sec-Fetch-Site': 'same-origin',
        },
      });
    const waiting = await read();
    expect(waiting.status).toBe(503);
    expect(JSON.parse(waiting.body)).toEqual({
      status: 'restarting',
      message: 'AgentLink is restarting this ID. Try again in a moment.',
    });
    expect([...h.ids.open]).toEqual([]);
    done();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...h.ids.open]).toEqual(['default']);
    // The ID is open again: the answer is the route's own, no longer "restarting".
    expect((await read()).body).not.toContain('restarting');
    expect(h.ids.violations).toEqual([]);
  });
});

describe('Show in Finder for the recorded kit (WP-R2b)', () => {
  it('takes no presence and no input; reveals only the recorded file, never its path in the answer', async () => {
    const h = await harness();
    const none = await h.reveal();
    expect(none.status).toBe(404);
    expect(h.revealed).toEqual([]);

    const saved = JSON.parse((await h.exportKit(world.code)).body) as Saved;
    const path = join(h.home, 'Downloads', saved.file);
    const shown = await h.reveal();
    expect(shown.status).toBe(200);
    expect(JSON.parse(shown.body)).toEqual({ status: 'shown' });
    expect(h.revealed).toEqual([[path, dirname(path)]]);
    expect(shown.body).not.toContain(h.home);

    // Anything more than the bare request is refused before anything is read.
    for (const res of [
      await h.reveal({ 'X-AgentLink-Input': 'e30' }),
      await h.reveal({ 'X-AgentLink-Presence': 'passkey' }),
      await h.reveal({}, encodeUtf8('{"path":"/etc/passwd"}')),
      await send(h.server.port, `${BACKUP_REVEAL_PATH}?file=x`, {
        method: 'POST',
        headers: h.headers(),
      }),
    ]) {
      expect(res.status).toBe(400);
    }
    expect(h.revealed).toHaveLength(1);
    // The session and CSRF gates still apply.
    const noCsrf = await h.reveal({ 'X-AgentLink-CSRF': 'x' });
    expect(noCsrf.status).toBe(403);
  });

  it('the kit reveal kind is registered once, only at its path', () => {
    const routes = createLocalUiRoutes();
    expect(
      routes
        .routes()
        .filter((r) => r.presence === 'kit-reveal')
        .map((r) => r.path),
    ).toEqual([BACKUP_REVEAL_PATH]);
    expect(() =>
      routes.register({
        method: 'POST',
        path: '/api/ui/other/reveal',
        presence: 'kit-reveal',
        handler: () => Promise.resolve({ status: 200, body: {} }),
      } as never),
    ).toThrow();
  });
});
