// WP-R4: the page's strict read of `GET /api/ui/backup` (WP-R2, frozen): `{export, record, state,
// lastKit, missing}`. Names are text only (rendered inside <bdi>); anything unexpected reads as
// "unknown", never as an invented state. The answer never carries a path or a kit ID.
export type KitState = 'backed_up' | 'out_of_date' | 'none' | 'unknown';

export interface KitStatus {
  readonly export: 'available' | 'not_available' | 'unknown';
  readonly state: KitState;
  /** Milliseconds. */
  readonly at?: number;
  readonly covers: readonly string[];
  readonly peopleAtSave?: number;
  readonly missingIds: readonly string[];
  readonly missingPeople: number;
}

const UNKNOWN: KitStatus = {
  export: 'unknown',
  state: 'unknown',
  covers: [],
  missingIds: [],
  missingPeople: 0,
};
export const UNKNOWN_STATUS: KitStatus = UNKNOWN;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u;

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    // WP-R2 sends {name, label}: the label is what people see (the folder name only as a fallback).
    const label = isObject(item) ? item['label'] : undefined;
    const n =
      typeof label === 'string' && NAME.test(label) ? label : isObject(item) ? item['name'] : item;
    if (typeof n === 'string' && NAME.test(n) && out.length < 12) out.push(n);
  }
  return out;
}

function millis(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0)
    return raw < 1e11 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Reads the answer; `undefined` data (a failed read) is the unknown status. */
export function parseKitStatus(data: unknown): KitStatus {
  if (!isObject(data)) return UNKNOWN;
  const exportWord =
    data['export'] === 'available'
      ? 'available'
      : data['export'] === 'not_available'
        ? 'not_available'
        : 'unknown';
  const record = data['record'];
  const state = data['state'];
  if (record !== 'saved' && record !== 'none') return { ...UNKNOWN, export: exportWord };
  if (state === 'none') return { ...UNKNOWN, export: exportWord, state: 'none' };
  if (state !== 'backed_up' && state !== 'out_of_date') return { ...UNKNOWN, export: exportWord };
  const kit = data['lastKit'];
  const at = isObject(kit) ? millis(kit['at']) : undefined;
  if (!isObject(kit) || at === undefined) return { ...UNKNOWN, export: exportWord };
  const missing = isObject(data['missing']) ? data['missing'] : {};
  const p = missing['people'];
  const saved = kit['peopleAtSave'];
  return {
    export: exportWord,
    state,
    at,
    covers: names(kit['covers']),
    ...(typeof saved === 'number' && Number.isSafeInteger(saved) && saved >= 0
      ? { peopleAtSave: saved }
      : {}),
    missingIds: names(missing['ids']),
    missingPeople: typeof p === 'number' && Number.isSafeInteger(p) && p >= 0 ? p : 0,
  };
}

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const dayOf = (ms: number): string => DAY.format(ms);
export const joinNames = (list: readonly string[]): string =>
  list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
