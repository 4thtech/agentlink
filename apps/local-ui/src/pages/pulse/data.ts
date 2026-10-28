// The pulse read (UX2-f1 route, b11 §24): `GET /api/ui/messages/pulse`. Counts and times only.
//
// I-5: every field is checked and copied into a fresh object (an allowlist), so a field the server
// should not send never reaches the page; an entry that fails the check is left out.
import { PULSE_STRINGS } from './strings.js';

export const PULSE_PATH = '/api/ui/messages/pulse';
export const BUCKETS = 12;
/** The bar area: 12 bars of 3 px with 1 px gaps is 47 px; the tallest bar is 16 px. */
export const SPARK_HEIGHT = 16;
const MIN_SCALE = 4;
const MAX_ENTRIES = 2_000;
const ID_RE = /^[A-Za-z0-9._:~-]{1,128}$/;

export type Activity = 'active_now' | 'today' | 'quiet';

export interface PulseContact {
  readonly contactId: string;
  /** Twelve two-hour buckets, oldest first; the current two hours last. */
  readonly counts: readonly number[];
  readonly lastAt: number;
  readonly activity: Activity;
}

export interface Pulse {
  readonly now: number;
  /** True when the server left contacts out: a contact not listed is then not known to be Quiet. */
  readonly partial: boolean;
  readonly contacts: ReadonlyMap<string, PulseContact>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isActivity = (v: unknown): v is Activity =>
  v === 'active_now' || v === 'today' || v === 'quiet';

function parseContact(raw: unknown): PulseContact | undefined {
  if (!isRecord(raw)) return undefined;
  const { contactId, counts, lastAt, activity } = raw;
  if (typeof contactId !== 'string' || !ID_RE.test(contactId)) return undefined;
  if (!Array.isArray(counts) || counts.length !== BUCKETS || !counts.every(isCount)) {
    return undefined;
  }
  if (!isCount(lastAt) || !isActivity(activity)) return undefined;
  return { contactId, counts: [...(counts as number[])], lastAt, activity };
}

export function parsePulse(data: unknown): Pulse | undefined {
  if (!isRecord(data) || !Array.isArray(data['contacts']) || !isCount(data['now'])) {
    return undefined;
  }
  const contacts = new Map<string, PulseContact>();
  for (const raw of (data['contacts'] as unknown[]).slice(0, MAX_ENTRIES)) {
    const c = parseContact(raw);
    if (c !== undefined) contacts.set(c.contactId, c);
  }
  return { now: data['now'], partial: data['partial'] === true, contacts };
}

/** Bar heights in px (b11 §24.2): per row, count over the larger of the busiest bucket and 4. */
export function barHeights(counts: readonly number[]): number[] {
  const scale = Math.max(MIN_SCALE, ...counts);
  return counts.map((n) =>
    n <= 0 ? 1 : Math.min(SPARK_HEIGHT, Math.max(2, Math.round((n / scale) * SPARK_HEIGHT))),
  );
}

export const totalOf = (counts: readonly number[]): number => counts.reduce((a, b) => a + b, 0);

export const pulseSummary = (counts: readonly number[]): string =>
  PULSE_STRINGS.summary(totalOf(counts));

export function activityRank(a: Activity): number {
  return a === 'active_now' ? 0 : a === 'today' ? 1 : 2;
}

/** "Most active": by activity, then the most recent exchange (a stable sort keeps equal rows in place). */
export function compareMostActive(
  a: { activity: Activity; lastAt: number },
  b: { activity: Activity; lastAt: number },
): number {
  return activityRank(a.activity) - activityRank(b.activity) || b.lastAt - a.lastAt;
}
