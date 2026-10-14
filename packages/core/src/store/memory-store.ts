// The in-memory Store (07 §3.1, §3.7): for tests and development, and the reference the SQLite (M1-8b)
// and Durable Object (M2-3a) stores are checked against. Nothing persists.
//
// Same contract as a real store: the schema is enforced here (keys, unique and partial unique
// constraints, enums, value types, row counts, no extra or missing columns), a transaction is
// serializable through a single lock and all-or-nothing across tables, its body must be synchronous,
// a refused statement changes nothing, and comparisons with null follow SQL (only an explicit null
// matches null). It holds only what the core gives it: `enc` columns arrive sealed.
import { isUsdAmount } from '@agentlink/types';
import { StoreConstraintError, StoreUsageError } from '../errors.js';
import { STORE_SCHEMA_VERSION } from '../constants.js';
import {
  TABLES,
  TABLE_NAMES,
  type ColumnSpec,
  type PrimaryKey,
  type Row,
  type StoreValue,
  type TableName,
  type TableSpec,
  type UniqueSpec,
} from './schema.js';
import type { Condition, SelectOptions, Store, StoreTx, Where } from './store.js';

type AnyRow = Readonly<Record<string, StoreValue>>;
type Data = Map<TableName, readonly AnyRow[]>;

const MAX_INT = Number.MAX_SAFE_INTEGER;

function spec(table: TableName): TableSpec {
  const s = (TABLES as Readonly<Record<string, TableSpec>>)[table];
  if (s === undefined) throw new StoreUsageError('store: unknown table');
  return s;
}

function checkValue(table: TableName, column: string, c: ColumnSpec, value: unknown): void {
  const fail = (): never => {
    throw new StoreConstraintError(
      table,
      `store: column ${column} of ${table} holds a value of the wrong type`,
    );
  };
  if (value === null) {
    if (!c.nullable) fail();
    return;
  }
  switch (c.kind) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_INT)
        fail();
      return;
    case 'flag':
      if (value !== 0 && value !== 1) fail();
      return;
    case 'id':
    case 'enc':
      if (typeof value !== 'string' || value.length === 0) fail();
      return;
    case 'text':
    case 'json':
      if (typeof value !== 'string') fail();
      return;
    case 'usd':
      if (typeof value !== 'string' || !isUsdAmount(value)) fail();
      return;
    case 'enum':
      if (typeof value !== 'string' || !(c.values ?? []).includes(value)) fail();
      return;
  }
}

/** Validates a complete row and returns a frozen copy with the columns in spec order. */
function checkRow(table: TableName, row: unknown): AnyRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new StoreConstraintError(table, `store: a row of ${table} must be an object`);
  }
  const s = spec(table);
  const source = row as Record<string, unknown>;
  const keys = Object.keys(source);
  const columns = Object.keys(s.columns);
  if (keys.length !== columns.length || keys.some((k) => !Object.hasOwn(s.columns, k))) {
    throw new StoreConstraintError(table, `store: a row of ${table} must have exactly its columns`);
  }
  const out: Record<string, StoreValue> = {};
  for (const column of columns) {
    if (!Object.hasOwn(source, column)) {
      throw new StoreConstraintError(
        table,
        `store: a row of ${table} must have exactly its columns`,
      );
    }
    const value = source[column];
    checkValue(table, column, s.columns[column] as ColumnSpec, value);
    out[column] = value as StoreValue;
  }
  return Object.freeze(out);
}

function uniqueKey(row: AnyRow, u: UniqueSpec): string | undefined {
  if (u.where !== undefined) {
    for (const [column, value] of Object.entries(u.where))
      if (row[column] !== value) return undefined;
  }
  const values = u.columns.map((c) => row[c]);
  // As in SQL, a null in a unique column never collides.
  if (values.some((v) => v === null || v === undefined)) return undefined;
  return JSON.stringify(values);
}

function checkTable(table: TableName, rows: readonly AnyRow[]): void {
  const s = spec(table);
  if (s.maxRows !== undefined && rows.length > s.maxRows) {
    throw new StoreConstraintError(table, `store: ${table} holds at most ${s.maxRows} row`);
  }
  const constraints: UniqueSpec[] = [{ columns: s.primaryKey }, ...(s.unique ?? [])];
  for (const u of constraints) {
    const seen = new Set<string>();
    for (const row of rows) {
      const key = uniqueKey(row, u);
      if (key === undefined) continue;
      if (seen.has(key)) {
        throw new StoreConstraintError(
          table,
          `store: a key or unique constraint of ${table} was violated`,
        );
      }
      seen.add(key);
    }
  }
}

function isOperator(c: unknown): c is Exclude<Condition<StoreValue>, StoreValue> {
  return typeof c === 'object' && c !== null;
}

