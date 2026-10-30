// M1-11c-a4: the Proofs and credits page's API (08 §1; 11 §5, §6.2; D-118; I-4, I-5, I-7).
//
// - Two read routes, `GET /api/ui/proofs` (the proof list, paged) and `GET /api/ui/proofs/credits`
//   (proofs left and the balance), both `presence: false` and both through the read-only client
//   view. No free test credits route (owner decision D2). Add credits and Withdraw credits came with
//   M1-11c-a4c and are tested in proofs-top-up.test.ts.
// - What leaves is only what the default view shows (UX north star, PR-1): a proof row is its
//   direction, a fixed display state and its time; credits are proofs left, a dollar balance and
//   two flags. No record, envelope or agent ID, chain, token or address, and never an error's text.
// - A query is parsed strictly and never echoed.
import { CoreError, type CreditsView, type Page, type ProofListItem } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import { readOnlyClient, type LocalUiContext, type LocalUiReadClient } from '../context.js';
import type { LocalUiReadRoute, LocalUiRequest } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { PROOF_PRICE_USD_MICROS } from '@4thtech-io/core';
import { UI_INVALID_QUERY, UI_NOT_SET_UP, UI_UNAVAILABLE } from '../route-types.js';
import { proofsRoutes } from './proofs.js';

const AGENT = '0x71c4000000000000000000000000000000009a2e';
const RECORD = '0x' + 'ab'.repeat(32);
const ENVELOPE = 'env-7f3a19c2-leak-marker';

type ListFn = LocalUiReadClient['proofs']['list'];
type CreditsFn = LocalUiReadClient['proofs']['creditsBalance'];

function fakeClient(
  list: ListFn = () => Promise.resolve({ items: [] }),
  credits: CreditsFn = () => Promise.resolve({ status: 'unavailable' }),
): LocalUiReadClient {
  return {
    agentId: AGENT,
    getProof: () => Promise.reject(new Error('not used')),
    listActivity: () => Promise.reject(new Error('not used')),
    messages: {
      conversations: () => Promise.reject(new Error('not used')),
      list: () => Promise.reject(new Error('not used')),
      pulseTimes: () => Promise.reject(new Error('not used')),
      flowEvents: () => Promise.reject(new Error('not used')),
    },
    filesIo: {
      received: () => Promise.reject(new Error('not used')),
      sent: () => Promise.reject(new Error('not used')),
      savedName: () => Promise.reject(new Error('not used')),
    },
    policy: {
      load: () => Promise.reject(new Error('not used')),
      prepareEdit: () => Promise.reject(new Error('not used')),
      recordReceiptsKept: () => Promise.reject(new Error('not used')),
    },
    files: {
      resolvedFolders: () => Promise.reject(new Error('not used')),
      preparePolicyEdit: () => Promise.reject(new Error('not used')),
    },
    proofs: {
      list,
      creditsBalance: credits,
      topUp: () => Promise.resolve({ status: 'unavailable' }),
    },
    contacts: {
      list: () => Promise.reject(new Error('not used')),
      safetyCode: () => Promise.reject(new Error('not used')),
      prepareCheck: () => Promise.reject(new Error('not used')),
      prepareRename: () => Promise.reject(new Error('not used')),
      prepareRemove: () => Promise.reject(new Error('not used')),
    },
  };
}

function ctx(client: LocalUiReadClient | undefined): LocalUiContext {
  return {
    client,
    ownerContext: () => Promise.reject(new Error('not used')),
    applyOwnerAction: () => Promise.reject(new Error('not used')),
    now: () => 0,
  };
}

function route(path: string): LocalUiReadRoute {
  const found = proofsRoutes.find((r) => r.path === path);
  if (found === undefined || found.presence) throw new Error(`no read route ${path}`);
  return found;
}

const req = (query = ''): LocalUiRequest => ({ params: {}, query: new URLSearchParams(query) });

function item(over: Partial<ProofListItem> = {}): ProofListItem {
  return {
    recordId: RECORD,
    envelopeId: ENVELOPE,
    direction: 'sent',
    status: 'recorded',
    chainId: 84532,
    chain: 'base-sepolia',
    createdAt: 1_760_270_520,
    ...over,
  };
}

function chain(
  usd: readonly (string | null)[],
  over: { testnet?: boolean; available?: boolean; chainId?: number; chain?: string } = {},
): Extract<CreditsView, { status: 'ok' }>['chains'][number] {
  return {
    chainId: over.chainId ?? 84532,
    chain: over.chain ?? 'base-sepolia',
    testnet: over.testnet ?? true,
    freeCredits: true,
    available: over.available ?? true,
    credits: usd.map((u) => ({ token: 'USDC', amount: '4800000', usd: u })),
  };
}

