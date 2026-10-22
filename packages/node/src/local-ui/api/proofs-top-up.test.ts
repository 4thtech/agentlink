// M1-11c-a4c: Add credits by QR (Chiado now) and Withdraw credits, the local UI API (D-122, D-123;
// 08 §1; 11 §5.6; 12 §4.1, §4.4; 04 §2.5, §2.5.1; I-4, I-7).
//
// - `GET /api/ui/proofs/top-up` (no presence): per network a fixed word and, on the Gnosis test
//   network (Chiado) only, the agent's address for the QR code and copy button, with what arrived,
//   what can become credits and the credits that can be withdrawn, in dollars and in base units. Any
//   other testnet is "coming soon"; a mainnet is never listed.
// - `POST /api/ui/proofs/top-up` and `POST /api/ui/proofs/withdraw` are owner operations: both
//   `presence: true`, so the central presence gate runs first (routes.ts, approval-server.ts). Each
//   signs exactly one owner action, `credits.deposit` or `credits.withdraw`, after checking its input
//   against a fresh read: the network, the exact amount it confirmed and, for a withdrawal, the agent's
//   own account as the recipient (the only one allowed until the recipient grant, IR-M1-4c-b-1 M-1).
//   Bad input signs nothing, so the gate answers 409 and core is never called.
// - Answers are fixed words and dollar amounts: never a key, a hash, a URL or an error's text.
import type { CreditsMoveResult, TopUpView } from '@4thtech-io/core';
import {
  TAGS,
  bip340Verify,
  canonicalizeToBytes,
  decodeHex,
  encodeUtf8,
  sha256,
  taggedHash,
  type JsonObject,
  type OwnerPresence,
} from '@4thtech-io/crypto';
import { MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  readOnlyClient,
  type LocalUiContext,
  type LocalUiCreditsPort,
  type LocalUiReadClient,
} from '../context.js';
import type {
  LocalUiOwnerOperation,
  LocalUiOwnerRoute,
  LocalUiReadRoute,
  LocalUiRequest,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { OWNER_ACTION_OPS } from '../../owner-allowlist.js';
import type { OwnerReview, OwnerSignRequest, OwnerSignature } from '../../owner-operation.js';
import { proofsRoutes } from './proofs.js';

const AGENT = '0x71c4000000000000000000000000000000009a2e';
const OTHER = '0x' + '22'.repeat(20);
const XDAI = 10n ** 18n;
const presence = (): OwnerPresence => ({ kind: 'passphrase', secret: encodeUtf8('owner code') });
const OWNER = new MemoryOwnerKeyStore(new Uint8Array(32).fill(7), presence());
let OWNER_NOSTR = new Uint8Array(32);
beforeAll(async () => {
  OWNER_NOSTR = (await OWNER.getPublicKeys()).ownerNostr;
});

function chiado(over: Partial<Record<string, unknown>> = {}) {
  return {
    chainId: 10200,
    chain: 'gnosis-chiado',
    method: 'address' as const,
    available: true as const,
    token: 'NATIVE',
    received: { amount: (5n * XDAI).toString(), usd: '5' },
    addable: { amount: (5n * XDAI - 10n ** 16n).toString(), usd: '4.99' },
    credits: { amount: (2n * XDAI).toString(), usd: '2' },
    ...over,
  };
}

const base = { chainId: 84532, chain: 'base-sepolia', method: 'coming_soon' as const };

function okView(chains: readonly unknown[] = [base, chiado()]): TopUpView {
  return { status: 'ok', agentId: AGENT, chains } as TopUpView;
}

function fakeClient(topUp: () => Promise<TopUpView>): LocalUiReadClient {
  return {
    agentId: AGENT,
    getProof: () => Promise.reject(new Error('not used')),
    proofs: {
      list: () => Promise.resolve({ items: [] }),
      creditsBalance: () => Promise.resolve({ status: 'unavailable' }),
      topUp,
    },
  };
}

interface Calls {
  deposit: unknown[];
  withdraw: unknown[];
}

function ctx(
  view: TopUpView | (() => Promise<TopUpView>),
  answer: CreditsMoveResult = { status: 'done' },
  calls: Calls = { deposit: [], withdraw: [] },
): { context: LocalUiContext; calls: Calls } {
  const topUp = typeof view === 'function' ? view : () => Promise.resolve(view);
  const credits: LocalUiCreditsPort = {
    addReceivedFunds: (signed) => {
      calls.deposit.push(signed);
      return Promise.resolve(answer);
    },
    withdrawCredits: (signed) => {
      calls.withdraw.push(signed);
      return Promise.resolve(answer);
    },
  };
  return {
    context: {
      client: fakeClient(topUp),
      credits,
      ownerContext: () =>
        Promise.resolve({
          agent: AGENT,
          owner: {
            ownerEvm: new Uint8Array(20),
            ownerNostr: OWNER_NOSTR,
            ownerEnc: new Uint8Array(32),
          },
        }),
      applyOwnerAction: () => Promise.reject(new Error('not used')),
      now: () => 1_800_000_000_000,
    },
    calls,
  };
}

/** A presence-backed owner operation that signs with a fixed owner key and records what it saw. */
function ownerOp(): LocalUiOwnerOperation & {
  reviews: OwnerReview[];
  requests: OwnerSignRequest[];
} {
  const reviews: OwnerReview[] = [];
  const requests: OwnerSignRequest[] = [];
  return {
    reviews,
    requests,
    async sign(review, reqs): Promise<readonly OwnerSignature[]> {
      reviews.push(review);
      requests.push(...reqs);
      const session = await OWNER.unlock(presence());
      try {
        const out: OwnerSignature[] = [];
        for (const r of reqs) {
          if (r.kind !== 'owner-action') throw new Error('owner actions only');
          out.push({
            kind: 'owner-action',
            signed: { body: r.action, sig: await session.signOwnerAction(r.action) },
          });
        }
        return out;
      } finally {
        await session.close();
      }
    },
  };
}

function readRoute(path: string): LocalUiReadRoute {
  const found = proofsRoutes.find((r) => r.path === path && r.method === 'GET');
  if (found === undefined || found.presence) throw new Error(`no read route ${path}`);
  return found;
}

function ownerRoute(path: string): LocalUiOwnerRoute {
  const found = proofsRoutes.find((r) => r.path === path && r.method === 'POST');
  if (found === undefined || !found.presence) throw new Error(`no owner route ${path}`);
  return found;
}

const req = (input?: unknown): LocalUiRequest => ({
  params: {},
  query: new URLSearchParams(),
  ...(input === undefined ? {} : { input: input as never }),
});

const SECRETISH =
  /seed|secret|private|sig\b|signature|url|https?:|key\b|txHash|tx_?hash|wallet|gas|0x[0-9a-f]{64}/i;

describe('routes (M1-11c-a4c)', () => {
  it('adds one read and two owner routes, both behind the presence gate', () => {
    expect(proofsRoutes.map((r) => [r.method, r.path, r.presence])).toEqual([
      ['GET', '/api/ui/proofs', false],
      ['GET', '/api/ui/proofs/credits', false],
      ['GET', '/api/ui/proofs/top-up', false],
      ['POST', '/api/ui/proofs/top-up', true],
      ['POST', '/api/ui/proofs/withdraw', true],
    ]);
    const registry = createLocalUiRoutes();
    for (const [method, path] of [
      ['GET', '/api/ui/proofs/top-up'],
      ['POST', '/api/ui/proofs/top-up'],
      ['POST', '/api/ui/proofs/withdraw'],
    ] as const) {
      const hit = registry.match(method, path);
      expect(hit !== undefined && hit !== 'method' && hit.route.presence).toBe(method === 'POST');
    }
    expect(registry.match('GET', '/api/ui/proofs/withdraw')).toBe('method');
  });

  it('the owner key may sign the two credits ops (owner allowlist)', () => {
    expect(OWNER_ACTION_OPS).toContain('credits.deposit');
    expect(OWNER_ACTION_OPS).toContain('credits.withdraw');
  });

  it('the read-only client view gains the top-up read and nothing that moves funds', () => {
    let asked = 0;
    const client = {
      agentId: AGENT,
      getProof: () => Promise.reject(new Error('x')),
      proofs: {
        list: () => Promise.resolve({ items: [] }),
        creditsBalance: () => Promise.resolve({ status: 'unavailable' }),
        topUp: () => {
          asked += 1;
          return Promise.resolve({ status: 'unavailable' });
        },
        addReceivedFunds: () => Promise.reject(new Error('never')),
        withdrawCredits: () => Promise.reject(new Error('never')),
        requestFaucet: () => Promise.reject(new Error('never')),
      },
    };
    const view = readOnlyClient(client as never);
    expect(Object.keys(view.proofs).sort()).toEqual(['creditsBalance', 'list', 'topUp']);
    void view.proofs.topUp();
    expect(asked).toBe(1);
  });
});

describe('GET /api/ui/proofs/top-up', () => {
  it('Chiado: the address for the QR code and the amounts; Base Sepolia coming soon', async () => {
    const { context } = ctx(okView());
    const res = await readRoute('/api/ui/proofs/top-up').handler(context, req());
    expect(res).toEqual({
      status: 200,
      body: {
        status: 'ok',
        networks: [
          { network: 'base-test', method: 'coming_soon' },
          {
            network: 'gnosis-test',
            method: 'address',
            available: true,
            address: AGENT,
            received: '$5.00',
            addable: { usd: '$4.99', amount: (5n * XDAI - 10n ** 16n).toString() },
            credits: { usd: '$2.00', amount: (2n * XDAI).toString() },
          },
        ],
      },
    });
  });

  it('the address appears only for the Gnosis test network', async () => {
    const { context } = ctx(okView([base]));
    const res = await readRoute('/api/ui/proofs/top-up').handler(context, req());
    expect(JSON.stringify(res.body)).not.toContain(AGENT);
    expect(JSON.stringify(res.body)).not.toContain(AGENT.slice(2, 10));
  });

  it('leaves out a mainnet, an unknown chain and a malformed entry', async () => {
    const { context } = ctx(
      okView([
        { chainId: 100, chain: 'gnosis', method: 'address', available: true },
        { chainId: 1, chain: 'ethereum', method: 'coming_soon' },
        chiado({ addable: { amount: '12abc', usd: '1' } }),
        base,
      ]),
    );
    const res = await readRoute('/api/ui/proofs/top-up').handler(context, req());
    expect(res).toEqual({
      status: 200,
      body: { status: 'ok', networks: [{ network: 'base-test', method: 'coming_soon' }] },
    });
  });

  it('a Gnosis read that failed keeps the address and says not available', async () => {
    const { context } = ctx(
      okView([{ chainId: 10200, chain: 'gnosis-chiado', method: 'address', available: false }]),
    );
    const res = await readRoute('/api/ui/proofs/top-up').handler(context, req());
    expect(res.body).toEqual({
      status: 'ok',
      networks: [{ network: 'gnosis-test', method: 'address', available: false, address: AGENT }],
    });
  });

  it('not set up, unavailable and a thrown error are the shared fixed answers', async () => {
    const route = readRoute('/api/ui/proofs/top-up');
    const none = { ...ctx(okView()).context, client: undefined };
    expect(await route.handler(none, req())).toEqual({
      status: 409,
      body: { error: 'not_set_up' },
    });
    expect(await route.handler(ctx({ status: 'unavailable' }).context, req())).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    });
    const thrown = ctx(() => Promise.reject(new Error('https://rpc.example/KEY'))).context;
    const res = await route.handler(thrown, req());
    expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
  });

  it('carries no secret', async () => {
    const res = await readRoute('/api/ui/proofs/top-up').handler(ctx(okView()).context, req());
    expect(JSON.stringify(res.body)).not.toMatch(SECRETISH);
  });
});

