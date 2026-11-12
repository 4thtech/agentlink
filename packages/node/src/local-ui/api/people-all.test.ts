// WP-P2 (design-1112 spec §5): `GET /api/ui/people`, every ID's people in one read.
//
// - Read only (`presence: false`); no query; outside the app host `{switchable: false, ids: []}`.
// - Each ID: name, label, current and its rows through the contacts allowlist, or `unavailable`
//   (no reason, no error text) when that ID cannot be read: the others still answer.
// - Names stay counterparty text: a hostile name passes through as plain data, never reaches an
//   error, and nothing beyond the allowlisted fields leaves.
// - The desk opens another ID once per cache window and always closes it again.
import type { ContactView } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
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
const ANA = '0x4c21a0f700000000000000000000000000000002';
const HOSTILE = '<img src=x onerror=alert(1)>‮gnp.exe';

function view(id: string, name: string, over: Partial<ContactView> = {}): ContactView {
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
    ...over,
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

interface Harness {
  readonly deps: PeopleAllDeskDeps;
  readonly opens: string[];
  readonly closes: string[];
  clock: number;
}

function harness(
  others: Record<string, readonly ContactView[] | 'fail' | 'no-open'>,
  entries: readonly PeopleAllEntry[] = [
    entry('default', 'Tali'),
    entry('macbook-agent-1', 'macbook-agent-1'),
  ],
): Harness {
  const h: Harness = {
    opens: [],
    closes: [],
    clock: 1_000_000,
    deps: undefined as unknown as PeopleAllDeskDeps,
  };
  (h as { deps: PeopleAllDeskDeps }).deps = {
    entries: () => Promise.resolve(entries),
    current: () => ({ name: 'default', label: 'Tali' }),
    currentContacts: () => Promise.resolve([view(MARKO, 'Marko Novak')]),
    open: (name) => {
      h.opens.push(name);
      const what = others[name];
      if (what === undefined || what === 'no-open') return Promise.resolve(undefined);
      return Promise.resolve({
        contacts: () =>
          what === 'fail'
            ? Promise.reject(new Error(`/Users/someone/.agentlink/${name}/store.sqlite`))
            : Promise.resolve(what),
        close: () => {
          h.closes.push(name);
          return Promise.resolve();
        },
      });
    },
    now: () => h.clock,
  };
  return h;
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
    const h = harness({});
    const result = await route.handler(ctx(createPeopleAllDesk(h.deps)), req('x=<b>'));
    expect(result).toBe(UI_INVALID_QUERY);
    expect(JSON.stringify(result)).not.toContain('<b>');
  });

  it('answers every ID with its people through the contacts allowlist', async () => {
    const h = harness({ 'macbook-agent-1': [view(ANA, 'oc-test')] });
    const result = await route.handler(ctx(createPeopleAllDesk(h.deps)), req());
    expect(result.status).toBe(200);
    const body = result.body as {
      status: string;
      switchable: boolean;
      ids: { name: string; label: string; current: boolean; status: string; contacts: unknown[] }[];
    };
    expect(body.status).toBe('ok');
    expect(body.switchable).toBe(true);
    expect(body.ids.map((i) => [i.name, i.label, i.current, i.status])).toEqual([
      ['default', 'Tali', true, 'ok'],
      ['macbook-agent-1', 'macbook-agent-1', false, 'ok'],
    ]);
    expect(body.ids[1]?.contacts).toEqual([
      {
        ref: ANA,
        name: 'oc-test',
        nameSource: 'counterparty',
        fingerprint: '7F3A·19C2',
        label: 'self-declared',
        status: 'active',
        pairing: 'complete',
        since: 1_759_449_600,
      },
    ]);
    // Never the card, the raw name, the long fingerprint or a key.
    const text = JSON.stringify(result.body);
    for (const leak of ['RAW ', 'card', '5D0E', 'ee'.repeat(32), 'dd'.repeat(32)]) {
      expect(text).not.toContain(leak);
    }
    // The other ID was opened for the read and closed again.
    expect(h.opens).toEqual(['macbook-agent-1']);
    expect(h.closes).toEqual(['macbook-agent-1']);
  });

  it('an ID that cannot be read is `unavailable` with no reason; the others still answer', async () => {
    const h = harness({ broken: 'fail', locked: 'no-open' }, [
      entry('default', 'Tali'),
      entry('broken', 'Broken'),
      entry('locked', 'Locked'),
    ]);
    const result = await route.handler(ctx(createPeopleAllDesk(h.deps)), req());
    const body = result.body as { ids: Record<string, unknown>[] };
    expect(body.ids).toEqual([
      expect.objectContaining({ name: 'default', status: 'ok' }),
      { name: 'broken', label: 'Broken', current: false, status: 'unavailable' },
      { name: 'locked', label: 'Locked', current: false, status: 'unavailable' },
    ]);
    // The failure's text (a path) never leaves; the opened ID is closed anyway.
    expect(JSON.stringify(result.body)).not.toContain('/Users/');
    expect(h.closes).toEqual(['broken']);
  });

  it('leaves out removing IDs and never opens an unavailable one', async () => {
    const h = harness({ gone: [view(ANA, 'x')] }, [
      entry('default', 'Tali'),
      entry('gone', 'Gone', { removing: true }),
      entry('cfg', 'Cfg', { available: false }),
    ]);
    const result = await route.handler(ctx(createPeopleAllDesk(h.deps)), req());
    const body = result.body as { ids: { name: string; status: string }[] };
    expect(body.ids.map((i) => [i.name, i.status])).toEqual([
      ['default', 'ok'],
      ['cfg', 'unavailable'],
    ]);
    expect(h.opens).toEqual([]);
  });

  it('a hostile name is plain data in the body and the open ID failing is a fixed answer', async () => {
    const h = harness({ 'macbook-agent-1': [view(ANA, HOSTILE)] });
    const desk = createPeopleAllDesk(h.deps);
    const result = await route.handler(ctx(desk), req());
    const body = result.body as { ids: { contacts?: { name: string }[] }[] };
    expect(body.ids[1]?.contacts?.[0]?.name).toBe(HOSTILE);
    // A whole-read failure is the shared fixed answer, never the error's text.
    const failing: LocalUiPeopleAllDesk = {
      list: () => Promise.reject(new Error(`no ${HOSTILE} at /Users/x`)),
    };
    const failed = await route.handler(ctx(failing), req());
    expect(failed).toBe(UI_UNAVAILABLE);
  });

  it('an ID part with a name outside the folder rule is left out', async () => {
    const desk: LocalUiPeopleAllDesk = {
      list: () =>
        Promise.resolve([
          { name: '../etc', label: 'x', current: false, contacts: [] },
          { name: 'ok-id', label: '', current: false, contacts: [] },
        ]),
    };
    const result = await route.handler(ctx(desk), req());
    expect((result.body as { ids: unknown[] }).ids).toEqual([
      { name: 'ok-id', label: 'ok-id', current: false, status: 'ok', contacts: [] },
    ]);
  });
});