const okCredits =
  (chains: Extract<CreditsView, { status: 'ok' }>['chains']): CreditsFn =>
  () =>
    Promise.resolve({ status: 'ok', agentId: AGENT, chains });

/** No ID, chain, token or address in a body. */
function expectNoLeak(body: unknown): void {
  const text = JSON.stringify(body);
  for (const marker of [
    AGENT,
    AGENT.slice(2, 10),
    RECORD,
    ENVELOPE,
    'base-sepolia',
    'chiado',
    '84532',
    '10200',
    'USDC',
    'agentId',
    'recordId',
    'envelopeId',
    'chain',
    'token',
  ]) {
    expect(text, marker).not.toContain(marker);
  }
}

describe('routes (M1-11c-a4)', () => {
  it('declares the two list and credits read routes (M1-11c-a4c adds top-up and withdraw)', () => {
    expect(
      proofsRoutes
        .filter((r) => r.path === '/api/ui/proofs' || r.path === '/api/ui/proofs/credits')
        .map((r) => [r.method, r.path, r.presence]),
    ).toEqual([
      ['GET', '/api/ui/proofs', false],
      ['GET', '/api/ui/proofs/credits', false],
    ]);
    expect(Object.isFrozen(proofsRoutes)).toBe(true);
  });

  it('is in the default registry, and a POST to either path is not a route', () => {
    const registry = createLocalUiRoutes();
    for (const path of ['/api/ui/proofs', '/api/ui/proofs/credits']) {
      const hit = registry.match('GET', path);
      expect(hit !== undefined && hit !== 'method' && hit.route.path).toBe(path);
      expect(registry.match('POST', path)).toBe('method');
    }
    expect(registry.match('POST', '/api/ui/proofs/faucet')).toBeUndefined();
    expect(registry.match('GET', '/api/ui/proofs/faucet')).toBeUndefined();
  });
});

describe('GET /api/ui/proofs: the proof list', () => {
  it('answers not_set_up without an agent', async () => {
    const res = await route('/api/ui/proofs').handler(ctx(undefined), req());
    expect(res).toEqual({ status: 409, body: { error: 'not_set_up' } });
    expect(res).toEqual(UI_NOT_SET_UP);
  });

  it('returns direction, display state and time only, newest first as core gives them', async () => {
    const page: Page<ProofListItem> = {
      items: [
        item({ status: 'recorded', createdAt: 30 }),
        item({ status: 'received', direction: 'received', createdAt: 20 }),
        item({ status: 'pending', createdAt: 10 }),
      ],
      nextCursor: `10~${RECORD}`,
    };
    const seen: unknown[] = [];
    const list: ListFn = (q) => {
      seen.push(q);
      return Promise.resolve(page);
    };
    const res = await route('/api/ui/proofs').handler(ctx(fakeClient(list)), req());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      items: [
        { direction: 'sent', state: 'recorded', createdAt: 30 },
        { direction: 'received', state: 'recorded', createdAt: 20 },
        { direction: 'sent', state: 'submitted', createdAt: 10 },
      ],
      nextCursor: `10~${RECORD}`,
    });
    expect(seen).toEqual([{ limit: 20 }]);
    expectNoLeak({ ...(res.body as Record<string, unknown>), nextCursor: undefined });
  });

  it('maps every listed core status to one fixed display state', async () => {
    const table: ReadonlyArray<readonly [string, string]> = [
      ['signed', 'recording'],
      ['pending', 'submitted'],
      ['needs_credits', 'needs-credits'],
      ['failed', 'failed'],
      ['conflict', 'failed'],
      ['released', 'failed'],
      ['recorded', 'recorded'],
      ['announced', 'recorded'],
      ['received', 'recorded'],
    ];
    const list: ListFn = () =>
      Promise.resolve({ items: table.map(([status], i) => item({ status, createdAt: 100 - i })) });
    const res = await route('/api/ui/proofs').handler(ctx(fakeClient(list)), req());
    const states = (res.body as { items: { state: string }[] }).items.map((i) => i.state);
    expect(states).toEqual(table.map(([, state]) => state));
  });

  it('leaves out a row whose status or time it does not know, and never passes text through', async () => {
    const list: ListFn = () =>
      Promise.resolve({
        items: [
          item({ status: '<img src=x onerror=alert(1)>' }),
          item({ status: 'replaced' }),
          item({ createdAt: -1 }),
          item({ createdAt: 1.5 }),
          item({ direction: 'weird' as 'sent' }),
          item({ createdAt: 5 }),
        ],
      });
    const res = await route('/api/ui/proofs').handler(ctx(fakeClient(list)), req());
    expect(res.body).toEqual({
      status: 'ok',
      items: [{ direction: 'sent', state: 'recorded', createdAt: 5 }],
    });
    expect(JSON.stringify(res.body)).not.toContain('onerror');
  });

  it('passes a valid limit and cursor to core', async () => {
    const seen: unknown[] = [];
    const list: ListFn = (q) => {
      seen.push(q);
      return Promise.resolve({ items: [] });
    };
    await route('/api/ui/proofs').handler(
      ctx(fakeClient(list)),
      req(`limit=50&cursor=${encodeURIComponent(`10~${RECORD}`)}`),
    );
    expect(seen).toEqual([{ limit: 50, cursor: `10~${RECORD}` }]);
  });

  it('refuses a bad limit or cursor with a fixed answer, before core, never echoing it', async () => {
    let calls = 0;
    const list: ListFn = () => {
      calls += 1;
      return Promise.resolve({ items: [] });
    };
    const bad = [
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=1e2',
      'limit=-5',
      'limit=05',
      'limit=',
      'limit=20&limit=30',
      'cursor=',
      `cursor=${'a'.repeat(300)}`,
      `cursor=${encodeURIComponent('1~<script>')}%0A`,
      `cursor=${encodeURIComponent('1~a b')}`,
      'cursor=a&cursor=b',
      'other=1',
    ];
    for (const q of bad) {
      const res = await route('/api/ui/proofs').handler(ctx(fakeClient(list)), req(q));
      expect(res, q).toEqual({ status: 400, body: { error: 'invalid_query' } });
    }
    expect(calls).toBe(0);
  });

  it("answers core's page_query_invalid as the same fixed 400", async () => {
    const list: ListFn = () =>
      Promise.reject(new CoreError('page_query_invalid', 'The page limit or cursor is not valid.'));
    const res = await route('/api/ui/proofs').handler(ctx(fakeClient(list)), req('cursor=1~zz'));
    expect(res).toEqual({ status: 400, body: { error: 'invalid_query' } });
  });

  it('answers any other failure as unavailable, with no error text', async () => {
    const list: ListFn = () => Promise.reject(new Error(`db at /home/x/.agentlink ${RECORD}`));
    const res = await route('/api/ui/proofs').handler(ctx(fakeClient(list)), req());
    expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
    expect(res).toEqual(UI_UNAVAILABLE);
  });
});