describe('POST /api/ui/proofs/top-up: turn received funds into credits', () => {
  const amount = (5n * XDAI - 10n ** 16n).toString();

  it('signs exactly one credits.deposit for the confirmed amount, then core applies it', async () => {
    const { context, calls } = ctx(okView());
    const owner = ownerOp();
    const res = await ownerRoute('/api/ui/proofs/top-up').handler(
      context,
      req({ network: 'gnosis-test', amount }),
      owner,
    );
    expect(res).toEqual({ status: 200, body: { status: 'done' } });
    expect(owner.requests).toHaveLength(1);
    const action = (owner.requests[0] as { action: JsonObject }).action;
    expect(Object.keys(action).sort()).toEqual(
      ['agent', 'expiresAt', 'issuedAt', 'nonce', 'op', 'owner', 'params', 'v'].sort(),
    );
    expect(action).toMatchObject({
      v: 1,
      agent: AGENT,
      owner: Buffer.from(OWNER_NOSTR).toString('hex'),
      op: 'credits.deposit',
      params: { chainId: 10200, token: 'NATIVE', amount },
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_600,
    });
    expect(action['nonce']).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The page was the confirmation: the review names the amount in dollars and the network.
    expect(owner.reviews[0]?.lines.join(' ')).toContain('$4.99');
    expect(owner.reviews[0]?.lines.join(' ')).toContain('Gnosis test network');
    expect(calls.deposit).toHaveLength(1);
    const signed = calls.deposit[0] as { body: JsonObject; sig: string };
    expect(signed.body).toEqual(action);
    const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(signed.body)));
    expect(bip340Verify(OWNER_NOSTR, digest, decodeHex(signed.sig, { length: 64 }))).toBe(true);
  });

  it('signs nothing for bad input, another network or more than can be added', async () => {
    for (const input of [
      undefined,
      null,
      'gnosis-test',
      {},
      { network: 'gnosis-test' },
      { network: 'gnosis-test', amount: Number(amount) },
      { network: 'gnosis-test', amount: '0' },
      { network: 'gnosis-test', amount: '01' },
      { network: 'gnosis-test', amount: '-1' },
      { network: 'gnosis-test', amount: (5n * XDAI).toString() },
      { network: 'gnosis-test', amount, extra: 1 },
      { network: 'gnosis-test', amount, to: OTHER },
      { network: 'base-test', amount },
      { network: 'gnosis', amount },
    ]) {
      const { context, calls } = ctx(okView());
      const owner = ownerOp();
      await ownerRoute('/api/ui/proofs/top-up').handler(context, req(input), owner);
      expect(owner.requests, JSON.stringify(input)).toHaveLength(0);
      expect(calls.deposit).toHaveLength(0);
    }
  });

  it('signs nothing while nothing can be added or the read fails', async () => {
    for (const view of [
      okView([chiado({ addable: { amount: '0', usd: '0' } })]),
      okView([{ chainId: 10200, chain: 'gnosis-chiado', method: 'address', available: false }]),
      { status: 'unavailable' } as TopUpView,
    ]) {
      const { context, calls } = ctx(view);
      const owner = ownerOp();
      await ownerRoute('/api/ui/proofs/top-up').handler(
        context,
        req({ network: 'gnosis-test', amount }),
        owner,
      );
      expect(owner.requests).toHaveLength(0);
      expect(calls.deposit).toHaveLength(0);
    }
  });

  it("maps core's outcome to fixed answers, never echoing anything else", async () => {
    const cases: [CreditsMoveResult, number, unknown][] = [
      [{ status: 'pending' }, 202, { status: 'pending' }],
      [{ status: 'refused', reason: 'amount_unavailable' }, 409, { error: 'amount_changed' }],
      [{ status: 'refused', reason: 'nonce_used' }, 409, { error: 'refused' }],
      [{ status: 'refused', reason: 'not_available' }, 409, { error: 'refused' }],
      [{ status: 'failed', reason: 'no_funds_for_fee' }, 502, { error: 'no_funds_for_fee' }],
      [{ status: 'failed', reason: 'reverted' }, 502, { error: 'failed' }],
      [{ status: 'failed', reason: 'unavailable' }, 503, { error: 'unavailable' }],
    ];
    for (const [answer, status, body] of cases) {
      const { context } = ctx(okView(), answer);
      const res = await ownerRoute('/api/ui/proofs/top-up').handler(
        context,
        req({ network: 'gnosis-test', amount }),
        ownerOp(),
      );
      expect(res).toEqual({ status, body });
      expect(JSON.stringify(res.body)).not.toMatch(SECRETISH);
    }
  });
});

