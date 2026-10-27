// MSG-FILES-IO-d: the Files page's Received and Sent API (08 §1; plan
// docs/process/proposals/MSG-FILES-IO.md §3, §4; 04 §2.5, §4; I-4, I-5, I-7).
//
// - `GET /api/ui/files/received` and `GET /api/ui/files/sent` are read routes (`presence: false`):
//   they read core's `client.filesIo` through the read-only client view and change nothing.
// - Each item is an exact allowlist. Never a file key, a link (drop or presigned URL), a locator, a
//   hash or a path: "saved as" is the single file name only, and only on a `saved` item.
// - One item that does not fit its allowlist is left out; the rest of the page still shows.
// - Paging: `limit` 1 to 100 (default 20), an opaque `cursor` of at most 256 characters, nothing
//   else. Errors are fixed codes and never echo the input or an error's text.
// - The session, CSRF and fetch-metadata gate is the server's (local-ui-server.test.ts); the
//   existing `/api/ui/files` routes are unchanged (files.test.ts).
import {
  CoreError,
  type Page,
  type PageQuery,
  type ReceivedFileItem,
  type SentFileItem,
} from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import { readOnlyClient, type LocalUiContext, type LocalUiReadClient } from '../context.js';
import { UI_NOT_SET_UP, type LocalUiReadRoute, type LocalUiResult } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { filesIoRoutes } from './files-io.js';

const ENV_A = 'a1'.repeat(32);
const ENV_B = 'b2'.repeat(32);
const SECRET_URL = 'https://drop.example.net/o/abc?X-Amz-Signature=deadbeef';
const FILE_KEY = 'k'.repeat(43);
const ABS_PATH = '/Users/someone/AgentLink/Inbox/report.pdf';

const marko = { name: 'Marko Novak', label: 'self-declared', nameSource: 'counterparty' } as const;

type Over<T> = { [K in keyof T]?: T[K] | undefined };

function receivedItem(over: Over<ReceivedFileItem> = {}): ReceivedFileItem {
  return {
    id: `${ENV_A}.00`,
    from: marko as never,
    at: 1_761_000_000,
    name: 'report.pdf',
    size: 50_000,
    state: 'saved',
    savedName: 'report (1).pdf',
    proof: true,
    ...over,
  } as ReceivedFileItem;
}

function sentItem(over: Over<SentFileItem> = {}): SentFileItem {
  return {
    id: `${ENV_B}.01`,
    to: marko as never,
    at: 1_761_000_100,
    name: 'plan.md',
    size: 1_200,
    status: 'sent',
    receipt: true,
    state: 'available',
    expiresAt: 1_761_600_000,
    ...over,
  } as SentFileItem;
}

type FilesIo = LocalUiReadClient['filesIo'];

function contextWith(filesIo: Partial<FilesIo> | undefined): LocalUiContext {
  const client =
    filesIo === undefined ? undefined : ({ agentId: 'a', filesIo } as unknown as LocalUiReadClient);
  return {
    client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => 0,
  };
}

const route = (path: string): LocalUiReadRoute =>
  filesIoRoutes.find((r) => r.path === path) as LocalUiReadRoute;
const RECEIVED = '/api/ui/files/received';
const SENT = '/api/ui/files/sent';

const call = (path: string, context: LocalUiContext, query = ''): Promise<LocalUiResult> =>
  route(path).handler(context, { params: {}, query: new URLSearchParams(query) });

const pageOf = <T>(items: T[], nextCursor?: string): Promise<Page<T>> =>
  Promise.resolve(nextCursor === undefined ? { items } : { items, nextCursor });

const bodyOf = (res: LocalUiResult) =>
  res.body as { items: Record<string, unknown>[]; nextCursor?: string; error?: string };

