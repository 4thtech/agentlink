// MSG-FILES-IO-c: the Messages page's API (08 §1; 04 §2.5; D-133, D-134; plan
// docs/process/proposals/MSG-FILES-IO.md §4; I-4, I-5, I-7).
//
// What these tests hold the routes to:
// - two read routes (`GET`, `presence: false`) in the default registry; no other method on their
//   paths, and nothing that writes: the handlers reach only the read-only `messages` view
//   (`conversations`, `list`), never a read mark (the AI's `read_at` stays as it was, I-4);
// - every item is built from an allowlist with an exact key set: no URL, file key, locator, hash,
//   envelope JSON or any other field core may carry rides along (zero access, I-7);
// - a bad `box`, `limit`, cursor, contact or an unknown query key is 400 `bad_request` before core
//   is asked, and the answer never echoes the input; an unknown or removed contact is 404
//   `not_found`; any other failure is 503 `unavailable`, never an error's text (I-5, I-7);
// - message text is passed as data only (a plain string, never interpreted here; the page renders
//   it as untrusted text).
import {
  CoreError,
  type Conversation,
  type MessageBox,
  type MessageItem,
  type Page,
  type PageQuery,
} from '@4thtech-io/core';
import { describe, expect, it, vi } from 'vitest';
import { readOnlyClient, type LocalUiContext, type LocalUiReadClient } from '../context.js';
import type { LocalUiReadRoute, LocalUiResult } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { messagesRoutes } from './messages.js';

const LIST = '/api/ui/messages';
const BOX = '/api/ui/messages/:contactId';
const listRoute = messagesRoutes.find((r) => r.path === LIST) as LocalUiReadRoute;
const boxRoute = messagesRoutes.find((r) => r.path === BOX) as LocalUiReadRoute;

const BOB = `0x${'b0'.repeat(20)}`;
const CAROL = `0x${'c0'.repeat(20)}`;
const CANARY_URL = 'https://drop.agentlink.example/o/CANARY-DROP-URL';
const CANARY_KEY = 'CANARY-FILE-KEY-MUST-NOT-LEAK';
const CANARY_TEXT = 'CANARY-INPUT-MUST-NOT-ECHO';

interface Messages {
  conversations: () => Promise<readonly Conversation[]>;
  list: (contactId: string, box: MessageBox, query: PageQuery) => Promise<Page<MessageItem>>;
}

function contextWith(messages: Partial<Messages> | undefined): LocalUiContext {
  const client =
    messages === undefined
      ? undefined
      : ({
          agentId: 'a',
          getProof: vi.fn(),
          messages: {
            conversations: messages.conversations ?? (() => Promise.reject(new Error('unused'))),
            list: messages.list ?? (() => Promise.reject(new Error('unused'))),
          },
        } as unknown as LocalUiReadClient);
  return {
    client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => 0,
  };
}

const callList = (context: LocalUiContext, query = ''): Promise<LocalUiResult> =>
  listRoute.handler(context, { params: {}, query: new URLSearchParams(query) });

const callBox = (
  context: LocalUiContext,
  contactId: string,
  query = 'box=in',
): Promise<LocalUiResult> =>
  boxRoute.handler(context, { params: { contactId }, query: new URLSearchParams(query) });

const display = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, nameSource: 'owner', label: 'self-declared', ...extra }) as never;

const CONVERSATIONS: Conversation[] = [
  {
    contactId: BOB,
    display: display('Bob', { fingerprint: 'AB12·CD34', card: { url: CANARY_URL } }),
    lastAt: 1_800_000_100,
    lastInAt: 1_800_000_050,
  },
  { contactId: CAROL, display: display('Carol'), lastAt: null, lastInAt: null },
];

