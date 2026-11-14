// NOTIFY-FOCUS (S1): no OS alert while the AgentLink window is focused and frontmost; the alert comes
// back as soon as the window is not (background, hidden, minimised, closed).
import { describe, expect, it } from 'vitest';
import { NOTIFY_GAP_MS, NativeNotifier } from '../../src/main/notify.js';
import type { NotificationOptions } from '../../src/main/electron-api.js';
import type { NotifyMessage } from '../../src/shared/protocol.js';
import { FakeBrowserWindow, FakeTimers } from './fakes.js';
import type { BrowserWindowOptions } from '../../src/main/electron-api.js';
import { MainWindow } from '../../src/main/window.js';

class FakeNotification {
  static shown: FakeNotification[] = [];
  static isSupported(): boolean {
    return true;
  }
  constructor(readonly options: NotificationOptions) {}
  on(): void {}
  show(): void {
    FakeNotification.shown.push(this);
  }
}

const msg = (kind: NotifyMessage['kind'], count = 1): NotifyMessage => ({
  v: 1,
  type: 'notify',
  kind,
  count,
  name: '',
});

describe('NativeNotifier with the window focused', () => {
  const make = (focused: { value: boolean }) => {
    FakeNotification.shown = [];
    const timers = new FakeTimers();
    const notifier = new NativeNotifier({
      Notification: FakeNotification,
      timers,
      windowFocused: () => focused.value,
      onClick: () => {},
    });
    return { notifier, timers };
  };

  it('shows nothing while focused, whatever the kind', () => {
    const { notifier } = make({ value: true });
    for (const kind of ['approvals', 'messages', 'files', 'update'] as const) {
      notifier.handle(msg(kind));
    }
    expect(FakeNotification.shown).toEqual([]);
  });

  it('shows it when the window is not focused', () => {
    const { notifier } = make({ value: false });
    notifier.handle(msg('messages'));
    expect(FakeNotification.shown.map((n) => n.options.title)).toEqual(['New message']);
  });

  it('is read at the moment of showing (focus lost, then an alert is shown)', () => {
    const focused = { value: true };
    const { notifier, timers } = make(focused);
    notifier.handle(msg('messages'));
    notifier.handle(msg('messages'));
    focused.value = false;
    timers.advance(NOTIFY_GAP_MS);
    // The first was never shown (focused); the second, held, is shown once the window is not focused.
    expect(FakeNotification.shown.map((n) => n.options.body)).toEqual(['From a contact.']);
  });

  it('without the hook it behaves as before', () => {
    FakeNotification.shown = [];
    const notifier = new NativeNotifier({
      Notification: FakeNotification,
      timers: new FakeTimers(),
      onClick: () => {},
    });
    notifier.handle(msg('approvals'));
    expect(FakeNotification.shown).toHaveLength(1);
  });
});

describe('MainWindow.focused', () => {
  it('is true only for a shown, un-minimised, focused window', () => {
    FakeBrowserWindow.created = [];
    const window = new MainWindow({
      BrowserWindow: FakeBrowserWindow,
      lock: { acceptSessionUrl: () => true, reset: () => undefined },
      quitting: () => false,
    } as unknown as ConstructorParameters<typeof MainWindow>[0]);
    expect(window.focused).toBe(false);
    window.showStatus('starting');
    const fake = FakeBrowserWindow.created[0] as FakeBrowserWindow;
    fake.focused = true;
    expect(window.focused).toBe(true);
    fake.hide();
    expect(window.focused).toBe(false);
    fake.show();
    fake.isMinimized = () => true;
    expect(window.focused).toBe(false);
    fake.isMinimized = () => false;
    fake.destroy();
    expect(window.focused).toBe(false);
    void ({} as BrowserWindowOptions);
  });
});