describe('GET /api/ui/files/received and /sent: registration (MSG-FILES-IO-d)', () => {
  it('are read routes without presence, registered in the default registry', () => {
    for (const path of [RECEIVED, SENT]) {
      expect(route(path)).toMatchObject({ method: 'GET', path, presence: false });
      const match = createLocalUiRoutes().match('GET', path);
      expect(match).not.toBe('method');
      expect(match).toBeDefined();
      expect(createLocalUiRoutes().match('POST', path)).toBe('method');
    }
    expect(filesIoRoutes.every((r) => r.method === 'GET' && r.presence === false)).toBe(true);
    expect(filesIoRoutes).toHaveLength(2);
  });

  it('keeps the existing /api/ui/files routes', () => {
    const routes = createLocalUiRoutes();
    expect(routes.match('GET', '/api/ui/files')).toMatchObject({
      route: { path: '/api/ui/files' },
    });
    expect(routes.match('GET', '/api/ui/files/review')).toMatchObject({
      route: { path: '/api/ui/files/review' },
    });
    expect(routes.match('POST', '/api/ui/files/folders')).toMatchObject({
      route: { path: '/api/ui/files/folders', presence: true },
    });
  });

  it('the read-only client view carries filesIo with only its two reads', async () => {
    const calls: string[] = [];
    const full = {
      agentId: 'agent-1',
      getProof: () => Promise.resolve(undefined),
      filesIo: {
        received: (q: unknown) => {
          calls.push(`received ${JSON.stringify(q)}`);
          return pageOf([]);
        },
        sent: (q: unknown) => {
          calls.push(`sent ${JSON.stringify(q)}`);
          return pageOf([]);
        },
      },
      fetchFile: () => Promise.reject(new Error('never')),
      sendMessage: () => Promise.reject(new Error('never')),
    };
    const view = readOnlyClient(full as never);
    expect(Object.keys(view.filesIo).sort()).toEqual(['received', 'sent']);
    expect(view.filesIo).not.toBe(full.filesIo);
    expect(Object.isFrozen(view.filesIo)).toBe(true);
    expect((view as unknown as Record<string, unknown>)['fetchFile']).toBeUndefined();
    await view.filesIo.received({ limit: 2 });
    await view.filesIo.sent({ limit: 3, cursor: 'c' });
    expect(calls).toEqual(['received {"limit":2}', 'sent {"limit":3,"cursor":"c"}']);
  });
});

