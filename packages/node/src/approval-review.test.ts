// M1-11a acceptance at the HTTP level: the local approval server's review-together route, the
// one-shot session link and the wrong-code backoff (08 §1; 04 §2.5, §2.5.2; 11 §6.2.1; D-68;
// IR-M1-8d-1 L-2, L-3).
//
// - Review together (D-68): one owner code entry signs one `approval.decideBatch` over exactly the
//   items the page listed (2 to 20), or one `approval.decide` for a single item. A commitment is
//   never part of it: the server refuses the whole request before the owner store is opened.
// - The session link (`/?t=…`) is one-shot: the first request exchanges it for a session cookie and
//   it never works again; a link also dies after SESSION_LINK_LIFETIME_MS. `open()` mints a new one.
// - After FREE_PRESENCE_ATTEMPTS wrong owner codes or passkeys in a row, every owner operation waits
//   (429 `wait`, Retry-After) before the owner store is opened, doubling up to a cap; a success resets.
import { encodeUtf8 } from '@agentlink/crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  FREE_PRESENCE_ATTEMPTS,
  MAX_PRESENCE_BACKOFF_S,
  SESSION_LINK_LIFETIME_MS,
  presenceBackoffSeconds,
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
} from './approval-server.js';
import {
  approvalId as id,
  fakeSource,
  ownerSigValid,
  ownerWorld,
  send,
  type FakeSource,
  type OwnerWorld,
  type RawResponse,
} from './approval-ui.fixture.js';
import { KeychainOwnerKeyStore } from './owner-keystore.js';

let world: OwnerWorld;
beforeAll(async () => {
  world = await ownerWorld('agentlink-m1-11a-');
}, 60_000);
afterAll(() => world.cleanup());

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

interface Harness {
  readonly server: ApprovalServer;
  readonly source: FakeSource;
  readonly events: ApprovalServerEvent[];
  readonly opened: string[];
  readonly ownerStoresOpened: { count: number };
  readonly clock: { ms: number };
  /** A fresh session link from `open()`. */
  link(): Promise<string>;
  /** A session cookie and the page's CSRF token, through a fresh link. */
  session(): Promise<{ cookie: string; csrf: string }>;
}

