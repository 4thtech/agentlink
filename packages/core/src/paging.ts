// Paging for the local UI reads (M1-11r-a): newest first by (time, ID), with an opaque cursor that
// names the last item of the previous page. IDs compare by code unit (store order for ASCII IDs).
// The cursor carries only that item's time and stable ID, both values the caller already received.
import { CoreError } from './errors.js';
import type { ColumnName, Row, TableName } from './store/schema.js';
import type { StoreTx, Where } from './store/store.js';

/** One page request: at most `limit` items (1 to 100, default 20) after `cursor`. */
export interface PageQuery {
  /** The `nextCursor` of the previous page; absent for the first page. */
  readonly cursor?: string | undefined;
  /** 1 to 100. Default 20. */
  readonly limit?: number | undefined;
}

/** One page, newest first. `nextCursor` is absent on the last page. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export const PAGE_DEFAULT_LIMIT = 20;
export const PAGE_MAX_LIMIT = 100;

/** The position after which a page starts: items strictly older than (at, id). */
export interface PagePosition {
  readonly at: number;
  readonly id: string;
}

const CURSOR = /^(0|[1-9][0-9]{0,15})~([\x21-\x7e]{1,200})$/;

const invalid = (): CoreError =>
  new CoreError('page_query_invalid', 'The page limit or cursor is not valid.');

export function pageLimit(query: PageQuery | undefined): number {
  const limit = query?.limit ?? PAGE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX_LIMIT) throw invalid();
  return limit;
}

export function parseCursor(cursor: string | undefined): PagePosition | undefined {
  if (cursor === undefined) return undefined;
  const m = typeof cursor === 'string' ? CURSOR.exec(cursor) : null;
  const at = m === null ? NaN : Number(m[1]);
  if (m === null || !Number.isSafeInteger(at)) throw invalid();
  return { at, id: m[2] as string };
}

export function encodeCursor(position: PagePosition): string {
  return `${String(position.at)}~${position.id}`;
}

/** Newest first: later time first, then the larger ID. */
export function newestFirst(a: PagePosition, b: PagePosition): number {
  if (a.at !== b.at) return b.at - a.at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True when `item` comes strictly after `cursor` in newest-first order. */
export function isAfter(item: PagePosition, cursor: PagePosition | undefined): boolean {
  return cursor === undefined || newestFirst(cursor, item) < 0;
}

/**
 * The page from candidates that include, for every source, its `limit + 1` newest items before the
 * cursor time and all its items at the cursor time: sorted, the cursor applied, cut at `limit`.
 */
export function pageOf<T extends PagePosition>(
  candidates: readonly T[],
  cursor: PagePosition | undefined,
  limit: number,
): { readonly items: T[]; readonly nextCursor?: string } {
  const sorted = candidates.filter((c) => isAfter(c, cursor)).sort(newestFirst);
  const items = sorted.slice(0, limit);
  const last = items[items.length - 1];
  return sorted.length > limit && last !== undefined
    ? { items, nextCursor: encodeCursor(last) }
    : { items };
}

/**
 * Inside a transaction: the candidate rows of one table for a page (see pageOf), every row whose
 * `time` is not null and could be on it. `where` narrows the table (its `time` condition, if any,
 * is replaced). It takes the `limit + 1` newest rows before the cursor time, every other row at the
 * time of the last of them, and every row at the cursor time, so the page does not depend on how
 * the store orders rows of equal time: pageOf orders them by the item's own ID. `key` (the primary
 * key column) only removes duplicates.
 */
export function candidatesTx<T extends TableName>(
  tx: StoreTx,
  table: T,
  where: Where<T>,
  time: ColumnName<T>,
  key: ColumnName<T>,
  cursor: PagePosition | undefined,
  limit: number,
): Row<T>[] {
  const at = (condition: unknown): Where<T> => ({ ...where, [time]: condition }) as Where<T>;
  const rows = tx.select(table, at(cursor === undefined ? { gte: 0 } : { lt: cursor.at }), {
    orderBy: [[time, 'desc']],
    limit: limit + 1,
  });
  const extra: Row<T>[] = [];
  const last = rows[rows.length - 1];
  if (rows.length === limit + 1 && last !== undefined) {
    extra.push(...tx.select(table, at(last[time as keyof Row<T>])));
  }
  if (cursor !== undefined) extra.push(...tx.select(table, at(cursor.at)));
  const seen = new Set(rows.map((r) => r[key as keyof Row<T>]));
  for (const r of extra) {
    const k = r[key as keyof Row<T>];
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(r);
  }
  return rows;
}
