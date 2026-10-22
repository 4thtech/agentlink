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
 * The page from candidates that include, for every source, its `limit + 1` first items after the
 * cursor (candidatesTx): sorted, the cursor applied, cut at `limit`.
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
 * Inside a transaction: the first `limit + 1` rows of one table after the cursor, in newest-first
 * order on the composite (`time`, `key`), so a page never reads more than `limit + 1` rows of a
 * table (IR-M1-11r-a-1 L-2), however many share one time.
 *
 * Each item's ID is `prefix + <key value>`, and the store orders `key` by code unit as pageOf orders
 * IDs, so the cursor's ID maps to a position in this table: with the prefix, the key below which
 * rows at the cursor time follow; otherwise all or none of them (no source prefix is a prefix of
 * another, so the prefix alone decides). `where` narrows the table; its `time` and `key`
 * conditions, if any, are replaced. Rows whose `time` is null are never read.
 */
export function candidatesTx<T extends TableName>(
  tx: StoreTx,
  table: T,
  where: Where<T>,
  time: ColumnName<T>,
  key: ColumnName<T>,
  prefix: string,
  cursor: PagePosition | undefined,
  limit: number,
): Row<T>[] {
  const want = limit + 1;
  const orderBy: readonly (readonly [ColumnName<T>, 'asc' | 'desc'])[] = [
    [time, 'desc'],
    [key, 'desc'],
  ];
  const cond = (t: unknown, k?: unknown): Where<T> =>
    ({ ...where, [time]: t, ...(k === undefined ? {} : { [key]: k }) }) as Where<T>;
  if (cursor === undefined) return tx.select(table, cond({ gte: 0 }), { orderBy, limit: want });
  // Rows at the cursor time that follow it.
  let ties: Row<T>[] = [];
  if (cursor.id.startsWith(prefix)) {
    const below = cursor.id.slice(prefix.length);
    ties = tx.select(table, cond(cursor.at, { lt: below }), { orderBy, limit: want });
  } else if (prefix < cursor.id) {
    ties = tx.select(table, cond(cursor.at), { orderBy, limit: want });
  }
  if (ties.length >= want) return ties;
  const older = tx.select(table, cond({ lt: cursor.at }), {
    orderBy,
    limit: want - ties.length,
  });
  return [...ties, ...older];
}
