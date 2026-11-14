// N7 (PLAN-NOTIFY §3.5; D2; S2): native notifications in the desktop app. The core sends fixed codes
// over the pipe (`notify {kind, count, name}`); the shell builds every word itself, throttles one per
// kind per 30 s (counts coalesced), opens only an allowlisted route on a click, and keeps the dock
// badge at the number of approvals waiting. No message text, file name or link is ever on the pipe
// or in a notification; a name only when the owner turned on Show names, and then only an owner-
// given alias (the core decides; the pipe only accepts a plain short name).
import { describe, expect, it } from 'vitest';
import {
  NOTIFY_KINDS,
  SESSION_PATHS,
  SHOW_ROUTES,
  encodeCoreMessage,
  encodeShellMessage,
  isNotifyName,
  parseCoreMessage,
  parseShellMessage,
  sessionUrlOrigin,
  type NotifyMessage,
} from '../../src/shared/protocol.js';
import {
  APP_USER_MODEL_ID,
  NOTIFY_GAP_MS,
  NOTIFY_ROUTES,
  NOTIFY_TITLES,
  NativeNotifier,
  notificationText,
} from '../../src/main/notify.js';
import type { NotificationOptions } from '../../src/main/electron-api.js';
import { runShell, type ShellProcess } from '../../src/main/main.js';
import {
  FakeBrowserWindow,
  FakeTimers,
  TOKEN,
  fakeElectron,
  fakeSpawn,
  readyLine,
} from './fakes.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const line = (value: unknown): string => JSON.stringify(value);
const notify = (kind: string, count: number, name = ''): string =>
  line({ v: 1, type: 'notify', kind, count, name });

