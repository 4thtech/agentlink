// WP-P2 (design-1112 spec §5): `GET /api/ui/people`, every ID in one read.
//
// - Read only (`presence: false`); no query; outside the app host `{switchable: false, ids: []}`.
// - The open ID: its rows through the contacts allowlist. Every other ID: only a count from the
//   read-only store peek; no KeyStore, client or store of another ID is opened (04 §2.5).
// - A switch during the read drops the open ID's rows (never one ID's people "with" another).
// - One read at a time, given up after the time limit (503), so a stuck read never pins the route.
// - Hostile names are plain data and never reach an error; nothing beyond the allowlist leaves.
import type { ContactView } from '@4thtech-io/core';
import { describe, expect, it, vi } from 'vitest';
import type { LocalUiContext } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiRequest,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import {
  PEOPLE_ALL_PATH,
  createPeopleAllDesk,
  peopleAllRoutes,
  type LocalUiPeopleAllDesk,
  type PeopleAllDeskDeps,
  type PeopleAllEntry,
} from './people-all.js';

const MARKO = '0x7f3a19c200000000000000000000000000000001';
const HOSTILE = '<img src=x onerror=alert(1)>‮gnp.exe';

function view(id: string, name: string): ContactView {
  return {
    agentNostr: 'ee'.repeat(32),
    name: { value: `RAW ${name}`, source: 'counterparty', selfDeclared: true },
    display: { name, label: 'self-declared', nameSource: 'counterparty' },
    card: { agentEvm: id, agentNostr: 'ee'.repeat(32), ownerNostr: 'dd'.repeat(32), name },
    keyEpoch: 0,
    ownerFingerprint: { short: '7F3A·19C2', long: '7F3A·19C2·5D0E·88B1' },
    status: 'active',
    pairing: 'complete',
    safetyCodeChecked: false,
    createdAt: 1_759_449_600,
    updatedAt: 1_759_449_600,
    id,
  } as unknown as ContactView;
}

const route = peopleAllRoutes[0] as LocalUiReadRoute;
const req = (query = ''): LocalUiRequest => ({ params: {}, query: new URLSearchParams(query) });
const ctx = (peopleAll?: LocalUiPeopleAllDesk): LocalUiContext =>
  ({
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('not used')),
    now: () => 0,
    ...(peopleAll === undefined ? {} : { peopleAll }),
  }) as unknown as LocalUiContext;

const entry = (
  name: string,
  label: string,
  over: Partial<PeopleAllEntry> = {},
): PeopleAllEntry => ({
  name,
  label,
  available: true,
  removing: false,
  ...over,
});

function deps(over: Partial<PeopleAllDeskDeps> = {}): PeopleAllDeskDeps {
  return {
    entries: () =>
      Promise.resolve([entry('default', 'Tali'), entry('macbook-agent-1', 'macbook-agent-1')]),
    open: () => ({
      name: 'default',
      label: 'Tali',
      generation: 1,
      contacts: () => Promise.resolve([view(MARKO, 'Marko Novak')]),
    }),
    generation: () => 1,
    count: (name) => Promise.resolve(name === 'macbook-agent-1' ? 1 : undefined),
    ...over,
  };
}