describe('GET /api/ui/files/received (MSG-FILES-IO-d)', () => {
  it('answers the exact allowlist, "saved as" only as one file name on a saved item', async () => {
    const seen: PageQuery[] = [];
    const ctx = contextWith({
      received: (q) => {
        seen.push(q);
        return pageOf(
          [
            receivedItem(),
            receivedItem({
              id: `${ENV_B}.02`,
              state: 'not_saved',
              savedName: undefined,
              proof: false,
            }),
          ],
          'next-1',
        );
      },
    });
    const res = await call(RECEIVED, ctx);
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ limit: 20 }]);
    const body = bodyOf(res);
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    expect(body.nextCursor).toBe('next-1');
    expect(body.items[0]).toEqual({
      id: `${ENV_A}.00`,
      from: 'Marko Novak',
      at: 1_761_000_000,
      name: 'report.pdf',
      size: 50_000,
      state: 'saved',
      savedName: 'report (1).pdf',
      proof: true,
    });
    expect(Object.keys(body.items[1] ?? {}).sort()).toEqual([
      'at',
      'from',
      'id',
      'name',
      'proof',
      'size',
      'state',
    ]);
  });

  it('never returns a key, a link, a locator, a hash or a path, even when core carries one', async () => {
    const leaky = {
      ...receivedItem(),
      url: SECRET_URL,
      fileKey: FILE_KEY,
      locator: { bucket: 'b', key: 'k' },
      sha256: 'cd'.repeat(32),
      savedTo: ABS_PATH,
      envelope_json: '{}',
    } as unknown as ReceivedFileItem;
    const res = await call(RECEIVED, contextWith({ received: () => pageOf([leaky]) }));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const bad of [
      SECRET_URL,
      FILE_KEY,
      'bucket',
      'cd'.repeat(32),
      ABS_PATH,
      'envelope_json',
    ]) {
      expect(text).not.toContain(bad);
    }
    expect(Object.keys(bodyOf(res).items[0] ?? {}).sort()).toEqual([
      'at',
      'from',
      'id',
      'name',
      'proof',
      'savedName',
      'size',
      'state',
    ]);
  });

  it('drops a "saved as" that is not a single file name, or that rides on an unsaved item', async () => {
    const res = await call(
      RECEIVED,
      contextWith({
        received: () =>
          pageOf([
            receivedItem({ id: `${ENV_A}.00`, savedName: ABS_PATH }),
            receivedItem({ id: `${ENV_A}.01`, savedName: '..\\secret.txt' }),
            receivedItem({ id: `${ENV_A}.02`, state: 'expired', savedName: 'old.pdf' }),
            receivedItem({ id: `${ENV_A}.03`, savedName: '' }),
          ]),
      }),
    );
    const items = bodyOf(res).items;
    expect(items).toHaveLength(4);
    for (const item of items) expect(item).not.toHaveProperty('savedName');
    expect(items[2]?.state).toBe('expired');
    expect(JSON.stringify(res.body)).not.toContain('Users');
  });

  it('shows every state, including expired and deleted from retention', async () => {
    const states = ['saved', 'not_saved', 'expired', 'deleted'] as const;
    const res = await call(
      RECEIVED,
      contextWith({
        received: () =>
          pageOf(
            states.map((state, i) =>
              receivedItem({
                id: `${ENV_A}.0${String(i)}`,
                state: state as ReceivedFileItem['state'],
                ...(state === 'saved' ? {} : { savedName: undefined }),
              }),
            ),
          ),
      }),
    );
    expect(bodyOf(res).items.map((i) => i.state)).toEqual([...states]);
  });

  it('leaves out an item outside its allowlist and still shows the rest', async () => {
    const good = receivedItem({ id: `${ENV_B}.00` });
    const bad: unknown[] = [
      receivedItem({ id: '../etc/passwd' }),
      receivedItem({ id: `${ENV_A}.0` }),
      receivedItem({ state: 'opened' as never }),
      receivedItem({ size: -1 }),
      receivedItem({ at: 1.5 }),
      receivedItem({ name: 7 as never }),
      receivedItem({ name: 'n'.repeat(1_000) }),
      receivedItem({ proof: 'yes' as never }),
      receivedItem({ from: { name: 9 } as never }),
      null,
    ];
    const res = await call(
      RECEIVED,
      contextWith({ received: () => pageOf([...bad, good] as ReceivedFileItem[]) }),
    );
    expect(res.status).toBe(200);
    expect(bodyOf(res).items.map((i) => i.id)).toEqual([`${ENV_B}.00`]);
  });

  it('keeps a contact file name as data, unchanged text', async () => {
    const name = '<img src=x onerror=alert(1)>.pdf';
    const res = await call(
      RECEIVED,
      contextWith({
        received: () => pageOf([receivedItem({ name, savedName: undefined, state: 'not_saved' })]),
      }),
    );
    expect(bodyOf(res).items[0]?.name).toBe(name);
  });
});

