// TRAY-WIDGET-API (D-155; 08 §1 `GET /api/ui/widget`; b11 §25.4; I-5, I-7).
//
// What these tests hold `GET /api/ui/widget` to:
// - one read route (`GET`, `presence: false`) in the default registry, no query (400
//   `bad_request` before core is asked), no agent 409 `not_set_up`, a core failure 503
//   `unavailable`, never an error's text;
// - the exact key sets `{now, previews, unread, today, contacts}`, each item rebuilt from an
//   allowlist (fail closed per item);
// - `unread` from the unread `messages` and `files` notification items, by contact, newest first,
//   at most WIDGET_MAX_UNREAD; approvals, update and network items and read items never count;
// - `preview` only while `widgetPreviews` is on (absent = on, unreadable = off): the newest
//   received message's text, control/format/bidi/separator characters removed, whitespace
//   collapsed, at most 80 code points cut on a grapheme boundary with "…"; never a file name; the
//   previews-off path never reads a message at all;
// - `today`: 24 hourly buckets since the local midnight; in and out from the store's exchange
//   times, proofs and files from the activity feed;
// - `contacts`: exchanged since the earlier of 24 h ago and the local midnight, `active_now` or
//   `today` only (never presence), bounded;
// - the read writes nothing and marks nothing read.
import { describe, expect, it, vi } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import type { LocalUiReadRoute, LocalUiResult } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import {
  WIDGET_BUCKETS,
  WIDGET_MAX_CONTACTS,
  WIDGET_MAX_UNREAD,
  WIDGET_PATH,
  WIDGET_PREVIEW_MAX,
  widgetActivityMark,
  widgetPreview,
  widgetRoute,
} from './widget.js';

const BOB = `0x${'b0'.repeat(20)}`;
const CAROL = `0x${'c0'.repeat(20)}`;
const DAVE = `0x${'d0'.repeat(20)}`;
const CANARY = 'CANARY-CONTENT-MUST-NOT-LEAK';

const HOUR = 3_600;
/** Local noon, so the local midnight is 12 hours back whatever the machine's time zone. */
const NOON_MS = new Date(2027, 2, 10, 12, 0, 0).getTime();
const NOON = NOON_MS / 1000;
function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
const MIDNIGHT = localMidnight(NOON_MS);

type Item = { id: string; kind: string; ref?: string; count: number; at: number; read: boolean };
const msgItem = (ref: string, count: number, at: number, read = false): Item => ({
  id: `messages-${ref}`,
  kind: 'messages',
  ref,
  count,
  at,
  read,
});
const fileItem = (ref: string, count: number, at: number, read = false): Item => ({
  id: `files-${ref}`,
  kind: 'files',
  ref,
  count,
  at,
  read,
});

interface World {
  items?: Item[];
  texts?: Record<string, string>;
  failText?: string[];
  flow?: { contactId: string; direction: 'in' | 'out'; kind: string; state: string; at: number }[];
  activity?: Record<string, unknown>[];
  pulse?: { contactId: string; at: number }[];
  settings?: Record<string, unknown> | 'throw' | 'none';
  failCore?: 'flow' | 'activity' | 'pulse' | 'notifications';
}

function contextOf(w: World = {}) {
  const list = vi.fn((contactId: string, box: string) => {
    if (box !== 'in') return Promise.reject(new Error('box'));
    if (w.failText?.includes(contactId)) return Promise.reject(new Error(`${CANARY} /Users/x`));
    const text = w.texts?.[contactId];
    if (text === undefined) return Promise.resolve({ items: [] });
    return Promise.resolve({
      items: [
        {
          id: 'env1',
          at: NOON - 60,
          type: 'message',
          text,
          files: [{ name: `${CANARY}.pdf`, size: 10 }],
          proof: false,
          size: 10,
          subject: CANARY,
        },
      ],
    });
  });
  const listActivity = vi.fn(() =>
    w.failCore === 'activity'
      ? Promise.reject(new Error(CANARY))
      : Promise.resolve({ items: w.activity ?? [] }),
  );
  const flowEvents = vi.fn(() =>
    w.failCore === 'flow'
      ? Promise.reject(new Error(CANARY))
      : Promise.resolve({ events: w.flow ?? [], capped: false }),
  );
  const pulseTimes = vi.fn(() =>
    w.failCore === 'pulse'
      ? Promise.reject(new Error(CANARY))
      : Promise.resolve({ times: w.pulse ?? [], capped: false }),
  );
  const client = {
    agentId: 'a',
    listActivity,
    messages: {
      conversations: () => Promise.reject(new Error('not used')),
      list,
      pulseTimes,
      flowEvents,
    },
  } as unknown as LocalUiReadClient;
  const markRead = vi.fn();
  const markAllRead = vi.fn();
  const refresh = vi.fn();
  const notifications = {
    list: () =>
      w.failCore === 'notifications'
        ? Promise.reject(new Error(CANARY))
        : Promise.resolve(w.items ?? []),
    refresh,
    markRead,
    markAllRead,
  };
  const settings = w.settings ?? {};
  const update = vi.fn();
  const uiSettings =
    settings === 'none'
      ? undefined
      : {
          read: () =>
            settings === 'throw' ? Promise.reject(new Error('x')) : Promise.resolve(settings),
          update,
        };
  const context = {
    client,
    ownerContext: () => Promise.resolve(undefined),
    applyOwnerAction: () => Promise.reject(new Error('no')),
    now: () => NOON_MS,
    notifications,
    ...(uiSettings === undefined ? {} : { uiSettings }),
  } as unknown as LocalUiContext;
  return {
    context,
    list,
    listActivity,
    flowEvents,
    pulseTimes,
    markRead,
    markAllRead,
    refresh,
    update,
  };
}

