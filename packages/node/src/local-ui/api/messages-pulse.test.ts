// UX2-f1: the per-contact activity pulse read (b11 §24; UX-WAVE-2 item 4, decision 4.1; 08 §1;
// I-1, I-5).
//
// What these tests hold `GET /api/ui/messages/pulse` to:
// - one read route (`GET`, `presence: false`) in the default registry, matched before the
//   `/api/ui/messages/:contactId` route; no other method on its path;
// - counts and times only: every contact item has exactly `contactId`, `counts`, `lastAt` and
//   `activity`, and nothing core may carry (text, subject, file name, size, envelope JSON) rides
//   along (zero access, I-5);
// - twelve two-hour buckets over the last 24 hours, oldest first, both directions together, with
//   the boundaries exact; the activity word from the last exchange: `active_now` within 5 minutes,
//   `today` since the local midnight, `quiet` otherwise;
// - bounded: at most MAX_PULSE_CONTACTS contacts, the most recent first, and `partial` when core's
//   scan was capped or contacts were left out; 10 000 contacts answer fast and small;
// - a query parameter is 400 `bad_request` before core is asked; no agent is 409 `not_set_up`; a
//   failure is 503 `unavailable`, never an error's text.
// The session gate (the token) is tested with the server in local-ui-server.test.ts.
import { describe, expect, it, vi } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import type { LocalUiReadRoute, LocalUiResult } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { MAX_PULSE_CONTACTS, PULSE_PATH, pulseRoute } from './messages-pulse.js';

const BOB = `0x${'b0'.repeat(20)}`;
const CAROL = `0x${'c0'.repeat(20)}`;
const DAVE = `0x${'d0'.repeat(20)}`;
const CANARY = 'CANARY-CONTENT-MUST-NOT-LEAK';

const HOUR = 3_600;
const BUCKET = 2 * HOUR;
const DAY = 24 * HOUR;

/** Local noon, so the local midnight is 12 hours back whatever the test machine's time zone. */
const NOON_MS = new Date(2027, 2, 10, 12, 0, 0).getTime();
const NOON = NOON_MS / 1000;

/** The local midnight (unix seconds) of the local day that contains `ms`. */
function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

interface Time {
  readonly contactId: string;
  readonly at: number;
}
type PulseTimes = (
  since: number,
  until: number,
) => Promise<{ readonly times: readonly Time[]; readonly capped: boolean }>;

