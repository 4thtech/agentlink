// N4 (S2; PLAN-NOTIFY §3.1, §3.4; I-5, I-7): the notification store holds only a kind, an ID ref, a
// count and times. These tests pin:
// - the schema refuses text, names, links and any other key or shape (no content can be stored);
// - retention: 30 days or 200 items per ID, whichever is fewer;
// - what an event does (approvals waiting, new messages per person, files, update, network);
// - nothing an AI app reaches (the MCP tools) can read or mark notifications.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTIFICATION_KEEP_SECONDS,
  NOTIFICATION_MAX_ITEMS,
  NOTIFY_DEFAULTS,
  notifyPrefsInForce,
  readNotificationItem,
  readNotificationList,
  readNotifyPrefs,
  unreadOf,
} from '@4thtech-io/types/ui-contract/notifications';
import { mergeUiSettings, readUiSettings } from '@4thtech-io/types/ui-contract/ui-settings';
import { describe, expect, it } from 'vitest';
import {
  createNotificationStore,
  memoryNotificationPersistence,
  NOTIFICATION_INBOUND_OVERLAP_SECONDS,
  readNotificationRecord,
  type NotificationPersistence,
} from './notifications.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const ref = (i: number): string => `0x${i.toString(16).padStart(40, '0')}`;
const DAY = 86_400;
const T0 = 1_800_000_000;

function clock(start = T0): { now: () => number; advance: (s: number) => void } {
  let t = start;
  return { now: () => t, advance: (s) => (t += s) };
}

describe('the notification schema (no content fields)', () => {
  const good = { id: `messages-${A}`, kind: 'messages', ref: A, count: 2, at: T0, read: false };

  it('accepts exactly kind, id ref, count and times', () => {
    expect(readNotificationItem(good)).toEqual(good);
    expect(
      readNotificationItem({ id: 'approvals', kind: 'approvals', count: 1, at: T0, read: true }),
    ).toBeDefined();
  });

  it.each([
    ['text', { ...good, text: 'hello there' }],
    ['message', { ...good, message: 'pay me' }],
    ['name', { ...good, name: 'Ana' }],
    ['title', { ...good, title: 'Ana sent you a file' }],
    ['fileName', { ...good, fileName: 'contract.pdf' }],
    ['link', { ...good, link: 'https://evil.example/x' }],
    ['url', { ...good, url: 'https://evil.example/x' }],
    ['origin', { ...good, origin: 'Claude' }],
  ])('refuses an item with a %s field', (_key, item) => {
    expect(readNotificationItem(item)).toBeUndefined();
  });

  it.each([
    ['a name as ref', { ...good, ref: 'Ana', id: 'messages-Ana' }],
    ['a link as ref', { ...good, ref: 'https://x.example', id: 'messages-https://x.example' }],
    ['an upper-case ref', { ...good, ref: A.toUpperCase(), id: `messages-${A.toUpperCase()}` }],
    ['text as count', { ...good, count: 'many' }],
    ['a zero count', { ...good, count: 0 }],
    ['a fractional time', { ...good, at: 1.5 }],
    ['an unknown kind', { ...good, kind: 'chat', id: `chat-${A}` }],
    ['an id that does not match', { ...good, id: `messages-${B}` }],
    [
      'a ref on a state kind',
      { id: 'update', kind: 'update', ref: A, count: 1, at: T0, read: false },
    ],
    [
      'no ref on a person kind',
      { id: 'messages', kind: 'messages', count: 1, at: T0, read: false },
    ],
    ['a string read flag', { ...good, read: 'no' }],
    ['an array', [good]],
    ['null', null],
  ])('refuses %s', (_what, item) => {
    expect(readNotificationItem(item)).toBeUndefined();
  });

  it('a list answer drops any item that is not of the schema, and counts approvals until decided', () => {
    const list = readNotificationList({
      items: [
        good,
        { ...good, id: `files-${B}`, kind: 'files', ref: B, read: true },
        { id: 'approvals', kind: 'approvals', count: 3, at: T0, read: true },
        { ...good, text: 'smuggled' },
      ],
    });
    expect(list?.items).toHaveLength(3);
    expect(list?.unread).toBe(1 + 3);
    expect(list?.approvals).toBe(3);
    expect(unreadOf([])).toBe(0);
  });

  it('prefs: D2 defaults (approvals on, others off, no names), booleans of known keys only', () => {
    expect(NOTIFY_DEFAULTS).toEqual({
      approvals: true,
      messages: false,
      people: false,
      problems: false,
      showNames: false,
      quietHours: false,
    });
    expect(notifyPrefsInForce(undefined)).toEqual(NOTIFY_DEFAULTS);
    expect(notifyPrefsInForce({ messages: true }).messages).toBe(true);
    expect(readNotifyPrefs({ approvals: false })).toEqual({ approvals: false });
    expect(readNotifyPrefs({ approvals: 'yes' })).toBeUndefined();
    expect(readNotifyPrefs({ sound: true })).toBeUndefined();
  });

  it('prefs round-trip through the UI settings (N6): merged key by key, refused when not boolean', () => {
    const stored = mergeUiSettings({}, readUiSettings({ notify: { messages: true } }, 1) ?? {});
    const next = mergeUiSettings(stored, readUiSettings({ notify: { showNames: true } }, 1) ?? {});
    expect(readUiSettings(JSON.parse(JSON.stringify(next)))).toEqual({
      notify: { messages: true, showNames: true },
    });
    expect(readUiSettings({ notify: { messages: 'yes' } })).toBeUndefined();
    expect(readUiSettings({ notify: { name: true } })).toBeUndefined();
  });
});

