// NET-UI-B: the typed client checks every answer against the 08 §1 shapes, and sends the requests
// the spec names (paths, JSON bodies, owner input header, CSRF) and nothing else.
import { describe, expect, it } from 'vitest';
import {
  PROGRESS_PATH,
  RESET_PATH,
  SERVERS_PATH,
  TEST_PATH,
  createServersApi,
  parseDone,
  parseProgress,
  parseReview,
  parseStatus,
  parseTestResults,
} from './api.js';
import { createMockServersApi, mockTest } from './mock.js';

const ok = {
  host: 'relay.example.com',
  outcome: 'ready',
  reason: null,
  roundTripMs: 80,
  signInRequired: false,
  paymentRequired: false,
};

describe('parsers', () => {
  it('parseTestResults keeps the spec shape and drops anything else', () => {
    expect(parseTestResults({ results: [ok] })?.[0]).toMatchObject({ host: 'relay.example.com' });
    expect(parseTestResults({ results: [] })).toBeUndefined();
    expect(parseTestResults({ results: Array.from({ length: 9 }, () => ok) })).toBeUndefined();
    expect(parseTestResults({ results: [{ ...ok, outcome: 'maybe' }] })).toBeUndefined();
    expect(parseTestResults({ results: [{ ...ok, reason: 'a server said hi' }] })).toBeUndefined();
    expect(parseTestResults({ nope: 1 })).toBeUndefined();
  });

  it('a host that is not plain DNS text is never kept (text or markup from a server)', () => {
    const r = parseTestResults({ results: [{ ...ok, host: '<b>x</b>' }] });
    expect(r?.[0]?.host).toBe('');
  });

  it('parseReview and parseDone', () => {
    const review = {
      servers: [
        { host: 'a.example.com', role: 'own', outcome: 'ready' },
        { host: 'b.example.com', role: 'automatic', outcome: 'ready' },
      ],
      leaving: [{ host: 'c.example.com', until: 1_800_000_000 }],
      contacts: 3,
    };
    expect(parseReview(review)?.contacts).toBe(3);
    expect(parseReview({ ...review, servers: [review.servers[0]] })).toBeUndefined();
    expect(parseReview({ ...review, contacts: -1 })).toBeUndefined();
    expect(
      parseReview({
        ...review,
        servers: [{ host: 'a', role: 'x', outcome: 'ready' }, review.servers[1]],
      }),
    ).toBeUndefined();
    expect(parseDone({ status: 'done', contacts: 4, leavingUntil: 1_800_000_000 })).toEqual({
      contacts: 4,
      leavingUntil: 1_800_000_000,
    });
    expect(parseDone({ status: 'done', contacts: 4, leavingUntil: null })?.leavingUntil).toBeNull();
    expect(parseDone({ status: 'failed' })).toBeUndefined();
  });

  it('parseProgress: {changedAt: null} is nothing yet; a bad shape is "bad"', () => {
    expect(parseProgress({ changedAt: null })).toBeUndefined();
    expect(parseProgress('x')).toBe('bad');
    const p = parseProgress({
      changedAt: 1_800_000_000,
      contacts: { total: 2, sent: 1, waiting: 1 },
      items: [
        { ref: '0x1', name: 'Natasa', state: 'sent' },
        { ref: '0x2', name: 'Denis', state: 'waiting' },
        { ref: '0x3', name: 'Odd', state: 'lost' },
      ],
      leavingUntil: null,
    });
    expect(p).not.toBe('bad');
    expect(p === undefined || p === 'bad' ? [] : p.items.map((i) => i.name)).toEqual([
      'Natasa',
      'Denis',
    ]);
  });

  it('parseStatus reads the 0.5.15 additions and tolerates their absence', () => {
    const base = {
      agent: 'running',
      mode: 'custom',
      servers: [{ kind: 'own' }, { kind: 'previous' }],
    };
    expect(parseStatus(base)).toMatchObject({ ownCount: 1, mixIn: false, change: null });
    expect(
      parseStatus({
        ...base,
        mixIn: true,
        announceDefault: false,
        change: 'paused',
        previousUntil: 5,
      }),
    ).toMatchObject({ mixIn: true, announceDefault: false, change: 'paused', previousUntil: 5 });
    expect(parseStatus({ agent: 'weird' })).toBeUndefined();
  });
});

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}
function client(answers: Record<string, { status: number; body: unknown }>): {
  api: ReturnType<typeof createServersApi>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
    });
    const a = answers[`${method} ${url}`] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { api: createServersApi({ fetch: fetchFn, token: 'tok' }), calls };
}

