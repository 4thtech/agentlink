// N7 (PLAN-NOTIFY §3.5; D2; S2): what the desktop core tells the shell to alert about. Fixed codes
// only (`notify {kind, count, name}`), from the notification store's items and the approvals count;
// the owner's switches decide; a name only with Show names on, and only an owner-given one.
import type { NotificationItem } from '@4thtech-io/types/ui-contract/notifications';
import { NOTIFY_DEFAULTS } from '@4thtech-io/types/ui-contract/notifications';
import { describe, expect, it } from 'vitest';
import { notifyMessages, planAlerts, type AlertSource } from './alerts.js';
import { parseHostMessage, encodeHostMessage } from './protocol.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;

const person = (
  kind: 'messages' | 'files',
  ref: string,
  count: number,
  at: number,
  read = false,
): NotificationItem => ({ id: `${kind}-${ref}`, kind, ref, count, at, read });
const update: NotificationItem = { id: 'update', kind: 'update', count: 1, at: 50, read: false };

/** n approvals waiting: apr_0 … apr_<n-1>. */
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `apr_${String(i)}`);

const ALL_ON = { ...NOTIFY_DEFAULTS, messages: true, files: true, updates: true };
const src = (
  items: readonly NotificationItem[],
  prefs: AlertSource['prefs'] = ALL_ON,
  scope = 'default',
): AlertSource => ({ scope, items, prefs });

describe('planAlerts', () => {
  it('the first look only notes what is there (nothing old is alerted)', () => {
    const { news } = planAlerts(undefined, ids(2), src([person('messages', A, 3, 10), update]));
    expect(news).toEqual([]);
  });

  it('IR-N7-1 L-3: one approval decided and another raised within one look is still news', () => {
    const first = planAlerts(undefined, ['apr_1'], src([]));
    expect(planAlerts(first.baseline, ['apr_2'], src([])).news).toEqual([
      { kind: 'approvals', count: 1 },
    ]);
  });

  it('a new approval waiting: the number waiting', () => {
    const first = planAlerts(undefined, ids(0), src([]));
    const next = planAlerts(first.baseline, ids(2), src([]));
    expect(next.news).toEqual([{ kind: 'approvals', count: 2 }]);
    // Fewer or the same is not news.
    expect(planAlerts(next.baseline, ids(1), src([])).news).toEqual([]);
    expect(planAlerts(next.baseline, ids(2), src([])).news).toEqual([]);
  });

  it('new messages and files per person: how many are new since the last look', () => {
    const first = planAlerts(undefined, ids(0), src([person('messages', A, 1, 10)]));
    const next = planAlerts(
      first.baseline,
      ids(0),
      src([person('messages', A, 3, 20), person('files', B, 1, 21)]),
    );
    expect(next.news).toEqual([
      { kind: 'messages', count: 2, ref: A },
      { kind: 'files', count: 1, ref: B },
    ]);
    // Nothing changed: nothing new.
    expect(
      planAlerts(
        next.baseline,
        ids(0),
        src([person('messages', A, 3, 20), person('files', B, 1, 21)]),
      ).news,
    ).toEqual([]);
  });

  it('a read item that gets a new message again is news (count from 1)', () => {
    const first = planAlerts(undefined, ids(0), src([person('messages', A, 4, 10, true)]));
    expect(planAlerts(first.baseline, ids(0), src([person('messages', A, 1, 30)])).news).toEqual([
      { kind: 'messages', count: 1, ref: A },
    ]);
  });

  it('an update that becomes ready', () => {
    const first = planAlerts(undefined, ids(0), src([]));
    expect(planAlerts(first.baseline, ids(0), src([update])).news).toEqual([
      { kind: 'update', count: 1 },
    ]);
  });

  it('another ID opened: a fresh first look, nothing alerted', () => {
    const first = planAlerts(undefined, ids(0), src([]));
    expect(
      planAlerts(first.baseline, ids(3), src([person('messages', A, 2, 9)], ALL_ON, 'work')).news,
    ).toEqual([]);
  });
});

describe('notifyMessages: the switches and the owner-name rule', () => {
  const news = [
    { kind: 'approvals' as const, count: 1 },
    { kind: 'messages' as const, count: 2, ref: A },
    { kind: 'files' as const, count: 1, ref: B },
    { kind: 'update' as const, count: 1 },
  ];
  const names = new Map([[A, 'Ana']]);

  it('D2 defaults: approvals only, no name', () => {
    expect(notifyMessages(news, NOTIFY_DEFAULTS, names)).toEqual([
      { v: 1, type: 'notify', kind: 'approvals', count: 1, name: '' },
    ]);
  });

  it('each switch lets its own kind through', () => {
    const kinds = (prefs: AlertSource['prefs']) =>
      notifyMessages(news, prefs, names).map((m) => m.kind);
    expect(kinds({ ...NOTIFY_DEFAULTS, approvals: false })).toEqual([]);
    expect(kinds({ ...NOTIFY_DEFAULTS, approvals: false, messages: true })).toEqual(['messages']);
    expect(kinds({ ...NOTIFY_DEFAULTS, approvals: false, files: true })).toEqual(['files']);
    expect(kinds({ ...NOTIFY_DEFAULTS, approvals: false, updates: true })).toEqual(['update']);
  });

  it('names off: never a name, even when the owner gave one', () => {
    for (const m of notifyMessages(news, ALL_ON, names)) expect(m.name).toBe('');
  });

  it('names on: only the owner-given names it was handed, else none', () => {
    const out = notifyMessages(news, { ...ALL_ON, showNames: true }, names);
    expect(out.map((m) => [m.kind, m.name])).toEqual([
      ['approvals', ''],
      ['messages', 'Ana'],
      ['files', ''],
      ['update', ''],
    ]);
  });

  it('a name that is not a plain short name is dropped, never sent', () => {
    const odd = new Map([[A, 'Ana\nclick https://evil.example']]);
    const out = notifyMessages(news, { ...ALL_ON, showNames: true }, odd);
    expect(out.find((m) => m.kind === 'messages')?.name).toBe('');
  });

  it('every message passes the strict pipe encoder', () => {
    for (const m of notifyMessages(news, { ...ALL_ON, showNames: true }, names)) {
      const encoded = encodeHostMessage(m);
      expect(encoded).toBeDefined();
      expect(parseHostMessage((encoded ?? '').trim())).toEqual(m);
    }
  });
});
