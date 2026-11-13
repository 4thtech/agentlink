// N5 (PLAN-NOTIFY §3.1, §4.1; D1, D4): the page side of the notification centre (N4's routes).
//
// - `readNotifications()`: `POST /api/ui/notifications/refresh` (the server brings the store up to
//   date; IR-NOTIFY-1 L-1: the GET only reads), then `GET /api/ui/notifications`, read strictly by the
//   shared reader
//   (ui-contract/notifications.ts): a kind, a contact ref, a count and times, never text, a name or a
//   link. A failure is "nothing", never an error on screen.
// - `markNotificationRead(id)` / `markAllNotificationsRead()`: the mark kind, an empty octet-stream
//   POST (the generation guard adds the generation header; api/generation.ts).
// - `useNotifications(path)`: the shell's one copy, read on every page change, every 30 s, when the
//   window comes back into view and when the approvals count moves (pages/approvals/badge.ts).
// Nothing here logs.
import {
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_ALL_PATH,
  NOTIFICATIONS_REFRESH_PATH,
  NOTIFICATION_READ_PATH,
  isNotificationId,
  readNotificationList,
  type NotificationList,
} from '@4thtech-io/types/ui-contract/notifications';
import { useCallback, useEffect, useState } from 'react';

export type {
  NotificationItem,
  NotificationList,
} from '@4thtech-io/types/ui-contract/notifications';

/** How often the shell reads the centre while a page is open. */
export const NOTIFICATIONS_POLL_MS = 30_000;
/** Fired after a mark, so every reader of the centre reads again. */
export const NOTIFICATIONS_CHANGED = 'agentlink:notifications-changed';
const APPROVALS_EVENT = 'agentlink:approvals-waiting';

export const EMPTY_NOTIFICATIONS: NotificationList = Object.freeze({
  items: Object.freeze([]),
  unread: 0,
  approvals: 0,
});

function token(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
}

export type NotificationsFetch = typeof fetch;
const doFetch = (seam?: NotificationsFetch): NotificationsFetch =>
  seam ?? ((input, init) => globalThis.fetch(input, init));

/** The centre now, or undefined (offline, not set up, an answer of another shape). */
export async function readNotifications(
  seam?: NotificationsFetch,
): Promise<NotificationList | undefined> {
  try {
    // A failed refresh still reads what is stored.
    await doFetch(seam)(NOTIFICATIONS_REFRESH_PATH, {
      method: 'POST',
      headers: { 'X-AgentLink-CSRF': token(), 'Content-Type': 'application/octet-stream' },
      credentials: 'same-origin',
      cache: 'no-store',
    }).catch(() => undefined);
    const res = await doFetch(seam)(NOTIFICATIONS_PATH, {
      method: 'GET',
      headers: { 'X-AgentLink-CSRF': token() },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return undefined;
    return readNotificationList(await res.json());
  } catch {
    return undefined;
  }
}

async function mark(path: string, seam?: NotificationsFetch): Promise<boolean> {
  try {
    const res = await doFetch(seam)(path, {
      method: 'POST',
      headers: { 'X-AgentLink-CSRF': token(), 'Content-Type': 'application/octet-stream' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (res.ok && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
    }
    return res.ok;
  } catch {
    return false;
  }
}

export function markNotificationRead(id: string, seam?: NotificationsFetch): Promise<boolean> {
  if (!isNotificationId(id)) return Promise.resolve(false);
  return mark(NOTIFICATION_READ_PATH.replace(':id', id), seam);
}

export function markAllNotificationsRead(seam?: NotificationsFetch): Promise<boolean> {
  return mark(NOTIFICATIONS_READ_ALL_PATH, seam);
}

/** Paths where the centre is not read (Get started runs before an owner exists). */
const SKIP = (path: string): boolean => path === '/first-run' || path.startsWith('/start/');

/**
 * The shell's copy of the centre. `override` is a test seam (the read itself). Never throws; a
 * failed read keeps what was shown.
 */
export function useNotifications(
  path: string,
  override?: () => Promise<NotificationList | undefined>,
): { readonly list: NotificationList; readonly refresh: () => void } {
  const [list, setList] = useState<NotificationList>(EMPTY_NOTIFICATIONS);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (SKIP(path)) return undefined;
    let live = true;
    (override ?? readNotifications)().then(
      (next) => {
        if (live && next !== undefined) setList(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [path, override, tick]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const again = (): void => refresh();
    const visible = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = setInterval(again, NOTIFICATIONS_POLL_MS);
    window.addEventListener(NOTIFICATIONS_CHANGED, again);
    window.addEventListener(APPROVALS_EVENT, again);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, again);
      window.removeEventListener(APPROVALS_EVENT, again);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  return { list, refresh };
}
