// The widget's reads, checked before use (D-155; 08 §1 `GET /api/ui/widget`; I-5). Exact key sets;
// an item or field outside the shape is dropped, never guessed. The only inbound text is `preview`:
// cleaned once more here (control, format, bidi and separator characters out, whitespace collapsed,
// at most 80 code points) even though the server did it, and kept as a plain string for a React text
// node. Nothing here parses markup or links.
import {
  WIDGET_BUCKETS,
  WIDGET_BUCKET_SECONDS,
  WIDGET_KEYS,
  WIDGET_MAX_CONTACTS,
  WIDGET_MAX_UNREAD,
  WIDGET_PREVIEW_MAX,
} from '@4thtech-io/types/ui-contract/widget';

export { WIDGET_PATH } from '@4thtech-io/types/ui-contract/widget';

export interface UnreadRow {
  readonly contactId: string;
  readonly count: number;
  readonly lastAt: number;
  /** Untrusted plain text; render as a text node only. */
  readonly preview?: string;
}
export interface TodayView {
  readonly start: number;
  readonly in: readonly number[];
  readonly out: readonly number[];
  readonly proofs: readonly number[];
  readonly files: readonly number[];
}
export interface ContactRowView {
  readonly contactId: string;
  readonly lastAt: number;
  readonly activity: 'active_now' | 'today';
}
export interface WidgetView {
  readonly now: number;
  readonly previews: boolean;
  readonly unread: readonly UnreadRow[];
  readonly today: TodayView;
  readonly contacts: readonly ContactRowView[];
}

const REF = /^0x[0-9a-f]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
/** Only allowed keys, and at least `required` of them. */
const keysOk = (
  o: Record<string, unknown>,
  allowed: readonly string[],
  required: number,
): boolean => {
  const keys = Object.keys(o);
  return keys.length >= required && keys.every((k) => allowed.includes(k));
};

/** Control, format, bidi, zero-width and line/paragraph separator characters. */
const UNSAFE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

/** A preview as one clean line of at most 80 code points, or undefined when nothing is left. */
export function cleanPreview(text: string): string | undefined {
  const line = text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  if (line === '') return undefined;
  const points = [...line];
  if (points.length <= WIDGET_PREVIEW_MAX) return line;
  return `${points
    .slice(0, WIDGET_PREVIEW_MAX - 1)
    .join('')
    .trimEnd()}…`;
}

function buckets(v: unknown): number[] | undefined {
  if (!Array.isArray(v) || v.length !== WIDGET_BUCKETS) return undefined;
  return v.every((n) => isCount(n)) ? (v as number[]) : undefined;
}

/** The answer, or undefined when it is not a well-formed one. */
export function parseWidget(data: unknown): WidgetView | undefined {
  if (!isRecord(data) || !keysOk(data, WIDGET_KEYS.answer, WIDGET_KEYS.answer.length)) {
    return undefined;
  }
  const { now, previews, unread, today, contacts } = data;
  if (!isCount(now) || typeof previews !== 'boolean') return undefined;
  if (!Array.isArray(unread) || !Array.isArray(contacts) || !isRecord(today)) return undefined;
  if (!keysOk(today, WIDGET_KEYS.today, WIDGET_KEYS.today.length)) return undefined;
  const inB = buckets(today['in']);
  const outB = buckets(today['out']);
  const proofs = buckets(today['proofs']);
  const files = buckets(today['files']);
  const start = today['start'];
  if (
    !isCount(start) ||
    today['bucketSeconds'] !== WIDGET_BUCKET_SECONDS ||
    inB === undefined ||
    outB === undefined ||
    proofs === undefined ||
    files === undefined
  ) {
    return undefined;
  }
  const rows: UnreadRow[] = [];
  for (const raw of unread.slice(0, WIDGET_MAX_UNREAD) as unknown[]) {
    if (!isRecord(raw) || !keysOk(raw, WIDGET_KEYS.unread, 3)) continue;
    const { contactId, count, lastAt, preview } = raw;
    if (typeof contactId !== 'string' || !REF.test(contactId)) continue;
    if (!isCount(count, 9_999) || count === 0 || !isCount(lastAt)) continue;
    // Previews off: whatever arrives is dropped (the server omits it; the page never shows it).
    const clean = previews && typeof preview === 'string' ? cleanPreview(preview) : undefined;
    rows.push({ contactId, count, lastAt, ...(clean === undefined ? {} : { preview: clean }) });
  }
  const people: ContactRowView[] = [];
  for (const raw of contacts.slice(0, WIDGET_MAX_CONTACTS) as unknown[]) {
    if (!isRecord(raw) || !keysOk(raw, WIDGET_KEYS.contact, WIDGET_KEYS.contact.length)) continue;
    const { contactId, lastAt, activity } = raw;
    if (typeof contactId !== 'string' || !REF.test(contactId) || !isCount(lastAt)) continue;
    if (activity !== 'active_now' && activity !== 'today') continue;
    people.push({ contactId, lastAt, activity });
  }
  return {
    now,
    previews,
    unread: rows,
    today: { start, in: inB, out: outB, proofs, files },
    contacts: people,
  };
}

/** Sum of an array. */
export const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
