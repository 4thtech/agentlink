// N4 (PLAN-NOTIFY §3.1, §3.4; D1, D2, D4; proposed, owner confirms at merge): the notification
// centre's wire and store shape, one definition for packages/node (notifications.ts, the routes),
// apps/cli (agent-dir.ts, the file under the ID folder) and apps/local-ui (the bell, Settings ›
// Notifications).
//
// An item holds ONLY a kind, an ID ref (a contact's ID, never a name), a count and two times: never
// message text, a subject, a file name, a link, a code, a name or anything else inbound or free
// text. The one strict reader below refuses any other key and any value of another shape, so no
// content can be stored or answered even by mistake (I-5, I-7; 11 §5.2). The page builds every word
// itself from the kind; a person's name comes from the page's own contact list by ref.
//
// - `GET /api/ui/notifications` (a read route): `{items, unread, approvals}`, newest first.
// - `POST /api/ui/notifications/:id/read`, `POST /api/ui/notifications/read-all` and
//   `POST /api/ui/notifications/refresh` (the `mark` kind: display state only, no input, no
//   presence, nothing signed; every write gate applies). Only these write; the GET only reads.
// - Kept for 30 days or 200 items per ID, whichever is fewer (NOTIFICATION_KEEP_SECONDS,
//   NOTIFICATION_MAX_ITEMS).

export const NOTIFICATIONS_PATH = '/api/ui/notifications';
export const NOTIFICATION_READ_PATH = '/api/ui/notifications/:id/read';
export const NOTIFICATIONS_READ_ALL_PATH = '/api/ui/notifications/read-all';
/** IR-NOTIFY-1 L-1: brings the store up to date (the GET only reads). The mark kind. */
export const NOTIFICATIONS_REFRESH_PATH = '/api/ui/notifications/refresh';

/** What an item is about (PLAN-NOTIFY §3.2). */
export const NOTIFICATION_KINDS = ['approvals', 'messages', 'files', 'update', 'network'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Kinds that carry a contact ref (one item per person). */
export const NOTIFICATION_PERSON_KINDS: readonly NotificationKind[] = ['messages', 'files'];

/** The only keys an item may have. `ref` only on a person kind. */
export const NOTIFICATION_KEYS = ['id', 'kind', 'ref', 'count', 'at', 'read'] as const;

/** 30 days, in seconds. */
export const NOTIFICATION_KEEP_SECONDS = 30 * 24 * 60 * 60;
/** At most this many items per ID (the newest are kept). */
export const NOTIFICATION_MAX_ITEMS = 200;
/** The largest count an item holds (a bigger one is kept at this). */
export const NOTIFICATION_MAX_COUNT = 9_999;

export interface NotificationItem {
  /** `<kind>` or `<kind>-<ref>` (notificationId). */
  readonly id: string;
  readonly kind: NotificationKind;
  /** A contact's ID (lowercase EVM address), only on `messages` and `files`. */
  readonly ref?: string;
  /** How many (approvals waiting, new messages from this person, files…); 1 for a state. */
  readonly count: number;
  /** When it last changed, unix seconds. */
  readonly at: number;
  readonly read: boolean;
}

export interface NotificationList {
  readonly items: readonly NotificationItem[];
  /** The bell's number: unread items, with every waiting approval counted until decided. */
  readonly unread: number;
  /** Approvals waiting (the favicon dot and the tab title). */
  readonly approvals: number;
}

const REF = /^0x[0-9a-f]{40}$/;
const ID = /^(approvals|update|network|(messages|files)-0x[0-9a-f]{40})$/;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const whole = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** An item's ID: the kind, plus the ref for a person kind. */
export function notificationId(kind: NotificationKind, ref?: string): string {
  return ref === undefined ? kind : `${kind}-${ref}`;
}

/** Whether an ID has the shape of an item ID (a mark route's `:id`). */
export function isNotificationId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/**
 * The one strict reading of an item (the store, the wire): exactly the allowlisted keys, each of its
 * own shape, the ID matching kind and ref. Anything else (a text, name, title, link, URL…) is
 * undefined; the caller never echoes it.
 */
export function readNotificationItem(value: unknown): NotificationItem | undefined {
  if (!plainObject(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((k) => !(NOTIFICATION_KEYS as readonly string[]).includes(k))) return undefined;
  const { id, kind, ref, count, at, read } = value;
  if (typeof kind !== 'string' || !(NOTIFICATION_KINDS as readonly string[]).includes(kind)) {
    return undefined;
  }
  const k = kind as NotificationKind;
  const person = NOTIFICATION_PERSON_KINDS.includes(k);
  if (person) {
    if (typeof ref !== 'string' || !REF.test(ref)) return undefined;
  } else if (ref !== undefined) {
    return undefined;
  }
  if (!whole(count, NOTIFICATION_MAX_COUNT) || count < 1) return undefined;
  if (!whole(at, Number.MAX_SAFE_INTEGER)) return undefined;
  if (typeof read !== 'boolean') return undefined;
  if (id !== notificationId(k, person ? (ref as string) : undefined)) return undefined;
  return Object.freeze({
    id: id as string,
    kind: k,
    ...(person ? { ref: ref as string } : {}),
    count,
    at,
    read,
  });
}

/** The bell's number for these items (an approval counts until decided, read or not). */
export function unreadOf(items: readonly NotificationItem[]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === 'approvals') n += item.count;
    else if (!item.read) n += 1;
  }
  return n;
}

