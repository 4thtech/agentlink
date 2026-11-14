// NOTIFY-DEEPLINK, NOTIFY-UPDATE-READY (S1): a click on a notification opens the one request or the
// one conversation it is about. The pipe carries only an opaque local ID (a request's or a person's),
// shape-checked on both sides; never content, a name or a path. An update that is ready to install says so.
import { describe, expect, it } from 'vitest';
import {
  encodeShellMessage,
  isNotifyTarget,
  parseCoreMessage,
  parseShellMessage,
  sessionUrlOrigin,
  type NotifyMessage,
} from '../../src/shared/protocol.js';
import { NOTIFY_GAP_MS, NativeNotifier, notificationText } from '../../src/main/notify.js';
import type { NotificationOptions } from '../../src/main/electron-api.js';
import { FakeTimers, TOKEN } from './fakes.js';

const APR = `apr_${'A'.repeat(22)}`;
const PERSON = `0x${'ab'.repeat(20)}`;
const line = (value: unknown): string => JSON.stringify(value);

class FakeNotification {
  static shown: FakeNotification[] = [];
  static isSupported(): boolean {
    return true;
  }
  private click1: (() => void) | undefined;
  constructor(readonly options: NotificationOptions) {}
  on(event: 'click' | 'close', listener: () => void): void {
    if (event === 'click') this.click1 = listener;
  }
  show(): void {
    FakeNotification.shown.push(this);
  }
  click(): void {
    this.click1?.();
  }
}

describe('the target is an opaque local ID of the right shape', () => {
  it('a request for approvals, a person for messages, files and inbox, nothing else', () => {
    expect(isNotifyTarget('approvals', APR)).toBe(true);
    expect(isNotifyTarget('approvals', PERSON)).toBe(false);
    for (const kind of ['messages', 'files', 'inbox'] as const) {
      expect(isNotifyTarget(kind, PERSON)).toBe(true);
      expect(isNotifyTarget(kind, APR)).toBe(false);
    }
    for (const kind of ['update', 'updates', 'home', 'join'] as const) {
      expect(isNotifyTarget(kind, PERSON)).toBe(false);
    }
    for (const bad of ['', '/etc/passwd', 'https://x', `${PERSON}/x`, `0x${'AB'.repeat(20)}`]) {
      expect(isNotifyTarget('messages', bad)).toBe(false);
    }
  });

  it('notify with a target parses; a wrong shape, a wrong kind or a number is refused', () => {
    const base = { v: 1, type: 'notify', kind: 'messages', count: 1, name: '' };
    expect(parseCoreMessage(line({ ...base, target: PERSON }))).toEqual({
      ...base,
      target: PERSON,
    });
    expect(parseCoreMessage(line({ ...base, target: APR }))).toBeUndefined();
    expect(parseCoreMessage(line({ ...base, target: 5 }))).toBeUndefined();
    expect(parseCoreMessage(line({ ...base, kind: 'update', target: PERSON }))).toBeUndefined();
    expect(parseCoreMessage(line({ ...base, target: PERSON, extra: 1 }))).toBeUndefined();
    // Without one it is the same as before.
    expect(parseCoreMessage(line(base))).toEqual(base);
  });

  it('show with a target parses only for its route', () => {
    expect(
      parseShellMessage(line({ v: 1, type: 'show', route: 'approvals', target: APR })),
    ).toEqual({ v: 1, type: 'show', route: 'approvals', target: APR });
    expect(parseShellMessage(line({ v: 1, type: 'show', route: 'inbox', target: PERSON }))).toEqual(
      { v: 1, type: 'show', route: 'inbox', target: PERSON },
    );
    expect(
      parseShellMessage(line({ v: 1, type: 'show', route: 'updates', target: PERSON })),
    ).toBeUndefined();
    expect(
      parseShellMessage(line({ v: 1, type: 'show', route: 'inbox', target: APR })),
    ).toBeUndefined();
    expect(encodeShellMessage({ v: 1, type: 'show', route: 'inbox', target: PERSON })).toBe(
      `${line({ v: 1, type: 'show', route: 'inbox', target: PERSON })}\n`,
    );
    expect(encodeShellMessage({ v: 1, type: 'show', route: 'home' })).toBe(
      `${line({ v: 1, type: 'show', route: 'home' })}\n`,
    );
  });
});