async function harness(): Promise<Harness> {
  const source = fakeSource(world);
  const events: ApprovalServerEvent[] = [];
  const opened: string[] = [];
  const ownerStoresOpened = { count: 0 };
  const clock = { ms: Date.now() };
  const server = await startApprovalServerWith(
    { source, onEvent: (e) => void events.push(e) },
    {
      keychain: world.keychain,
      openOwnerStore: (expected) => {
        ownerStoresOpened.count += 1;
        return KeychainOwnerKeyStore.open(world.keychain, expected);
      },
      opener: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      notifier: () => Promise.resolve(true),
      now: () => clock.ms,
    },
  );
  servers.push(server);
  const h: Harness = {
    server,
    source,
    events,
    opened,
    ownerStoresOpened,
    clock,
    async link() {
      await server.open();
      return opened[opened.length - 1] ?? '';
    },
    async session() {
      const url = new URL(await h.link());
      const res = await send(server.port, `${url.pathname}${url.search}`);
      expect(res.status).toBe(303);
      const cookie = (res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
      const page = await send(server.port, '/', { headers: { Cookie: cookie } });
      expect(page.status).toBe(200);
      const csrf = /<meta name="agentlink-csrf" content="([A-Za-z0-9_-]+)">/.exec(page.body)?.[1];
      return { cookie, csrf: csrf ?? '' };
    },
  };
  return h;
}

type Pick = readonly [n: number, decision: 'approve' | 'deny'];

/** The items header as the page sends it: `<approvalId>:<actionDigest>:<a|d>`, comma separated. */
async function itemsHeader(h: Harness, picks: readonly Pick[]): Promise<string> {
  const parts: string[] = [];
  for (const [n, decision] of picks) {
    const row = await h.source.get(id(n));
    parts.push(
      `${id(n)}:${row?.actionDigest ?? '0'.repeat(64)}:${decision === 'approve' ? 'a' : 'd'}`,
    );
  }
  return parts.join(',');
}

async function review(
  h: Harness,
  picks: readonly Pick[] | string,
  secret: string | undefined,
  session?: { cookie: string; csrf: string },
): Promise<RawResponse> {
  const s = session ?? (await h.session());
  const items = typeof picks === 'string' ? picks : await itemsHeader(h, picks);
  return send(h.server.port, '/api/approvals/review', {
    method: 'POST',
    headers: {
      Cookie: s.cookie,
      Origin: h.server.origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-CSRF': s.csrf,
      'X-AgentLink-Items': items,
      'Sec-Fetch-Site': 'same-origin',
    },
    ...(secret === undefined ? {} : { body: encodeUtf8(secret) }),
  });
}

async function decideOne(
  h: Harness,
  n: number,
  secret: string,
  session: { cookie: string; csrf: string },
): Promise<RawResponse> {
  const row = await h.source.get(id(n));
  return send(h.server.port, `/api/approvals/${id(n)}/approve`, {
    method: 'POST',
    headers: {
      Cookie: session.cookie,
      Origin: h.server.origin,
      'Content-Type': 'application/octet-stream',
      'X-AgentLink-CSRF': session.csrf,
      'X-AgentLink-Digest': row?.actionDigest ?? '',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: encodeUtf8(secret),
  });
}

const WRONG = 'AAAA BBBB CCCC DDDD EEEE FFFF';
const json = (res: RawResponse): Record<string, unknown> =>
  JSON.parse(res.body) as Record<string, unknown>;

describe('review together: one owner code entry, exactly the listed items (D-68, 04 §2.5.2)', () => {
  it('signs one approval.decideBatch over exactly the selected items, in canonical order', async () => {
    const h = await harness();
    for (const n of [1, 2, 3, 4, 5]) h.source.add(n);
    // The owner marks 3, 1 and 4; 2 and 5 are left for later.
    const res = await review(
      h,
      [
        [3, 'approve'],
        [1, 'approve'],
        [4, 'deny'],
      ],
      world.code,
    );
    expect(res.status).toBe(200);
    expect(json(res)).toEqual({
      status: 'applied',
      items: [
        { approvalId: id(1), decision: 'approve' },
        { approvalId: id(3), decision: 'approve' },
        { approvalId: id(4), decision: 'deny' },
      ],
    });
    expect(h.ownerStoresOpened.count).toBe(1);
    expect(h.source.applied).toHaveLength(1);
    const signed = h.source.applied[0];
    if (signed === undefined) throw new Error('unreachable');
    expect(ownerSigValid(world.owner, signed.body, signed.sig)).toBe(true);
    expect(signed.body['op']).toBe('approval.decideBatch');
    const items = (signed.body['params'] as { items: { approvalId: string; decision: string }[] })
      .items;
    expect(items.map((i) => [i.approvalId, i.decision])).toEqual([
      [id(1), 'approve'],
      [id(3), 'approve'],
      [id(4), 'deny'],
    ]);
    expect(h.source.pending(2)).toBe(true);
    expect(h.source.pending(5)).toBe(true);
    // expiresAt ≤ issuedAt + 600 (D-71 (3)).
    expect(Number(signed.body['expiresAt']) - Number(signed.body['issuedAt'])).toBeLessThanOrEqual(
      600,
    );
    // The decided items are gone from the list.
    const s = await h.session();
    const list = await send(h.server.port, '/api/approvals', {
      headers: { Cookie: s.cookie, 'X-AgentLink-CSRF': s.csrf },
    });
    expect(
      (json(list)['approvals'] as { approvalId: string }[]).map((a) => a.approvalId).sort(),
    ).toEqual([id(2), id(5)]);
  });

  it('signs a single listed item as approval.decide, never a batch of one', async () => {
    const h = await harness();
    h.source.add(1);
    h.source.add(2);
    const res = await review(h, [[2, 'deny']], world.code);
    expect(res.status).toBe(200);
    expect(h.source.applied[0]?.body['op']).toBe('approval.decide');
  });

  it('refuses a list with a commitment before asking for presence', async () => {
    const h = await harness();
    h.source.add(1);
    h.source.add(2, { commitment: true });
    const res = await review(
      h,
      [
        [1, 'approve'],
        [2, 'approve'],
      ],
      world.code,
    );
    expect(res.status).toBe(409);
    expect(json(res)).toMatchObject({ status: 'commitment', items: [id(2)] });
    expect(h.ownerStoresOpened.count).toBe(0);
    expect(h.source.calls.apply).toBe(0);
    expect(h.source.pending(1)).toBe(true);
    expect(h.source.pending(2)).toBe(true);
  });

  it('refuses a malformed, duplicate, empty or oversized list before asking for presence', async () => {
    const h = await harness();
    for (let n = 0; n < 22; n += 1) h.source.add(n);
    const one = await itemsHeader(h, [[1, 'approve']]);
    const cases = [
      '',
      'nonsense',
      `${one},${one}`,
      one.replace(':a', ':x'),
      one.replace(id(1), 'apr_short'),
      `${one};${one}`,
      await itemsHeader(
        h,
        Array.from({ length: 21 }, (_, n) => [n, 'approve'] as const),
      ),
    ];
    for (const items of cases) {
      const res = await review(h, items, world.code);
      expect(res.status, items.slice(0, 40)).toBe(400);
      expect(json(res)).toMatchObject({ status: 'invalid' });
    }
    expect(h.ownerStoresOpened.count).toBe(0);
    expect(h.source.calls.apply).toBe(0);
  });

  it('refuses the whole list when one item changed or is no longer pending', async () => {
    const h = await harness();
    for (const n of [1, 2, 3]) h.source.add(n);
    const items = await itemsHeader(h, [
      [1, 'approve'],
      [2, 'approve'],
      [3, 'deny'],
    ]);
    h.source.remove(2);
    const gone = await review(h, items, world.code);
    expect(gone.status).toBe(409);
    expect(json(gone)).toMatchObject({ status: 'not_pending', items: [id(2)] });
    h.source.add(2);
    h.source.add(3, { actionDigest: '0'.repeat(64), storedDigest: '0'.repeat(64) });
    const changed = await review(
      h,
      (await itemsHeader(h, [[1, 'approve']])) + ',' + items.split(',')[2],
      world.code,
    );
    expect(changed.status).toBe(409);
    expect(json(changed)).toMatchObject({ status: 'changed' });
    expect(h.ownerStoresOpened.count).toBe(0);
    expect(h.source.applied).toEqual([]);
  });

  it('needs owner presence: no code, a wrong code, nothing signed', async () => {
    const h = await harness();
    h.source.add(1);
    h.source.add(2);
    const picks: Pick[] = [
      [1, 'approve'],
      [2, 'approve'],
    ];
    expect(json(await review(h, picks, undefined))).toMatchObject({ status: 'presence_required' });
    expect(json(await review(h, picks, WRONG))).toMatchObject({ status: 'presence_rejected' });
    expect(h.source.applied).toEqual([]);
  });

  it('reports the items core refused; nothing applies', async () => {
    const h = await harness();
    h.source.add(1);
    h.source.add(2);
    const items = await itemsHeader(h, [
      [1, 'approve'],
      [2, 'approve'],
    ]);
    // Core refuses item 2: it changed between the server's check and core's transaction.
    const apply = h.source.apply.bind(h.source);
    h.source.apply = (signed) => {
      h.source.add(2, { commitment: true });
      return apply(signed);
    };
    const res = await review(h, items, world.code);
    expect(res.status).toBe(409);
    expect(json(res)).toMatchObject({ status: 'refused', items: [id(2)] });
    expect(h.source.pending(1)).toBe(true);
  });
});

describe('the session link is one-shot (IR-M1-8d-1 L-3)', () => {
  it('exchanges a link once; the same link never works again', async () => {
    const h = await harness();
    const url = new URL(await h.link());
    const path = `${url.pathname}${url.search}`;
    const first = await send(h.server.port, path);
    expect(first.status).toBe(303);
    const second = await send(h.server.port, path);
    expect(second.status).toBe(401);
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(second.body).toContain('This link has expired.');
    // The cookie from the first exchange keeps the page open.
    const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    expect((await send(h.server.port, '/', { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('mints a new link on every open(), and the cookie is not the link', async () => {
    const h = await harness();
    const a = new URL(await h.link()).searchParams.get('t');
    const b = new URL(await h.link()).searchParams.get('t');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    const res = await send(h.server.port, `/?t=${String(b)}`);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).not.toContain(String(a));
    expect(cookie).not.toContain(String(b));
    // Both links were valid; a is still unused and works once.
    expect((await send(h.server.port, `/?t=${String(a)}`)).status).toBe(303);
    expect((await send(h.server.port, `/?t=${String(a)}`)).status).toBe(401);
  });

  it('a link dies after SESSION_LINK_LIFETIME_MS unused', async () => {
    const h = await harness();
    const url = new URL(await h.link());
    h.clock.ms += SESSION_LINK_LIFETIME_MS + 1;
    expect((await send(h.server.port, `${url.pathname}${url.search}`)).status).toBe(401);
    expect(SESSION_LINK_LIFETIME_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe('wrong owner codes back off (IR-M1-8d-1 L-2)', () => {
  it('waits after FREE_PRESENCE_ATTEMPTS wrong codes, without opening the owner store', async () => {
    const h = await harness();
    h.source.add(1);
    const s = await h.session();
    for (let i = 0; i < FREE_PRESENCE_ATTEMPTS; i += 1) {
      const res = await decideOne(h, 1, WRONG, s);
      expect(json(res)).toMatchObject({ status: 'presence_rejected' });
    }
    const opened = h.ownerStoresOpened.count;
    // Even the right code waits now.
    const waiting = await decideOne(h, 1, world.code, s);
    expect(waiting.status).toBe(429);
    const body = json(waiting);
    expect(body['status']).toBe('wait');
    expect(body['retryAfter']).toBe(presenceBackoffSeconds(FREE_PRESENCE_ATTEMPTS));
    expect(waiting.headers['retry-after']).toBe(String(body['retryAfter']));
    expect(h.ownerStoresOpened.count).toBe(opened);
    // The review route and the passkey route wait too.
    expect((await review(h, [[1, 'approve']], world.code, s)).status).toBe(429);
    const passkey = await send(h.server.port, '/api/owner/passkey', {
      method: 'POST',
      headers: {
        Cookie: s.cookie,
        Origin: h.server.origin,
        'Content-Type': 'application/octet-stream',
        'X-AgentLink-CSRF': s.csrf,
      },
      body: new Uint8Array([0, 4, 65, 65, 65, 65]),
    });
    expect(passkey.status).toBe(429);
    expect(h.events).toContainEqual({ kind: 'decision', outcome: 'wait' });

    // After the wait, the right code works, and resets the count.
    h.clock.ms += Number(body['retryAfter']) * 1000 + 1;
    expect(json(await decideOne(h, 1, world.code, s))).toMatchObject({ status: 'applied' });
    h.source.add(2);
    expect(json(await decideOne(h, 2, WRONG, s))).toMatchObject({ status: 'presence_rejected' });
    expect(json(await decideOne(h, 2, world.code, s))).toMatchObject({ status: 'applied' });
  }, 60_000);

  it('doubles the wait for every further wrong code, up to a cap', () => {
    expect(FREE_PRESENCE_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(FREE_PRESENCE_ATTEMPTS).toBeLessThanOrEqual(5);
    const first = presenceBackoffSeconds(FREE_PRESENCE_ATTEMPTS);
    expect(first).toBeGreaterThan(0);
    expect(presenceBackoffSeconds(FREE_PRESENCE_ATTEMPTS + 1)).toBe(first * 2);
    expect(presenceBackoffSeconds(FREE_PRESENCE_ATTEMPTS + 30)).toBe(MAX_PRESENCE_BACKOFF_S);
    expect(presenceBackoffSeconds(FREE_PRESENCE_ATTEMPTS - 1)).toBe(0);
  });
});

describe('the approval card data (11 §6.2.1, I-5)', () => {
  it('passes who, what, cost, the rule and the AI arguments to the page as data only', async () => {
    const h = await harness();
    const xss = '<img src=x onerror="window.__xss=1">';
    h.source.add(1, {
      details: {
        who: `Denis ${xss}`,
        what: 'Record a proof',
        cost: '$0.10',
        expires: '12 Oct 2026 14:02 UTC',
        rule: 'Your rules ask you to approve every proof.',
        fromAi: [{ name: 'path', value: `report-${xss}.pdf` }],
      },
    });
    const s = await h.session();
    const res = await send(h.server.port, `/api/approvals/${id(1)}`, {
      headers: { Cookie: s.cookie, 'X-AgentLink-CSRF': s.csrf },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const approval = json(res)['approval'] as { details: { who: string; fromAi: unknown[] } };
    expect(approval.details.who).toBe(`Denis ${xss}`);
    expect(approval.details.fromAi).toEqual([{ name: 'path', value: `report-${xss}.pdf` }]);
    // The page itself carries no request data.
    const page = await send(h.server.port, '/', { headers: { Cookie: s.cookie } });
    expect(page.body).not.toContain('Denis');
  });
});