describe('GET /api/ui/proofs/credits: proofs left', () => {
  it('takes the proof price from core and returns it formatted, never a literal of its own', async () => {
    // Core's price is the chain schedule's NOTARIZE fee (12 §2); this test follows it.
    const price = Number(PROOF_PRICE_USD_MICROS) / 1_000_000;
    const res = await route('/api/ui/proofs/credits').handler(
      ctx(fakeClient(undefined, okCredits([chain(['5'])]))),
      req(),
    );
    const body = res.body as { proofsLeft: number; price: string };
    expect(body.price).toBe(`$${price.toFixed(2)}`);
    expect(body.proofsLeft).toBe(Math.floor(5 / price));
  });

  it('shares the fixed answers with the other page routes (route-types.ts)', () => {
    expect(UI_NOT_SET_UP).toEqual({ status: 409, body: { error: 'not_set_up' } });
    expect(UI_INVALID_QUERY).toEqual({ status: 400, body: { error: 'invalid_query' } });
    expect(UI_UNAVAILABLE).toEqual({ status: 503, body: { error: 'unavailable' } });
    for (const a of [UI_NOT_SET_UP, UI_INVALID_QUERY, UI_UNAVAILABLE]) {
      expect(Object.isFrozen(a) && Object.isFrozen(a.body)).toBe(true);
    }
  });

  it('answers not_set_up without an agent', async () => {
    const res = await route('/api/ui/proofs/credits').handler(ctx(undefined), req());
    expect(res).toEqual({ status: 409, body: { error: 'not_set_up' } });
    expect(res).toEqual(UI_NOT_SET_UP);
  });

  it('sums the networks into proofs left and a dollar balance, nothing else', async () => {
    const credits = okCredits([
      chain(['4.5', '0.25']),
      chain(['0.059999'], { chainId: 10200, chain: 'chiado' }),
    ]);
    const res = await route('/api/ui/proofs/credits').handler(
      ctx(fakeClient(undefined, credits)),
      req(),
    );
    expect(res).toEqual({
      status: 200,
      body: {
        status: 'ok',
        proofsLeft: 48,
        balance: '$4.80',
        price: '$0.10',
        test: true,
        partial: false,
      },
    });
    expectNoLeak(res.body);
  });

  it('rounds down: never shows a proof or a cent the agent does not have', async () => {
    const res = await route('/api/ui/proofs/credits').handler(
      ctx(fakeClient(undefined, okCredits([chain(['0.099999'])]))),
      req(),
    );
    expect(res.body).toMatchObject({ proofsLeft: 0, balance: '$0.09' });
  });

  it('says test credits only when every network is a test network', async () => {
    const res = await route('/api/ui/proofs/credits').handler(
      ctx(
        fakeClient(
          undefined,
          okCredits([chain(['1']), chain(['1'], { testnet: false, chainId: 8453, chain: 'base' })]),
        ),
      ),
      req(),
    );
    expect(res.body).toMatchObject({ proofsLeft: 20, balance: '$2.00', test: false });
  });

  it('marks the balance partial when a network could not be read or a value is not usable', async () => {
    for (const chains of [
      [chain(['1']), chain([], { available: false, chainId: 10200, chain: 'chiado' })],
      [chain(['1', null])],
      [chain(['1', '1,5'])],
    ]) {
      const res = await route('/api/ui/proofs/credits').handler(
        ctx(fakeClient(undefined, okCredits(chains))),
        req(),
      );
      expect(res.body).toEqual({
        status: 'ok',
        proofsLeft: 10,
        balance: '$1.00',
        price: '$0.10',
        test: true,
        partial: true,
      });
    }
  });

  it('answers unavailable when nothing could be read, with no error text', async () => {
    const cases: CreditsFn[] = [
      () => Promise.resolve({ status: 'unavailable' }),
      okCredits([]),
      okCredits([chain([], { available: false })]),
      () => Promise.reject(new Error('fetch https://rpc.example/key-123 failed')),
    ];
    for (const credits of cases) {
      const res = await route('/api/ui/proofs/credits').handler(
        ctx(fakeClient(undefined, credits)),
        req(),
      );
      expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
    }
  });

  it('keeps proofs left a safe integer for a huge balance', async () => {
    const res = await route('/api/ui/proofs/credits').handler(
      ctx(fakeClient(undefined, okCredits([chain(['99999999999999999999'])]))),
      req(),
    );
    const body = res.body as { proofsLeft: number; balance: string };
    expect(body.proofsLeft).toBe(Number.MAX_SAFE_INTEGER);
    expect(body.balance).toBe('$99999999999999999999.00');
  });

  it('ignores any query', async () => {
    const res = await route('/api/ui/proofs/credits').handler(
      ctx(fakeClient(undefined, okCredits([chain(['1'])]))),
      req('chainId=8453'),
    );
    expect(res.body).toMatchObject({ status: 'ok', proofsLeft: 10 });
  });
});

