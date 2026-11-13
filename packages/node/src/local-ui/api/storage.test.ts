// REL051-RET1: `GET /api/ui/storage`, the read-only sizes (08 §1 Storage).
//
// - Read only (`presence: false`); no query; outside the app host `{switchable: false, ids: []}`.
// - The open ID: totals, people by restricted display name, "other" for people not in the list.
//   Another ID: totals only; its people are never named and its store is only peeked.
// - Nothing beyond the allowlist leaves: no contact ID, no path, no error text (I-7).
// - Inbox: the folder setting with the home shown as `~`, never the resolved path.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContactView } from '@4thtech-io/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiRequest,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import type { StorageUsage } from '../../storage-usage.js';
import {
  STORAGE_PATH,
  createStorageDesk,
  inboxUsageOf,
  storageRoutes,
  type LocalUiStorageDesk,
  type StorageDeskDeps,
} from './storage.js';

const MARKO = '0x7f3a19c200000000000000000000000000000001';
const GONE = '0x7f3a19c200000000000000000000000000000002';
const HOSTILE = '<img src=x onerror=alert(1)>‮gnp.exe';

function view(id: string, name: string): ContactView {
  return {
    id,
    display: { name, label: 'self-declared', nameSource: 'counterparty' },
    status: 'active',
  } as unknown as ContactView;
}

const usage = (over: Partial<StorageUsage> = {}): StorageUsage => ({
  storeBytes: 5000,
  walBytes: 100,
  messageBytes: 900,
  fileCount: 3,
  fileBytes: 7000,
  perContact: [
    { contactId: MARKO, messageBytes: 600, fileCount: 2, fileBytes: 6000 },
    { contactId: GONE, messageBytes: 200, fileCount: 1, fileBytes: 1000 },
    { contactId: null, messageBytes: 100, fileCount: 0, fileBytes: 0 },
  ],
  ...over,
});

const route = storageRoutes[0] as LocalUiReadRoute;
const req = (query = ''): LocalUiRequest => ({ params: {}, query: new URLSearchParams(query) });
const ctx = (storage?: LocalUiStorageDesk): LocalUiContext =>
  ({
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('not used')),
    now: () => 0,
    ...(storage === undefined ? {} : { storage }),
  }) as unknown as LocalUiContext;

function deps(over: Partial<StorageDeskDeps> = {}): StorageDeskDeps {
  return {
    entries: () =>
      Promise.resolve([
        { name: 'default', label: 'Tali', available: true, removing: false },
        { name: 'second', label: 'Second', available: true, removing: false },
      ]),
    open: () => ({
      name: 'default',
      label: 'Tali',
      generation: 1,
      contacts: () => Promise.resolve([view(MARKO, 'Marko Novak')]),
      dropUsage: () => Promise.resolve({ usedBytes: 10, quotaBytes: 1000 }),
    }),
    generation: () => 1,
    usage: (name) =>
      Promise.resolve(name === 'second' ? usage({ messageBytes: 42, perContact: [] }) : usage()),
    inbox: () =>
      Promise.resolve({
        folder: '~/AgentLink/Inbox',
        scan: { files: 4, bytes: 8000, truncated: false },
      }),
    ...over,
  };
}

