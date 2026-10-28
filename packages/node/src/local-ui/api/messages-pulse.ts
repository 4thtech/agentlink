// UX2-f1: the per-contact activity pulse read (b11 §24; UX-WAVE-2 item 4, decision 4.1; 08 §1;
// I-1, I-5).
//
// `GET /api/ui/messages/pulse` (`presence: false`), behind the same session, CSRF, Host and
// fetch-metadata gate as every /api/ui/ route (approval-server.ts). One aggregated read through
// core's `MessagesView.pulseTimes` (one store transaction, bounded, no per-conversation read):
//
//   { now, bucketSeconds: 7200, partial, contacts: [{ contactId, counts, lastAt, activity }] }
//
// - `now`: the server's clock, unix seconds, so the page can turn Active now into Today on time.
// - `counts`: twelve two-hour buckets over the last 24 hours, oldest first, the current two hours
//   last; messages in and out together. A bucket holds an exchange `age` seconds old (now - time)
//   when `floor(age / 7200)` is 11 minus its index; an exchange 24 hours old or more is in none.
// - `lastAt`: the newest exchange in the window (unix seconds). Exchanges up to 5 minutes in the
//   future (another agent's clock) count as now; later ones are never counted.
// - `activity`: `active_now` when `now - lastAt <= 300`, else `today` when `lastAt` is on or after
//   the local midnight, else `quiet` (b11 §24.3). The page shows the words.
// - Only contacts with an exchange since the earlier of 24 hours ago and the local midnight are
//   listed; a contact not listed is Quiet with a flat pulse. Unknown senders and removed contacts
//   are never listed (core's selection).
// - Bounded: at most MAX_PULSE_CONTACTS contacts, the most recent first (then by contact ID).
//   `partial` is true when core's scan cap or this cap left anything out.
//
// What leaves (zero access, I-5): counts and times only, from columns the store keeps in clear (07
// §3). Each item is built from an allowlist with an exact key set; never message text, a subject,
// a file name or size, a name or anything else inbound. An item that is not a contact ID and a
// whole time is left out (fail closed). Errors are fixed codes (`bad_request`, `unavailable` and
// the shared `not_set_up`), never an input echo or an error's text. Nothing here logs.
import { PULSE_SCAN_CAP } from '@4thtech-io/core';
import type { JsonObject } from '@4thtech-io/crypto';
import { UI_NOT_SET_UP, type LocalUiReadRoute, type LocalUiResult } from '../route-types.js';

export const PULSE_PATH = '/api/ui/messages/pulse';
/** At most this many contacts per answer (about 120 KB of JSON). */
export const MAX_PULSE_CONTACTS = 1_000;
const BUCKETS = 12;
const BUCKET_SECONDS = 7_200;
const DAY_SECONDS = BUCKETS * BUCKET_SECONDS;
/** "Active now": an exchange within the last 5 minutes (b11 §24.3). */
const ACTIVE_NOW_SECONDS = 300;
/** How far in the future another agent's clock may put a message and still count (as now). */
const MAX_SKEW_SECONDS = 300;
/** Core answers at most PULSE_SCAN_CAP per direction; anything beyond is not read. */
const MAX_TIMES = 2 * PULSE_SCAN_CAP;
/** A contact's ID: its agent's EVM address, lowercase (04 §2.9). */
const CONTACT = /^0x[0-9a-f]{40}$/;

type Activity = 'active_now' | 'today' | 'quiet';

const fixed = (status: number, error: string): LocalUiResult =>
  Object.freeze({ status, body: Object.freeze({ error }) });

/** 400: this route takes no query; the input is never echoed. */
const BAD_REQUEST = fixed(400, 'bad_request');
/** 503: the store could not be read just now; never the error's text. */
const UNAVAILABLE = fixed(503, 'unavailable');

const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The local midnight (unix seconds) of the local day that holds `ms`. */
function localMidnight(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return Math.floor(day.getTime() / 1000);
}

interface Tally {
  readonly counts: number[];
  lastAt: number;
}

export const pulseRoute: LocalUiReadRoute = Object.freeze<LocalUiReadRoute>({
  method: 'GET',
  path: PULSE_PATH,
  presence: false,
  handler: async (context, request) => {
    if ([...request.query.keys()].length > 0) return BAD_REQUEST;
    const client = context.client;
    if (client === undefined) return UI_NOT_SET_UP;
    const nowMs = context.now();
    const now = Math.floor(nowMs / 1000);
    if (!isTime(now)) return UNAVAILABLE;
    const midnight = localMidnight(nowMs);
    const since = Math.max(0, Math.min(now - DAY_SECONDS + 1, midnight));
    const until = now + MAX_SKEW_SECONDS;
    let read: unknown;
    try {
      read = await client.messages.pulseTimes(since, until);
    } catch {
      return UNAVAILABLE;
    }
    if (typeof read !== 'object' || read === null) return UNAVAILABLE;
    const { times, capped } = read as { times?: unknown; capped?: unknown };
    if (!Array.isArray(times) || typeof capped !== 'boolean') return UNAVAILABLE;
    let partial = capped || times.length > MAX_TIMES;

    const tallies = new Map<string, Tally>();
    for (const t of (times as unknown[]).slice(0, MAX_TIMES)) {
      if (typeof t !== 'object' || t === null) continue;
      const { contactId, at } = t as { contactId?: unknown; at?: unknown };
      if (typeof contactId !== 'string' || !CONTACT.test(contactId)) continue;
      if (!isTime(at) || at < since || at > until) continue;
      const when = Math.min(at, now);
      let tally = tallies.get(contactId);
      if (tally === undefined) {
        tally = { counts: new Array<number>(BUCKETS).fill(0), lastAt: when };
        tallies.set(contactId, tally);
      } else if (when > tally.lastAt) {
        tally.lastAt = when;
      }
      const age = now - when;
      if (age < DAY_SECONDS) {
        const index = BUCKETS - 1 - Math.floor(age / BUCKET_SECONDS);
        tally.counts[index] = (tally.counts[index] as number) + 1;
      }
    }

    const ranked = [...tallies].sort(
      ([a, x], [b, y]) => y.lastAt - x.lastAt || (a < b ? -1 : a > b ? 1 : 0),
    );
    if (ranked.length > MAX_PULSE_CONTACTS) partial = true;
    const contacts: JsonObject[] = ranked
      .slice(0, MAX_PULSE_CONTACTS)
      .map(([contactId, { counts, lastAt }]) => {
        const activity: Activity =
          now - lastAt <= ACTIVE_NOW_SECONDS
            ? 'active_now'
            : lastAt >= midnight
              ? 'today'
              : 'quiet';
        return { contactId, counts, lastAt, activity };
      });
    return { status: 200, body: { now, bucketSeconds: BUCKET_SECONDS, contacts, partial } };
  },
});