const call = (context: LocalUiContext, query = ''): Promise<LocalUiResult> =>
  (widgetRoute as LocalUiReadRoute).handler(context, {
    params: {},
    query: new URLSearchParams(query),
  });

type Body = {
  now: number;
  previews: boolean;
  unread: { contactId: string; count: number; lastAt: number; preview?: string }[];
  today: {
    start: number;
    bucketSeconds: number;
    in: number[];
    out: number[];
    proofs: number[];
    files: number[];
  };
  contacts: { contactId: string; lastAt: number; activity: string }[];
};
const bodyOf = (r: LocalUiResult): Body => r.body as unknown as Body;
const codePoints = (s: string): number => [...s].length;

describe('GET /api/ui/widget: the route', () => {
  it('is one read route without presence in the default registry', () => {
    expect(WIDGET_PATH).toBe('/api/ui/widget');
    expect(widgetRoute.method).toBe('GET');
    expect(widgetRoute.presence).toBe(false);
    const match = createLocalUiRoutes().match('GET', WIDGET_PATH);
    expect(match).toBeDefined();
    expect(match === 'method' ? undefined : match?.route.path).toBe(WIDGET_PATH);
    expect(
      createLocalUiRoutes()
        .routes()
        .filter((r) => r.path === WIDGET_PATH),
    ).toHaveLength(1);
    expect(createLocalUiRoutes().match('POST', WIDGET_PATH)).toBe('method');
  });

  it('refuses any query before core is asked, without echoing it', async () => {
    const w = contextOf();
    const r = await call(w.context, `x=${CANARY}`);
    expect(r).toEqual({ status: 400, body: { error: 'bad_request' } });
    expect(w.flowEvents).not.toHaveBeenCalled();
    expect(w.list).not.toHaveBeenCalled();
  });

  it('answers not_set_up without an agent', async () => {
    const w = contextOf();
    const r = await call({ ...w.context, client: undefined });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'not_set_up' });
  });

  for (const fail of ['flow', 'activity', 'pulse', 'notifications'] as const) {
    it(`answers 503 unavailable when the ${fail} read fails, never its text`, async () => {
      const w = contextOf({ failCore: fail, items: [msgItem(BOB, 1, NOON)] });
      const r = await call(w.context);
      expect(r).toEqual({ status: 503, body: { error: 'unavailable' } });
      expect(JSON.stringify(r)).not.toContain(CANARY);
    });
  }
});

