// TRAY-WIDGET-API (D-155; 08 §1 `GET /api/ui/widget`; b11 §25.4; I-5, I-7; proposed, owner
// confirms at merge): the menu bar widget's one read, and the opaque mark behind the `activity`
// event of `GET /api/ui/events` (events.ts).
//
// `GET /api/ui/widget` (`presence: false`), behind the same session, CSRF, Host and fetch-metadata
// gate as every /api/ui/ route (approval-server.ts), no query:
//
//   { now, previews, unread: [{contactId, count, lastAt, preview?}],
//     today: {start, bucketSeconds: 3600, in[], out[], proofs[], files[], partial},
//     contacts: [{contactId, lastAt, activity}] }
//
// - `unread`: the open ID's unread `messages` notification items (the bell's store, read only),
//   summed by contact, newest first, at most WIDGET_MAX_UNREAD. `files` items are not counted here:
//   the widget shows them under Needs you only (WIDGET-UNREAD-MESSAGES-ONLY).
// - `preview`: only while the `widgetPreviews` UI setting is on (absent = on; unreadable or any
//   value but true = off, fail closed). The newest received message's text, made plain here
//   (widgetPreview). While off, no message is read at all. Never a file name, subject or size.
// - `today`: WIDGET_BUCKETS hourly buckets since the local midnight; in and out from the store's
//   exchange times (core `flowEvents`), proofs and files from the activity feed (at most
//   ACTIVITY_PAGES pages of 100, newest first, stopping at the midnight). `partial` is true when
//   core's 200-per-direction cap or the page cap left some of today out.
// - `contacts`: exchanged since the earlier of 24 hours ago and the local midnight (core
//   `pulseTimes`), `active_now` (within 5 minutes) or `today` as the pulse defines them; a contact
//   that is `quiet` is not listed. There is no presence in the protocol.
//
// Every item is rebuilt from an allowlist with an exact key set; one that does not pass is left out
// (fail closed). A store read that fails is 503 `unavailable`; one preview that cannot be read is
// left out alone. The read writes nothing and marks nothing read (I-4). Nothing here logs (I-7).
import type { JsonObject } from '@4thtech-io/crypto';
import { refusedCategory15 } from '@4thtech-io/types';
import { readNotificationItem } from '@4thtech-io/types/ui-contract/notifications';
import type { UiSettings } from '@4thtech-io/types/ui-contract/ui-settings';
import {
  WIDGET_BUCKETS,
  WIDGET_BUCKET_SECONDS,
  WIDGET_MAX_CONTACTS,
  WIDGET_MAX_UNREAD,
  WIDGET_PATH,
  WIDGET_PREVIEW_MAX,
} from '@4thtech-io/types/ui-contract/widget';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import { UI_NOT_SET_UP, type LocalUiReadRoute, type LocalUiResult } from '../route-types.js';
import type { LocalUiNotificationsDesk } from './notifications.js';

export {
  WIDGET_BUCKETS,
  WIDGET_BUCKET_SECONDS,
  WIDGET_MAX_CONTACTS,
  WIDGET_MAX_UNREAD,
  WIDGET_PATH,
  WIDGET_PREVIEW_MAX,
};

/** "Active now": an exchange within the last 5 minutes (b11 §24.3, the pulse's rule). */
const ACTIVE_NOW_SECONDS = 300;
/** Another agent's clock may put a message this far in the future and still count (as now). */
const MAX_SKEW_SECONDS = 300;
const DAY_SECONDS = 86_400;
/** The activity feed is read in at most this many pages of ACTIVITY_PAGE for `today`. */
const ACTIVITY_PAGES = 5;
const ACTIVITY_PAGE = 100;
/** The pulse read's answer is bounded by core (PULSE_SCAN_CAP per direction); this caps the loop. */
const MAX_TIMES = 20_000;
/** At most this many flow events are counted (core answers at most 200 per direction). */
const MAX_FLOW = 1_000;
/** The largest count of one unread item (the store's own cap, NOTIFICATION_MAX_COUNT). */
const MAX_COUNT = 9_999;
/** A preview reads at most this many UTF-16 units of the text (a huge message stays cheap). */
const PREVIEW_SCAN_UNITS = 2_048;
/** The window of the mark's newest-exchange read. */
const MARK_EXCHANGE_SECONDS = 600;
const CONTACT = /^0x[0-9a-f]{40}$/;
const ELLIPSIS = '…';

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });
/** 400: this route takes no query; the input is never echoed. */
const BAD_REQUEST = fixed(400, 'bad_request');
/** 503: the store could not be read just now; never the error's text. */
const UNAVAILABLE = fixed(503, 'unavailable');

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isContact = (v: unknown): v is string => typeof v === 'string' && CONTACT.test(v);