/** Core items carrying extra fields that must never leave the server. */
const INBOX: MessageItem[] = [
  {
    id: 'env_AAAAAAAAAAAAAAAAAAAAAA',
    at: 1_800_000_050,
    type: 'text',
    text: '<img src=x onerror=alert(1)> **hi** [link](javascript:alert(1))',
    files: [{ name: 'report.pdf', size: 1234, url: CANARY_URL, fileKey: CANARY_KEY } as never],
    proof: true,
    size: 77,
    url: CANARY_URL,
    envelope_json: '{"CANARY":1}',
  } as MessageItem,
  {
    id: 'env_BBBBBBBBBBBBBBBBBBBBBB',
    at: 1_800_000_040,
    type: 'offer',
    text: '',
    files: [],
    proof: false,
    size: 12,
  },
];

const SENT: MessageItem[] = [
  {
    id: 'env_CCCCCCCCCCCCCCCCCCCCCC',
    at: 1_800_000_100,
    type: 'note',
    text: '{\n  "a": 1\n}',
    files: [],
    proof: false,
    size: 9,
    status: 'not_delivered',
    receipt: false,
    locator: CANARY_URL,
  } as MessageItem,
  {
    id: 'env_DDDDDDDDDDDDDDDDDDDDDD',
    at: 1_800_000_090,
    type: 'file',
    text: 'here',
    files: [{ name: 'a.txt', size: 3 }],
    proof: true,
    size: 40,
    status: 'sent',
    receipt: true,
  },
];

const IN_KEYS = ['at', 'files', 'id', 'proof', 'size', 'text', 'type'];
const OUT_KEYS = [...IN_KEYS, 'receipt', 'status'].sort();

const bodyOf = (res: LocalUiResult): Record<string, unknown> =>
  res.body as Record<string, unknown>;

describe('the Messages routes (MSG-FILES-IO-c)', () => {
  it('are two GET routes without presence, in the default registry, with no other method', () => {
    expect(messagesRoutes).toHaveLength(2);
    for (const route of messagesRoutes) {
      expect(route.method).toBe('GET');
      expect(route.presence).toBe(false);
    }
    const registry = createLocalUiRoutes();
    expect(registry.routes()).toEqual(expect.arrayContaining([listRoute, boxRoute]));
    const onPaths = registry
      .routes()
      .filter((r) => r.path === LIST || r.path === BOX)
      .map((r) => r.method);
    expect(onPaths).toEqual(['GET', 'GET']);
    const hit = registry.match('GET', `/api/ui/messages/${BOB}`);
    expect(hit).not.toBe('method');
    expect(hit === undefined || hit === 'method' ? undefined : hit.params).toEqual({
      contactId: BOB,
    });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(registry.match(method, LIST)).toBe('method');
      expect(registry.match(method, `/api/ui/messages/${BOB}`)).toBe('method');
    }
  });
});

