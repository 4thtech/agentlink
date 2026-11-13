// N7 (PLAN-NOTIFY §3.5; D2; S2): the desktop app's native notifications, from Electron's
// Notification in the main process. The core sends only fixed codes over the private pipe
// (protocol.ts `notify {kind, count, name}`); every word is built here from the kind:
//
// - Titles are four fixed words (NOTIFY_TITLES). The body is fixed text with a number, and a name
//   only when the core sent one: an owner-given alias, sent only while the owner turned on Show names
//   (the pipe parser refuses any other shape). Never message text, a file name, a link or an amount
//   (11 §5.2, §5.7; I-5).
// - A click focuses the window and opens the kind's ONE fixed route (NOTIFY_ROUTES, a `show` enum);
//   nothing from a notification can choose a page, and no notification has an action that approves,
//   accepts or replies (11 §10).
// - At most one notification per kind per NOTIFY_GAP_MS (30 s, 06's OS-alert rule). What arrives
//   meanwhile is coalesced into one later notification: approvals keep the latest number waiting,
//   messages and files add up; a name stays only while it is the same person.
// - Electron drops a notification's click handler once the object is collected, so each shown one
//   is held until it is clicked or closed (at most MAX_HELD).
import {
  NOTIFY_KINDS,
  type NotifyKind,
  type NotifyMessage,
  type ShowRoute,
} from '../shared/protocol.js';
import type { Timers } from './core-process.js';
import type { NativeNotification, NotificationConstructor } from './electron-api.js';

/** At most one notification per kind in this many milliseconds. */
export const NOTIFY_GAP_MS = 30_000;

/** Windows: the AppUserModelID toasts are attributed to (the installer's Start menu shortcut). */
export const APP_USER_MODEL_ID = '4thTech.AgentLink';

/** The fixed titles (11 §5). */
export const NOTIFY_TITLES: Readonly<Record<NotifyKind, string>> = Object.freeze({
  approvals: 'Approval waiting',
  messages: 'New message',
  files: 'File received',
  update: 'Update ready',
});

/** The one page a click opens, per kind (a `show` route; never a path). */
export const NOTIFY_ROUTES: Readonly<Record<NotifyKind, ShowRoute>> = Object.freeze({
  approvals: 'approvals',
  messages: 'inbox',
  files: 'inbox',
  update: 'updates',
});

/** Shown notifications held for their click handler. */
const MAX_HELD = 20;

/** The fixed title and body for a kind, a count and a name ("" for none). */
export function notificationText(
  kind: NotifyKind,
  count: number,
  name: string,
): { readonly title: string; readonly body: string } {
  const title = NOTIFY_TITLES[kind];
  const n = String(count);
  const named = name !== '' && (kind === 'messages' || kind === 'files');
  switch (kind) {
    case 'approvals':
      return {
        title,
        body: count === 1 ? 'Open AgentLink to review it.' : `${n} approvals are waiting for you.`,
      };
    case 'messages':
      if (named)
        return { title, body: count === 1 ? `From ${name}.` : `${n} new messages from ${name}.` };
      return {
        title,
        body: count === 1 ? 'From a contact.' : `${n} new messages from your contacts.`,
      };
    case 'files':
      if (named) return { title, body: count === 1 ? `From ${name}.` : `${n} files from ${name}.` };
      return { title, body: count === 1 ? 'From a contact.' : `${n} files from your contacts.` };
    case 'update':
      return { title, body: 'A new version of AgentLink is ready to install.' };
  }
}

export interface NativeNotifierOptions {
  /** Electron's Notification; absent or unsupported: nothing is shown. */
  readonly Notification?: NotificationConstructor;
  readonly timers: Timers;
  /** A notification was clicked: focus the window and open this fixed route. */
  readonly onClick: (route: ShowRoute) => void;
}

interface KindState {
  lastShownAt: number | undefined;
  pending: { count: number; name: string } | undefined;
  timer: unknown;
}

export class NativeNotifier {
  private readonly kinds = new Map<NotifyKind, KindState>();
  private readonly held = new Set<NativeNotification>();
  private disposed = false;

  constructor(private readonly options: NativeNotifierOptions) {
    for (const kind of NOTIFY_KINDS) {
      this.kinds.set(kind, { lastShownAt: undefined, pending: undefined, timer: undefined });
    }
  }

  /** One `notify` from the core (already strictly parsed). */
  handle(message: NotifyMessage): void {
    if (this.disposed) return;
    const state = this.kinds.get(message.kind);
    if (state === undefined) return;
    const now = this.options.timers.now();
    const free = state.lastShownAt === undefined || now - state.lastShownAt >= NOTIFY_GAP_MS;
    if (free && state.pending === undefined) {
      state.lastShownAt = now;
      this.show(message.kind, message.count, message.name);
      return;
    }
    const before = state.pending;
    state.pending =
      before === undefined
        ? { count: message.count, name: message.name }
        : {
            count: message.kind === 'approvals' ? message.count : before.count + message.count,
            name: before.name === message.name ? before.name : '',
          };
    if (state.timer === undefined) {
      const wait = Math.max(0, (state.lastShownAt ?? now) + NOTIFY_GAP_MS - now);
      state.timer = this.options.timers.setTimeout(() => this.flush(message.kind), wait);
    }
  }

  /** Stops every waiting notification (the app quits). */
  dispose(): void {
    this.disposed = true;
    for (const state of this.kinds.values()) {
      if (state.timer !== undefined) this.options.timers.clearTimeout(state.timer);
      state.timer = undefined;
      state.pending = undefined;
    }
    this.held.clear();
  }

  private flush(kind: NotifyKind): void {
    const state = this.kinds.get(kind);
    if (state === undefined) return;
    state.timer = undefined;
    const pending = state.pending;
    state.pending = undefined;
    if (pending === undefined || this.disposed) return;
    state.lastShownAt = this.options.timers.now();
    this.show(kind, pending.count, pending.name);
  }

  private show(kind: NotifyKind, count: number, name: string): void {
    const Notification = this.options.Notification;
    try {
      if (Notification === undefined || !Notification.isSupported()) return;
      const notification = new Notification(notificationText(kind, count, name));
      const route = NOTIFY_ROUTES[kind];
      const release = (): void => {
        this.held.delete(notification);
      };
      notification.on('click', () => {
        release();
        this.options.onClick(route);
      });
      notification.on('close', release);
      if (this.held.size >= MAX_HELD) {
        const oldest = this.held.values().next().value;
        if (oldest !== undefined) this.held.delete(oldest);
      }
      this.held.add(notification);
      notification.show();
    } catch {
      // Best effort: the app, the tray and the dock badge still show it.
    }
  }
}
