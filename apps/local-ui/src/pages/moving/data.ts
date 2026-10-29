// U3-map-2: which rows have a stream right now (b11 §32.1, §32.3). The same flow read and the same
// rules as the Agents map (one source: `agents/map/data.ts`), reduced to a mark per contact. Words and
// directions only: nothing here carries a message, a subject, a file name or a link (I-5).
import {
  MAX_ANIMATED,
  STREAM_SECONDS,
  type ContactFlow,
  type FlowItem,
} from '../agents/map/data.js';

export interface Moving {
  readonly direction: 'in' | 'out';
  readonly kind: 'message' | 'file';
  readonly at: number;
  /** The dash travels (at most 2 rows at once; the rest keep the mark without a dash). */
  readonly animate: boolean;
}

export type MovingMap = ReadonlyMap<string, Moving>;
export type Kind = 'message' | 'file';
export const NONE: MovingMap = new Map();

/** A running stream: in the last minute, and not a send that failed (b11 §32.3). */
function recent(item: FlowItem | undefined, nowSec: number): FlowItem | undefined {
  return item !== undefined && item.state !== 'not_delivered' && item.at >= nowSec - STREAM_SECONDS
    ? item
    : undefined;
}

/**
 * Per contact, the newest direction that moved in the last minute. `kinds` narrows what counts (the
 * Files page only marks a file that moves). A failed flow read passes `live: false`: nothing moves.
 */
export function movingRows(
  flow: ReadonlyMap<string, ContactFlow>,
  nowSec: number,
  kinds: readonly Kind[] = ['message', 'file'],
  live = true,
): MovingMap {
  if (!live) return NONE;
  const found: { id: string; item: FlowItem }[] = [];
  for (const [id, cf] of flow) {
    const o = recent(cf.out, nowSec);
    const i = recent(cf.in, nowSec);
    const o2 = o !== undefined && kinds.includes(o.kind) ? o : undefined;
    const i2 = i !== undefined && kinds.includes(i.kind) ? i : undefined;
    const item = o2 !== undefined && (i2 === undefined || o2.at >= i2.at) ? o2 : i2;
    if (item !== undefined) found.push({ id, item });
  }
  found.sort((a, b) => b.item.at - a.item.at || a.id.localeCompare(b.id));
  const out = new Map<string, Moving>();
  found.forEach(({ id, item }, n) => {
    out.set(id, {
      direction: item.direction,
      kind: item.kind,
      at: item.at,
      animate: n < MAX_ANIMATED,
    });
  });
  return out;
}

/**
 * Files rows carry a name, not a contact ID (the server shows `from` and `to` as display names). A
 * row is matched to a contact only by an owner-confirmed name that exactly one active contact holds;
 * the other side's own name, an ambiguous name or no match gives no mark. Never a guess.
 */
export function namesToIds(
  contacts: readonly { ref: string; name: string; nameSource: string; status: string }[],
): ReadonlyMap<string, string> {
  const seen = new Map<string, string | undefined>();
  for (const c of contacts) {
    if (c.status !== 'active' || c.nameSource !== 'owner' || c.name === '') continue;
    seen.set(c.name, seen.has(c.name) ? undefined : c.ref);
  }
  const out = new Map<string, string>();
  for (const [name, ref] of seen) if (ref !== undefined) out.set(name, ref);
  return out;
}

export interface FileRowRef {
  readonly id: string;
  /** The row's contact name as shown (`from` on Received, `to` on Sent). */
  readonly who: string;
  readonly at: number;
}

/**
 * The file rows that carry a mark: for each moving contact, only the newest row on that side
 * (Received matches an incoming file, Sent an outgoing one). Item IDs to the mark.
 */
export function fileMarks(
  side: 'in' | 'out',
  rows: readonly FileRowRef[],
  ids: ReadonlyMap<string, string>,
  moving: MovingMap,
): ReadonlyMap<string, Moving> {
  const newest = new Map<string, FileRowRef>();
  for (const row of rows) {
    const contact = ids.get(row.who);
    if (contact === undefined) continue;
    const m = moving.get(contact);
    if (m === undefined || m.direction !== side || m.kind !== 'file') continue;
    const held = newest.get(contact);
    if (held === undefined || row.at > held.at) newest.set(contact, row);
  }
  const out = new Map<string, Moving>();
  for (const [contact, row] of newest) {
    const m = moving.get(contact);
    if (m !== undefined) out.set(row.id, m);
  }
  return out;
}