/** Approvals waiting in these items. */
export function approvalsOf(items: readonly NotificationItem[]): number {
  return items.find((i) => i.kind === 'approvals')?.count ?? 0;
}

/** The strict reading of a GET answer: items that fail the item reader are left out. */
export function readNotificationList(value: unknown): NotificationList | undefined {
  if (!plainObject(value) || !Array.isArray(value['items'])) return undefined;
  const items: NotificationItem[] = [];
  for (const raw of value['items'] as unknown[]) {
    const item = readNotificationItem(raw);
    if (item !== undefined) items.push(item);
  }
  return Object.freeze({
    items: Object.freeze(items),
    unread: unreadOf(items),
    approvals: approvalsOf(items),
  });
}

// --- prefs (N6, Settings › Notifications) ----------------------------------------------------------

/**
 * The switches of Settings › Notifications (PLAN-NOTIFY §4.4), kept per install in ui-settings. N7
 * (desktop app): `messages`, `files` and `updates` each govern their own native notification and
 * `showNames` an owner-given name in it; `people`, `problems` and `quietHours` are not built yet
 * (kept in the schema, never shown).
 */
export const NOTIFY_PREF_KEYS = [
  'approvals',
  'messages',
  'files',
  'updates',
  'people',
  'problems',
  'showNames',
  'quietHours',
] as const;
export type NotifyPrefKey = (typeof NOTIFY_PREF_KEYS)[number];
export type NotifyPrefs = { readonly [K in NotifyPrefKey]?: boolean };

/** D2: approvals on; messages, files, updates, people and problems off; names off; quiet hours off. */
export const NOTIFY_DEFAULTS: Readonly<Record<NotifyPrefKey, boolean>> = Object.freeze({
  approvals: true,
  messages: false,
  files: false,
  updates: false,
  people: false,
  problems: false,
  showNames: false,
  quietHours: false,
});

/** A stored or sent prefs object: allowlisted keys, booleans only; anything else is undefined. */
export function readNotifyPrefs(value: unknown): NotifyPrefs | undefined {
  if (!plainObject(value)) return undefined;
  const out: Partial<Record<NotifyPrefKey, boolean>> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!(NOTIFY_PREF_KEYS as readonly string[]).includes(key) || typeof v !== 'boolean') {
      return undefined;
    }
    out[key as NotifyPrefKey] = v;
  }
  return Object.freeze(out);
}

/** The prefs in force: the stored choice, else the D2 default. */
export function notifyPrefsInForce(
  stored: NotifyPrefs | undefined,
): Record<NotifyPrefKey, boolean> {
  const out = { ...NOTIFY_DEFAULTS };
  for (const key of NOTIFY_PREF_KEYS) {
    const v = stored?.[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}