function compare(a: StoreValue, b: StoreValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matchesCondition(value: StoreValue, condition: unknown): boolean {
  if (!isOperator(condition)) return value === condition;
  // SQL semantics: an operator never matches a null value.
  if (value === null) return false;
  const c = condition as Readonly<Record<string, unknown>>;
  for (const [op, operand] of Object.entries(c)) {
    if (op === 'in') {
      if (!Array.isArray(operand) || !operand.some((v) => v === value)) return false;
      continue;
    }
    if (operand === null || operand === undefined || typeof value !== typeof operand) return false;
    const d = compare(value, operand as StoreValue);
    switch (op) {
      case 'ne':
        if (d === 0) return false;
        break;
      case 'lt':
        if (!(d < 0)) return false;
        break;
      case 'lte':
        if (!(d <= 0)) return false;
        break;
      case 'gt':
        if (!(d > 0)) return false;
        break;
      case 'gte':
        if (!(d >= 0)) return false;
        break;
      default:
        throw new StoreUsageError('store: unknown condition operator');
    }
  }
  return true;
}

function matches(table: TableName, row: AnyRow, where: unknown): boolean {
  if (where === undefined) return true;
  if (typeof where !== 'object' || where === null) throw new StoreUsageError('store: bad where');
  const s = spec(table);
  for (const [column, condition] of Object.entries(where)) {
    if (!Object.hasOwn(s.columns, column))
      throw new StoreUsageError('store: unknown column in where');
    if (condition === undefined) continue;
    if (!matchesCondition(row[column] ?? null, condition)) return false;
  }
  return true;
}

class MemoryTx implements StoreTx {
  #open = true;
  readonly #data: Data;

  constructor(data: Data) {
    this.#data = data;
  }

  end(): void {
    this.#open = false;
  }

  #rows(table: TableName): readonly AnyRow[] {
    if (!this.#open) throw new StoreUsageError('store: the transaction has ended');
    spec(table);
    return this.#data.get(table) ?? [];
  }

  #set(table: TableName, rows: readonly AnyRow[]): void {
    checkTable(table, rows);
    this.#data.set(table, rows);
  }

  get<T extends TableName>(table: T, key: PrimaryKey<T>): Row<T> | undefined {
    const pk = spec(table).primaryKey;
    const where: Record<string, unknown> = {};
    for (const column of pk) {
      const value = (key as Readonly<Record<string, unknown>>)[column];
      if (value === undefined || value === null || isOperator(value)) {
        throw new StoreUsageError('store: get needs every primary-key column');
      }
      where[column] = value;
    }
    return this.#rows(table).find((row) => matches(table, row, where)) as Row<T> | undefined;
  }

  select<T extends TableName>(table: T, where?: Where<T>, options?: SelectOptions<T>): Row<T>[] {
    let rows = this.#rows(table).filter((row) => matches(table, row, where));
    const orderBy = options?.orderBy ?? [];
    if (orderBy.length > 0) {
      rows = [...rows].sort((a, b) => {
        for (const [column, dir] of orderBy) {
          const av = a[column] ?? null;
          const bv = b[column] ?? null;
          // Nulls first ascending, as SQLite does.
          const d = av === null ? (bv === null ? 0 : -1) : bv === null ? 1 : compare(av, bv);
          if (d !== 0) return dir === 'asc' ? d : -d;
        }
        return 0;
      });
    }
    if (options?.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows as unknown as Row<T>[];
  }

  count<T extends TableName>(table: T, where?: Where<T>): number {
    return this.#rows(table).filter((row) => matches(table, row, where)).length;
  }

  insert<T extends TableName>(table: T, row: Row<T>): void {
    const rows = this.#rows(table);
    this.#set(table, [...rows, checkRow(table, row)]);
  }

  update<T extends TableName>(table: T, where: Where<T>, patch: Partial<Row<T>>): number {
    const rows = this.#rows(table);
    let changed = 0;
    const next = rows.map((row) => {
      if (!matches(table, row, where)) return row;
      changed += 1;
      return checkRow(table, { ...row, ...(patch as Readonly<Record<string, unknown>>) });
    });
    if (changed > 0) this.#set(table, next);
    return changed;
  }

  delete<T extends TableName>(table: T, where: Where<T>): number {
    const rows = this.#rows(table);
    const kept = rows.filter((row) => !matches(table, row, where));
    const deleted = rows.length - kept.length;
    if (deleted > 0) this.#set(table, kept);
    return deleted;
  }
}

export interface MemoryStoreOptions {
  /** The schema version this store reports (tests of the open rules). Default: the code's. */
  readonly schemaVersion?: number;
}

/** An in-memory Store. For tests and development only; nothing persists. */
export class MemoryStore implements Store {
  readonly schemaVersion: number;
  #data: Data = new Map(TABLE_NAMES.map((t) => [t, []]));
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: MemoryStoreOptions = {}) {
    this.schemaVersion = options.schemaVersion ?? STORE_SCHEMA_VERSION;
  }

  transaction<R>(body: (tx: StoreTx) => R): Promise<R> {
    const run = (): R => {
      if (this.#closed) throw new StoreUsageError('store: the store is closed');
      // Copy-on-write: tables are arrays of frozen rows, so a shallow copy isolates the transaction.
      const working: Data = new Map(this.#data);
      const tx = new MemoryTx(working);
      let result: R;
      try {
        result = body(tx);
      } finally {
        tx.end();
      }
      if (
        typeof result === 'object' &&
        result !== null &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        // An asynchronous body could interleave with other writes (07 §3.1): refuse, keep nothing.
        Promise.resolve(result).catch(() => undefined);
        throw new StoreUsageError('store: a transaction body must be synchronous');
      }
      this.#data = working;
      return result;
    };
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#data = new Map();
    return Promise.resolve();
  }
}