describe('the production client', () => {
  it('test: one JSON POST of exactly {servers}, results in input order', async () => {
    const { api, calls } = client({
      [`POST ${TEST_PATH}`]: { status: 200, body: { results: [ok] } },
    });
    const out = await api.test(['wss://relay.example.com']);
    expect(out.kind).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ servers: ['wss://relay.example.com'] });
    expect(calls[0]?.headers.get('X-AgentLink-CSRF')).toBe('tok');
  });

  it('test: 429 is busy, a wrong count of results is a failure, offline is offline', async () => {
    expect(
      (
        await client({ [`POST ${TEST_PATH}`]: { status: 429, body: {} } }).api.test([
          'wss://a.example.com',
        ])
      ).kind,
    ).toBe('busy');
    expect(
      (
        await client({
          [`POST ${TEST_PATH}`]: { status: 200, body: { results: [ok, ok] } },
        }).api.test(['wss://a.example.com'])
      ).kind,
    ).toBe('failed');
    const off = createServersApi({
      fetch: (async () => {
        throw new TypeError('x');
      }) as typeof fetch,
      token: 't',
    });
    expect((await off.test(['wss://a.example.com'])).kind).toBe('offline');
  });

  it('review: {…, review: true} without presence; refusals keep their fixed code and fitsFrom', async () => {
    const input = {
      servers: ['wss://a.example.com', 'wss://b.example.com'],
      automatic: true,
      announce: true,
    };
    const review = {
      servers: [
        { host: 'a.example.com', role: 'own', outcome: 'ready' },
        { host: 'b.example.com', role: 'own', outcome: 'ready' },
      ],
      leaving: [],
      contacts: 0,
    };
    const good = client({ [`POST ${SERVERS_PATH}`]: { status: 200, body: review } });
    expect((await good.api.review(input)).kind).toBe('ok');
    // NET-OWNER-SET: the owner route's input travels in X-AgentLink-Input; the body is empty (no
    // master code, no passkey), so the server answers the review before its presence gate.
    const sent = good.calls[0];
    expect(sent?.headers.get('content-type')).toBe('application/octet-stream');
    const raw = sent?.headers.get('X-AgentLink-Input') ?? '';
    expect(JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
      ...input,
      review: true,
    });
    expect(sent?.body).toBeUndefined();
    expect(sent?.headers.get('X-AgentLink-Presence')).toBeNull();
    expect(sent?.headers.get('X-AgentLink-CSRF')).toBe('tok');
    const refused = client({
      [`POST ${SERVERS_PATH}`]: {
        status: 409,
        body: { error: 'too_many_previous', fitsFrom: 1_800_000_000 },
      },
    });
    expect(await refused.api.review(input)).toEqual({
      kind: 'refused',
      code: 'too_many_previous',
      fitsFrom: 1_800_000_000,
    });
    const unknown = client({
      [`POST ${SERVERS_PATH}`]: { status: 409, body: { error: 'free text from a server' } },
    });
    expect((await unknown.api.review(input)).kind).toBe('failed');
  });

  it('set and reset: an owner operation (input in the header, the code as the body), signing on the server', async () => {
    const input = {
      servers: ['wss://a.example.com', 'wss://b.example.com'],
      automatic: false,
      announce: false,
    };
    const { api, calls } = client({
      [`POST ${SERVERS_PATH}`]: {
        status: 200,
        body: { status: 'done', contacts: 2, leavingUntil: 1_800_000_000 },
      },
      [`POST ${RESET_PATH}`]: { status: 409, body: { error: 'rotation_pending' } },
    });
    expect(await api.set(input, { kind: 'code', code: '123456' })).toEqual({
      kind: 'ok',
      value: { contacts: 2, leavingUntil: 1_800_000_000 },
    });
    const sent = calls[0];
    expect(sent?.headers.get('content-type')).toBe('application/octet-stream');
    const raw = sent?.headers.get('X-AgentLink-Input') ?? '';
    expect(JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')))).toEqual(input);
    expect(await api.reset({ kind: 'code', code: '123456' })).toEqual({
      kind: 'refused',
      code: 'rotation_pending',
    });
  });

  it('progress: {changedAt: null} is undefined; a bad body fails', async () => {
    expect(
      await client({
        [`GET ${PROGRESS_PATH}`]: { status: 200, body: { changedAt: null } },
      }).api.progress(),
    ).toEqual({ kind: 'ok', value: undefined });
    expect(
      (await client({ [`GET ${PROGRESS_PATH}`]: { status: 200, body: [] } }).api.progress()).kind,
    ).toBe('failed');
  });
});

describe('the mocked client', () => {
  it('answers shapes the parsers accept, so wiring is a small change', async () => {
    const mock = createMockServersApi();
    const tested = await mock.test(['wss://relay.example.com', 'wss://slow.example.com']);
    expect(tested.kind === 'ok' && parseTestResults({ results: tested.value })).toBeTruthy();
    const review = await mock.review({
      servers: ['wss://a.example.com', 'wss://b.example.com'],
      automatic: true,
      announce: true,
    });
    expect(review.kind === 'ok' && parseReview(review.value)).toBeTruthy();
    expect(mockTest('wss://x.example.com').outcome).toBe('ready');
  });
});
