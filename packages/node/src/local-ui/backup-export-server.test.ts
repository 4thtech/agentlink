// WP-11 (F-1 full; D-117 A; 04 §2.3.3 "Export: who sees the seeds", §2.5.1 `backup.export`; 08 §1
// Backup): the recovery kit is saved from the local app, behind owner presence, through the approval
// server's real presence gate, the real owner store (unlockForExport) and the real KeyExportControl.
//
// - `GET /api/ui/backup` says whether this ID can save a kit here (a keychain ID in the app host).
// - `POST /api/ui/backup/export` (presence): core prepares one `backup.export` for the open ID, the
//   gate signs it, core applies it (its nonce row is the audit record), and only then the export
//   control seals the owner seed, the ID's KeyStore items and its store snapshot as `ALKK` v1 into a
//   new 0600 file in the Downloads folder. The page gets the file name and the new recovery code,
//   once. A wrong code or no code seals and signs nothing.
// - The generic one-use `sign` of every other presence route never signs a `backup.export`.
// - Nothing leaves this computer: no event carries the code, and nothing is written under
//   ~/.agentlink.
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  buildOwnerActionBody,
  newOwnerActionNonce,
  type OwnerActionOutcome,
} from '@4thtech-io/core';
import {
  encodeHex,
  encodeUtf8,
  type JsonObject,
  type RecoveryKitStoreSink,
} from '@4thtech-io/crypto';
import { openRecoveryKit } from '@4thtech-io/crypto/keystore';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
  type ApprovalServerSource,
} from '../approval-server.js';
import { ownerSigValid, ownerWorld, send, type OwnerWorld } from '../approval-ui.fixture.js';
import { TEST_APP } from '../local-ui-app.fixture.js';
import { KeychainOwnerKeyStore } from '../owner-keystore.js';
import type { LocalUiOwnerRoute, LocalUiRoute } from './route-types.js';
import { BACKUP_EXPORT_PATH, BACKUP_PATH, createLocalUiRoutes } from './routes.js';

const KDF = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-wp11-backup-');
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

function registryWith(extra: readonly LocalUiRoute[]) {
  const routes = createLocalUiRoutes();
  for (const route of extra) routes.register(route);
  return routes;
}

let homes = 0;
async function harness(
  over: {
    downloads?: boolean;
    recoveryKit?: false;
    routes?: readonly LocalUiRoute[];
  } = {},
) {
  homes += 1;
  const home = join(world.root, `home-${homes}`);
  const agentDir = join(home, '.agentlink', 'agents', 'default');
  mkdirSync(agentDir, { recursive: true });
  if (over.downloads !== false) mkdirSync(join(home, 'Downloads'));
  const storePath = join(agentDir, 'store.sqlite');
  const db = new Database(storePath);
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
  db.close();

  const state = { applied: [] as JsonObject[] };
  const client = {
    agentId: world.agentId,
    ownerActions: {
      loadLabel: () => Promise.resolve({ status: 'verified', label: 'Personal' }),
      prepareBackupExport: (kitId: string, contents: 'full' | 'identity') => {
        const issuedAt = Math.floor(Date.now() / 1000);
        const { body, jcs } = buildOwnerActionBody({
          agent: world.agentId,
          owner: encodeHex(world.owner.ownerNostr),
          op: 'backup.export',
          params: { kitId, contents },
          nonce: newOwnerActionNonce(),
          issuedAt,
          expiresAt: issuedAt + 600,
        } as never);
        return Promise.resolve({ status: 'prepared', op: 'backup.export', body, jcs });
      },
    },
  };
  const source: ApprovalServerSource = {
    context: () => Promise.resolve({ agent: world.agentId, owner: world.owner }),
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(undefined),
    apply: (signed) => {
      const body = signed.body as JsonObject;
      if (body['op'] !== 'backup.export' || !ownerSigValid(world.owner, body, signed.sig)) {
        return Promise.resolve({ status: 'refused', op: 'backup.export', reason: 'x' } as never);
      }
      state.applied.push(body);
      return Promise.resolve({ status: 'applied', op: 'backup.export' } as OwnerActionOutcome);
    },
  };
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const server = await startApprovalServerWith(
    {
      source,
      onEvent: (event) => void events.push(event),
      localUi: {
        assets: TEST_APP,
        client: client as never,
        ...(over.recoveryKit === false
          ? {}
          : {
              recoveryKit: {
                agentId: world.agentId,
                name: 'default',
                storePath,
                home,
                kdf: KDF,
              },
            }),
      },
    },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      ...(over.routes === undefined ? {} : { routes: registryWith(over.routes) }),
    },
  );
  servers.push(server);
  await server.open();
  const token = new URL(opened[0] ?? '').searchParams.get('t') ?? '';
  const login = await send(server.port, `/?t=${token}`);
  const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
  const page = await send(server.port, '/', { headers: { Cookie: cookie } });
  const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1] ?? '';
  const post = (path: string, code: string) =>
    send(server.port, path, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: server.origin,
        'X-AgentLink-CSRF': csrf,
        'Content-Type': 'application/octet-stream',
        'Sec-Fetch-Site': 'same-origin',
        'X-AgentLink-Input': 'e30', // base64url of `{}`
      },
      body: encodeUtf8(code),
    });
  const read = () =>
    send(server.port, BACKUP_PATH, {
      headers: { Cookie: cookie, 'X-AgentLink-CSRF': csrf, 'Sec-Fetch-Site': 'same-origin' },
    });
  return {
    home,
    state,
    events,
    exportKit: (code: string) => post(BACKUP_EXPORT_PATH, code),
    post,
    read,
  };
}

const KIT_NAME = /^agentlink-recovery-kit-\d{4}-\d{2}-\d{2}(?:-\d{1,2})?\.alkk$/;
const CODE = /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$/;

