// U3-flow: the live connections map's read (USABILITY-WAVE-3 §4.1; 08 §1; 07 §3; I-1, I-2, I-5,
// I-7).
//
// What these tests hold `GET /api/ui/flow?since=<cursor>` to:
// - one read route (`GET`, `presence: false`) in the default registry, replacing U3-c's stub (it
//   answers, never 501); no other method on its path;
// - metadata only, from an allowlist with exact key sets: `{contactId, direction, kind, state, at}`
//   per item and `{now, cursor, items, partial}` per answer. Nothing core or a hostile store may
//   carry rides along: no message text, subject, contact or file name, link (drop upload or download
//   URL), file key, hash or envelope ID; an item that does not fit the allowlist is left out (fail
//   closed). No upload byte counts exist in the store, so no `bytesDone`/`bytesTotal` is sent;
// - the cursor: `since` is whole unix seconds (inclusive); without it the last minute; never older
//   than 24 hours; the next `cursor` is the newest item's time, or a minute ago when quiet;
// - bounded: at most 200 items, newest first, and the answer under 20 KB; `partial` when core's scan
//   cap or either bound left anything out;
// - a bad query is 400 `bad_request` before core is asked, never echoed; no agent is 409
//   `not_set_up`; a failure is 503 `unavailable`, never an error's text; nothing is logged.
// The session gate and the generation stamp are tested with the server in local-ui-server.test.ts
// and app-host-server.test.ts (U3-c); see flow-server.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import type { LocalUiReadRoute, LocalUiResult } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import {
  FLOW_DEFAULT_WINDOW_SECONDS,
  FLOW_MAX_BYTES,
  FLOW_MAX_ITEMS,
  FLOW_MAX_WINDOW_SECONDS,
  FLOW_PATH,
  flowRoute,
} from './flow.js';

const BOB = `0x${'b0'.repeat(20)}`;
const CAROL = `0x${'c0'.repeat(20)}`;
const HOSTILE = 'HOSTILE-<img src=x onerror=alert(1)>';
const CANARY_URL = 'https://drop.agentlink.example/o/CANARY-DROP-URL?X-Amz-Signature=abc';
const NOW = 1_800_000_000;
const NOW_MS = NOW * 1000;

interface Event {
  readonly contactId: unknown;
  readonly direction: unknown;
  readonly kind: unknown;
  readonly state: unknown;
  readonly at: unknown;
  readonly [k: string]: unknown;
}
type FlowEvents = (
  since: number,
  until: number,
) => Promise<{ readonly events: readonly Event[]; readonly capped: boolean }>;

function contextWith(flowEvents: FlowEvents | undefined, nowMs = NOW_MS): LocalUiContext {
  const client =
    flowEvents === undefined
      ? undefined
      : ({
          agentId: 'a',
          getProof: vi.fn(),
          messages: {
            conversations: () => Promise.reject(new Error('not used')),
            list: () => Promise.reject(new Error('not used')),
            pulseTimes: () => Promise.reject(new Error('not used')),
            flowEvents,
          },
        } as unknown as LocalUiReadClient);
  return {
    client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => nowMs,
  };
}

const call = (context: LocalUiContext, query = ''): Promise<LocalUiResult> =>
  (flowRoute as LocalUiReadRoute).handler(context, {
    params: {},
    query: new URLSearchParams(query),
  });

const events =
  (list: readonly Event[], capped = false): FlowEvents =>
  () =>
    Promise.resolve({ events: list, capped });

const ev = (over: Partial<Event> = {}): Event => ({
  contactId: BOB,
  direction: 'in',
  kind: 'message',
  state: 'received',
  at: NOW - 1,
  ...over,
});

interface FlowItem {
  contactId: string;
  direction: string;
  kind: string;
  state: string;
  at: number;
}
interface FlowBody {
  now: number;
  cursor: string;
  items: FlowItem[];
  partial: boolean;
}

