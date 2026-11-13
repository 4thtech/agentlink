// N4 (S2; PLAN-NOTIFY §3.1, §3.4; 08 §1, proposed, owner confirms at merge): the notification
// centre's routes, behind the same session, CSRF, Host and fetch-metadata gate as every /api/ui/
// route (approval-server.ts).
//
// - `GET /api/ui/notifications` (`presence: false`): `{items, unread, approvals}` of the open ID,
//   newest first, as stored: it reads only and never writes (IR-NOTIFY-1 L-1).
// - `POST /api/ui/notifications/refresh` (the `mark` kind): brings the store up to date with what
//   the server sees now (approvals waiting, inbound events, update, network) and writes it when
//   something changed. The page sends it before each read. Each item is built again by the one strict reader (ui-contract/notifications.ts):
//   a kind, an ID ref, a count and times, never text, a name, a file name or a link (I-5, I-7).
// - `POST /api/ui/notifications/:id/read` and `POST /api/ui/notifications/read-all`: the `mark`
//   kind (route-types.ts MARK_PATHS): display state only (nothing is decided from it), no owner
//   presence, no input, nothing signed; the server's mark gate keeps every write guard. Marking an
//   approval read never decides it: the approval stays counted until it is approved or declined.
// - No MCP tool reaches any of this (I-4): the store lives in the server, per ID.
// - Fixed answers only; nothing here logs a value, a ref or a path.
import type { JsonObject } from '@4thtech-io/crypto';
import {
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_ALL_PATH,
  NOTIFICATIONS_REFRESH_PATH,
  NOTIFICATION_READ_PATH,
  approvalsOf,
  isNotificationId,
  readNotificationItem,
  unreadOf,
  type NotificationItem,
} from '@4thtech-io/types/ui-contract/notifications';
import type { LocalUiContext } from '../context.js';
import {
  UI_INVALID_QUERY,
  UI_UNAVAILABLE,
  type LocalUiMarkRoute,
  type LocalUiReadRoute,
  type LocalUiResult,
  type LocalUiRoute,
} from '../route-types.js';

export {
  NOTIFICATIONS_PATH,
  NOTIFICATIONS_READ_ALL_PATH,
  NOTIFICATIONS_REFRESH_PATH,
  NOTIFICATION_READ_PATH,
};

/** The open ID's notification store, as the server binds it (approval-server.ts). Never throws text. */
export interface LocalUiNotificationsDesk {
  /** The stored items (reads only). */
  list(): Promise<readonly NotificationItem[]>;
  /** Brings the store up to date with what the server sees now (writes when something changed). */
  refresh(): Promise<void>;
  markRead(id: string): Promise<boolean>;
  markAllRead(): Promise<void>;
}

const NOT_FOUND: LocalUiResult = Object.freeze({
  status: 404,
  body: Object.freeze({ error: 'not_found' }),
});
const DONE: LocalUiResult = Object.freeze({ status: 200, body: Object.freeze({ status: 'done' }) });

/** The answer body, rebuilt key by key from the checked items (nothing of the source passes). */
function body(items: readonly NotificationItem[]): JsonObject {
  const out: JsonObject[] = [];
  for (const raw of items) {
    const item = readNotificationItem({ ...raw });
    if (item === undefined) continue;
    out.push({
      id: item.id,
      kind: item.kind,
      ...(item.ref === undefined ? {} : { ref: item.ref }),
      count: item.count,
      at: item.at,
      read: item.read,
    });
  }
  const checked = items.filter((i) => readNotificationItem({ ...i }) !== undefined);
  return { items: out, unread: unreadOf(checked), approvals: approvalsOf(checked) };
}

const listRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: NOTIFICATIONS_PATH,
  presence: false,
  handler: async (context: LocalUiContext, request): Promise<LocalUiResult> => {
    if ([...request.query.keys()].length > 0) return UI_INVALID_QUERY;
    const desk = context.notifications;
    if (desk === undefined) return { status: 200, body: body([]) };
    try {
      return { status: 200, body: body(await desk.list()) };
    } catch {
      return UI_UNAVAILABLE;
    }
  },
});

const readRoute: LocalUiMarkRoute = Object.freeze<LocalUiMarkRoute>({
  method: 'POST',
  path: NOTIFICATION_READ_PATH,
  presence: 'mark',
  handler: async (context, params): Promise<LocalUiResult> => {
    const id = params['id'];
    if (!isNotificationId(id)) return NOT_FOUND;
    const desk = context.notifications;
    if (desk === undefined) return NOT_FOUND;
    try {
      return (await desk.markRead(id)) ? DONE : NOT_FOUND;
    } catch {
      return UI_UNAVAILABLE;
    }
  },
});

const readAllRoute: LocalUiMarkRoute = Object.freeze<LocalUiMarkRoute>({
  method: 'POST',
  path: NOTIFICATIONS_READ_ALL_PATH,
  presence: 'mark',
  handler: async (context): Promise<LocalUiResult> => {
    const desk = context.notifications;
    if (desk === undefined) return DONE;
    try {
      await desk.markAllRead();
      return DONE;
    } catch {
      return UI_UNAVAILABLE;
    }
  },
});

const refreshRoute: LocalUiMarkRoute = Object.freeze<LocalUiMarkRoute>({
  method: 'POST',
  path: NOTIFICATIONS_REFRESH_PATH,
  presence: 'mark',
  handler: async (context): Promise<LocalUiResult> => {
    const desk = context.notifications;
    if (desk === undefined) return DONE;
    try {
      await desk.refresh();
      return DONE;
    } catch {
      return UI_UNAVAILABLE;
    }
  },
});

export const notificationsRoutes: readonly LocalUiRoute[] = Object.freeze([
  listRoute,
  readRoute,
  readAllRoute,
  refreshRoute,
]);