describe('GET /api/ui/messages (MSG-FILES-IO-c)', () => {
  it('lists conversations with exactly contactId, name, lastAt and lastInAt', async () => {
    const res = await callList(contextWith({ conversations: () => Promise.resolve(CONVERSATIONS) }));
    expect(res.status).toBe(200);
    expect(Object.keys(bodyOf(res))).toEqual(['conversations']);
    expect(res.body).toEqual({
      conversations: [
        { contactId: BOB, name: 'Bob', lastAt: 1_800_000_100, lastInAt: 1_800_000_050 },
        { contactId: CAROL, name: 'Carol', lastAt: null, lastInAt: null },
      ],
    });
    for (const c of bodyOf(res)['conversations'] as Record<string, unknown>[]) {
      expect(Object.keys(c).sort()).toEqual(['contactId', 'lastAt', 'lastInAt', 'name']);
    }
    expect(JSON.stringify(res.body)).not.toContain('CANARY');
  });

  it('leaves out a conversation with a value outside its allowlist (fail closed)', async () => {
    const bad: Conversation[] = [
      { contactId: 'not-an-address', display: display('X'), lastAt: 1, lastInAt: 1 },
      { contactId: BOB, display: display('x'.repeat(129)), lastAt: 1, lastInAt: 1 },
      { contactId: BOB, display: display('Y'), lastAt: -1, lastInAt: null },
      { contactId: BOB, display: display('Z'), lastAt: 1.5, lastInAt: null },
      { contactId: BOB, display: { name: 7 } as never, lastAt: 1, lastInAt: null },
      CONVERSATIONS[1] as Conversation,
    ];
    const res = await callList(contextWith({ conversations: () => Promise.resolve(bad) }));
    expect(res.body).toEqual({
      conversations: [{ contactId: CAROL, name: 'Carol', lastAt: null, lastInAt: null }],
    });
  });

  it('refuses any query parameter with bad_request, never echoing it', async () => {
    const conversations = vi.fn(() => Promise.resolve(CONVERSATIONS));
    for (const query of ['limit=5', `x=${CANARY_TEXT}`, 'cursor=abc']) {
      const res = await callList(contextWith({ conversations }), query);
      expect(res).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    expect(conversations).not.toHaveBeenCalled();
  });

  it('answers 409 not_set_up without an agent and 503 unavailable on a failure, no error text', async () => {
    expect(await callList(contextWith(undefined))).toEqual({
      status: 409,
      body: { error: 'not_set_up' },
    });
    const res = await callList(
      contextWith({ conversations: () => Promise.reject(new Error(`/Users/x ${CANARY_TEXT}`)) }),
    );
    expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
  });
});

describe('GET /api/ui/messages/:contactId (MSG-FILES-IO-c)', () => {
  it('returns Inbox items with the exact inbound key set and the text as a plain string', async () => {
    const list = vi.fn(() => Promise.resolve({ items: INBOX, nextCursor: 'cur_1' }));
    const res = await callBox(contextWith({ list }), BOB, 'box=in&limit=2');
    expect(list).toHaveBeenCalledWith(BOB, 'in', { limit: 2 });
    expect(res.status).toBe(200);
    expect(Object.keys(bodyOf(res)).sort()).toEqual(['items', 'next']);
    expect(bodyOf(res)['next']).toBe('cur_1');
    const items = bodyOf(res)['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(IN_KEYS);
    expect(items[0]).toEqual({
      id: 'env_AAAAAAAAAAAAAAAAAAAAAA',
      at: 1_800_000_050,
      type: 'text',
      text: '<img src=x onerror=alert(1)> **hi** [link](javascript:alert(1))',
      files: [{ name: 'report.pdf', size: 1234 }],
      proof: true,
      size: 77,
    });
    expect(Object.keys((items[0]?.['files'] as object[])[0] as object).sort()).toEqual([
      'name',
      'size',
    ]);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('CANARY');
    expect(json).not.toContain('drop.agentlink');
  });

  it('returns Sent items with status and receipt, and no next on the last page', async () => {
    const list = vi.fn(() => Promise.resolve({ items: SENT }));
    const res = await callBox(contextWith({ list }), BOB, 'box=out');
    expect(list).toHaveBeenCalledWith(BOB, 'out', { limit: 20 });
    expect(Object.keys(bodyOf(res))).toEqual(['items']);
    const items = bodyOf(res)['items'] as Record<string, unknown>[];
    for (const item of items) expect(Object.keys(item).sort()).toEqual(OUT_KEYS);
    expect(items.map((i) => [i['status'], i['receipt']])).toEqual([
      ['not_delivered', false],
      ['sent', true],
    ]);
    expect(JSON.stringify(res.body)).not.toContain('CANARY');
  });

  it('passes the cursor through and accepts the limits 1 and 100', async () => {
    const list = vi.fn(() => Promise.resolve({ items: [] }));
    const context = contextWith({ list });
    await callBox(context, BOB, 'box=in&limit=1&cursor=abc_-DEF');
    await callBox(context, BOB, `cursor=${'c'.repeat(256)}&box=out&limit=100`);
    expect(list.mock.calls).toEqual([
      [BOB, 'in', { limit: 1, cursor: 'abc_-DEF' }],
      [BOB, 'out', { limit: 100, cursor: 'c'.repeat(256) }],
    ]);
  });

  it('leaves out an item with a value outside its allowlist (fail closed)', async () => {
    const base = INBOX[1] as MessageItem;
    const bad = [
      { ...base, id: 'has.dot' },
      { ...base, at: -1 },
      { ...base, type: 'ack' },
      { ...base, text: 7 },
      { ...base, files: [{ name: 'a', size: -1 }] },
      { ...base, files: [{ name: 1, size: 1 }] },
      { ...base, proof: 'yes' },
      { ...base, size: 1.5 },
      base,
    ] as MessageItem[];
    const res = await callBox(contextWith({ list: () => Promise.resolve({ items: bad }) }), BOB);
    expect((bodyOf(res)['items'] as unknown[]).length).toBe(1);
    const sent = [
      { ...(SENT[1] as MessageItem), status: 'delivered' },
      { ...(SENT[1] as MessageItem), receipt: 1 },
      { ...(SENT[1] as MessageItem), status: undefined },
      SENT[1],
    ] as MessageItem[];
    const out = await callBox(
      contextWith({ list: () => Promise.resolve({ items: sent }) }),
      BOB,
      'box=out',
    );
    expect((bodyOf(out)['items'] as unknown[]).length).toBe(1);
  });

  it('refuses a bad box, limit, cursor, contact or query key with bad_request, never echoing it', async () => {
    const list = vi.fn(() => Promise.resolve({ items: [] }));
    const context = contextWith({ list });
    const queries = [
      '',
      'limit=5',
      'box=both',
      'box=IN',
      'box=in&box=out',
      'box=in&limit=0',
      'box=in&limit=101',
      'box=in&limit=05',
      'box=in&limit=1.5',
      'box=in&limit=',
      'box=in&limit=1&limit=2',
      'box=in&cursor=',
      `box=in&cursor=${'c'.repeat(257)}`,
      'box=in&cursor=a&cursor=b',
      `box=in&q=${CANARY_TEXT}`,
      `box=in&contactId=${CAROL}`,
    ];
    for (const query of queries) {
      const res = await callBox(context, BOB, query);
      expect(res, query).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    for (const contact of ['', 'bob', `0x${'B0'.repeat(20)}`, `0x${'b0'.repeat(19)}`, CANARY_TEXT]) {
      const res = await callBox(context, contact, 'box=in');
      expect(res, contact).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('maps core refusals to fixed codes, never an error text', async () => {
    const failWith = (error: unknown) =>
      callBox(contextWith({ list: () => Promise.reject(error) }), BOB);
    expect(await failWith(new CoreError('contact_not_found', CANARY_TEXT))).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    expect(await failWith(new CoreError('page_query_invalid', CANARY_TEXT))).toEqual({
      status: 400,
      body: { error: 'bad_request' },
    });
    expect(await failWith(new CoreError('store_locked' as never, CANARY_TEXT))).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    });
    expect(await failWith(new Error(CANARY_TEXT))).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    });
  });

  it('answers 409 not_set_up without an agent', async () => {
    expect(await callBox(contextWith(undefined), BOB)).toEqual({
      status: 409,
      body: { error: 'not_set_up' },
    });
  });
});

describe('the read-only messages view (context.ts, MSG-FILES-IO-c; I-4)', () => {
  it('exposes only conversations and list, bound to core, and never a read mark', async () => {
    const markRead = vi.fn();
    const conversations = vi.fn(() => Promise.resolve(CONVERSATIONS));
    const list = vi.fn(() => Promise.resolve({ items: [] }));
    const full = {
      agentId: 'agent-1',
      messages: { conversations, list, markRead, store: {} },
      inbox: { list: markRead, page: markRead },
    };
    const view = readOnlyClient(full as never);
    expect(Object.keys(view.messages).sort()).toEqual(['conversations', 'list']);
    expect(Object.isFrozen(view.messages)).toBe(true);
    expect(view.messages).not.toBe(full.messages);
    await view.messages.conversations();
    await view.messages.list(BOB, 'out', { limit: 3 });
    expect(conversations).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(BOB, 'out', { limit: 3 });
    expect(markRead).not.toHaveBeenCalled();
  });
});