async function flowOf(list: readonly Event[], query = '', capped = false) {
  const res = await call(contextWith(events(list, capped)), query);
  expect(res.status).toBe(200);
  return res.body as unknown as FlowBody;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/ui/flow: the route', () => {
  it('is one read route that replaces the U3-c stub, GET only', async () => {
    expect(FLOW_PATH).toBe('/api/ui/flow');
    expect(flowRoute).toMatchObject({ method: 'GET', path: FLOW_PATH, presence: false });
    const registry = createLocalUiRoutes();
    const hit = registry.match('GET', FLOW_PATH);
    expect(hit !== undefined && hit !== 'method' ? hit.route : undefined).toBe(flowRoute);
    expect(registry.match('POST', FLOW_PATH)).toBe('method');
    expect(registry.routes().filter((r) => r.path === FLOW_PATH)).toHaveLength(1);
    // Not the stub any more.
    const res = await call(contextWith(events([])));
    expect(res.status).toBe(200);
  });

  it('is 409 not_set_up with no agent, and 503 unavailable (never the error text) when core fails', async () => {
    expect(await call(contextWith(undefined))).toMatchObject({
      status: 409,
      body: { error: 'not_set_up' },
    });
    const res = await call(contextWith(() => Promise.reject(new Error(`boom ${CANARY_URL}`))));
    expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
    for (const bad of [null, 'x', { events: 'x', capped: false }, { events: [], capped: 'no' }]) {
      const r = await call(contextWith(() => Promise.resolve(bad as never)));
      expect(r).toEqual({ status: 503, body: { error: 'unavailable' } });
    }
  });

  it('refuses any other query parameter, or a since that is not whole seconds, before core is asked, without echoing it', async () => {
    const flowEvents = vi.fn<FlowEvents>();
    for (const query of [
      `x=${HOSTILE}`,
      'limit=5',
      `contactId=${BOB}`,
      'since=1&since=2',
      'since=',
      'since=-1',
      'since=1.5',
      'since=1e9',
      'since=0x10',
      `since=${'9'.repeat(13)}`,
      `since=${encodeURIComponent(HOSTILE)}`,
      'since=1&x=1',
    ]) {
      const res = await call(contextWith(flowEvents), query);
      expect(res).toEqual({ status: 400, body: { error: 'bad_request' } });
      expect(JSON.stringify(res)).not.toContain('HOSTILE');
    }
    expect(flowEvents).not.toHaveBeenCalled();
  });
});

describe('GET /api/ui/flow: the cursor', () => {
  const windowOf = async (query: string, nowMs = NOW_MS): Promise<[number, number]> => {
    const seen: [number, number][] = [];
    await call(
      contextWith((since, until) => {
        seen.push([since, until]);
        return Promise.resolve({ events: [], capped: false });
      }, nowMs),
      query,
    );
    expect(seen).toHaveLength(1);
    return seen[0] as [number, number];
  };

  it('without since, asks core for the last minute up to now', async () => {
    expect(FLOW_DEFAULT_WINDOW_SECONDS).toBe(60);
    expect(await windowOf('')).toEqual([NOW - 60, NOW]);
  });

  it('takes since as given (inclusive), never older than 24 hours, never after now', async () => {
    expect(FLOW_MAX_WINDOW_SECONDS).toBe(86_400);
    expect(await windowOf(`since=${NOW - 30}`)).toEqual([NOW - 30, NOW]);
    expect(await windowOf(`since=${NOW - 86_400}`)).toEqual([NOW - 86_400, NOW]);
    expect(await windowOf('since=0')).toEqual([NOW - 86_400, NOW]);
    expect(await windowOf(`since=${NOW + 500}`)).toEqual([NOW, NOW]);
  });

  it('answers the next cursor: the newest item’s time, else a minute ago when quiet', async () => {
    const busy = await flowOf([ev({ at: NOW - 5 }), ev({ at: NOW - 40 })], `since=${NOW - 50}`);
    expect(busy.now).toBe(NOW);
    expect(busy.cursor).toBe(String(NOW - 5));
    const quiet = await flowOf([], `since=${NOW - 3_600}`);
    expect(quiet.cursor).toBe(String(NOW - 60));
    // An item older than a minute ago never moves the cursor back.
    const old = await flowOf([ev({ at: NOW - 600 })], `since=${NOW - 3_600}`);
    expect(old.cursor).toBe(String(NOW - 60));
    // Feeding the cursor back asks from that second on (inclusive: the page may see it again).
    const next = await windowOf(`since=${busy.cursor}`);
    expect(next).toEqual([NOW - 5, NOW]);
  });

  it('carries over a cursor from another agent harmlessly: it is only a time (stale generation)', async () => {
    // After a switch the page may poll once with the old agent's cursor: it names no agent, no
    // contact and no row, so the answer is simply the open agent's flow from that second on.
    const res = await flowOf([ev({ contactId: CAROL, at: NOW - 2 })], `since=${NOW - 10}`);
    expect(res.items.map((i) => i.contactId)).toEqual([CAROL]);
  });
});

