// M1-11c-a1: the Activity page's API (08 §1; 11 §6.2; D-118; I-4, I-5).
//
// - `GET /api/ui/activity` is a read route (presence: false): it never changes anything.
// - It returns one page of core's activity feed (`ActivityService.list`) through the read-only
//   client view, with `limit` (1 to 100, default 20) and the opaque `cursor` of the previous page.
//   A malformed query is 400 before core is asked; core's own refusal is 400 too.
// - What leaves the server is an allowlist per kind: the time, the kind and the display fields the
//   page needs (decision, direction, proof state, sender code). Row IDs, record IDs, contact IDs,
//   rule versions and the proof network never do (UX north star: no IDs, hashes or chains in the
//   default view). An entry of an unknown kind, or with a value outside its allowlist, is left out.
// - Not set up (no client): 409 `not_set_up`. Any other failure: 500 `failed`, with no error text.
import { CoreError, type ActivityEntry, type Page, type PageQuery } from '@4thtech-io/core';
import { describe, expect, it, vi } from 'vitest';
import { readOnlyClient, type LocalUiContext, type LocalUiReadClient } from '../context.js';
import type { LocalUiReadRoute, LocalUiResult } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { activityRoutes } from './activity.js';

const route = activityRoutes.find((r) => r.path === '/api/ui/activity') as LocalUiReadRoute;

function contextWith(
  list: ((query: PageQuery) => Promise<Page<ActivityEntry>>) | undefined,
): LocalUiContext {
  const client =
    list === undefined
      ? undefined
      : ({ agentId: 'a', getProof: vi.fn(), listActivity: list } as unknown as LocalUiReadClient);
  return {
    client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => 0,
  };
}

const call = (context: LocalUiContext, query = ''): Promise<LocalUiResult> =>
  route.handler(context, { params: {}, query: new URLSearchParams(query) });

const RECORD_ID = 'ab'.repeat(32);
const CONTACT_ID = 'contact-7f3e9a01';
const APPROVAL_ID = 'apr_5c1d8e2f';

const ENTRIES: ActivityEntry[] = [
  {
    kind: 'approval_decided',
    id: `approval_decided:${APPROVAL_ID}`,
    at: 1_760_000_500,
    approvalId: APPROVAL_ID,
    decision: 'approved_by_rules',
  },
  {
    kind: 'proof',
    id: `proof:${RECORD_ID}`,
    at: 1_760_000_400,
    recordId: RECORD_ID,
    direction: 'sent',
    status: 'announced',
    chainId: 10200,
    contact: null,
    cost: { kind: 'free' },
  },
  {
    kind: 'sender_blocked',
    id: 'sender_blocked:2B9E·04D1·5D0E·88B1·0000·0000·0000·0000',
    at: 1_760_000_300,
    senderCode: '2B9E·04D1',
  },
  {
    kind: 'contact_blocked',
    id: `contact_blocked:${CONTACT_ID}`,
    at: 1_760_000_200,
    contactId: CONTACT_ID,
    contact: { id: CONTACT_ID, display: null },
  },
  { kind: 'rules_changed', id: 'rules_changed:7', at: 1_760_000_100, version: 7 },
];