describe('GET /api/ui/widget: the answer', () => {
  it('has exact key sets, everywhere', async () => {
    const w = contextOf({
      items: [msgItem(BOB, 2, NOON - 30)],
      texts: { [BOB]: 'hello' },
      flow: [
        { contactId: BOB, direction: 'in', kind: 'message', state: 'received', at: NOON - 30 },
      ],
      pulse: [{ contactId: BOB, at: NOON - 30 }],
    });
    const r = await call(w.context);
    expect(r.status).toBe(200);
    const b = bodyOf(r);
    expect(Object.keys(b).sort()).toEqual(['contacts', 'now', 'previews', 'today', 'unread']);
    expect(b.now).toBe(NOON);
    expect(b.previews).toBe(true);
    expect(Object.keys(b.unread[0] ?? {}).sort()).toEqual([
      'contactId',
      'count',
      'lastAt',
      'preview',
    ]);
    expect(Object.keys(b.today).sort()).toEqual([
      'bucketSeconds',
      'files',
      'in',
      'out',
      'proofs',
      'start',
    ]);
    expect(Object.keys(b.contacts[0] ?? {}).sort()).toEqual(['activity', 'contactId', 'lastAt']);
  });

  it('groups unread messages and files by contact, newest first, ignoring read and other kinds', async () => {
    const w = contextOf({
      settings: { widgetPreviews: false },
      items: [
        msgItem(BOB, 2, NOON - 300),
        fileItem(BOB, 1, NOON - 100),
        msgItem(CAROL, 4, NOON - 50, true),
        fileItem(DAVE, 3, NOON - 200),
        { id: 'approvals', kind: 'approvals', count: 5, at: NOON, read: false },
        { id: 'update', kind: 'update', count: 1, at: NOON, read: false },
        // Malformed: refused whole (fail closed), never echoed.
        {
          id: `messages-${CANARY}`,
          kind: 'messages',
          ref: CANARY,
          count: 1,
          at: NOON,
          read: false,
        },
        { ...msgItem(CAROL, 1, NOON), text: CANARY } as unknown as Item,
      ],
    });
    const b = bodyOf(await call(w.context));
    expect(b.unread).toEqual([
      { contactId: BOB, count: 3, lastAt: NOON - 100 },
      { contactId: DAVE, count: 3, lastAt: NOON - 200 },
    ]);
    expect(JSON.stringify(b)).not.toContain(CANARY);
  });

  it('lists at most WIDGET_MAX_UNREAD contacts', async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      msgItem(`0x${i.toString(16).padStart(40, '0')}`, 1, NOON - i),
    );
    const w = contextOf({ items, settings: { widgetPreviews: false } });
    const b = bodyOf(await call(w.context));
    expect(WIDGET_MAX_UNREAD).toBe(20);
    expect(b.unread).toHaveLength(WIDGET_MAX_UNREAD);
    expect(b.unread[0]?.lastAt).toBe(NOON);
  });

  it('writes nothing and marks nothing read', async () => {
    const w = contextOf({ items: [msgItem(BOB, 1, NOON)], texts: { [BOB]: 'hi' } });
    await call(w.context);
    expect(w.markRead).not.toHaveBeenCalled();
    expect(w.markAllRead).not.toHaveBeenCalled();
    expect(w.refresh).not.toHaveBeenCalled();
    expect(w.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/ui/widget: previews', () => {
  it('adds the newest received text, plain, as the preview while previews are on', async () => {
    const w = contextOf({
      items: [msgItem(BOB, 1, NOON)],
      texts: { [BOB]: '  Hi\tthere,\n\n  the  report is ready  ' },
    });
    const b = bodyOf(await call(w.context));
    expect(b.previews).toBe(true);
    expect(b.unread[0]?.preview).toBe('Hi there, the report is ready');
    expect(w.list).toHaveBeenCalledWith(BOB, 'in', { limit: 1 });
    // Never a file name, a subject or anything else of the message.
    expect(JSON.stringify(b)).not.toContain(CANARY);
  });

  it('is on when the setting is absent and when there is no settings store', async () => {
    for (const settings of [{}, 'none'] as const) {
      const w = contextOf({ settings, items: [msgItem(BOB, 1, NOON)], texts: { [BOB]: 'x' } });
      const b = bodyOf(await call(w.context));
      expect(b.previews).toBe(true);
      expect(b.unread[0]?.preview).toBe('x');
    }
  });

  it('omits every preview, and never reads a message, while previews are off', async () => {
    const w = contextOf({
      settings: { widgetPreviews: false },
      items: [msgItem(BOB, 1, NOON), msgItem(CAROL, 1, NOON - 1)],
      texts: { [BOB]: CANARY, [CAROL]: CANARY },
    });
    const r = await call(w.context);
    const b = bodyOf(r);
    expect(b.previews).toBe(false);
    expect(b.unread).toEqual([
      { contactId: BOB, count: 1, lastAt: NOON },
      { contactId: CAROL, count: 1, lastAt: NOON - 1 },
    ]);
    expect(b.unread.every((u) => !('preview' in u))).toBe(true);
    expect(w.list).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it('is off when the settings cannot be read (fail closed)', async () => {
    const w = contextOf({
      settings: 'throw',
      items: [msgItem(BOB, 1, NOON)],
      texts: { [BOB]: CANARY },
    });
    const r = await call(w.context);
    expect(bodyOf(r).previews).toBe(false);
    expect(w.list).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it('is off for any value of the setting but absent or true', async () => {
    const w = contextOf({ settings: { widgetPreviews: 'yes' }, items: [msgItem(BOB, 1, NOON)] });
    expect(bodyOf(await call(w.context)).previews).toBe(false);
  });

  it('leaves out one preview that cannot be read (and an empty one), keeping the item', async () => {
    const w = contextOf({
      items: [msgItem(BOB, 1, NOON), msgItem(CAROL, 1, NOON - 1), msgItem(DAVE, 1, NOON - 2)],
      texts: { [CAROL]: ' ​‮\n ', [DAVE]: 'ok' },
      failText: [BOB],
    });
    const r = await call(w.context);
    expect(bodyOf(r).unread).toEqual([
      { contactId: BOB, count: 1, lastAt: NOON },
      { contactId: CAROL, count: 1, lastAt: NOON - 1 },
      { contactId: DAVE, count: 1, lastAt: NOON - 2, preview: 'ok' },
    ]);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
});

describe('widgetPreview: plain text (I-5)', () => {
  it('removes control, format, bidi and separator characters', () => {
    expect(widgetPreview('a\u0000b\u0007c\u001Bd\u007F')).toBe('abcd');
    expect(widgetPreview('pay‮gnp.exe‬')).toBe('paygnp.exe');
    expect(widgetPreview('x​y‍z﻿⁦w⁩')).toBe('xyzw');
    expect(widgetPreview('one two three')).toBe('one two three');
    expect(widgetPreview('private\uDBFF')).toBe('private');
  });

  it('collapses whitespace to single spaces on one line', () => {
    expect(widgetPreview(' a \t\r\n b 　c ')).toBe('a b c');
  });

  it('cuts to 80 code points with an ellipsis, on a grapheme boundary', () => {
    expect(WIDGET_PREVIEW_MAX).toBe(80);
    const exact = 'a'.repeat(80);
    expect(widgetPreview(exact)).toBe(exact);
    const long = widgetPreview('b'.repeat(500));
    expect(long.endsWith('…')).toBe(true);
    expect(codePoints(long)).toBeLessThanOrEqual(80);
    // A grapheme of 4 code points (a letter with three combining marks) is never split.
    const mark = 'e\u0301\u0302\u0303';
    const p = widgetPreview('c'.repeat(77) + mark + 'd'.repeat(20));
    expect(codePoints(p)).toBeLessThanOrEqual(80);
    expect(p).toBe(`${'c'.repeat(77)}…`);
    const q = widgetPreview('c'.repeat(70) + mark + 'd'.repeat(20));
    expect(q).toBe(`${'c'.repeat(70)}${mark}ddddd…`);
  });

  it('keeps plain markup as text (the page renders a text node)', () => {
    expect(widgetPreview('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  it('is bounded for a huge text', () => {
    const t0 = Date.now();
    const p = widgetPreview(`${'​'.repeat(1_000_000)}${'z'.repeat(1_000_000)}`);
    expect(codePoints(p)).toBeLessThanOrEqual(80);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('GET /api/ui/widget: today', () => {
  it('counts hourly buckets since the local midnight', async () => {
    const w = contextOf({
      flow: [
        { contactId: BOB, direction: 'in', kind: 'message', state: 'received', at: MIDNIGHT },
        { contactId: BOB, direction: 'in', kind: 'file', state: 'received', at: MIDNIGHT + 30 },
        { contactId: BOB, direction: 'out', kind: 'message', state: 'sent', at: NOON - 1 },
        { contactId: CAROL, direction: 'out', kind: 'message', state: 'queued', at: NOON + 60 },
        // Before midnight, and far in the future: in no bucket.
        { contactId: BOB, direction: 'in', kind: 'message', state: 'received', at: MIDNIGHT - 1 },
        { contactId: BOB, direction: 'in', kind: 'message', state: 'received', at: NOON + 3_600 },
        // Malformed: left out.
        { contactId: CANARY, direction: 'in', kind: 'message', state: 'received', at: NOON },
        { contactId: BOB, direction: 'sideways' as 'in', kind: 'message', state: 'x', at: NOON },
      ],
      activity: [
        { kind: 'proof', id: 'p1', at: NOON - 10, direction: 'sent', status: 'recorded' },
        {
          kind: 'file',
          id: 'envelope:e1',
          at: MIDNIGHT + 2 * HOUR,
          direction: 'received',
          files: [{ name: CANARY }],
        },
        { kind: 'message', id: 'envelope:e2', at: NOON - 5, direction: 'received', text: CANARY },
        { kind: 'proof', id: 'p0', at: MIDNIGHT - 1, direction: 'received', status: 'received' },
      ],
    });
    const r = await call(w.context);
    const t = bodyOf(r).today;
    expect(t.start).toBe(MIDNIGHT);
    expect(t.bucketSeconds).toBe(3_600);
    expect(WIDGET_BUCKETS).toBe(24);
    for (const k of ['in', 'out', 'proofs', 'files'] as const) expect(t[k]).toHaveLength(24);
    const hour = Math.floor((NOON - MIDNIGHT) / HOUR);
    expect(t.in[0]).toBe(2);
    expect(t.in.reduce((a, b) => a + b, 0)).toBe(2);
    expect(t.out[hour - 1]).toBe(1);
    // A message a minute in the future (another agent's clock) counts as now.
    expect(t.out[hour]).toBe(1);
    expect(t.proofs[hour - 1]).toBe(1);
    expect(t.proofs.reduce((a, b) => a + b, 0)).toBe(1);
    expect(t.files[2]).toBe(1);
    expect(t.files.reduce((a, b) => a + b, 0)).toBe(1);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(w.flowEvents).toHaveBeenCalledWith(MIDNIGHT, NOON + 300);
  });

  it('reads the activity feed in bounded pages and stops at the local midnight', async () => {
    const w = contextOf();
    let pages = 0;
    w.listActivity.mockImplementation(() => {
      pages += 1;
      return Promise.resolve({
        items: Array.from({ length: 100 }, (_, i) => ({
          kind: 'proof',
          id: `p${pages}-${i}`,
          at: NOON - pages,
        })),
        nextCursor: `c${pages}`,
      });
    });
    const t = bodyOf(await call(w.context)).today;
    expect(pages).toBeLessThanOrEqual(10);
    expect(t.proofs.reduce((a, b) => a + b, 0)).toBe(pages * 100);
  });
});

describe('GET /api/ui/widget: contacts', () => {
  it('lists the last exchange, active_now within 5 minutes or today, never quiet', async () => {
    const w = contextOf({
      pulse: [
        { contactId: BOB, at: NOON - 100 },
        { contactId: BOB, at: NOON - 2_000 },
        { contactId: CAROL, at: NOON - 3 * HOUR },
        { contactId: DAVE, at: MIDNIGHT - HOUR },
        { contactId: CANARY, at: NOON },
      ],
    });
    const r = await call(w.context);
    expect(bodyOf(r).contacts).toEqual([
      { contactId: BOB, lastAt: NOON - 100, activity: 'active_now' },
      { contactId: CAROL, lastAt: NOON - 3 * HOUR, activity: 'today' },
    ]);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(r)).not.toContain('online');
  });

  it('is bounded', async () => {
    const pulse = Array.from({ length: 500 }, (_, i) => ({
      contactId: `0x${i.toString(16).padStart(40, '0')}`,
      at: NOON - i,
    }));
    const b = bodyOf(await call(contextOf({ pulse }).context));
    expect(b.contacts).toHaveLength(WIDGET_MAX_CONTACTS);
    expect(b.contacts[0]?.lastAt).toBe(NOON);
  });
});

describe('widgetActivityMark (the activity event)', () => {
  it('changes with the notification items, the activity head and the newest exchange', async () => {
    const w: World = {
      items: [msgItem(BOB, 1, NOON)],
      activity: [{ kind: 'proof', id: 'p1', at: NOON }],
      pulse: [{ contactId: BOB, at: NOON - 10 }],
    };
    const mark = async (): Promise<string | undefined> => {
      const { context } = contextOf(w);
      return widgetActivityMark(
        context.client as LocalUiReadClient,
        context.notifications,
        NOON_MS,
      );
    };
    const m1 = await mark();
    expect(typeof m1).toBe('string');
    expect(await mark()).toBe(m1);
    w.items = [msgItem(BOB, 2, NOON + 1)];
    const m2 = await mark();
    expect(m2).not.toBe(m1);
    w.activity = [{ kind: 'proof', id: 'p2', at: NOON + 2 }];
    const m3 = await mark();
    expect(m3).not.toBe(m2);
    w.pulse = [{ contactId: CAROL, at: NOON + 3 }];
    expect(await mark()).not.toBe(m3);
  });

  it('is undefined when it cannot be read', async () => {
    const { context } = contextOf({ failCore: 'activity' });
    expect(
      await widgetActivityMark(context.client as LocalUiReadClient, context.notifications, NOON_MS),
    ).toBeUndefined();
  });
});