describe('GET /api/ui/flow: metadata only (zero access, I-5, I-7)', () => {
  const ITEM_KEYS = ['at', 'contactId', 'direction', 'kind', 'state'];
  const BODY_KEYS = ['cursor', 'items', 'now', 'partial'];

  it('returns exact key sets and nothing else core carries, even hostile content', async () => {
    const body = await flowOf([
      ev({
        // Everything a hostile or buggy store layer might add: never passed on.
        text: `BODY ${HOSTILE}`,
        subject: HOSTILE,
        name: HOSTILE,
        display: HOSTILE,
        fileName: `${HOSTILE}.pdf`,
        url: CANARY_URL,
        uploadUrl: CANARY_URL,
        downloadUrl: CANARY_URL,
        fileKey: 'FILE-KEY-CANARY',
        sha256: 'ab'.repeat(32),
        envelopeId: 'ENVELOPE-ID-CANARY',
        envelope_json: '{"CANARY":1}',
        bytesDone: 5,
        bytesTotal: 10,
      }),
      ev({ direction: 'out', kind: 'file', state: 'queued', at: NOW - 2 }),
    ]);
    expect(Object.keys(body).sort()).toEqual(BODY_KEYS);
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    const json = JSON.stringify(body);
    expect(json).not.toMatch(
      /HOSTILE|BODY|CANARY|https?:|X-Amz|FILE-KEY|ENVELOPE-ID|abababab|bytes|name|url|key|hash|sha/i,
    );
    expect(body.items).toEqual([
      { contactId: BOB, direction: 'in', kind: 'message', state: 'received', at: NOW - 1 },
      { contactId: BOB, direction: 'out', kind: 'file', state: 'queued', at: NOW - 2 },
    ]);
  });

  it('leaves out an item that does not fit the allowlist (fail closed)', async () => {
    const body = await flowOf([
      ev({ contactId: HOSTILE }),
      ev({ contactId: BOB.toUpperCase().replace('0X', '0x') }),
      ev({ contactId: CANARY_URL }),
      ev({ direction: 'sideways' }),
      ev({ kind: HOSTILE }),
      ev({ state: HOSTILE }),
      ev({ direction: 'in', state: 'sent' }), // only sent messages are sent
      ev({ direction: 'out', state: 'received' }),
      ev({ at: 1.5 }),
      ev({ at: -1 }),
      ev({ at: String(NOW) }),
      ev({ at: NOW + 1 }), // after now
      ev({ at: NOW - 86_401 }), // before the window
      null as unknown as Event,
      'x' as unknown as Event,
      ev({ contactId: CAROL, at: NOW - 3 }),
    ]);
    expect(body.items).toEqual([
      { contactId: CAROL, direction: 'in', kind: 'message', state: 'received', at: NOW - 3 },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/HOSTILE|CANARY/);
  });

  it('never logs: nothing reaches the console (logs carry counts only, and this route has none)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await flowOf([ev({ text: HOSTILE, url: CANARY_URL })]);
    await call(contextWith(() => Promise.reject(new Error(CANARY_URL))));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('GET /api/ui/flow: bounded (at most 200 items, under 20 KB)', () => {
  const many = (n: number, contact = (i: number) => `0x${i.toString(16).padStart(40, '0')}`) =>
    Array.from({ length: n }, (_, i) =>
      ev({
        contactId: contact(i),
        direction: 'out',
        kind: 'message',
        state: 'not_delivered', // the longest state word
        at: NOW - (i % 86_000),
      }),
    );

  it('caps at FLOW_MAX_ITEMS (200), newest first, and keeps the answer under FLOW_MAX_BYTES (20 KB)', async () => {
    expect(FLOW_MAX_ITEMS).toBe(200);
    expect(FLOW_MAX_BYTES).toBeLessThanOrEqual(20 * 1024);
    const body = await flowOf(many(10_000), `since=${NOW - 86_400}`);
    expect(body.partial).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThanOrEqual(FLOW_MAX_ITEMS);
    expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThan(20 * 1024);
    const ats = body.items.map((i) => i.at);
    expect(ats).toEqual([...ats].sort((x, y) => y - x));
  });

  it('answers 100 items whole; past the size bound it keeps the newest and says partial', async () => {
    const list = Array.from({ length: 201 }, (_, i) => ev({ at: NOW - i }));
    const whole = await flowOf(list.slice(0, 100), `since=${NOW - 3_600}`);
    expect(whole.items).toHaveLength(100);
    expect(whole.partial).toBe(false);
    // A full item is about 127 bytes, so the 20 KB bound is reached before 200 items.
    const over = await flowOf(list, `since=${NOW - 3_600}`);
    expect(over.partial).toBe(true);
    expect(over.items.length).toBeGreaterThan(140);
    expect(over.items.length).toBeLessThan(200);
    expect(over.items[0]?.at).toBe(NOW);
    expect(new TextEncoder().encode(JSON.stringify(over)).length).toBeLessThanOrEqual(
      FLOW_MAX_BYTES,
    );
  });

  it('caps the items at 200 even when the size bound would allow more (the bound is the item count first)', async () => {
    // A stand-in for core answering more than 200: the route never passes more than 200 on.
    const list = Array.from({ length: 500 }, (_, i) => ev({ at: NOW - i }));
    const body = await flowOf(list, `since=${NOW - 3_600}`);
    expect(body.items.length).toBeLessThanOrEqual(FLOW_MAX_ITEMS);
    expect(body.partial).toBe(true);
  });

  it('passes core’s scan cap on as partial', async () => {
    const body = await flowOf([ev()], '', true);
    expect(body.partial).toBe(true);
  });

  it('sorts newest first whatever order core answers in (then by contact, direction, kind)', async () => {
    const body = await flowOf([
      ev({ at: NOW - 9 }),
      ev({ contactId: CAROL, at: NOW - 1 }),
      ev({ at: NOW - 1, direction: 'out', state: 'sent' }),
      ev({ at: NOW - 5 }),
      ev({ at: NOW - 1 }),
    ]);
    expect(body.items.map((i) => [i.contactId, i.direction, i.at])).toEqual([
      [BOB, 'in', NOW - 1],
      [BOB, 'out', NOW - 1],
      [CAROL, 'in', NOW - 1],
      [BOB, 'in', NOW - 5],
      [BOB, 'in', NOW - 9],
    ]);
  });
});
