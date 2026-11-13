// N4 (S2; PLAN-NOTIFY §3.1, §3.4; D1; proposed, owner confirms at merge): the notification centre's
// store, one per ID, local only (never sent to any 4thTech service).
//
// - An item is a kind, an ID ref, a count and times (ui-contract/notifications.ts). No content: no
//   message text, subject, file name, link, code or name ever enters it; the strict reader refuses
//   any other key, on every read of the file and before every write (I-5, I-7).
// - What changes it are signals the server gathers from what core already keeps in clear: approvals
//   waiting (a number), inbound message and file events (a contact ID, a kind and a time), whether an
//   update is available and whether the network has been down for more than 10 minutes.
// - Kept for 30 days or 200 items, whichever is fewer; a state item (approvals, update, network) is
//   removed once it is no longer true.
// - The record is `{v: 1, cursor, items}`: `cursor` is the newest event time already counted, so the
//   same event is never counted twice and nothing from before the store existed is backfilled.
// - One change at a time (a queue); nothing here logs.
import {
  NOTIFICATION_KEEP_SECONDS,
  NOTIFICATION_MAX_COUNT,
  NOTIFICATION_MAX_ITEMS,
  isNotificationId,
  notificationId,
  readNotificationItem,
  type NotificationItem,
  type NotificationKind,
} from '@4thtech-io/types/ui-contract/notifications';

export interface NotificationRecord {
  readonly v: 1;
  readonly cursor: number;
  readonly items: readonly NotificationItem[];
}

/** Where a store keeps its record (a JSON file under the ID folder, or memory). */
export interface NotificationPersistence {
  /** The stored record as parsed JSON, or undefined; never trusted (read strictly). */
  read(): Promise<unknown>;
  write(record: NotificationRecord): Promise<void>;
}

/** One inbound event: a contact ID, message or file, and its time (unix seconds). */
export interface NotificationInbound {
  readonly contactId: string;
  readonly kind: 'message' | 'file';
  readonly at: number;
}

/** What the server saw now; a missing field leaves that kind as it is. */
export interface NotificationSignals {
  readonly approvals?: number;
  readonly inbound?: readonly NotificationInbound[];
  readonly update?: boolean;
  /** The network has been down for more than 10 minutes. */
  readonly networkDown?: boolean;
}

export interface NotificationStore {
  /** The kept items, newest first (old ones dropped). */
  list(): Promise<readonly NotificationItem[]>;
  observe(signals: NotificationSignals): Promise<void>;
  /** False when no item has this ID. */
  markRead(id: string): Promise<boolean>;
  markAllRead(): Promise<void>;
  /** The newest event time already counted (the next inbound read starts after it). */
  cursor(): Promise<number>;
}

const REF = /^0x[0-9a-f]{40}$/;
const whole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The strict reading of a stored record: exactly `{v: 1, cursor, items}`; an item that is not of the
 * schema is dropped (never kept, never answered). Anything else is undefined.
 */