describe('GET /api/ui/files/sent (MSG-FILES-IO-d)', () => {
  it('answers the exact allowlist', async () => {
    const res = await call(SENT, contextWith({ sent: () => pageOf([sentItem()]) }));
    expect(res.status).toBe(200);
    expect(bodyOf(res)).toEqual({
      items: [
        {
          id: `${ENV_B}.01`,
          to: 'Marko Novak',
          at: 1_761_000_100,
          name: 'plan.md',
          size: 1_200,
          status: 'sent',
          receipt: true,
          state: 'available',
          expiresAt: 1_761_600_000,
        },
      ],
    });
  });

  it('an inline file deleted on receipt reads deleted, its expiry null; an expired link reads expired', async () => {
    const res = await call(
      SENT,
      contextWith({
        sent: () =>
          pageOf([
            sentItem({ id: `${ENV_B}.00`, state: 'deleted', expiresAt: null }),
            sentItem({
              id: `${ENV_A}.00`,
              state: 'expired',
              status: 'not_delivered',
              receipt: false,
            }),
            sentItem({ id: `${ENV_A}.01`, status: 'queued' }),
          ]),
      }),
    );
    const items = bodyOf(res).items;
    expect(items.map((i) => [i.state, i.status, i.expiresAt])).toEqual([
      ['deleted', 'sent', null],
      ['expired', 'not_delivered', 1_761_600_000],
      ['available', 'queued', 1_761_600_000],
    ]);
  });

  it('never returns a key, a link, a locator or a path, and drops an item outside its allowlist', async () => {
    const leaky = {
      ...sentItem(),
      url: SECRET_URL,
      fileKey: FILE_KEY,
      locator: { bucket: 'b' },
      realpath: ABS_PATH,
    } as unknown as SentFileItem;
    const res = await call(
      SENT,
      contextWith({
        sent: () =>
          pageOf([
            leaky,
            sentItem({ status: 'delivered' as never }),
            sentItem({ state: 'gone' as never }),
            sentItem({ expiresAt: 'soon' as never }),
            sentItem({ receipt: 1 as never }),
          ]),
      }),
    );
    const text = JSON.stringify(res.body);
    for (const bad of [SECRET_URL, FILE_KEY, 'bucket', ABS_PATH]) expect(text).not.toContain(bad);
    expect(bodyOf(res).items).toHaveLength(1);
    expect(Object.keys(bodyOf(res).items[0] ?? {}).sort()).toEqual([
      'at',
      'expiresAt',
      'id',
      'name',
      'receipt',
      'size',
      'state',
      'status',
      'to',
    ]);
  });
});

describe('the Files In/Out reads: query and errors (MSG-FILES-IO-d)', () => {
  const ok = (): Partial<FilesIo> => ({ received: () => pageOf([]), sent: () => pageOf([]) });

  it.each([RECEIVED, SENT])('%s passes a valid limit and cursor to core', async (path) => {
    const seen: PageQuery[] = [];
    const ctx = contextWith({
      received: (q) => {
        seen.push(q);
        return pageOf([]);
      },
      sent: (q) => {
        seen.push(q);
        return pageOf([]);
      },
    });
    expect((await call(path, ctx, 'limit=100&cursor=abc_-1')).status).toBe(200);
    expect((await call(path, ctx, 'limit=1')).status).toBe(200);
    expect(seen).toEqual([{ limit: 100, cursor: 'abc_-1' }, { limit: 1 }]);
  });

  it.each([RECEIVED, SENT])(
    '%s refuses a bad query with bad_request, never echoing it',
    async (path) => {
      for (const query of [
        'limit=0',
        'limit=101',
        'limit=-1',
        'limit=1.5',
        'limit=abc',
        'limit=1&limit=2',
        'cursor=',
        `cursor=${'c'.repeat(257)}`,
        'cursor=a&cursor=b',
        'box=in',
        'path=%2Fetc%2Fpasswd',
      ]) {
        const res = await call(path, contextWith(ok()), query);
        expect(res).toEqual({ status: 400, body: { error: 'bad_request' } });
      }
    },
  );

  it.each([RECEIVED, SENT])('%s: a cursor core refuses is bad_request', async (path) => {
    const refuse = () => Promise.reject(new CoreError('page_query_invalid', 'bad cursor <x>'));
    const res = await call(path, contextWith({ received: refuse, sent: refuse }), 'cursor=zzz');
    expect(res).toEqual({ status: 400, body: { error: 'bad_request' } });
  });

  it.each([RECEIVED, SENT])(
    '%s: any other failure is unavailable, with no error text',
    async (path) => {
      const fail = () =>
        Promise.reject(new CoreError('store_unreadable', `could not open ${ABS_PATH} report.pdf`));
      const res = await call(path, contextWith({ received: fail, sent: fail }));
      expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
      const thrown = () => {
        throw new Error(SECRET_URL);
      };
      const sync = await call(path, contextWith({ received: thrown, sent: thrown }));
      expect(sync).toEqual({ status: 503, body: { error: 'unavailable' } });
    },
  );

  it.each([RECEIVED, SENT])('%s without an agent is not_set_up', async (path) => {
    expect(await call(path, contextWith(undefined))).toBe(UI_NOT_SET_UP);
  });
});
