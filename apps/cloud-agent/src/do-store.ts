// M2-3a: core's Store on the Durable Object's SQLite storage (07 §3, §3.1–§3.7; 08 §3.1).
//
// - The schema is core's shared DDL (createSqlSchemaStatements), the same statements as the Node
//   store (M1-8b), plus the cloud-only tables (cloud-schema.ts). It is created once, in one
//   transaction, in an empty object, at the code's STORE_SCHEMA_VERSION; a newer stored version is
//   refused and an older one needs a forward migration (none exists yet: the DO store starts at 5).
// - Every write runs in `transactionSync` (07 §3.1): the body is synchronous and is all-or-nothing
//   across tables. A body that returns a promise is refused and rolled back. The object is single
//   threaded and the body never awaits, so nothing interleaves with it (serializable).
// - The store holds only what core gives it: `enc` columns arrive sealed (StoreCipher) and are opaque
//   text here. It never reads a clock.
// - Fail closed: a stored value outside its column's type is `store_unreadable`, never absent.
// - Nothing here logs; errors are fixed sentences (I-7).
import {
  STORE_SCHEMA_VERSION,
  SQL_MAX_INT,
  StoreConstraintError,
  StoreUsageError,
  TABLES,
  TABLE_NAMES,
  createSqlSchemaStatements,
  sqlColumnsOf,
  sqlIdent as q,
  sqlTableSpec,
  type ColumnSpec,
  type PrimaryKey,
  type Row,
  type SelectOptions,
  type Store,
  type StoreTx,
  type StoreValue,
  type TableName,
  type Where,
} from '@4thtech-io/core';
import {
  AGENT_ITEMS,
  CLOUD_TABLES,
  createCloudSchemaStatements,
  type AgentItem,
} from './cloud-schema.js';
import { CloudAgentError } from './errors.js';

type AnyRow = Readonly<Record<string, StoreValue>>;

const jsType = (spec: ColumnSpec): 'number' | 'string' =>
  spec.kind === 'int' || spec.kind === 'flag' ? 'number' : 'string';

function columnSpec(table: TableName, column: string): ColumnSpec | undefined {
  const columns = sqlTableSpec(table).columns;
  return Object.hasOwn(columns, column) ? (columns[column] as ColumnSpec) : undefined;
}

/** The JS checks a SQLite column type cannot make (as the Node store). */
function valueOk(spec: ColumnSpec, value: unknown): boolean {
  if (value === null) return spec.nullable;
  switch (spec.kind) {
    case 'int':
      return (
        typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SQL_MAX_INT
      );
    case 'flag':
      return value === 0 || value === 1;
    case 'id':
    case 'enc':
      return typeof value === 'string' && value.length > 0;
    case 'text':
    case 'json':
    case 'usd':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string' && (spec.values ?? []).includes(value);
  }
}

const wrongType = (table: TableName, column: string): StoreConstraintError =>
  new StoreConstraintError(
    table,
    `store: column ${column} of ${table} holds a value of the wrong type`,
  );

function rowValues(table: TableName, row: unknown): StoreValue[] {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new StoreConstraintError(table, `store: a row of ${table} must be an object`);
  }
  const columns = sqlColumnsOf(table);
  const source = row as Readonly<Record<string, unknown>>;
  const keys = Object.keys(source);
  if (keys.length !== columns.length || keys.some((k) => columnSpec(table, k) === undefined)) {
    throw new StoreConstraintError(table, `store: a row of ${table} must have exactly its columns`);
  }
  return columns.map((column) => {
    const value = source[column];
    if (!valueOk(columnSpec(table, column) as ColumnSpec, value)) throw wrongType(table, column);
    return value as StoreValue;
  });
}

interface Sql {
  readonly text: string;
  readonly params: StoreValue[];
}