/** The local midnight (unix seconds) of the local day that holds `ms`. */
function localMidnight(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return Math.floor(day.getTime() / 1000);
}

const SPACE_SEPARATOR = /^\p{Zs}$/u;
let segmenter: Intl.Segmenter | undefined;

/**
 * Inbound text as a plain one-line preview (D-155 (5); I-5): control, format (bidi, zero-width),
 * private-use, surrogate, unassigned and separator characters removed (line and paragraph
 * separators and whitespace become one space), whitespace collapsed and trimmed, then cut on a
 * grapheme boundary to at most WIDGET_PREVIEW_MAX code points, "…" included. Only the first
 * PREVIEW_SCAN_UNITS UTF-16 units are read. The result is untrusted text: rendered as a text node.
 */
export function widgetPreview(text: string): string {
  if (typeof text !== 'string') return '';
  let plain = '';
  for (const ch of text.slice(0, PREVIEW_SCAN_UNITS)) {
    const cp = ch.codePointAt(0) as number;
    const category = refusedCategory15(cp);
    if (
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0b ||
      cp === 0x0c ||
      cp === 0x0d ||
      category === 'Zl' ||
      category === 'Zp' ||
      SPACE_SEPARATOR.test(ch)
    ) {
      plain += ' ';
    } else if (category === null) {
      plain += ch;
    }
  }
  plain = plain.replace(/ +/g, ' ').trim();
  if ([...plain].length <= WIDGET_PREVIEW_MAX) return plain;
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  let out = '';
  let used = 0;
  for (const { segment } of segmenter.segment(plain)) {
    const size = [...segment].length;
    if (used + size > WIDGET_PREVIEW_MAX - 1) break;
    out += segment;
    used += size;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

/**
 * Whether previews are on: the `widgetPreviews` UI setting (TRAY-TOGGLE), absent = on. A settings
 * store that cannot be read, or any value but a boolean, is off (fail closed).
 */
async function previewsOn(context: LocalUiContext): Promise<boolean> {
  const desk = context.uiSettings;
  if (desk === undefined) return true;
  let settings: unknown;
  try {
    settings = await desk.read();
  } catch {
    return false;
  }
  if (typeof settings !== 'object' || settings === null) return false;
  // TRAY-TOGGLE: the typed field (absent = on). Checked again at run time: anything but a boolean
  // is off.
  const value: unknown = (settings as UiSettings).widgetPreviews;
  return value === undefined || value === true;
}

interface UnreadTally {
  count: number;
  lastAt: number;
}

/** The unread messages items (never files), summed by contact, newest first, bounded. */
function unreadOf(items: readonly unknown[]): [string, UnreadTally][] {
  const tallies = new Map<string, UnreadTally>();
  for (const raw of items.slice(0, 1_000)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = readNotificationItem({ ...raw });
    if (item === undefined || item.read || item.ref === undefined) continue;
    if (item.kind !== 'messages') continue;
    const tally = tallies.get(item.ref);
    if (tally === undefined) {
      tallies.set(item.ref, { count: Math.min(item.count, MAX_COUNT), lastAt: item.at });
    } else {
      tally.count = Math.min(tally.count + item.count, MAX_COUNT);
      tally.lastAt = Math.max(tally.lastAt, item.at);
    }
  }
  return [...tallies]
    .sort(([a, x], [b, y]) => y.lastAt - x.lastAt || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, WIDGET_MAX_UNREAD);
}

/** The newest received message's text as a preview; undefined when none or unreadable. */
async function previewOf(
  client: LocalUiReadClient,
  contactId: string,
): Promise<string | undefined> {
  try {
    const page: unknown = await client.messages.list(contactId, 'in', { limit: 1 });
    const items = (page as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return undefined;
    const text = (items[0] as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string') return undefined;
    const preview = widgetPreview(text);
    return preview === '' ? undefined : preview;
  } catch {
    return undefined;
  }
}

/** The bucket of a time, or undefined outside today's window. */
function bucketOf(at: unknown, start: number, now: number): number | undefined {
  if (!isTime(at) || at < start || at > now + MAX_SKEW_SECONDS) return undefined;
  const index = Math.floor((Math.min(at, now) - start) / WIDGET_BUCKET_SECONDS);
  return Math.min(Math.max(index, 0), WIDGET_BUCKETS - 1);
}

const zeros = (): number[] => new Array<number>(WIDGET_BUCKETS).fill(0);
const add = (buckets: number[], index: number): void => {
  buckets[index] = (buckets[index] as number) + 1;
};

/** Today's buckets. Throws when a store read fails (the route answers unavailable). */
async function todayOf(client: LocalUiReadClient, start: number, now: number): Promise<JsonObject> {
  const inbound = zeros();
  const outbound = zeros();
  const proofs = zeros();
  const files = zeros();
  const flow: unknown = await client.messages.flowEvents(start, now + MAX_SKEW_SECONDS);
  const events = (flow as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) throw new Error('flow');
  // Core reads at most FLOW_SCAN_CAP (200) per direction: then some of today is not counted.
  let partial = (flow as { capped?: unknown }).capped === true || events.length > MAX_FLOW;
  for (const e of (events as unknown[]).slice(0, MAX_FLOW)) {
    if (typeof e !== 'object' || e === null) continue;
    const { contactId, direction, at } = e as Record<string, unknown>;
    if (!isContact(contactId)) continue;
    const index = bucketOf(at, start, now);
    if (index === undefined) continue;
    if (direction === 'in') add(inbound, index);
    else if (direction === 'out') add(outbound, index);
  }
  let cursor: string | undefined;
  for (let page = 0; page < ACTIVITY_PAGES; page++) {
    const read: unknown = await client.listActivity(
      cursor === undefined ? { limit: ACTIVITY_PAGE } : { limit: ACTIVITY_PAGE, cursor },
    );
    const items = (read as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) throw new Error('activity');
    let older = false;
    for (const entry of (items as unknown[]).slice(0, ACTIVITY_PAGE)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { kind, at } = entry as Record<string, unknown>;
      if (isTime(at) && at < start) older = true;
      const index = bucketOf(at, start, now);
      if (index === undefined) continue;
      if (kind === 'proof') add(proofs, index);
      else if (kind === 'file') add(files, index);
    }
    const next = (read as { nextCursor?: unknown }).nextCursor;
    if (older || typeof next !== 'string' || items.length === 0) break;
    // The last page allowed ended before the local midnight: the rest of today is not counted.
    if (page === ACTIVITY_PAGES - 1) partial = true;
    cursor = next;
  }
  return {
    start,
    bucketSeconds: WIDGET_BUCKET_SECONDS,
    in: inbound,
    out: outbound,
    proofs,
    files,
    partial,
  };
}

/** The contacts exchanged with recently. Throws when the store read fails. */
async function contactsOf(
  client: LocalUiReadClient,
  midnight: number,
  now: number,
): Promise<JsonObject[]> {
  const since = Math.max(0, Math.min(now - DAY_SECONDS + 1, midnight));
  const until = now + MAX_SKEW_SECONDS;
  const read: unknown = await client.messages.pulseTimes(since, until);
  const times = (read as { times?: unknown } | null)?.times;
  if (!Array.isArray(times)) throw new Error('pulse');
  const last = new Map<string, number>();
  for (const t of (times as unknown[]).slice(0, MAX_TIMES)) {
    if (typeof t !== 'object' || t === null) continue;
    const { contactId, at } = t as Record<string, unknown>;
    if (!isContact(contactId) || !isTime(at) || at < since || at > until) continue;
    const when = Math.min(at, now);
    if (when > (last.get(contactId) ?? -1)) last.set(contactId, when);
  }
  const out: JsonObject[] = [];
  for (const [contactId, lastAt] of [...last].sort(
    ([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const activity =
      now - lastAt <= ACTIVE_NOW_SECONDS ? 'active_now' : lastAt >= midnight ? 'today' : undefined;
    if (activity === undefined) continue;
    out.push({ contactId, lastAt, activity });
    if (out.length >= WIDGET_MAX_CONTACTS) break;
  }
  return out;
}

export const widgetRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: WIDGET_PATH,
  presence: false,
  handler: async (context, request) => {
    if ([...request.query.keys()].length > 0) return BAD_REQUEST;
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    const nowMs = context.now();
    const now = Math.floor(nowMs / 1000);
    if (!isTime(now)) return UNAVAILABLE;
    const midnight = localMidnight(nowMs);
    const previews = await previewsOn(context);
    let ranked: [string, UnreadTally][];
    let today: JsonObject;
    let contacts: JsonObject[];
    try {
      const items: unknown = (await context.notifications?.list()) ?? [];
      if (!Array.isArray(items)) return UNAVAILABLE;
      ranked = unreadOf(items as unknown[]);
      today = await todayOf(client, midnight, now);
      contacts = await contactsOf(client, midnight, now);
    } catch {
      return UNAVAILABLE;
    }
    const unread: JsonObject[] = [];
    for (const [contactId, { count, lastAt }] of ranked) {
      // While previews are off, no message is read at all (D-155 (5): enforced here).
      const preview = previews ? await previewOf(client, contactId) : undefined;
      unread.push(
        preview === undefined
          ? { contactId, count, lastAt }
          : { contactId, count, lastAt, preview },
      );
    }
    return { status: 200, body: { now, previews, unread, today, contacts } };
  },
});

/** What the activity mark remembers between reads (the newest exchange seen; memory only). */
export interface WidgetMarkMemo {
  newest?: string;
}

/**
 * The opaque mark behind the `activity` event (events.ts): the open ID's notification items, its
 * activity head and its newest exchange. Compared by the hub in memory, never sent or logged.
 * Undefined when any part cannot be read (the hub then keeps the last mark). Pass the same `memo`
 * on every read of one host.
 */
export async function widgetActivityMark(
  client: LocalUiReadClient,
  notifications: LocalUiNotificationsDesk | undefined,
  nowMs: number,
  memo: WidgetMarkMemo = {},
): Promise<string | undefined> {
  try {
    const now = Math.floor(nowMs / 1000);
    const parts: string[] = [];
    const items: unknown = (await notifications?.list()) ?? [];
    if (!Array.isArray(items)) return undefined;
    for (const raw of (items as unknown[]).slice(0, 1_000)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = readNotificationItem({ ...raw });
      if (item !== undefined) parts.push(`${item.id}:${item.count}:${item.at}:${item.read}`);
    }
    const head: unknown = await client.listActivity({ limit: 1 });
    const first = (head as { items?: unknown[] } | null)?.items?.[0] as
      Record<string, unknown> | undefined;
    parts.push(`|${String(first?.['kind'])}:${String(first?.['at'])}:${String(first?.['id'])}`);
    if (isTime(now)) {
      const read: unknown = await client.messages.pulseTimes(
        Math.max(0, now - MARK_EXCHANGE_SECONDS),
        now + MAX_SKEW_SECONDS,
      );
      const times = (read as { times?: unknown } | null)?.times;
      if (!Array.isArray(times)) return undefined;
      // Low 2 (IR): only the newest exchange's contact and time, never how many are in the window,
      // and an exchange that ages out of the window keeps the last one seen, so ageing out never
      // changes the mark.
      const newest = times[0] as Record<string, unknown> | undefined;
      if (newest !== undefined && isContact(newest['contactId']) && isTime(newest['at'])) {
        memo.newest = `${newest['contactId']}:${String(newest['at'])}`;
      }
      parts.push(`|${memo.newest ?? '-'}`);
    }
    return parts.join(',');
  } catch {
    return undefined;
  }
}