describe('Save a recovery kit from the app (WP-11, F-1, D-117 A)', () => {
  it('GET /api/ui/backup says the kit can be saved here', async () => {
    const h = await harness();
    const res = await h.read();
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ export: 'available' });
  });

  it('with the owner code: signs and applies one backup.export, then writes an ALKK kit that opens with the code shown', async () => {
    const h = await harness();
    const res = await h.exportKit(world.code);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      status: string;
      file: string;
      folder: string;
      code: string;
    };
    expect(body.status).toBe('saved');
    expect(body.file).toMatch(KIT_NAME);
    expect(body.folder).toBe('Downloads');
    expect(body.code).toMatch(CODE);

    // The audit record first: one backup.export for this ID, signed by the owner, applied by core.
    expect(h.state.applied).toHaveLength(1);
    const action = h.state.applied[0] as JsonObject;
    expect(action).toMatchObject({ op: 'backup.export', agent: world.agentId });
    const params = action['params'] as JsonObject;
    expect(params['contents']).toBe('full');
    expect(params['kitId']).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // The kit: in Downloads, 0600, sealed under the code the page got, with this owner and this ID.
    const path = join(h.home, 'Downloads', body.file);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const store: Uint8Array[] = [];
    const kit = await openRecoveryKit(
      new Uint8Array(readFileSync(path)),
      { secret: encodeUtf8(body.code), source: 'prompt' },
      { createStoreSink: () => memorySink(store), expectedOwnerNostr: world.owner.ownerNostr },
    );
    try {
      expect(kit.agents.map((a) => a.agentId)).toEqual([world.agentId]);
      expect(kit.agents[0]?.items.map((i) => i.name).slice(0, 2)).toEqual(['seed', 'store-key']);
      expect(encodeHex(kit.kitId)).toBeDefined();
      expect(store.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(0);
    } finally {
      kit.wipe();
    }

    // Nothing under ~/.agentlink but the ID's own folder; no event carries the code.
    expect(readdirSync(join(h.home, '.agentlink'))).toEqual(['agents']);
    expect(JSON.stringify(h.events)).not.toContain(body.code);
    expect(JSON.stringify(h.events)).not.toContain(body.code.replace(/-/g, ''));
  });

  it('a second kit gets its own file and its own new code; the first is never replaced', async () => {
    const h = await harness();
    const first = JSON.parse((await h.exportKit(world.code)).body) as {
      file: string;
      code: string;
    };
    const before = readFileSync(join(h.home, 'Downloads', first.file));
    const second = JSON.parse((await h.exportKit(world.code)).body) as {
      file: string;
      code: string;
    };
    expect(second.file).toMatch(KIT_NAME);
    expect(second.file).not.toBe(first.file);
    expect(second.code).not.toBe(first.code);
    expect(readFileSync(join(h.home, 'Downloads', first.file))).toEqual(before);
    expect(h.state.applied).toHaveLength(2);
  });

  it('no Downloads folder: the kit goes to the home folder', async () => {
    const h = await harness({ downloads: false });
    const body = JSON.parse((await h.exportKit(world.code)).body) as {
      file: string;
      folder: string;
    };
    expect(body.folder).toBe('Home');
    expect(statSync(join(h.home, body.file)).isFile()).toBe(true);
  });

  it('a wrong owner code signs nothing and writes no kit', async () => {
    const h = await harness();
    const res = await h.exportKit('AAAA BBBB CCCC DDDD EEEE FFFF');
    expect(res.status).toBe(403);
    expect(h.state.applied).toEqual([]);
    expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
  });

  it('no presence proof at all: refused, nothing signed or written', async () => {
    const h = await harness();
    const res = await h.exportKit('');
    expect(res.status).toBe(403);
    expect(h.state.applied).toEqual([]);
    expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
  });

  it('an ID that cannot save a kit here: not_available before the gesture', async () => {
    const h = await harness({ recoveryKit: false });
    expect(JSON.parse((await h.read()).body)).toEqual({ export: 'not_available' });
    const res = await h.exportKit(world.code);
    expect(res.status).toBe(501);
    expect(h.state.applied).toEqual([]);
    expect(readdirSync(join(h.home, 'Downloads'))).toEqual([]);
  });

  it('no other route can ask for an export session', () => {
    const routes = createLocalUiRoutes();
    expect(() =>
      routes.register({
        method: 'POST',
        path: '/api/ui/other/export',
        presence: true,
        recoveryKit: true,
        handler: () => Promise.resolve({ status: 200, body: {} }),
      }),
    ).toThrow(/only the recovery-kit export route/);
  });

  it('the one-use sign of any other presence route never signs a backup.export', async () => {
    const sneaky: LocalUiOwnerRoute = {
      method: 'POST',
      path: '/api/ui/sneaky',
      presence: true,
      handler: async (_context, _request, owner) => {
        const issuedAt = Math.floor(Date.now() / 1000);
        const { body } = buildOwnerActionBody({
          agent: world.agentId,
          owner: encodeHex(world.owner.ownerNostr),
          op: 'backup.export',
          params: { kitId: 'AAAAAAAAAAAAAAAAAAAAAA', contents: 'full' },
          nonce: newOwnerActionNonce(),
          issuedAt,
          expiresAt: issuedAt + 600,
        } as never);
        await owner.sign({ lines: ['Save a recovery kit'] }, [
          { kind: 'owner-action', action: body as unknown as JsonObject },
        ]);
        return { status: 200, body: { status: 'signed' } };
      },
    };
    const h = await harness({ routes: [sneaky] });
    const res = await h.post('/api/ui/sneaky', world.code);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'refused' });
  });
});