function contextWith(pulseTimes: PulseTimes | undefined, nowMs = NOON_MS): LocalUiContext {
  const client =
    pulseTimes === undefined
      ? undefined
      : ({
          agentId: 'a',
          getProof: vi.fn(),
          messages: {
            conversations: () => Promise.reject(new Error('not used')),
            list: () => Promise.reject(new Error('not used')),
            pulseTimes,
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
  (pulseRoute as LocalUiReadRoute).handler(context, {
    params: {},
    query: new URLSearchParams(query),
  });

const times =
  (list: readonly Time[], capped = false): PulseTimes =>
  () =>
    Promise.resolve({ times: list, capped });

interface PulseItem {
  contactId: string;
  counts: number[];
  lastAt: number;
  activity: string;
}
interface PulseBody {
  now: number;
  bucketSeconds: number;
  contacts: PulseItem[];
  partial: boolean;
}

async function pulseOf(list: readonly Time[], nowMs = NOON_MS, capped = false) {
  const res = await call(contextWith(times(list, capped), nowMs));
  expect(res.status).toBe(200);
  return res.body as unknown as PulseBody;
}

const counts = (filled: Record<number, number>): number[] =>
  Array.from({ length: 12 }, (_, i) => filled[i] ?? 0);

describe('GET /api/ui/messages/pulse: the route', () => {
  it('is one read route, matched before /api/ui/messages/:contactId, GET only', () => {
    expect(PULSE_PATH).toBe('/api/ui/messages/pulse');
    expect(pulseRoute).toMatchObject({ method: 'GET', path: PULSE_PATH, presence: false });
    const registry = createLocalUiRoutes();
    const hit = registry.match('GET', PULSE_PATH);
    expect(hit).not.toBe('method');
    expect(hit !== undefined && hit !== 'method' ? hit.route.path : undefined).toBe(PULSE_PATH);
    expect(registry.match('POST', PULSE_PATH)).toBe('method');
    expect(registry.routes().filter((r) => r.path === PULSE_PATH)).toHaveLength(1);
  });

  it('asks core for the last 24 hours (or since the local midnight, if earlier), plus 5 minutes of clock skew', async () => {
    const seen: [number, number][] = [];
    const res = await call(
      contextWith((since, until) => {
        seen.push([since, until]);
        return Promise.resolve({ times: [], capped: false });
      }),
    );
    expect(res).toEqual({
      status: 200,
      body: { now: NOON, bucketSeconds: BUCKET, contacts: [], partial: false },
    });
    expect(seen).toEqual([[Math.min(NOON - DAY + 1, localMidnight(NOON_MS)), NOON + 300]]);
  });

  it('refuses any query parameter before core is asked, without echoing it', async () => {
    const pulseTimes = vi.fn<PulseTimes>();
    for (const query of [`x=${CANARY}`, 'limit=5', 'since=1', 'contactId=' + BOB]) {
      const res = await call(contextWith(pulseTimes), query);
      expect(res).toEqual({ status: 400, body: { error: 'bad_request' } });
      expect(JSON.stringify(res)).not.toContain(CANARY);
    }
    expect(pulseTimes).not.toHaveBeenCalled();
  });

  it('is 409 not_set_up with no agent, and 503 unavailable (never the error text) when core fails', async () => {
    expect(await call(contextWith(undefined))).toEqual({
      status: 409,
      body: { error: 'not_set_up' },
    });
    const res = await call(contextWith(() => Promise.reject(new Error(`/Users/x/${CANARY}`))));
    expect(res).toEqual({ status: 503, body: { error: 'unavailable' } });
  });
});

describe('GET /api/ui/messages/pulse: counts and times only (zero access, I-5)', () => {
  it('returns exact key sets and nothing core carries besides the contact and the time', async () => {
    const leaky = [
      {
        contactId: BOB,
        at: NOON - 60,
        text: CANARY,
        subject: CANARY,
        name: `${CANARY}.pdf`,
        fileName: `${CANARY}.pdf`,
        files: [{ name: `${CANARY}.pdf`, size: 1234 }],
        size: 987_654_321,
        envelope_json: `{"${CANARY}":1}`,
        payload_json: CANARY,
        display: { name: CANARY },
      },
    ] as unknown as Time[];
    const body = await pulseOf(leaky);
    expect(Object.keys(body).sort()).toEqual(['bucketSeconds', 'contacts', 'now', 'partial']);
    expect(body.contacts).toHaveLength(1);
    for (const item of body.contacts) {
      expect(Object.keys(item).sort()).toEqual(['activity', 'contactId', 'counts', 'lastAt']);
      expect(item.counts).toHaveLength(12);
    }
    const json = JSON.stringify(body);
    expect(json).not.toContain(CANARY);
    expect(json).not.toContain('987654321');
    expect(json).not.toMatch(/"(?:text|subject|name|fileName|files|size|envelope_json|payload_json|display)"/);
  });

  it('leaves out an item that is not a contact ID and a whole time (fail closed)', async () => {
    const bad = [
      { contactId: 'not-a-contact', at: NOON - 10 },
      { contactId: BOB.toUpperCase().replace('0X', '0x'), at: NOON - 10 },
      { contactId: BOB, at: NOON - 10.5 },
      { contactId: BOB, at: -1 },
      { contactId: BOB, at: `${NOON - 10}` },
      { contactId: CAROL, at: NOON - 10 },
    ] as unknown as Time[];
    const body = await pulseOf(bad);
    expect(body.contacts.map((c) => c.contactId)).toEqual([CAROL]);
  });
});

describe('GET /api/ui/messages/pulse: buckets and words at the boundaries (b11 §24.2, §24.3)', () => {
  it('puts each exchange in its two-hour bucket, oldest left, the current two hours right', async () => {
    const body = await pulseOf([
      { contactId: BOB, at: NOON }, // age 0: current bucket
      { contactId: BOB, at: NOON - (BUCKET - 1) }, // still the current bucket
      { contactId: BOB, at: NOON - BUCKET }, // the bucket before it
      { contactId: BOB, at: NOON - (DAY - 1) }, // the oldest bucket
      { contactId: BOB, at: NOON - DAY }, // 24 hours old: outside the pulse
      { contactId: BOB, at: NOON + 300 }, // 5 minutes of clock skew: counted as now
      { contactId: BOB, at: NOON + 301 }, // further in the future: never counted
    ]);
    expect(body.contacts).toEqual([
      { contactId: BOB, counts: counts({ 0: 1, 10: 1, 11: 3 }), lastAt: NOON, activity: 'active_now' },
    ]);
  });

  it('counts both directions together, per contact, and sums to the messages in the window', async () => {
    const list: Time[] = [];
    for (let i = 0; i < 14; i += 1) list.push({ contactId: CAROL, at: NOON - i * HOUR });
    const body = await pulseOf(list);
    const item = body.contacts[0] as PulseItem;
    expect(item.counts.reduce((s, n) => s + n, 0)).toBe(14);
    expect(item.counts).toEqual(counts({ 5: 2, 6: 2, 7: 2, 8: 2, 9: 2, 10: 2, 11: 2 }));
  });

  it('says Active now up to 5 minutes after the last exchange, then Today', async () => {
    const at300 = await pulseOf([{ contactId: BOB, at: NOON - 300 }]);
    expect(at300.contacts[0]).toMatchObject({ lastAt: NOON - 300, activity: 'active_now' });
    const at301 = await pulseOf([{ contactId: BOB, at: NOON - 301 }]);
    expect(at301.contacts[0]).toMatchObject({ lastAt: NOON - 301, activity: 'today' });
  });

  it('says Today from the local midnight, and Quiet just before it even with counts in the pulse', async () => {
    const midnight = localMidnight(NOON_MS);
    const today = await pulseOf([{ contactId: BOB, at: midnight }]);
    expect(today.contacts[0]).toMatchObject({ lastAt: midnight, activity: 'today' });
    const quiet = await pulseOf([{ contactId: BOB, at: midnight - 1 }]);
    expect(quiet.contacts[0]).toMatchObject({ lastAt: midnight - 1, activity: 'quiet' });
    expect((quiet.contacts[0] as PulseItem).counts.reduce((s, n) => s + n, 0)).toBe(1);
  });

  it('just after midnight: 31 minutes ago is yesterday, so Quiet; 29 minutes ago is Today', async () => {
    const nowMs = new Date(2027, 2, 10, 0, 30, 0).getTime();
    const now = nowMs / 1000;
    const midnight = localMidnight(nowMs);
    expect(now - midnight).toBe(1_800);
    const body = await pulseOf(
      [
        { contactId: BOB, at: now - 31 * 60 },
        { contactId: CAROL, at: now - 29 * 60 },
        { contactId: DAVE, at: now - 4 * 60 },
      ],
      nowMs,
    );
    expect(body.now).toBe(now);
    expect(body.contacts.map((c) => [c.contactId, c.activity])).toEqual([
      [DAVE, 'active_now'],
      [CAROL, 'today'],
      [BOB, 'quiet'],
    ]);
  });

  it('takes the last exchange as the newest time, in any order from core, and lists the most recent first', async () => {
    const body = await pulseOf([
      { contactId: CAROL, at: NOON - 5 * HOUR },
      { contactId: BOB, at: NOON - 3 * HOUR },
      { contactId: CAROL, at: NOON - 2 * HOUR },
      { contactId: BOB, at: NOON - 9 * HOUR },
      { contactId: DAVE, at: NOON - 2 * HOUR },
    ]);
    expect(body.contacts.map((c) => [c.contactId, c.lastAt])).toEqual([
      [CAROL, NOON - 2 * HOUR],
      [DAVE, NOON - 2 * HOUR],
      [BOB, NOON - 3 * HOUR],
    ]);
  });
});

describe('GET /api/ui/messages/pulse: bounded (UX2-f1 caps)', () => {
  it('passes core’s scan cap on as partial', async () => {
    const body = await pulseOf([{ contactId: BOB, at: NOON - 10 }], NOON_MS, true);
    expect(body.partial).toBe(true);
  });

  it('holds the caps at 10 000 contacts: the most recent MAX_PULSE_CONTACTS, small and fast', async () => {
    const list: Time[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      const contactId = `0x${i.toString(16).padStart(40, '0')}`;
      list.push({ contactId, at: NOON - i * 8 }, { contactId, at: NOON - i * 8 - 1 });
    }
    const started = performance.now();
    const body = await pulseOf(list);
    const elapsed = performance.now() - started;
    expect(MAX_PULSE_CONTACTS).toBeLessThanOrEqual(1_000);
    expect(body.contacts).toHaveLength(MAX_PULSE_CONTACTS);
    expect(body.partial).toBe(true);
    expect(body.contacts[0]?.contactId).toBe(`0x${'0'.repeat(40)}`);
    expect(body.contacts.at(-1)?.lastAt).toBe(NOON - (MAX_PULSE_CONTACTS - 1) * 8);
    expect(JSON.stringify(body).length).toBeLessThan(256 * 1024);
    expect(elapsed).toBeLessThan(2_000);
  });
});