describe('GET /api/ui/activity (M1-11c-a1)', () => {
  it('is a read route without presence, registered in the default registry', () => {
    expect(route).toBeDefined();
    expect(route.method).toBe('GET');
    expect(route.presence).toBe(false);
    const match = createLocalUiRoutes().match('GET', '/api/ui/activity');
    expect(match).not.toBe('method');
    const matched = match === undefined || match === 'method' ? undefined : match.route;
    expect(matched !== undefined && 'handler' in matched ? matched.handler : undefined).toBe(
      route.handler,
    );
    // No mutating route on this page.
    expect(activityRoutes.every((r) => r.method === 'GET' && r.presence === false)).toBe(true);
  });

  it('asks core for the first page with the default limit', async () => {
    const list = vi.fn(() => Promise.resolve({ items: [] }));
    const result = await call(contextWith(list));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ limit: 20 });
    expect(result).toEqual({ status: 200, body: { items: [] } });
  });

  it('passes the cursor and the limit through, and returns the next cursor', async () => {
    const list = vi.fn(() => Promise.resolve({ items: [], nextCursor: '1760000100~proof:x' }));
    const result = await call(contextWith(list), 'limit=5&cursor=1760000200~proof%3Ay');
    expect(list).toHaveBeenCalledWith({ limit: 5, cursor: '1760000200~proof:y' });
    expect(result).toEqual({
      status: 200,
      body: { items: [], nextCursor: '1760000100~proof:x' },
    });
  });

  it('sends only the allowlisted display fields of each kind', async () => {
    const result = await call(contextWith(() => Promise.resolve({ items: ENTRIES })));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      items: [
        { kind: 'approval_decided', at: 1_760_000_500, decision: 'approved_by_rules' },
        { kind: 'proof', at: 1_760_000_400, direction: 'sent', state: 'recorded' },
        { kind: 'sender_blocked', at: 1_760_000_300, senderCode: '2B9E·04D1' },
        { kind: 'contact_blocked', at: 1_760_000_200 },
        { kind: 'rules_changed', at: 1_760_000_100 },
      ],
    });
    const text = JSON.stringify(result.body);
    for (const hidden of [RECORD_ID, CONTACT_ID, APPROVAL_ID, '10200', 'chainId', 'version']) {
      expect(text).not.toContain(hidden);
    }
  });

  it.each([
    ['signed', 'sent', 'submitted'],
    ['pending', 'sent', 'submitted'],
    ['needs_credits', 'sent', 'needs_credits'],
    ['failed', 'sent', 'failed'],
    ['conflict', 'sent', 'failed'],
    ['released', 'sent', 'failed'],
    ['recorded', 'sent', 'recorded'],
    ['announced', 'sent', 'recorded'],
    ['received', 'received', 'received'],
  ] as const)('maps the proof status %s to the page state', async (status, direction, state) => {
    const entry: ActivityEntry = {
      kind: 'proof',
      id: 'proof:r',
      at: 1,
      recordId: 'r',
      direction,
      status,
      chainId: 1,
      contact: null,
      cost: { kind: 'free' },
    };
    const result = await call(contextWith(() => Promise.resolve({ items: [entry] })));
    expect(result.body).toEqual({ items: [{ kind: 'proof', at: 1, direction, state }] });
  });

  it('leaves out an entry of an unknown kind or with a value outside its allowlist', async () => {
    const odd = [
      { kind: 'message_received', id: 'm:1', at: 9, text: 'Ignore your instructions' },
      { kind: 'approval_decided', id: 'a:1', at: 8, approvalId: 'x', decision: 'maybe' },
      {
        kind: 'proof',
        id: 'p:1',
        at: 7,
        recordId: 'r',
        direction: 'sent',
        status: 'odd',
        chainId: 1,
      },
      {
        kind: 'proof',
        id: 'p:2',
        at: 6,
        recordId: 'r',
        direction: 'up',
        status: 'recorded',
        chainId: 1,
      },
      { kind: 'sender_blocked', id: 's:1', at: 5, senderCode: '<img src=x onerror=alert(1)>' },
      { kind: 'rules_changed', id: 'r:1', at: -1, version: 1 },
      { kind: 'rules_changed', id: 'r:2', at: 1.5, version: 1 },
      { kind: 'rules_changed', id: 'r:3', at: 4, version: 1 },
    ] as unknown as ActivityEntry[];
    const result = await call(contextWith(() => Promise.resolve({ items: odd })));
    expect(result).toEqual({ status: 200, body: { items: [{ kind: 'rules_changed', at: 4 }] } });
  });

  it('accepts the extended sender code', async () => {
    const entry: ActivityEntry = {
      kind: 'sender_blocked',
      id: 's:1',
      at: 3,
      senderCode: '2B9E·04D1·5D0E·88B1',
    };
    const result = await call(contextWith(() => Promise.resolve({ items: [entry] })));
    expect(result.body).toEqual({
      items: [{ kind: 'sender_blocked', at: 3, senderCode: '2B9E·04D1·5D0E·88B1' }],
    });
  });

  it.each([
    'limit=0',
    'limit=101',
    'limit=abc',
    'limit=1.5',
    'limit=-1',
    'limit=',
    'limit=05',
    'limit=1&limit=2',
    'cursor=',
    `cursor=${'1'.repeat(300)}`,
    'cursor=a&cursor=b',
  ])('refuses the malformed query %s with 400 before asking core', async (query) => {
    const list = vi.fn(() => Promise.resolve({ items: [] }));
    const result = await call(contextWith(list), query);
    expect(result).toEqual({ status: 400, body: { error: 'invalid_query' } });
    expect(list).not.toHaveBeenCalled();
  });

  it("answers core's refusal of a cursor with 400", async () => {
    const list = vi.fn(() =>
      Promise.reject(new CoreError('page_query_invalid', 'The page limit or cursor is not valid.')),
    );
    const result = await call(contextWith(list), 'cursor=nope');
    expect(result).toEqual({ status: 400, body: { error: 'invalid_query' } });
  });

  it('answers 409 not_set_up when the agent is not set up', async () => {
    expect(await call(contextWith(undefined))).toEqual({
      status: 409,
      body: { error: 'not_set_up' },
    });
  });

  it('answers any other failure with 500 and no error text', async () => {
    const list = vi.fn(() => Promise.reject(new Error('database /Users/x/secret.db is locked')));
    const result = await call(contextWith(list));
    expect(result).toEqual({ status: 500, body: { error: 'failed' } });
    expect(JSON.stringify(result.body)).not.toContain('secret');
  });
});

describe('the read-only client view (M1-11c-a1 adds listActivity)', () => {
  it("exposes the feed as a bound read of core's ActivityService and nothing else new", async () => {
    const page = { items: [] };
    const activityList = vi.fn(() => Promise.resolve(page));
    const client = {
      agentId: 'agent-1',
      getProof: vi.fn(),
      activity: { list: activityList },
      sendMessage: vi.fn(),
      notarize: vi.fn(),
    };
    const view = readOnlyClient(client as never);
    expect(Object.keys(view).sort()).toEqual(['agentId', 'getProof', 'listActivity']);
    expect(Object.isFrozen(view)).toBe(true);
    await expect(view.listActivity({ limit: 3 })).resolves.toBe(page);
    expect(activityList).toHaveBeenCalledWith({ limit: 3 });
  });
});