export function readNotificationRecord(value: unknown): NotificationRecord | undefined {
  if (!plainObject(value)) return undefined;
  if (Object.keys(value).sort().join(',') !== 'cursor,items,v') return undefined;
  if (value['v'] !== 1 || !whole(value['cursor']) || !Array.isArray(value['items'])) {
    return undefined;
  }
  const items: NotificationItem[] = [];
  const seen = new Set<string>();
  for (const raw of value['items'] as unknown[]) {
    const item = readNotificationItem(raw);
    if (item === undefined || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return Object.freeze({ v: 1, cursor: value['cursor'], items: Object.freeze(items) });
}

/** A store that lives only as long as the process (outside the app host, and tests). */
export function memoryNotificationPersistence(): NotificationPersistence {
  let stored: unknown;
  return {
    read: () => Promise.resolve(stored),
    write: (record) => {
      stored = JSON.parse(JSON.stringify(record)) as unknown;
      return Promise.resolve();
    },
  };
}

/** Newest first, then by ID; at most 200, none older than 30 days. */
function kept(items: readonly NotificationItem[], now: number): NotificationItem[] {
  const oldest = now - NOTIFICATION_KEEP_SECONDS;
  return items
    .filter((i) => i.at >= oldest)
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, NOTIFICATION_MAX_ITEMS);
}

function item(
  kind: NotificationKind,
  count: number,
  at: number,
  read: boolean,
  ref?: string,
): NotificationItem {
  // Built field by field and checked again by the one reader (no other key can reach the file).
  const built = readNotificationItem({
    id: notificationId(kind, ref),
    kind,
    ...(ref === undefined ? {} : { ref }),
    count: Math.min(Math.max(1, count), NOTIFICATION_MAX_COUNT),
    at,
    read,
  });
  if (built === undefined) throw new Error('invalid notification');
  return built;
}

export function createNotificationStore(
  persistence: NotificationPersistence,
  options: { readonly now: () => number },
): NotificationStore {
  const now = (): number => Math.floor(options.now());
  let queue: Promise<unknown> = Promise.resolve();
  /** Records started now (none was stored): written on the first observe, so the start time holds. */
  const fresh = new WeakSet<NotificationRecord>();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  const load = async (): Promise<NotificationRecord> => {
    let raw: unknown;
    try {
      raw = await persistence.read();
    } catch {
      raw = undefined;
    }
    // No record (or an unreadable one): start now, so history from before is never backfilled.
    const found = readNotificationRecord(raw);
    if (found !== undefined) return found;
    const started: NotificationRecord = { v: 1, cursor: now(), items: [] };
    fresh.add(started);
    return started;
  };
  const save = async (cursor: number, items: readonly NotificationItem[]): Promise<void> => {
    const record: NotificationRecord = { v: 1, cursor, items: kept(items, now()) };
    await persistence.write(record);
  };

  return Object.freeze<NotificationStore>({
    list: () => serial(async () => kept((await load()).items, now())),
    cursor: () => serial(async () => (await load()).cursor),
    observe: (signals) =>
      serial(async () => {
        const record = await load();
        const t = now();
        const byId = new Map(record.items.map((i) => [i.id, i]));
        const state = (kind: 'approvals' | 'update' | 'network', count: number | undefined) => {
          if (count === undefined) return;
          const before = byId.get(kind);
          if (count <= 0) {
            byId.delete(kind);
            return;
          }
          if (before === undefined) byId.set(kind, item(kind, count, t, false));
          // More of the same (another approval waiting) is news again; fewer or the same is not.
          else if (count > before.count) byId.set(kind, item(kind, count, t, false));
          else if (count < before.count) byId.set(kind, item(kind, count, before.at, before.read));
        };
        const approvals = signals.approvals;
        state('approvals', whole(approvals) ? approvals : undefined);
        state('update', signals.update === undefined ? undefined : signals.update ? 1 : 0);
        state(
          'network',
          signals.networkDown === undefined ? undefined : signals.networkDown ? 1 : 0,
        );
        let cursor = record.cursor;
        for (const e of [...(signals.inbound ?? [])].sort((a, b) => a.at - b.at)) {
          if (!REF.test(e.contactId) || !whole(e.at) || e.at <= record.cursor) continue;
          if (e.kind !== 'message' && e.kind !== 'file') continue;
          const kind: NotificationKind = e.kind === 'file' ? 'files' : 'messages';
          const id = notificationId(kind, e.contactId);
          const before = byId.get(id);
          const count = before === undefined || before.read ? 1 : before.count + 1;
          const at = Math.max(e.at, before?.at ?? 0);
          byId.set(id, item(kind, count, at, false, e.contactId));
          if (e.at > cursor) cursor = e.at;
        }
        const items = kept([...byId.values()], t);
        // Nothing changed (the usual poll): no write.
        const same =
          !fresh.has(record) &&
          cursor === record.cursor &&
          JSON.stringify(items) === JSON.stringify(kept(record.items, t));
        if (!same) await save(cursor, items);
      }),
    markRead: (id) =>
      serial(async () => {
        if (!isNotificationId(id)) return false;
        const record = await load();
        const items = kept(record.items, now());
        const found = items.find((i) => i.id === id);
        if (found === undefined) return false;
        if (!found.read) {
          await save(
            record.cursor,
            items.map((i) => (i.id === id ? item(i.kind, i.count, i.at, true, i.ref) : i)),
          );
        }
        return true;
      }),
    markAllRead: () =>
      serial(async () => {
        const record = await load();
        if (record.items.every((i) => i.read)) return;
        await save(
          record.cursor,
          record.items.map((i) => (i.read ? i : item(i.kind, i.count, i.at, true, i.ref))),
        );
      }),
  });
}