describe('GET /api/ui/people (WP-P2)', () => {
  it('is one read route at the fixed path, without presence, registered in the registry', () => {
    expect(peopleAllRoutes).toHaveLength(1);
    expect(route.method).toBe('GET');
    expect(route.path).toBe(PEOPLE_ALL_PATH);
    expect(route.presence).toBe(false);
    const all = createLocalUiRoutes().routes();
    expect(all.filter((r) => r.path === PEOPLE_ALL_PATH).map((r) => r.method)).toEqual(['GET']);
  });

  it('outside the app host answers no IDs (the page keeps its one-ID list)', async () => {
    const result = await route.handler(ctx(), req());
    expect(result).toEqual({ status: 200, body: { status: 'ok', switchable: false, ids: [] } });
  });

  it('refuses any query without echoing it', async () => {
    const result = await route.handler(ctx(createPeopleAllDesk(deps())), req('x=<b>'));
    expect(result).toBe(UI_INVALID_QUERY);
    expect(JSON.stringify(result)).not.toContain('<b>');
  });

  it('the open ID answers rows through the allowlist; another ID only its count', async () => {
    const result = await route.handler(ctx(createPeopleAllDesk(deps())), req());
    expect(result).toEqual({
      status: 200,
      body: {
        status: 'ok',
        switchable: true,
        ids: [
          {
            name: 'default',
            label: 'Tali',
            current: true,
            status: 'ok',
            contacts: [
              {
                ref: MARKO,
                name: 'Marko Novak',
                nameSource: 'counterparty',
                fingerprint: '7F3A·19C2',
                label: 'self-declared',
                status: 'active',
                pairing: 'complete',
                since: 1_759_449_600,
              },
            ],
          },
          {
            name: 'macbook-agent-1',
            label: 'macbook-agent-1',
            current: false,
            status: 'ok',
            count: 1,
          },
        ],
      },
    });
    const text = JSON.stringify(result.body);
    for (const leak of ['RAW ', 'card', '5D0E', 'ee'.repeat(32), 'dd'.repeat(32)]) {
      expect(text).not.toContain(leak);
    }
  });

  it('never opens another ID: only the peek count is asked for it, the open client only for the open ID', async () => {
    const count = vi.fn((name: string) => Promise.resolve(name === 'work' ? 4 : 0));
    const contacts = vi.fn(() => Promise.resolve([view(MARKO, 'Marko')]));
    const open = vi.fn(() => ({ name: 'default', label: 'Tali', generation: 1, contacts }));
    const desk = createPeopleAllDesk(
      deps({
        entries: () => Promise.resolve([entry('default', 'Tali'), entry('work', 'Work')]),
        open,
        count,
      }),
    );
    await desk.list();
    expect(count.mock.calls).toEqual([['work']]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(contacts).toHaveBeenCalledTimes(1);
    // The desk's deps have no way to open another ID: no KeyStore, client or store method exists.
    expect(Object.keys(deps()).sort()).toEqual(['count', 'entries', 'generation', 'open']);
  });

  it('an ID that cannot be read is `unavailable` with no reason; the others still answer', async () => {
    const desk = createPeopleAllDesk(
      deps({
        entries: () =>
          Promise.resolve([
            entry('default', 'Tali'),
            entry('broken', 'Broken'),
            entry('cfg', 'Cfg', { available: false }),
            entry('gone', 'Gone', { removing: true }),
          ]),
        count: (name) =>
          name === 'broken'
            ? Promise.reject(new Error('/Users/someone/.agentlink/broken/store.sqlite'))
            : Promise.resolve(3),
      }),
    );
    const result = await route.handler(ctx(desk), req());
    expect((result.body as { ids: unknown[] }).ids).toEqual([
      expect.objectContaining({ name: 'default', status: 'ok' }),
      { name: 'broken', label: 'Broken', current: false, status: 'unavailable' },
      { name: 'cfg', label: 'Cfg', current: false, status: 'unavailable' },
    ]);
    expect(JSON.stringify(result.body)).not.toContain('/Users/');
  });

  it('a switch during the read drops the open ID’s rows (never shown with another ID)', async () => {
    let generation = 1;
    const desk = createPeopleAllDesk(
      deps({
        generation: () => generation,
        open: () => ({
          name: 'default',
          label: 'Tali',
          generation: 1,
          contacts: () => {
            generation = 2; // the switch lands while the rows are read
            return Promise.resolve([view(MARKO, 'Someone of the next ID')]);
          },
        }),
      }),
    );
    const result = await route.handler(ctx(desk), req());
    const body = result.body as { ids: Record<string, unknown>[] };
    expect(body.ids[0]).toEqual({
      name: 'default',
      label: 'Tali',
      current: true,
      status: 'unavailable',
    });
    expect(JSON.stringify(result.body)).not.toContain('Someone of the next ID');
  });

  it('a stuck read gives up after the time limit (503) and the next read runs again', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const desk = createPeopleAllDesk(
        deps({
          timeoutMs: 1000,
          entries: () => {
            calls += 1;
            return calls === 1 ? new Promise(() => undefined) : Promise.resolve([]);
          },
        }),
      );
      const first = route.handler(ctx(desk), req());
      await vi.advanceTimersByTimeAsync(1001);
      expect(await first).toBe(UI_UNAVAILABLE);
      const second = await route.handler(ctx(desk), req());
      expect(second.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs one read at a time (concurrent calls share it)', async () => {
    const count = vi.fn(() => Promise.resolve(1));
    const desk = createPeopleAllDesk(deps({ count }));
    const [a, b] = await Promise.all([desk.list(), desk.list()]);
    expect(a).toBe(b);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('a hostile name is plain data; a whole-read failure is the fixed answer', async () => {
    const desk = createPeopleAllDesk(
      deps({
        open: () => ({
          name: 'default',
          label: HOSTILE,
          generation: 1,
          contacts: () => Promise.resolve([view(MARKO, HOSTILE)]),
        }),
      }),
    );
    const result = await route.handler(ctx(desk), req());
    const body = result.body as { ids: { label: string; contacts?: { name: string }[] }[] };
    expect(body.ids[0]?.label).toBe(HOSTILE);
    expect(body.ids[0]?.contacts?.[0]?.name).toBe(HOSTILE);
    const failing: LocalUiPeopleAllDesk = {
      list: () => Promise.reject(new Error(`no ${HOSTILE} at /Users/x`)),
    };
    expect(await route.handler(ctx(failing), req())).toBe(UI_UNAVAILABLE);
  });

  it('a part with a name outside the folder rule or a bad count is left out or unavailable', async () => {
    const desk: LocalUiPeopleAllDesk = {
      list: () =>
        Promise.resolve([
          { name: '../etc', label: 'x', current: false, count: 1 },
          { name: 'ok-id', label: '', current: false, count: -1 },
        ]),
    };
    const result = await route.handler(ctx(desk), req());
    expect((result.body as { ids: unknown[] }).ids).toEqual([
      { name: 'ok-id', label: 'ok-id', current: false, status: 'unavailable' },
    ]);
  });
});