describe('the read-only client view (context.ts)', () => {
  it('exposes the proof list and credits reads, and not the free test credits request', async () => {
    const calls: string[] = [];
    const full = {
      agentId: AGENT,
      getProof: () => Promise.resolve(undefined),
      proofs: {
        list: (q: unknown) => {
          calls.push(`list ${JSON.stringify(q)}`);
          return Promise.resolve({ items: [] });
        },
        creditsBalance: () => {
          calls.push('credits');
          return Promise.resolve({ status: 'unavailable' });
        },
        requestFaucet: () => Promise.reject(new Error('never')),
        notarize: () => Promise.reject(new Error('never')),
      },
    };
    const view = readOnlyClient(full as never);
    expect(Object.keys(view).sort()).toEqual([
      // U3-d: the verified label and the unsigned agent.label (reads and prepare only).
      'agent',
      'agentId',
      // U3-f: the unsigned app.connect / app.disconnect (prepare only).
      'apps',
      // W4-AUTO-SAVE: the one-time notice (display state only).
      'autoSaveNotice',
      // W4-RENAME-REACHES-CONTACTS: the former-name note's seen mark only (display state).
      'contactNames',
      'contacts',
      'files',
      'filesIo',
      'getProof',
      'listActivity',
      'messages',
      'policy',
      'proofs',
    ]);
    expect(Object.keys(view.proofs).sort()).toEqual(['creditsBalance', 'list', 'topUp']);
    // M1-11c-a4c adds the top-up read (proofs-top-up.test.ts); still nothing that moves funds.
    expect(view.proofs).not.toBe(full.proofs);
    expect(Object.isFrozen(view.proofs)).toBe(true);
    await view.proofs.list({ limit: 3 });
    await view.proofs.creditsBalance();
    expect(calls).toEqual(['list {"limit":3}', 'credits']);
  });
});
