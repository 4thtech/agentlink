// The compact view's pulse read, checked before use (UX2-h; b11 §24, §25; I-5). The route
// (`GET /api/ui/messages/pulse`, UX2-f1) sends counts and times only; this keeps from each item
// only a contact ID, twelve counts, a time and one of three fixed words. Anything else is dropped,
// so nothing inbound can reach the page. UX2-f2 (Messages and Contacts) may later share
// `parsePulse`, `barHeights` and `rankByActivity` from here; they are kept free of React for that.
import type { ContactRow } from '../contacts/data.js';

export const PULSE_PATH = '/api/ui/messages/pulse';
/** The contacts shown before "+n more". */
export const TOP_N = 5;
const BUCKETS = 12;
const MAX_ROWS = 1_000;
const REF = /^0x[0-9a-f]{40}$/;

export type Activity = 'active_now' | 'today' | 'quiet';
const ACTIVITIES: ReadonlySet<string> = new Set(['active_now', 'today', 'quiet']);

export interface PulseRow {
  readonly ref: string;
  /** Twelve two-hour buckets, oldest first. */
  readonly counts: readonly number[];
  /** Unix seconds. */
  readonly lastAt: number;
  readonly activity: Activity;
}

export interface PulseAnswer {
  /** The server's clock, unix seconds. */
  readonly now: number;
  readonly rows: readonly PulseRow[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The checked pulse answer, or undefined when it is not a well-formed answer. */
export function parsePulse(data: unknown): PulseAnswer | undefined {
  if (!isRecord(data) || !isCount(data['now']) || !Array.isArray(data['contacts']))
    return undefined;
  const rows: PulseRow[] = [];
  for (const raw of data['contacts'] as unknown[]) {
    if (rows.length >= MAX_ROWS) break;
    if (!isRecord(raw)) continue;
    const { contactId, counts, lastAt, activity } = raw;
    if (typeof contactId !== 'string' || !REF.test(contactId)) continue;
    if (!Array.isArray(counts) || counts.length !== BUCKETS || !counts.every(isCount)) continue;
    if (!isCount(lastAt)) continue;
    if (typeof activity !== 'string' || !ACTIVITIES.has(activity)) continue;
    rows.push({
      ref: contactId,
      counts: [...(counts as number[])],
      lastAt,
      activity: activity as Activity,
    });
  }
  return { now: data['now'], rows };
}

export const pulseTotal = (counts: readonly number[]): number => counts.reduce((a, b) => a + b, 0);

/**
 * Bar heights in px for the 47 x 16 pulse (b11 §24.2): the larger of the row's busiest bar and 4
 * is full height; a bar with a count is at least 2 px; an empty bucket is a 1 px baseline tick.
 */
export function barHeights(counts: readonly number[]): number[] {
  const scale = Math.max(4, ...counts);
  return counts.map((c) => (c === 0 ? 1 : Math.min(16, Math.max(2, Math.round((c / scale) * 16)))));
}

export interface RankedContact {
  readonly contact: ContactRow;
  readonly pulse?: PulseRow;
}

/**
 * Most active order (b11 §24.5): the 24-hour count, then the newest exchange, then the name so the
 * order is stable. Only contacts that are active; a contact with no pulse row is Quiet.
 */
export function rankByActivity(
  contacts: readonly ContactRow[],
  rows: readonly PulseRow[],
): RankedContact[] {
  const byRef = new Map(rows.map((r) => [r.ref, r] as const));
  return contacts
    .filter((c) => c.status === 'active')
    .map((contact): RankedContact => {
      const pulse = byRef.get(contact.ref);
      return pulse === undefined ? { contact } : { contact, pulse };
    })
    .sort((a, b) => {
      const ta = a.pulse === undefined ? 0 : pulseTotal(a.pulse.counts);
      const tb = b.pulse === undefined ? 0 : pulseTotal(b.pulse.counts);
      if (ta !== tb) return tb - ta;
      const la = a.pulse?.lastAt ?? 0;
      const lb = b.pulse?.lastAt ?? 0;
      if (la !== lb) return lb - la;
      return a.contact.name.localeCompare(b.contact.name);
    });
}