/** A fake Electron Notification: records what was shown and lets a test click it. */
class FakeNotification {
  static shown: FakeNotification[] = [];
  static supported = true;
  static isSupported(): boolean {
    return FakeNotification.supported;
  }
  private readonly listeners = new Map<string, (() => void)[]>();
  constructor(readonly options: NotificationOptions) {}
  on(event: 'click' | 'close', listener: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  show(): void {
    FakeNotification.shown.push(this);
  }
  click(): void {
    for (const l of this.listeners.get('click') ?? []) l();
  }
}

describe('the pipe: notify is fixed codes only (strict)', () => {
  it('has exactly the four kinds of the notification store that alert', () => {
    expect([...NOTIFY_KINDS]).toEqual(['approvals', 'messages', 'files', 'update']);
  });

  it('parses a notify with a kind, a count and an empty name', () => {
    expect(parseCoreMessage(notify('approvals', 2))).toEqual({
      v: 1,
      type: 'notify',
      kind: 'approvals',
      count: 2,
      name: '',
    });
    expect(parseCoreMessage(notify('messages', 3, 'Ana'))).toEqual({
      v: 1,
      type: 'notify',
      kind: 'messages',
      count: 3,
      name: 'Ana',
    });
  });

  it.each([
    ['a text field', { v: 1, type: 'notify', kind: 'messages', count: 1, name: '', text: 'hi' }],
    ['a title', { v: 1, type: 'notify', kind: 'messages', count: 1, name: '', title: 'x' }],
    ['a body', { v: 1, type: 'notify', kind: 'messages', count: 1, name: '', body: 'x' }],
    ['a link', { v: 1, type: 'notify', kind: 'update', count: 1, name: '', url: 'https://x' }],
    ['a route', { v: 1, type: 'notify', kind: 'update', count: 1, name: '', route: '/x' }],
    ['no name key', { v: 1, type: 'notify', kind: 'approvals', count: 1 }],
    ['an unknown kind', { v: 1, type: 'notify', kind: 'network', count: 1, name: '' }],
    ['a free-text kind', { v: 1, type: 'notify', kind: 'Your bank says hi', count: 1, name: '' }],
    ['count 0', { v: 1, type: 'notify', kind: 'messages', count: 0, name: '' }],
    ['a fractional count', { v: 1, type: 'notify', kind: 'messages', count: 1.5, name: '' }],
    ['a string count', { v: 1, type: 'notify', kind: 'messages', count: '1', name: '' }],
    ['a name on approvals', { v: 1, type: 'notify', kind: 'approvals', count: 1, name: 'Ana' }],
    ['a name on update', { v: 1, type: 'notify', kind: 'update', count: 1, name: 'Ana' }],
    ['a name with a newline', { v: 1, type: 'notify', kind: 'files', count: 1, name: 'A\nB' }],
    [
      'a name with a link',
      { v: 1, type: 'notify', kind: 'files', count: 1, name: 'evil.example/x' },
    ],
    ['a name with a scheme', { v: 1, type: 'notify', kind: 'files', count: 1, name: 'https:x' }],
    ['a name with bidi', { v: 1, type: 'notify', kind: 'files', count: 1, name: 'Ana\u202Eevil' }],
    ['a zero-width name', { v: 1, type: 'notify', kind: 'files', count: 1, name: 'A\u200Bna' }],
    ['a long name', { v: 1, type: 'notify', kind: 'files', count: 1, name: 'A'.repeat(33) }],
    ['a name of spaces', { v: 1, type: 'notify', kind: 'files', count: 1, name: '   ' }],
    [
      'message text as a name',
      {
        v: 1,
        type: 'notify',
        kind: 'messages',
        count: 1,
        name: 'Please send the code: 1234!',
      },
    ],
    ['a name object', { v: 1, type: 'notify', kind: 'files', count: 1, name: { a: 1 } }],
  ])('rejects %s', (_what, value) => {
    expect(parseCoreMessage(line(value))).toBeUndefined();
  });

  it('a plain owner alias passes the name shape; anything else does not', () => {
    for (const ok of ['Ana', 'Ana Novak', "O'Neil", 'Jean-Luc', 'Mei 2', 'Žiga', '李雷']) {
      expect(isNotifyName(ok)).toBe(true);
    }
    for (const bad of ['', ' Ana', 'Ana ', 'a@b', 'x:y', '<b>', 'A\tB', 'A'.repeat(33), 42]) {
      expect(isNotifyName(bad)).toBe(false);
    }
  });

  it('the encoder refuses an invalid notify (nothing reaches the pipe)', () => {
    const bad = { v: 1, type: 'notify', kind: 'approvals', count: 1, name: 'Ana' } as NotifyMessage;
    expect(() => encodeCoreMessage(bad)).toThrow(/^protocol: invalid core message$/);
    const good: NotifyMessage = { v: 1, type: 'notify', kind: 'files', count: 4, name: '' };
    expect(encodeCoreMessage(good)).toBe(`${notify('files', 4)}\n`);
  });
});

describe('deep links: only allowlisted routes', () => {
  it('show routes are a fixed enum: home, approvals, join, inbox, updates', () => {
    expect([...SHOW_ROUTES]).toEqual(['home', 'approvals', 'join', 'inbox', 'updates']);
    for (const route of ['inbox', 'updates'] as const) {
      expect(parseShellMessage(encodeShellMessage({ v: 1, type: 'show', route }).trim())).toEqual({
        v: 1,
        type: 'show',
        route,
      });
    }
    for (const route of ['/settings/updates', 'settings', 'people/0xabc', 'https://x', '']) {
      expect(parseShellMessage(line({ v: 1, type: 'show', route }))).toBeUndefined();
    }
  });

  it('each kind opens one fixed route', () => {
    expect(NOTIFY_ROUTES).toEqual({
      approvals: 'approvals',
      messages: 'inbox',
      files: 'inbox',
      update: 'updates',
    });
  });

  it('the session link may now land on Settings › Updates, and nowhere new besides', () => {
    expect([...SESSION_PATHS]).toEqual([
      '/',
      '/first-run',
      '/settings/home',
      '/settings/join',
      '/settings/updates',
    ]);
    expect(sessionUrlOrigin(`http://localhost:4567/settings/updates?t=${TOKEN}`)).toBe(
      'http://localhost:4567',
    );
    expect(sessionUrlOrigin(`http://localhost:4567/settings/updates/x?t=${TOKEN}`)).toBeNull();
  });
});

describe('fixed strings', () => {
  it('titles are the four fixed words', () => {
    expect(NOTIFY_TITLES).toEqual({
      approvals: 'Approval waiting',
      messages: 'New message',
      files: 'File received',
      update: 'Update ready',
    });
  });

  it('never a name unless one came, and then only that name; never other words from the pipe', () => {
    expect(notificationText('approvals', 1, '')).toEqual({
      title: 'Approval waiting',
      body: 'Open AgentLink to review it.',
    });
    expect(notificationText('approvals', 3, '').body).toBe('3 approvals are waiting for you.');
    expect(notificationText('messages', 1, '')).toEqual({
      title: 'New message',
      body: 'From a contact.',
    });
    expect(notificationText('messages', 2, '').body).toBe('2 new messages from your contacts.');
    expect(notificationText('messages', 1, 'Ana').body).toBe('From Ana.');
    expect(notificationText('messages', 4, 'Ana').body).toBe('4 new messages from Ana.');
    expect(notificationText('files', 1, '')).toEqual({
      title: 'File received',
      body: 'From a contact.',
    });
    expect(notificationText('files', 2, 'Ana').body).toBe('2 files from Ana.');
    expect(notificationText('update', 2, '')).toEqual({
      title: 'Update ready',
      body: 'A new version of AgentLink is ready to install.',
    });
    // A name is ignored where no name belongs (the parser refuses it anyway).
    expect(notificationText('approvals', 1, 'Ana').body).not.toContain('Ana');
  });

  it('uses plain words (11 §5): no wallet, gas, seed phrase or transaction', () => {
    for (const kind of NOTIFY_KINDS) {
      const { title, body } = notificationText(kind, 2, '');
      expect(`${title} ${body}`).not.toMatch(/wallet|gas|seed phrase|transaction|chain/i);
    }
  });
});

describe('NativeNotifier: throttle, coalesce and click', () => {
  const make = () => {
    FakeNotification.shown = [];
    FakeNotification.supported = true;
    const timers = new FakeTimers();
    const clicks: string[] = [];
    const notifier = new NativeNotifier({
      Notification: FakeNotification,
      timers,
      onClick: (route) => clicks.push(route),
    });
    const msg = (kind: NotifyMessage['kind'], count: number, name = ''): NotifyMessage => ({
      v: 1,
      type: 'notify',
      kind,
      count,
      name,
    });
    return { timers, clicks, notifier, msg };
  };

  it('shows the first one at once with fixed text, silent on nothing else', () => {
    const { notifier, msg } = make();
    notifier.handle(msg('approvals', 1));
    expect(FakeNotification.shown.map((n) => n.options)).toEqual([
      { title: 'Approval waiting', body: 'Open AgentLink to review it.' },
    ]);
  });

  it('at most one per kind per 30 s; counts coalesce into one later notification', () => {
    const { notifier, msg, timers } = make();
    notifier.handle(msg('messages', 1));
    notifier.handle(msg('messages', 1));
    notifier.handle(msg('messages', 2));
    expect(FakeNotification.shown).toHaveLength(1);
    // Another kind is not held back by this one.
    notifier.handle(msg('files', 1));
    expect(FakeNotification.shown).toHaveLength(2);
    timers.advance(NOTIFY_GAP_MS - 1);
    expect(FakeNotification.shown).toHaveLength(2);
    timers.advance(1);
    expect(FakeNotification.shown).toHaveLength(3);
    expect(FakeNotification.shown[2]?.options.body).toBe('3 new messages from your contacts.');
    // Nothing more waits: no further notification.
    timers.advance(NOTIFY_GAP_MS * 3);
    expect(FakeNotification.shown).toHaveLength(3);
  });

  it('approvals coalesce to the latest number waiting, not a sum', () => {
    const { notifier, msg, timers } = make();
    notifier.handle(msg('approvals', 1));
    notifier.handle(msg('approvals', 2));
    notifier.handle(msg('approvals', 3));
    timers.advance(NOTIFY_GAP_MS);
    expect(FakeNotification.shown.map((n) => n.options.body)).toEqual([
      'Open AgentLink to review it.',
      '3 approvals are waiting for you.',
    ]);
  });

  it('a coalesced name stays only while it is the same person', () => {
    const { notifier, msg, timers } = make();
    notifier.handle(msg('messages', 1, 'Ana'));
    notifier.handle(msg('messages', 1, 'Ana'));
    timers.advance(NOTIFY_GAP_MS);
    expect(FakeNotification.shown[1]?.options.body).toBe('From Ana.');
    notifier.handle(msg('messages', 1, 'Ana'));
    notifier.handle(msg('messages', 1, 'Bo'));
    timers.advance(NOTIFY_GAP_MS);
    expect(FakeNotification.shown[2]?.options.body).toBe('2 new messages from your contacts.');
  });

  it('a click opens only the fixed route of its kind', () => {
    const { notifier, msg, clicks } = make();
    for (const kind of NOTIFY_KINDS) notifier.handle(msg(kind, 1));
    for (const shown of FakeNotification.shown) shown.click();
    expect(clicks).toEqual(['approvals', 'inbox', 'inbox', 'updates']);
  });

  it('shows nothing where the OS has no notifications', () => {
    const { notifier, msg } = make();
    FakeNotification.supported = false;
    notifier.handle(msg('approvals', 1));
    expect(FakeNotification.shown).toHaveLength(0);
  });
});

describe('runShell wiring (N7)', () => {
  function setup(platform = 'darwin') {
    const electron = fakeElectron();
    const badges: number[] = [];
    const ids: string[] = [];
    FakeNotification.shown = [];
    FakeNotification.supported = true;
    Object.assign(electron, { Notification: FakeNotification });
    Object.assign(electron.app, {
      setBadgeCount: (n: number) => {
        badges.push(n);
        return true;
      },
      setAppUserModelId: (id: string) => {
        ids.push(id);
      },
    });
    const { spawn, children } = fakeSpawn();
    const exe =
      platform === 'win32'
        ? 'C:\\Users\\x\\AppData\\Local\\Programs\\AgentLink\\AgentLink.exe'
        : '/Applications/AgentLink.app/Contents/MacOS/AgentLink';
    const proc: ShellProcess = {
      argv: [exe],
      execArgv: [],
      env: { HOME: '/Users/x', PATH: '/usr/bin' },
      platform,
      execPath: exe,
      resourcesPath: '/Applications/AgentLink.app/Contents/Resources',
      homeDir: '/Users/x',
      tmpDir: '/var/folders/ab/T',
      writable: () => true,
      exists: () => true,
      spawn,
      timers: new FakeTimers(),
      preview: null,
      logDir: join(mkdtempSync(join(tmpdir(), 'agentlink-n7-')), 'Logs'),
    };
    return { electron, children, proc, badges, ids };
  }

  it('a notify from the core shows a native notification; a click focuses and opens its route', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    const core = children[0];
    core?.stream.push(readyLine());
    core?.stream.push(`${notify('update', 2)}\n`);
    expect(FakeNotification.shown.map((n) => n.options.title)).toEqual(['Update ready']);
    const window = FakeBrowserWindow.created[0];
    window?.hide();
    const before = core?.stream.written.length ?? 0;
    FakeNotification.shown[0]?.click();
    expect(window?.visible).toBe(true);
    expect(core?.stream.written.slice(before)).toEqual([
      `${line({ v: 1, type: 'show', route: 'updates' })}\n`,
    ]);
  });

  it('a notify with text in it is a protocol violation: nothing is shown and the core is stopped', async () => {
    const { electron, children, proc } = setup();
    await runShell(electron, proc);
    const core = children[0];
    core?.stream.push(readyLine());
    core?.stream.push(
      `${line({ v: 1, type: 'notify', kind: 'messages', count: 1, name: '', text: 'secret' })}\n`,
    );
    expect(FakeNotification.shown).toHaveLength(0);
    expect(core?.kills.length ?? 0).toBeGreaterThan(0);
  });

  it('the dock badge is the number of approvals waiting', async () => {
    const { electron, children, proc, badges } = setup();
    await runShell(electron, proc);
    const core = children[0];
    core?.stream.push(readyLine());
    core?.stream.push(
      `${line({ v: 1, type: 'status', state: 'running', counts: { openPages: 1, waitingApprovals: 2 } })}\n`,
    );
    core?.stream.push(`${line({ v: 1, type: 'approval-waiting', count: 0 })}\n`);
    expect(badges).toEqual([2, 0]);
  });

  it('Windows: the AppUserModelID is set at startup (toasts need it)', async () => {
    const { electron, proc, ids } = setup('win32');
    await runShell(electron, proc);
    expect(ids).toEqual([APP_USER_MODEL_ID]);
    expect(APP_USER_MODEL_ID).toBe('4thTech.AgentLink');
  });

  it('macOS: no AppUserModelID call', async () => {
    const { electron, proc, ids } = setup('darwin');
    await runShell(electron, proc);
    expect(ids).toEqual([]);
  });
});