describe('GET /api/ui/storage (REL051-RET1)', () => {
  it('is one read route at the fixed path, without presence, registered in the registry', () => {
    expect(storageRoutes).toHaveLength(1);
    expect(route.method).toBe('GET');
    expect(route.path).toBe(STORAGE_PATH);
    expect(route.presence).toBe(false);
    const all = createLocalUiRoutes().routes();
    expect(all.filter((r) => r.path === STORAGE_PATH).map((r) => r.method)).toEqual(['GET']);
  });

  it('outside the app host answers no IDs', async () => {
    expect(await route.handler(ctx(), req())).toEqual({
      status: 200,
      body: { status: 'ok', switchable: false, ids: [], inbox: null },
    });
  });

  it('refuses any query without echoing it', async () => {
    const result = await route.handler(ctx(createStorageDesk(deps())), req('x=<b>'));
    expect(result).toBe(UI_INVALID_QUERY);
    expect(JSON.stringify(result)).not.toContain('<b>');
  });

  it('answers the open ID by person, another ID by totals, and the Inbox', async () => {
    const result = await route.handler(ctx(createStorageDesk(deps())), req());
    expect(result.status).toBe(200);
    const body = result.body as {
      ids: Record<string, unknown>[];
      inbox: unknown;
    };
    expect(body.ids).toHaveLength(2);
    expect(body.ids[0]).toEqual({
      name: 'default',
      label: 'Tali',
      current: true,
      status: 'ok',
      storeBytes: 5000,
      walBytes: 100,
      messageBytes: 900,
      fileCount: 3,
      fileBytes: 7000,
      drop: { usedBytes: 10, quotaBytes: 1000 },
      people: [{ name: 'Marko Novak', messageBytes: 600, fileCount: 2, fileBytes: 6000 }],
      // The person no longer in the list and the rows with no person are counted, never named.
      other: { messageBytes: 300, fileCount: 1, fileBytes: 1000 },
    });
    expect(body.ids[1]).toEqual({
      name: 'second',
      label: 'Second',
      current: false,
      status: 'ok',
      storeBytes: 5000,
      walBytes: 100,
      messageBytes: 42,
      fileCount: 3,
      fileBytes: 7000,
    });
    expect(body.inbox).toEqual({
      folder: '~/AgentLink/Inbox',
      files: 4,
      bytes: 8000,
      truncated: false,
    });
    // No contact ID and no path leaves the server.
    const text = JSON.stringify(result);
    expect(text).not.toContain(MARKO);
    expect(text).not.toContain(GONE);
    expect(text).not.toMatch(/\/Users\/|store\.sqlite/);
  });

  it('only peeks another ID: the open client is asked only for the open ID', async () => {
    const contacts = vi.fn(() => Promise.resolve([view(MARKO, 'Marko')]));
    const usageOf = vi.fn((name: string) => Promise.resolve(name === '' ? undefined : usage()));
    const desk = createStorageDesk(
      deps({
        open: () => ({ name: 'default', label: 'Tali', generation: 1, contacts }),
        usage: usageOf,
      }),
    );
    await route.handler(ctx(desk), req());
    expect(contacts).toHaveBeenCalledTimes(1);
    expect(usageOf.mock.calls.map((c) => c[0]).sort()).toEqual(['default', 'second']);
  });

  it('an ID that cannot be read is `unavailable` with no reason; the others still answer', async () => {
    const desk = createStorageDesk(
      deps({ usage: (name) => Promise.resolve(name === 'second' ? undefined : usage()) }),
    );
    const result = await route.handler(ctx(desk), req());
    const ids = (result.body as { ids: Record<string, unknown>[] }).ids;
    expect(ids[1]).toEqual({
      name: 'second',
      label: 'Second',
      current: false,
      status: 'unavailable',
    });
    expect(ids[0]?.['status']).toBe('ok');
  });

  it('a switch during the read drops the open ID’s people', async () => {
    let gen = 1;
    const desk = createStorageDesk(
      deps({
        generation: () => gen,
        open: () => ({
          name: 'default',
          label: 'Tali',
          generation: 1,
          contacts: () => {
            gen = 2;
            return Promise.resolve([view(MARKO, 'Marko')]);
          },
        }),
      }),
    );
    const result = await route.handler(ctx(desk), req());
    const first = (result.body as { ids: Record<string, unknown>[] }).ids[0];
    expect(first?.['people']).toBeUndefined();
    expect(first?.['messageBytes']).toBe(900);
  });

  it('with no Inbox known the answer is null', async () => {
    const desk = createStorageDesk(deps({ inbox: () => Promise.resolve(undefined) }));
    const result = await route.handler(ctx(desk), req());
    expect((result.body as { inbox: unknown }).inbox).toBeNull();
  });

  it('a stuck read gives up after the time limit (503) and no second read starts meanwhile', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let release: (() => void) | undefined;
      const desk = createStorageDesk(
        deps({
          timeoutMs: 1000,
          entries: () => {
            calls += 1;
            if (calls > 1) return Promise.resolve([]);
            return new Promise((resolve) => {
              release = () => resolve([]);
            });
          },
        }),
      );
      const first = route.handler(ctx(desk), req());
      await vi.advanceTimersByTimeAsync(1001);
      expect(await first).toBe(UI_UNAVAILABLE);
      const second = route.handler(ctx(desk), req());
      await vi.advanceTimersByTimeAsync(1001);
      expect(await second).toBe(UI_UNAVAILABLE);
      expect(calls).toBe(1);
      release?.();
      await vi.advanceTimersByTimeAsync(1);
      expect((await route.handler(ctx(desk), req())).status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a switch during the read drops the Inbox too', async () => {
    let gen = 1;
    const desk = createStorageDesk(
      deps({
        generation: () => gen,
        inbox: () => {
          gen = 2;
          return Promise.resolve({
            folder: '~/AgentLink/Inbox',
            scan: { files: 1, bytes: 1, truncated: false },
          });
        },
      }),
    );
    const result = await route.handler(ctx(desk), req());
    expect((result.body as { inbox: unknown }).inbox).toBeNull();
  });

  it('a hostile name is plain data; a whole-read failure is the fixed answer', async () => {
    const ok = createStorageDesk(
      deps({
        open: () => ({
          name: 'default',
          label: 'Tali',
          generation: 1,
          contacts: () => Promise.resolve([view(MARKO, HOSTILE)]),
        }),
      }),
    );
    const result = await route.handler(ctx(ok), req());
    const people = (
      (result.body as { ids: { people: { name: string }[] }[] }).ids[0] as {
        people: { name: string }[];
      }
    ).people;
    expect(people[0]?.name).toBe(HOSTILE);
    const failing: LocalUiStorageDesk = {
      list: () => Promise.reject(new Error('/Users/x/.agentlink/agents/a/store.sqlite Marko')),
    };
    const failed = await route.handler(ctx(failing), req());
    expect(failed).toBe(UI_UNAVAILABLE);
    expect(JSON.stringify(failed)).not.toContain('Marko');
  });

  it('a part with a name outside the folder rule is left out', async () => {
    const desk = createStorageDesk(
      deps({
        entries: () =>
          Promise.resolve([
            { name: '../etc', label: 'x', available: true, removing: false },
            { name: 'default', label: 'Tali', available: true, removing: false },
            { name: 'gone', label: 'Gone', available: true, removing: true },
          ]),
      }),
    );
    const ids = ((await route.handler(ctx(desk), req())).body as { ids: { name: string }[] }).ids;
    expect(ids.map((i) => i.name)).toEqual(['default']);
  });
});

