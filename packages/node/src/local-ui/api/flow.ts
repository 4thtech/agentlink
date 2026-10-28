// U3-flow: the live connections map's read (USABILITY-WAVE-3 §4.1; 08 §1; 07 §3; I-1, I-2, I-5,
// I-7). It replaces U3-c's reserved stub at the same path.
//
// `GET /api/ui/flow?since=<cursor>` (`presence: false`), behind the same session, CSRF, Host and
// fetch-metadata gate as every /api/ui/ route (approval-server.ts); in the app host every answer
// carries the generation, and a read waits for a switch in progress (U3-c). For the open agent only:
// other agents' lines come from their pulse (b11 §32). Polled by the page every 3 s while visible.
// One aggregated read through core's `MessagesView.flowEvents` (one store transaction, bounded):
//
//   { now, cursor, items: [{ contactId, direction, kind, state, at }], partial }
//
// - `since`: whole unix seconds, inclusive (the boundary second may come again; the page keeps the
//   newest per line). Without it, the last minute (FLOW_DEFAULT_WINDOW_SECONDS); never older than 24
//   hours, never after now. Any other query parameter, a repeated `since` or one that is not 1 to 12
//   digits is 400 `bad_request`, never echoed.
// - `cursor`: what to send as `since` next: always a minute ago (IR-U3-flow-1). Never the newest
//   item's time: a message stored late with an older time (a slow sender's clock) would then be
//   skipped. Each poll sees the last minute again; the page keeps the newest per line, and the
//   bounds below still hold. It is only a time: it names no agent, contact or row, so a cursor
//   the page kept across an agent switch (a stale generation) only asks the new agent from that
//   second on.
// - `items`: newest first (then by contact, direction, kind, state); `direction` `in` or `out`;
//   `kind` `message` or `file`; `state` `received` for an inbound one, else the delivery state
//   (`queued`, `sent`, `not_delivered`); `at` the envelope's time. An item stamped up to 5 minutes
//   after now (another agent's clock) counts as now, like the pulse; a later one is left out.
// - No progress: the store keeps no upload or download byte counts (07 §3; UX2-c found none), so
//   no `bytesDone`/`bytesTotal` is sent and the page shows an indeterminate fill. None is invented.
// - Bounded: at most FLOW_MAX_ITEMS items and FLOW_MAX_BYTES of JSON (a full item is about 127
//   bytes, so the size bound binds near 155 items); `partial` is true when core's scan cap or
//   either bound left anything out. Core reads at most FLOW_SCAN_CAP rows per direction.
//
// What leaves (zero access, I-5): metadata only, from columns the store keeps in clear (07 §3).
// Each item is built from an allowlist with an exact key set; never message text, a subject, a
// contact or file name, a size, a link (a drop upload or download URL), a key, a hash or an envelope
// ID. An item that does not fit is left out (fail closed). Errors are fixed codes (`bad_request`,
// `unavailable` and the shared `not_set_up`), never an input echo or an error's text. Nothing here
// logs (I-7: logs carry counts only, and this route needs none).
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiRoute } from '../route-types.js';
import { UI_NOT_SET_UP, type LocalUiReadRoute, type LocalUiResult } from '../route-types.js';

export const FLOW_PATH = '/api/ui/flow';
/** At most this many items per answer (USABILITY-WAVE-3 §4.1). */
export const FLOW_MAX_ITEMS = 200;
/** The answer stays at or under this many bytes of JSON (under 20 KB, §4.1 budget). */
export const FLOW_MAX_BYTES = 20_000;
/** Without `since`: the last minute (a stream runs for exchanges in the last minute, §4.1). */
export const FLOW_DEFAULT_WINDOW_SECONDS = 60;
/** `since` is never older than 24 hours (the map draws lines for the last 24 hours). */
export const FLOW_MAX_WINDOW_SECONDS = 86_400;
/** A contact's ID: its agent's EVM address, lowercase (04 §2.9). */
const CONTACT = /^0x[0-9a-f]{40}$/;
const SINCE = /^[0-9]{1,12}$/;
/** How far in the future another agent's clock may put an item and still count (as now). */
const MAX_SKEW_SECONDS = 300;
const IN_STATES: readonly string[] = Object.freeze(['received']);
const OUT_STATES: readonly string[] = Object.freeze(['queued', 'sent', 'not_delivered']);
const KINDS: readonly string[] = Object.freeze(['message', 'file']);

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