const OPERATORS: Readonly<Record<string, string>> = {
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** One column condition with MemoryStore's semantics (as the Node store). */
function conditionSql(
  spec: ColumnSpec,
  column: string,
  condition: unknown,
  params: StoreValue[],
): string {
  const c = q(column);
  const type = jsType(spec);
  if (condition === null) return `${c} IS NULL`;
  if (typeof condition !== 'object') {
    if (typeof condition !== type) return '0';
    params.push(condition as StoreValue);
    return `${c} = ?`;
  }
  const parts: string[] = [`${c} IS NOT NULL`];
  for (const [op, operand] of Object.entries(condition as Readonly<Record<string, unknown>>)) {
    if (op === 'in') {
      if (!Array.isArray(operand)) return '0';
      const values = (operand as readonly unknown[]).filter((v) => typeof v === type);
      if (values.length === 0) return '0';
      parts.push(`${c} IN (${values.map(() => '?').join(', ')})`);
      params.push(...(values as StoreValue[]));
      continue;
    }
    const sqlOp = Object.hasOwn(OPERATORS, op) ? OPERATORS[op] : undefined;
    if (sqlOp === undefined) throw new StoreUsageError('store: unknown condition operator');
    if (typeof operand !== type) return '0';
    parts.push(`${c} ${sqlOp} ?`);
    params.push(operand as StoreValue);
  }
  return parts.join(' AND ');
}

function whereSql(table: TableName, where: unknown): Sql {
  if (where === undefined) return { text: '', params: [] };
  if (typeof where !== 'object' || where === null) throw new StoreUsageError('store: bad where');
  const params: StoreValue[] = [];
  const parts: string[] = [];
  for (const [column, condition] of Object.entries(where)) {
    const spec = columnSpec(table, column);
    if (spec === undefined) throw new StoreUsageError('store: unknown column in where');
    if (condition === undefined) continue;
    parts.push(`(${conditionSql(spec, column, condition, params)})`);
  }
  return { text: parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`, params };
}

function checkTable(table: unknown): asserts table is TableName {
  if (typeof table !== 'string' || !Object.hasOwn(TABLES, table)) {
    throw new StoreUsageError('store: unknown table');
  }
}

/** SQLite reports a constraint (key, unique, CHECK, NOT NULL, a RAISE(ABORT) trigger) this way. */
const isConstraint = (error: unknown): boolean =>
  error instanceof Error && /SQLITE_CONSTRAINT/.test(error.message);

const selectList = (table: TableName): string => sqlColumnsOf(table).map(q).join(', ');

/** A stored row as a frozen object in column order, after the same type checks as a write. */
function toRow(table: TableName, values: readonly unknown[]): AnyRow {
  const columns = sqlColumnsOf(table);
  if (values.length !== columns.length) throw new CloudAgentError('store_unreadable');
  const out: Record<string, StoreValue> = {};
  columns.forEach((column, i) => {
    const value = values[i];
    if (!valueOk(columnSpec(table, column) as ColumnSpec, value)) {
      throw new CloudAgentError('store_unreadable');
    }
    out[column] = value as StoreValue;
  });
  return Object.freeze(out);
}

class DurableObjectTx implements StoreTx {
  #open = true;
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  end(): void {
    this.#open = false;
  }

  #ready(table: unknown): asserts table is TableName {
    if (!this.#open) throw new StoreUsageError('store: the transaction has ended');
    checkTable(table);
  }

  #exec(table: TableName, sql: string, params: readonly StoreValue[]): SqlStorageCursor {
    try {
      return this.#sql.exec(sql, ...params);
    } catch (error) {
      if (isConstraint(error)) {
        throw new StoreConstraintError(
          table,
          `store: a key or constraint of ${table} was violated`,
        );
      }
      throw new CloudAgentError('store_failed');
    }
  }

  #read(table: TableName, sql: string, params: readonly StoreValue[]): AnyRow[] {
    let raw: unknown[][];
    try {
      raw = [...this.#exec(table, sql, params).raw()];
    } catch (error) {
      if (error instanceof StoreConstraintError || error instanceof CloudAgentError) throw error;
      throw new CloudAgentError('store_failed');
    }
    return raw.map((values) => toRow(table, values));
  }

  get<T extends TableName>(table: T, key: PrimaryKey<T>): Row<T> | undefined {
    this.#ready(table);
    const where: Record<string, unknown> = {};
    for (const column of sqlTableSpec(table).primaryKey) {
      const value = (key as Readonly<Record<string, unknown>> | null)?.[column];
      if (value === undefined || value === null || typeof value === 'object') {
        throw new StoreUsageError('store: get needs every primary-key column');
      }
      where[column] = value;
    }
    const w = whereSql(table, where);
    const rows = this.#read(
      table,
      `SELECT ${selectList(table)} FROM ${q(table)}${w.text} LIMIT 1`,
      w.params,
    );
    return rows[0] as Row<T> | undefined;
  }

  select<T extends TableName>(table: T, where?: Where<T>, options?: SelectOptions<T>): Row<T>[] {
    this.#ready(table);
    const w = whereSql(table, where);
    let sql = `SELECT ${selectList(table)} FROM ${q(table)}${w.text}`;
    const params = [...w.params];
    const orderBy = options?.orderBy ?? [];
    if (orderBy.length > 0) {
      const terms = orderBy.map(([column, dir]) => {
        if (columnSpec(table, column) === undefined || (dir !== 'asc' && dir !== 'desc')) {
          throw new StoreUsageError('store: bad orderBy');
        }
        return `${q(column)} ${dir === 'asc' ? 'ASC' : 'DESC'}`;
      });
      sql += ` ORDER BY ${terms.join(', ')}`;
    }
    if (options?.limit !== undefined) {
      if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
        throw new StoreUsageError('store: limit must be a non-negative integer');
      }
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    return this.#read(table, sql, params) as unknown as Row<T>[];
  }

  count<T extends TableName>(table: T, where?: Where<T>): number {
    this.#ready(table);
    const w = whereSql(table, where);
    const rows = [
      ...this.#exec(table, `SELECT count(*) FROM ${q(table)}${w.text}`, w.params).raw(),
    ];
    const n = rows[0]?.[0];
    if (typeof n !== 'number' || !Number.isSafeInteger(n))
      throw new CloudAgentError('store_failed');
    return n;
  }

  insert<T extends TableName>(table: T, row: Row<T>): void {
    this.#ready(table);
    const values = rowValues(table, row);
    const columns = sqlColumnsOf(table);
    const sql = `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns
      .map(() => '?')
      .join(', ')})`;
    this.#exec(table, sql, values);
  }

  update<T extends TableName>(table: T, where: Where<T>, patch: Partial<Row<T>>): number {
    this.#ready(table);
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new StoreConstraintError(table, `store: a patch of ${table} must be an object`);
    }
    const entries = Object.entries(patch as Readonly<Record<string, unknown>>);
    for (const [column, value] of entries) {
      const spec = columnSpec(table, column);
      if (spec === undefined) {
        throw new StoreConstraintError(
          table,
          `store: a row of ${table} must have exactly its columns`,
        );
      }
      if (!valueOk(spec, value)) throw wrongType(table, column);
    }
    if (entries.length === 0) return this.count(table, where);
    const w = whereSql(table, where);
    const sql = `UPDATE ${q(table)} SET ${entries.map(([c]) => `${q(c)} = ?`).join(', ')}${w.text}`;
    const params = [...entries.map(([, v]) => v as StoreValue), ...w.params];
    this.#exec(table, sql, params);
    return this.#changes(table);
  }

  delete<T extends TableName>(table: T, where: Where<T>): number {
    this.#ready(table);
    const w = whereSql(table, where);
    this.#exec(table, `DELETE FROM ${q(table)}${w.text}`, w.params);
    return this.#changes(table);
  }

  /** Rows the last statement changed (SQLite `changes()`; `rowsWritten` also counts index rows). */
  #changes(table: TableName): number {
    const n = [...this.#exec(table, 'SELECT changes()', []).raw()][0]?.[0];
    if (typeof n !== 'number' || !Number.isSafeInteger(n))
      throw new CloudAgentError('store_failed');
    return n;
  }
}

const AGENT_ITEM_SET: ReadonlySet<string> = new Set(AGENT_ITEMS);

/** Every user table this store's schema creates (core's TABLES and the cloud-only tables). */
const SCHEMA_TABLES: ReadonlySet<string> = new Set<string>([...TABLE_NAMES, ...CLOUD_TABLES]);

/**
 * The agent's Store in its Durable Object. Construct with `DurableObjectStore.open(storage)` from the
 * object's constructor (inside `blockConcurrencyWhile`). One per object; the object is the single
 * publisher of the deployment (`idFromName("agent")`, 06 §6).
 */
export class DurableObjectStore implements Store {
  readonly #storage: DurableObjectStorage;
  #schemaVersion = 0;
  #closed = false;
  #inBody = false;

  private constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  get schemaVersion(): number {
    return this.#schemaVersion;
  }

  /**
   * Opens the store in `storage`: creates the schema in an empty object (idempotent: a second open
   * finds it), refuses a newer stored version and storage that is not this schema.
   */
  static open(storage: DurableObjectStorage): DurableObjectStore {
    const store = new DurableObjectStore(storage);
    store.#schemaVersion = store.#init();
    return store;
  }

  #userTables(): string[] {
    const rows = [
      ...this.#storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw(),
    ];
    return rows
      .map((r) => r[0])
      .filter(
        (name): name is string =>
          typeof name === 'string' && !name.startsWith('sqlite_') && !name.startsWith('_cf_'),
      );
  }

  #init(): number {
    try {
      return this.#storage.transactionSync(() => {
        const tables = this.#userTables();
        if (tables.length === 0) {
          for (const statement of createSqlSchemaStatements()) this.#storage.sql.exec(statement);
          for (const statement of createCloudSchemaStatements()) this.#storage.sql.exec(statement);
          this.#storage.sql.exec(
            'INSERT INTO "deploy_state" ("id", "schema_version") VALUES (1, ?)',
            STORE_SCHEMA_VERSION,
          );
          this.#verify();
          return STORE_SCHEMA_VERSION;
        }
        if (!tables.includes('deploy_state')) throw new CloudAgentError('store_foreign');
        const rows = [
          ...this.#storage.sql
            .exec('SELECT "schema_version" FROM "deploy_state" WHERE "id" = 1')
            .raw(),
        ];
        const version = rows[0]?.[0];
        if (rows.length !== 1 || typeof version !== 'number' || !Number.isSafeInteger(version)) {
          throw new CloudAgentError('store_foreign');
        }
        if (version > STORE_SCHEMA_VERSION) throw new CloudAgentError('store_too_new');
        if (version < STORE_SCHEMA_VERSION) throw new CloudAgentError('store_needs_migration');
        if (tables.some((t) => !SCHEMA_TABLES.has(t))) throw new CloudAgentError('store_foreign');
        this.#verify();
        return version;
      });
    } catch (error) {
      if (error instanceof CloudAgentError) throw error;
      throw new CloudAgentError('store_failed');
    }
  }

  /** Every table of the logical schema exists with exactly its columns, types and keys. */
  #verify(): void {
    for (const table of TABLE_NAMES) {
      const spec = sqlTableSpec(table);
      const info = this.#storage.sql.exec(`PRAGMA table_info(${q(table)})`).toArray();
      const columns = Object.entries(spec.columns);
      if (info.length !== columns.length) throw new CloudAgentError('store_foreign');
      columns.forEach(([name, c], i) => {
        const col = info[i];
        const type = c.kind === 'int' || c.kind === 'flag' ? 'INTEGER' : 'TEXT';
        const pk = spec.primaryKey.indexOf(name) + 1;
        const notnull = !c.nullable || pk > 0 ? 1 : 0;
        if (
          col?.['name'] !== name ||
          col['type'] !== type ||
          col['notnull'] !== notnull ||
          col['pk'] !== pk
        ) {
          throw new CloudAgentError('store_foreign');
        }
      });
    }
  }

  transaction<R>(body: (tx: StoreTx) => R): Promise<R> {
    if (this.#inBody) return Promise.reject(new StoreUsageError('store: transactions do not nest'));
    if (this.#closed) return Promise.reject(new StoreUsageError('store: the store is closed'));
    const tx = new DurableObjectTx(this.#storage.sql);
    this.#inBody = true;
    try {
      const result = this.#storage.transactionSync(() => {
        const value = body(tx);
        if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { then?: unknown }).then === 'function'
        ) {
          // An asynchronous body could interleave with other writes (07 §3.1): refuse, keep nothing.
          Promise.resolve(value).catch(() => undefined);
          throw new StoreUsageError('store: a transaction body must be synchronous');
        }
        return value;
      });
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    } finally {
      this.#inBody = false;
      tx.end();
    }
  }

  // --- Cloud-only rows (cloud-schema.ts) ----------------------------------------------------------

  /** One agent item's value, or null when it is not stored. */
  readItem(name: AgentItem): string | null {
    this.#assertItem(name);
    const rows = this.#cloud(() => [
      ...this.#storage.sql.exec('SELECT "value" FROM "agent_items" WHERE "name" = ?', name).raw(),
    ]);
    if (rows.length === 0) return null;
    const value = rows[0]?.[0];
    if (typeof value !== 'string' || value.length === 0)
      throw new CloudAgentError('store_unreadable');
    return value;
  }

  /**
   * Runs `fn` with the item's current value inside one transaction and stores what it returns (a
   * string replaces or creates the item, undefined leaves it). Returns what was stored, read back.
   */
  updateItem(name: AgentItem, fn: (current: string | null) => string | undefined): string | null {
    this.#assertItem(name);
    return this.#cloud(() =>
      this.#storage.transactionSync(() => {
        const read = (): string | null => {
          const rows = [
            ...this.#storage.sql
              .exec('SELECT "value" FROM "agent_items" WHERE "name" = ?', name)
              .raw(),
          ];
          const value = rows[0]?.[0];
          if (rows.length === 0) return null;
          if (typeof value !== 'string' || value.length === 0) {
            throw new CloudAgentError('store_unreadable');
          }
          return value;
        };
        const next = fn(read());
        if (next !== undefined) {
          this.#storage.sql.exec(
            'INSERT INTO "agent_items" ("name", "value") VALUES (?, ?) ' +
              'ON CONFLICT ("name") DO UPDATE SET "value" = excluded."value"',
            name,
            next,
          );
        }
        return read();
      }),
    );
  }

  #assertItem(name: unknown): asserts name is AgentItem {
    if (typeof name !== 'string' || !AGENT_ITEM_SET.has(name)) {
      throw new StoreUsageError('store: unknown agent item');
    }
    if (this.#closed) throw new StoreUsageError('store: the store is closed');
  }

  #cloud<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof CloudAgentError || error instanceof StoreUsageError) throw error;
      throw new CloudAgentError('store_failed');
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}