describe('createPeopleAllDesk (WP-P2)', () => {
  it('reuses another ID within the cache window and opens it again after', async () => {
    const h = harness({ 'macbook-agent-1': [view(ANA, 'oc-test')] });
    const desk = createPeopleAllDesk({ ...h.deps, cacheMs: 1000 });
    await desk.list();
    await desk.list();
    expect(h.opens).toEqual(['macbook-agent-1']);
    h.clock += 1001;
    await desk.list();
    expect(h.opens).toEqual(['macbook-agent-1', 'macbook-agent-1']);
  });

  it('runs one read at a time (concurrent calls share it)', async () => {
    const h = harness({ 'macbook-agent-1': [view(ANA, 'oc-test')] });
    const desk = createPeopleAllDesk(h.deps);
    const [a, b] = await Promise.all([desk.list(), desk.list()]);
    expect(a).toBe(b);
    expect(h.opens).toEqual(['macbook-agent-1']);
  });

  it('the open ID is read through its own client, never opened again', async () => {
    const h = harness({ default: [view(ANA, 'never')] }, [entry('default', 'Tali')]);
    const out = await createPeopleAllDesk(h.deps).list();
    expect(out.map((p) => [p.name, p.current, p.contacts?.length])).toEqual([['default', true, 1]]);
    expect(h.opens).toEqual([]);
  });

  it('the open ID failing is that ID missing, not the whole read', async () => {
    const h = harness({ 'macbook-agent-1': [view(ANA, 'oc-test')] });
    const desk = createPeopleAllDesk({
      ...h.deps,
      currentContacts: () => Promise.reject(new Error('busy')),
    });
    const out = await desk.list();
    expect(out.map((p) => [p.name, p.contacts === undefined])).toEqual([
      ['default', true],
      ['macbook-agent-1', false],
    ]);
  });
});