describe('the notification store', () => {
  it('starts empty and never backfills history from before it existed', async () => {
    const c = clock();
    const store = createNotificationStore(memoryNotificationPersistence(), { now: c.now });
    await store.observe({ inbound: [{ contactId: A, kind: 'message', at: T0 - 60 }] });
    expect(await store.list()).toEqual([]);
  });

  it('counts new messages per person, and starts again after it was read', async () => {
    const c = clock();
    const store = createNotificationStore(memoryNotificationPersistence(), { now: c.now });
    await store.observe({});
    c.advance(10);
    await store.observe({
      inbound: [
        { contactId: A, kind: 'message', at: T0 + 5 },
        { contactId: A, kind: 'message', at: T0 + 6 },
        { contactId: B, kind: 'file', at: T0 + 7 },
      ],
    });
    // The same events seen again are not counted twice.
    await store.observe({
      inbound: [{ contactId: A, kind: 'message', at: T0 + 6 }],
    });
    const items = await store.list();
    expect(items.find((i) => i.id === `messages-${A}`)).toMatchObject({ count: 2, read: false });
    expect(items.find((i) => i.id === `files-${B}`)).toMatchObject({ count: 1, read: false });
    expect(await store.markRead(`messages-${A}`)).toBe(true);
    c.advance(10);
    await store.observe({ inbound: [{ contactId: A, kind: 'message', at: T0 + 15 }] });
    expect((await store.list()).find((i) => i.id === `messages-${A}`)).toMatchObject({
      count: 1,
      read: false,
    });
  });

  it('approvals: one item while any wait (count follows), gone once decided', async () => {
    const c = clock();
    const store = createNotificationStore(memoryNotificationPersistence(), { now: c.now });
    await store.observe({ approvals: 2 });
    expect(await store.list()).toEqual([
      { id: 'approvals', kind: 'approvals', count: 2, at: T0, read: false },
    ]);
    await store.markAllRead();
    await store.observe({ approvals: 2 });
    expect((await store.list())[0]?.read).toBe(true);
    c.advance(5);
    await store.observe({ approvals: 3 });
    expect((await store.list())[0]).toMatchObject({ count: 3, read: false, at: T0 + 5 });
    await store.observe({ approvals: 0 });
    expect(await store.list()).toEqual([]);
  });

  it('update and network are one item each, gone when no longer true', async () => {
    const store = createNotificationStore(memoryNotificationPersistence(), { now: clock().now });
    await store.observe({ update: true, networkDown: true });
    expect((await store.list()).map((i) => i.id).sort()).toEqual(['network', 'update']);
    await store.observe({ update: false, networkDown: false });
    expect(await store.list()).toEqual([]);
  });

  it('keeps at most 200 items, the newest', async () => {
    const c = clock();
    const store = createNotificationStore(memoryNotificationPersistence(), { now: c.now });
    await store.observe({});
    const inbound = Array.from({ length: 250 }, (_, i) => ({
      contactId: ref(i + 1),
      kind: 'message' as const,
      at: T0 + 1 + i,
    }));
    c.advance(1_000);
    await store.observe({ inbound });
    const items = await store.list();
    expect(items).toHaveLength(NOTIFICATION_MAX_ITEMS);
    expect(items[0]?.ref).toBe(ref(250));
    expect(items.some((i) => i.ref === ref(1))).toBe(false);
  });

  it('IR-NOTIFY-1 M-2: counts a message stored late with an older time (the read window overlaps)', async () => {
    const c = clock();
    const store = createNotificationStore(memoryNotificationPersistence(), { now: c.now });
    await store.observe({});
    c.advance(60);
    await store.observe({
      scannedUntil: T0 + 60,
      inbound: [{ contactId: A, kind: 'message', at: T0 + 30 }],
    });
    // The next read starts before the last one ended, so a late arrival is still in it.
    expect(await store.since()).toBe(T0 + 60 - NOTIFICATION_INBOUND_OVERLAP_SECONDS);
    c.advance(60);
    // A message stamped T0+20 is stored only now (a slow sender); the overlapping read returns
    // the one already counted too, which is not counted again.
    await store.observe({
      scannedUntil: T0 + 120,
      inbound: [
        { contactId: A, kind: 'message', at: T0 + 30 },
        { contactId: A, kind: 'message', at: T0 + 20 },
      ],
    });
    expect((await store.list()).find((i) => i.id === `messages-${A}`)?.count).toBe(2);
    // The same window read again counts nothing new.
    await store.observe({
      scannedUntil: T0 + 120,
      inbound: [
        { contactId: A, kind: 'message', at: T0 + 30 },
        { contactId: A, kind: 'message', at: T0 + 20 },
      ],
    });
    expect((await store.list()).find((i) => i.id === `messages-${A}`)?.count).toBe(2);
  });

  it('two messages from one person in the same second are both counted, once each', async () => {
    const c = clock();
    const store = createNotificationStore(memoryNotificationPersistence(), { now: c.now });
    await store.observe({});
    c.advance(10);
    const twice = [
      { contactId: A, kind: 'message' as const, at: T0 + 5 },
      { contactId: A, kind: 'message' as const, at: T0 + 5 },
    ];
    await store.observe({ scannedUntil: T0 + 10, inbound: twice });
    await store.observe({ scannedUntil: T0 + 10, inbound: twice });
    expect((await store.list())[0]?.count).toBe(2);
  });

  it('drops items older than 30 days', async () => {
    const c = clock();
    const store = createNotificationStore(memoryNotificationPersistence(), { now: c.now });
    await store.observe({});
    c.advance(10);
    await store.observe({ inbound: [{ contactId: A, kind: 'message', at: T0 + 5 }] });
    c.advance(NOTIFICATION_KEEP_SECONDS - 100);
    expect(await store.list()).toHaveLength(1);
    c.advance(200);
    expect(await store.list()).toEqual([]);
    expect(NOTIFICATION_KEEP_SECONDS).toBe(30 * DAY);
  });

  it('what it writes is only the record shape; a tampered file is read as nothing', async () => {
    const writes: unknown[] = [];
    let stored: unknown = {
      v: 1,
      cursor: T0,
      items: [
        { id: `messages-${A}`, kind: 'messages', ref: A, count: 1, at: T0, read: false, text: 'x' },
      ],
    };
    const persistence: NotificationPersistence = {
      read: () => Promise.resolve(stored),
      write: (record) => {
        writes.push(JSON.parse(JSON.stringify(record)));
        stored = record;
        return Promise.resolve();
      },
    };
    const store = createNotificationStore(persistence, { now: clock().now });
    // The smuggled item is dropped on read.
    expect(await store.list()).toEqual([]);
    await store.observe({ approvals: 1 });
    for (const w of writes) {
      expect(readNotificationRecord(w)).toEqual(w);
      expect(Object.keys(w as object).sort()).toEqual(['cursor', 'items', 'seen', 'v']);
    }
    expect(readNotificationRecord({ v: 2, cursor: T0, items: [] })).toBeUndefined();
    expect(readNotificationRecord({ v: 1, cursor: T0, items: [], note: 'hi' })).toBeUndefined();
  });

  it('a poll that changes nothing writes nothing', async () => {
    let writes = 0;
    const inner = memoryNotificationPersistence();
    const persistence: NotificationPersistence = {
      read: () => inner.read(),
      write: (record) => {
        writes += 1;
        return inner.write(record);
      },
    };
    const store = createNotificationStore(persistence, { now: clock().now });
    await store.observe({ approvals: 1 });
    expect(writes).toBe(1);
    await store.observe({ approvals: 1, update: false, networkDown: false, inbound: [] });
    await store.observe({});
    expect(writes).toBe(1);
  });

  it('markRead refuses an ID that is not an item', async () => {
    const store = createNotificationStore(memoryNotificationPersistence(), { now: clock().now });
    expect(await store.markRead('approvals')).toBe(false);
    expect(await store.markRead('../../etc')).toBe(false);
  });
});

describe('not reachable from MCP tools (I-4)', () => {
  it('no MCP tool source names the notifications store or its routes', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const dir = join(here, '..', '..', 'mcp-tools', 'src');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/notifications|ui-contract\/notifications|\/api\/ui\//);
    }
  });
});