describe('the session link may name one request or one person', () => {
  it('accepts /approve/<id> and a #person=<id> fragment on Home', () => {
    expect(sessionUrlOrigin(`http://localhost:4567/approve/${APR}?t=${TOKEN}`)).toBe(
      'http://localhost:4567',
    );
    expect(sessionUrlOrigin(`http://localhost:4567/?t=${TOKEN}#person=${PERSON}`)).toBe(
      'http://localhost:4567',
    );
  });

  it('refuses any other path or fragment', () => {
    for (const url of [
      `http://localhost:4567/approve/nope?t=${TOKEN}`,
      `http://localhost:4567/approve/${APR}/x?t=${TOKEN}`,
      `http://localhost:4567/?t=${TOKEN}#person=0xZZ`,
      `http://localhost:4567/?t=${TOKEN}#x=1`,
      `http://localhost:4567/?t=${TOKEN}#person=${PERSON}&y=1`,
    ]) {
      expect(sessionUrlOrigin(url)).toBeNull();
    }
  });
});

describe('a click carries the notification target', () => {
  const make = () => {
    FakeNotification.shown = [];
    const timers = new FakeTimers();
    const clicks: { route: string; target?: string }[] = [];
    const notifier = new NativeNotifier({
      Notification: FakeNotification,
      timers,
      onClick: (route, target) =>
        clicks.push({ route, ...(target === undefined ? {} : { target }) }),
    });
    const msg = (kind: NotifyMessage['kind'], count: number, target?: string): NotifyMessage => ({
      v: 1,
      type: 'notify',
      kind,
      count,
      name: '',
      ...(target === undefined ? {} : { target }),
    });
    return { notifier, timers, clicks, msg };
  };

  it('opens that request or person; none leaves the kind page alone', () => {
    const { notifier, clicks, msg } = make();
    notifier.handle(msg('approvals', 1, APR));
    notifier.handle(msg('messages', 1, PERSON));
    notifier.handle(msg('files', 1));
    for (const shown of FakeNotification.shown) shown.click();
    expect(clicks).toEqual([
      { route: 'approvals', target: APR },
      { route: 'inbox', target: PERSON },
      { route: 'inbox' },
    ]);
  });

  it('coalesced from two people: no target (the list), from one: that person', () => {
    const { notifier, timers, clicks, msg } = make();
    const other = `0x${'cd'.repeat(20)}`;
    notifier.handle(msg('messages', 1, PERSON));
    notifier.handle(msg('messages', 1, PERSON));
    notifier.handle(msg('messages', 1, other));
    timers.advance(NOTIFY_GAP_MS);
    FakeNotification.shown[1]?.click();
    expect(clicks).toEqual([{ route: 'inbox' }]);
  });
});

describe('NOTIFY-UPDATE-READY: the words follow the state', () => {
  it('ready to install says so; only available says available', () => {
    expect(notificationText('update', 2, '')).toEqual({
      title: 'Update ready',
      body: 'A new version of AgentLink is ready to install.',
    });
    expect(notificationText('update', 1, '')).toEqual({
      title: 'Update available',
      body: 'A new version of AgentLink is available.',
    });
  });

  it('coalesced: the more advanced state wins (never counts added)', () => {
    FakeNotification.shown = [];
    const timers = new FakeTimers();
    const notifier = new NativeNotifier({
      Notification: FakeNotification,
      timers,
      onClick: () => {},
    });
    const update = (count: number): NotifyMessage => ({
      v: 1,
      type: 'notify',
      kind: 'update',
      count,
      name: '',
    });
    notifier.handle(update(1));
    notifier.handle(update(1));
    notifier.handle(update(2));
    timers.advance(NOTIFY_GAP_MS);
    expect(FakeNotification.shown[1]?.options.title).toBe('Update ready');
  });
});