describe('inboxUsageOf', () => {
  let home: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'agentlink-ret1-inbox-')));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const client = (inboxFolder: unknown, mode = 'ok'): LocalUiReadClient =>
    ({
      policy: { load: () => Promise.resolve({ mode, policy: { files: { inboxFolder } } }) },
    }) as unknown as LocalUiReadClient;

  it('measures the Inbox folder and shows the home folder as ~', async () => {
    const inbox = join(home, 'AgentLink', 'Inbox');
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, 'a.txt'), Buffer.alloc(123));
    const result = await inboxUsageOf(client(inbox), home);
    expect(result).toEqual({
      folder: '~/AgentLink/Inbox',
      scan: { files: 1, bytes: 123, truncated: false },
    });
  });

  it('is undefined with no client, rules that fail closed or a bad setting', async () => {
    expect(await inboxUsageOf(undefined, home)).toBeUndefined();
    expect(await inboxUsageOf(client(join(home, 'x'), 'fail_closed'), home)).toBeUndefined();
    expect(await inboxUsageOf(client(42), home)).toBeUndefined();
    // A file where the folder should be cannot be read as a folder.
    writeFileSync(join(home, 'afile'), 'x');
    expect(await inboxUsageOf(client(join(home, 'afile')), home)).toBeUndefined();
  });

  // REL051-R2C (R2-UI-03): nothing saved yet is 0 files, not "could not be read".
  it('a folder that does not exist yet holds no files', async () => {
    expect(await inboxUsageOf(client('~/AgentLink/Inbox'), home)).toEqual({
      folder: '~/AgentLink/Inbox',
      scan: { files: 0, bytes: 0, truncated: false },
    });
  });
});