/** 400: the query is not `since` alone (or nothing); the input is never echoed. */
const BAD_REQUEST = fixed(400, 'bad_request');
/** 503: the store could not be read just now; never the error's text. */
const UNAVAILABLE = fixed(503, 'unavailable');

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

interface FlowItem {
  readonly contactId: string;
  readonly direction: 'in' | 'out';
  readonly kind: string;
  readonly state: string;
  readonly at: number;
}

/** The allowlisted copy of one core event, or undefined when it does not fit (fail closed). */
function itemOf(e: unknown, since: number, now: number): FlowItem | undefined {
  const until = now + MAX_SKEW_SECONDS;
  if (typeof e !== 'object' || e === null) return undefined;
  const { contactId, direction, kind, state, at } = e as Record<string, unknown>;
  if (typeof contactId !== 'string' || !CONTACT.test(contactId)) return undefined;
  if (direction !== 'in' && direction !== 'out') return undefined;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return undefined;
  const states = direction === 'in' ? IN_STATES : OUT_STATES;
  if (typeof state !== 'string' || !states.includes(state)) return undefined;
  if (!isTime(at) || at < since || at > until) return undefined;
  return { contactId, direction, kind, state, at: Math.min(at, now) };
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const flowRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: FLOW_PATH,
  presence: false,
  handler: async (context, request) => {
    const names = [...request.query.keys()];
    if (names.some((n) => n !== 'since') || names.length > 1) return BAD_REQUEST;
    const raw = names.length === 1 ? request.query.get('since') : null;
    if (raw !== null && !SINCE.test(raw)) return BAD_REQUEST;
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    const now = Math.floor(context.now() / 1000);
    if (!isTime(now)) return UNAVAILABLE;
    const asked = raw === null ? now - FLOW_DEFAULT_WINDOW_SECONDS : Number(raw);
    const since = Math.max(0, now - FLOW_MAX_WINDOW_SECONDS, Math.min(asked, now));
    let read: unknown;
    try {
      read = await client.messages.flowEvents(since, now + MAX_SKEW_SECONDS);
    } catch {
      return UNAVAILABLE;
    }
    if (typeof read !== 'object' || read === null) return UNAVAILABLE;
    const { events, capped } = read as { events?: unknown; capped?: unknown };
    if (!Array.isArray(events) || typeof capped !== 'boolean') return UNAVAILABLE;
    let partial = capped;

    const items: FlowItem[] = [];
    for (const e of events as unknown[]) {
      const item = itemOf(e, since, now);
      if (item !== undefined) items.push(item);
    }
    items.sort(
      (x, y) =>
        y.at - x.at ||
        order(x.contactId, y.contactId) ||
        order(x.direction, y.direction) ||
        order(x.kind, y.kind) ||
        order(x.state, y.state),
    );
    if (items.length > FLOW_MAX_ITEMS) {
      items.length = FLOW_MAX_ITEMS;
      partial = true;
    }
    // The size bound: drop the oldest until the whole answer fits (ASCII only: length is bytes).
    const cursor = String(Math.max(now - FLOW_DEFAULT_WINDOW_SECONDS, 0));
    const bodyOf = (): JsonObject => ({
      now,
      cursor,
      items: items.map((i) => ({ ...i })),
      partial,
    });
    let body = bodyOf();
    while (JSON.stringify(body).length > FLOW_MAX_BYTES && items.length > 0) {
      items.pop();
      partial = true;
      body = bodyOf();
    }
    return { status: 200, body };
  },
});

/** U3-flow: the one route of this file (registered by routes.ts, replacing U3-c's stub). */
export const flowRoutes: readonly LocalUiRoute[] = Object.freeze([flowRoute]);