describe('POST /api/ui/proofs/withdraw: credits back to the agent account', () => {
  const amount = (2n * XDAI).toString();

  it("signs one credits.withdraw to the agent's own account, then core applies it", async () => {
    const { context, calls } = ctx(okView());
    const owner = ownerOp();
    const res = await ownerRoute('/api/ui/proofs/withdraw').handler(
      context,
      req({ network: 'gnosis-test', amount }),
      owner,
    );
    expect(res).toEqual({ status: 200, body: { status: 'done' } });
    const action = (owner.requests[0] as { action: JsonObject }).action;
    expect(action).toMatchObject({
      op: 'credits.withdraw',
      agent: AGENT,
      params: { chainId: 10200, token: 'NATIVE', amount, to: AGENT },
    });
    expect(owner.reviews[0]?.lines.join(' ')).toContain('$2.00');
    expect(owner.reviews[0]?.lines.join(' ')).toContain("agent's own account");
    expect(calls.withdraw).toHaveLength(1);
    expect(calls.deposit).toHaveLength(0);
  });

  it('signs nothing for another recipient, more than the credits or bad input', async () => {
    for (const input of [
      { network: 'gnosis-test', amount, to: OTHER },
      { network: 'gnosis-test', amount, to: AGENT },
      { network: 'gnosis-test', amount: (2n * XDAI + 1n).toString() },
      { network: 'gnosis-test', amount: '0' },
      { network: 'base-test', amount },
      { amount },
      [],
    ]) {
      const { context, calls } = ctx(okView());
      const owner = ownerOp();
      await ownerRoute('/api/ui/proofs/withdraw').handler(context, req(input), owner);
      expect(owner.requests, JSON.stringify(input)).toHaveLength(0);
      expect(calls.withdraw).toHaveLength(0);
    }
  });

  it('without the owner context or the credits port, signs nothing', async () => {
    const { context } = ctx(okView());
    const owner = ownerOp();
    await ownerRoute('/api/ui/proofs/withdraw').handler(
      { ...context, ownerContext: () => Promise.resolve(undefined) },
      req({ network: 'gnosis-test', amount }),
      owner,
    );
    const noPort: LocalUiContext = { ...context };
    delete (noPort as { credits?: unknown }).credits;
    await ownerRoute('/api/ui/proofs/withdraw').handler(
      noPort,
      req({ network: 'gnosis-test', amount }),
      owner,
    );
    expect(owner.requests).toHaveLength(0);
  });
});
