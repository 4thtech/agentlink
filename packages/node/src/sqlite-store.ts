// M1-8b: the Node Store on SQLite (better-sqlite3), implementing core's Store contract (07 §3.1,
// §3.7) over the schema of sqlite-schema.ts.
//
// - One file per agent, in WAL mode, so several harnesses on one machine share one agent (06 §6).
//   Every transaction is `BEGIN IMMEDIATE`: it takes SQLite's write lock on the file first, so writers
//   in any process serialise and a transaction is serializable and all-or-nothing across tables. The
//   lock is waited for asynchronously (the body never starts until it is held), up to a time limit.
// - The body is synchronous: better-sqlite3 runs each statement to completion, nothing else runs on
//   this connection in between, and a body that returns a promise is refused and rolled back.
// - The store holds only what core gives it: `enc` columns arrive sealed (StoreCipher) and are opaque
//   text here. It never reads a clock for data; only the lock wait uses one.
// - Fail closed: a stored value outside its column's type is `store_unreadable`, never absent; a lost
//   transaction (SQLite rolled it back on an I/O error) stops every later statement of the body.
// - Forward migrations only (07 §3.7): a newer schema version is refused, never downgraded.
import { closeSync, openSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  StoreConstraintError,
  StoreUsageError,
  TABLES,
  TABLE_NAMES,
  type ColumnSpec,
  type PrimaryKey,
  type Row,
  type SelectOptions,
  type Store,
  type StoreTx,
  type StoreValue,
  type TableName,
  type Where,
} from '@agentlink/core';
import {
  MAX_INT,
  MIGRATIONS,
  STORE_APPLICATION_ID,
  columnsOf,
  createSchemaStatements,
  q,
  tableSpec,
  type StoreMigration,
} from './sqlite-schema.js';
import { NodeStoreError } from './store-errors.js';
import { withInterProcessLock, type InterProcessLockOptions } from './inter-process-lock.js';

/** How long a transaction waits for the write lock before `store_busy`. */
export const STORE_LOCK_TIMEOUT_MS = 10_000;
/** SQLite's own busy wait for a single statement (WAL recovery); short, it blocks the thread. */
const STATEMENT_BUSY_MS = 50;
const STATEMENT_CACHE_LIMIT = 512;

export interface SqliteStoreOptions {
  /** How long a transaction waits for the write lock. Default STORE_LOCK_TIMEOUT_MS. */
  readonly lockTimeoutMs?: number;
  /** Test seam (not exported from the package): the migration list. Default MIGRATIONS. */
  readonly migrations?: readonly StoreMigration[];
}

type AnyRow = Readonly<Record<string, StoreValue>>;

const isBusy = (error: unknown): boolean =>
  error instanceof Database.SqliteError &&
  (error.code === 'SQLITE_BUSY' || error.code.startsWith('SQLITE_BUSY_'));

const isConstraint = (error: unknown): boolean =>
  error instanceof Database.SqliteError && error.code.startsWith('SQLITE_CONSTRAINT');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The JS type a column's values have: numbers for int and flag, text for every other kind. */
const jsType = (spec: ColumnSpec): 'number' | 'string' =>
  spec.kind === 'int' || spec.kind === 'flag' ? 'number' : 'string';

function columnSpec(table: TableName, column: string): ColumnSpec | undefined {
  const columns = tableSpec(table).columns;
  return Object.hasOwn(columns, column) ? (columns[column] as ColumnSpec) : undefined;
}

/** The JS checks a SQLite column type cannot make (a number never becomes text, and so on). */
function valueOk(spec: ColumnSpec, value: unknown): boolean {
  if (value === null) return spec.nullable;
  switch (spec.kind) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_INT;
    case 'flag':
      return value === 0 || value === 1;
    case 'id':
    case 'enc':
      return typeof value === 'string' && value.length > 0;
    case 'text':
    case 'json':
    case 'usd':
      // usd: its exact form is the column's CHECK constraint (sqlite-schema.ts).
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

/** Validates a complete row (exactly its columns) and returns the values in column order. */
function rowValues(table: TableName, row: unknown): StoreValue[] {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new StoreConstraintError(table, `store: a row of ${table} must be an object`);
  }
  const columns = columnsOf(table);
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

/**
 * One column condition as SQL, with MemoryStore's semantics: a bare value is equality (null matches
 * only null); an operator never matches a null value; an operand of another type, or null, matches
 * nothing (SQLite would otherwise convert it with the column's affinity).
 */
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

class SqliteTx implements StoreTx {
  #open = true;
  readonly #store: SqliteStore;

  constructor(store: SqliteStore) {
    this.#store = store;
  }

  end(): void {
    this.#open = false;
  }

  #ready(table: unknown): asserts table is TableName {
    if (!this.#open) throw new StoreUsageError('store: the transaction has ended');
    checkTable(table);
    // SQLite rolls a transaction back by itself on some I/O errors; statements after that would
    // run outside any transaction and commit on their own. Stop the body instead.
    if (!this.#store.db.inTransaction) throw new NodeStoreError('store_failed');
  }

  #read(table: TableName, sql: string, params: readonly StoreValue[]): Row<TableName>[] {
    const raw = this.#store.run(table, () =>
      this.#store
        .statement(sql)
        .safeIntegers(true)
        .raw(true)
        .all(...params),
    ) as unknown[][];
    return raw.map((values) => toRow(table, values)) as Row<TableName>[];
  }

  get<T extends TableName>(table: T, key: PrimaryKey<T>): Row<T> | undefined {
    this.#ready(table);
    const where: Record<string, unknown> = {};
    for (const column of tableSpec(table).primaryKey) {
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
        // Nulls sort first ascending and last descending (SQLite's default, as MemoryStore).
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
    return this.#read(table, sql, params) as Row<T>[];
  }

  count<T extends TableName>(table: T, where?: Where<T>): number {
    this.#ready(table);
    const w = whereSql(table, where);
    const n = this.#store.run(table, () =>
      this.#store
        .statement(`SELECT count(*) FROM ${q(table)}${w.text}`)
        .pluck(true)
        .get(...w.params),
    );
    return Number(n);
  }

  insert<T extends TableName>(table: T, row: Row<T>): void {
    this.#ready(table);
    const values = rowValues(table, row);
    const columns = columnsOf(table);
    const sql = `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${columns
      .map(() => '?')
      .join(', ')})`;
    this.#store.run(table, () => this.#store.statement(sql).run(...values));
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
    const info = this.#store.run(table, () => this.#store.statement(sql).run(...params));
    return info.changes;
  }

  delete<T extends TableName>(table: T, where: Where<T>): number {
    this.#ready(table);
    const w = whereSql(table, where);
    const info = this.#store.run(table, () =>
      this.#store.statement(`DELETE FROM ${q(table)}${w.text}`).run(...w.params),
    );
    return info.changes;
  }
}

const selectList = (table: TableName): string => columnsOf(table).map(q).join(', ');

/** A stored row as a frozen object in column order, after the same type checks as a write. */
function toRow(table: TableName, values: readonly unknown[]): AnyRow {
  const columns = columnsOf(table);
  if (values.length !== columns.length) throw new NodeStoreError('store_unreadable');
  const out: Record<string, StoreValue> = {};
  columns.forEach((column, i) => {
    let value = values[i];
    if (typeof value === 'bigint') {
      if (value < 0n || value > BigInt(MAX_INT)) throw new NodeStoreError('store_unreadable');
      value = Number(value);
    }
    if (!valueOk(columnSpec(table, column) as ColumnSpec, value)) {
      throw new NodeStoreError('store_unreadable');
    }
    out[column] = value as StoreValue;
  });
  return Object.freeze(out);
}

/** Creates the file with owner-only permissions if it does not exist (WAL files inherit them). */
function createOwnerOnly(path: string): void {
  try {
    closeSync(openSync(path, 'wx', 0o600));
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw new NodeStoreError('store_failed');
  }
}

export class SqliteStore implements Store {
  #schemaVersion = 0;
  /** @internal */
  readonly db: Database.Database;
  readonly #path: string;
  readonly #lockTimeoutMs: number;
  readonly #statements = new Map<string, Database.Statement>();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #inBody = false;

  private constructor(db: Database.Database, path: string, lockTimeoutMs: number) {
    this.db = db;
    this.#path = path;
    this.#lockTimeoutMs = lockTimeoutMs;
  }

  /** The schema version of this store's data (07 §3.7), after its forward migrations ran. */
  get schemaVersion(): number {
    return this.#schemaVersion;
  }

  /**
   * Opens (or creates) the store at `path`, runs pending forward migrations and checks that the
   * tables are this schema. Refuses a newer schema version (`store_too_new`) and a file that is not
   * an AgentLink store (`store_foreign`).
   */
  static async open(path: string, options: SqliteStoreOptions = {}): Promise<SqliteStore> {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path === ':memory:' ||
      path.startsWith('file:')
    ) {
      throw new StoreUsageError('store: the store needs a file path');
    }
    const migrations = options.migrations ?? MIGRATIONS;
    const lockTimeoutMs = options.lockTimeoutMs ?? STORE_LOCK_TIMEOUT_MS;
    createOwnerOnly(path);
    let db: Database.Database;
    try {
      db = new Database(path, { fileMustExist: true });
    } catch {
      throw new NodeStoreError('store_failed');
    }
    try {
      // Locks are polled asynchronously (#retryBusy) while opening; statements get a short wait after.
      db.pragma('busy_timeout = 0');
      const store = new SqliteStore(db, path, lockTimeoutMs);
      await store.#retryBusy(() => {
        if (String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase() !== 'wal') {
          throw new NodeStoreError('store_failed');
        }
      });
      db.pragma('synchronous = FULL');
      db.pragma('trusted_schema = OFF');
      store.#schemaVersion = await store.#migrate(migrations);
      verifySchema(db);
      db.pragma(`busy_timeout = ${STATEMENT_BUSY_MS}`);
      return store;
    } catch (error) {
      db.close();
      if (error instanceof NodeStoreError || error instanceof StoreUsageError) throw error;
      if (error instanceof Database.SqliteError && error.code === 'SQLITE_NOTADB') {
        throw new NodeStoreError('store_foreign');
      }
      throw new NodeStoreError(isBusy(error) ? 'store_busy' : 'store_failed');
    }
  }

  /** Runs `fn` until it does not fail with SQLITE_BUSY, waiting asynchronously, up to the limit. */
  async #retryBusy<R>(fn: () => R): Promise<R> {
    const deadline = Date.now() + this.#lockTimeoutMs;
    let delay = 2;
    for (;;) {
      try {
        return fn();
      } catch (error) {
        if (!isBusy(error)) throw error;
        if (Date.now() >= deadline) throw new NodeStoreError('store_busy');
        await sleep(delay);
        delay = Math.min(delay * 2, 50);
      }
    }
  }

  /** Brings the schema to the last migration's version in one IMMEDIATE transaction per step. */
  async #migrate(migrations: readonly StoreMigration[]): Promise<number> {
    const target = migrations.at(-1)?.version ?? 0;
    for (;;) {
      await this.#retryBusy(() => this.db.prepare('BEGIN IMMEDIATE').run());
      try {
        const appId = Number(this.db.pragma('application_id', { simple: true }));
        const version = Number(this.db.pragma('user_version', { simple: true }));
        const objects = Number(
          this.db
            .prepare("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
            .pluck()
            .get(),
        );
        if (appId !== STORE_APPLICATION_ID && !(appId === 0 && version === 0 && objects === 0)) {
          throw new NodeStoreError('store_foreign');
        }
        if (version > target) throw new NodeStoreError('store_too_new');
        if (version === target) {
          this.db.prepare('COMMIT').run();
          return version;
        }
        const next = migrations.find((m) => m.version === version + 1);
        if (next === undefined) throw new NodeStoreError('store_foreign');
        for (const statement of next.statements) this.db.prepare(statement).run();
        this.db.pragma(`application_id = ${STORE_APPLICATION_ID}`);
        this.db.pragma(`user_version = ${next.version}`);
        this.db.prepare('COMMIT').run();
      } catch (error) {
        this.#rollback();
        throw error;
      }
    }
  }

  /** Rolls back the open transaction, if any; a failed rollback never hides the original error. */
  #rollback(): void {
    try {
      if (this.db.inTransaction) this.statement('ROLLBACK').run();
    } catch {
      // SQLite has already rolled back, or the connection failed; nothing was committed.
    }
  }

  /** @internal A cached prepared statement. */
  statement(sql: string): Database.Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      if (this.#statements.size >= STATEMENT_CACHE_LIMIT) this.#statements.clear();
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** @internal Runs one statement, mapping SQLite errors: constraints to StoreConstraintError. */
  run<R>(table: TableName, fn: () => R): R {
    try {
      return fn();
    } catch (error) {
      if (isConstraint(error)) {
        throw new StoreConstraintError(
          table,
          `store: a key or constraint of ${table} was violated`,
        );
      }
      if (error instanceof NodeStoreError || error instanceof StoreUsageError) throw error;
      throw new NodeStoreError(isBusy(error) ? 'store_busy' : 'store_failed');
    }
  }

  transaction<R>(body: (tx: StoreTx) => R): Promise<R> {
    if (this.#inBody) {
      // A nested call from inside a body would run outside its transaction's all-or-nothing scope.
      return Promise.reject(new StoreUsageError('store: transactions do not nest'));
    }
    const run = (): Promise<R> => this.#run(body);
    const next = this.#tail.then(run, run);
    this.#tail = next.catch(() => undefined);
    return next;
  }

  async #run<R>(body: (tx: StoreTx) => R): Promise<R> {
    if (this.#closed) throw new StoreUsageError('store: the store is closed');
    // The write lock is waited for here, between polls, never inside SQLite's own busy handler,
    // which would block this process's event loop for the whole wait.
    const begin = this.statement('BEGIN IMMEDIATE');
    this.db.pragma('busy_timeout = 0');
    try {
      await this.#retryBusy(() => begin.run());
    } finally {
      this.db.pragma(`busy_timeout = ${STATEMENT_BUSY_MS}`);
    }
    if (this.#closed) {
      this.#rollback();
      throw new StoreUsageError('store: the store is closed');
    }
    const tx = new SqliteTx(this);
    this.#inBody = true;
    try {
      const result = body(tx);
      if (
        typeof result === 'object' &&
        result !== null &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        // An asynchronous body could interleave with other writes (07 §3.1): refuse, keep nothing.
        Promise.resolve(result).catch(() => undefined);
        throw new StoreUsageError('store: a transaction body must be synchronous');
      }
      if (!this.db.inTransaction) throw new NodeStoreError('store_failed');
      try {
        this.statement('COMMIT').run();
      } catch {
        throw new NodeStoreError('store_failed');
      }
      return result;
    } catch (error) {
      this.#rollback();
      throw error;
    } finally {
      this.#inBody = false;
      tx.end();
    }
  }

  /**
   * Runs `fn` under the agent's inter-process lock (06 §6): one holder at a time across every
   * process and connection on this machine, for critical sections that span awaits (the policy-version
   * mark, 07 §3.4; the file KeyStore, M1-8f). Store transactions do not need it: they lock the file
   * themselves. Do not call `transaction` from `fn` while another holder can wait on it in-process.
   */
  withInterProcessLock<T>(fn: () => Promise<T> | T, options?: InterProcessLockOptions): Promise<T> {
    if (this.#closed) return Promise.reject(new StoreUsageError('store: the store is closed'));
    return withInterProcessLock(`${this.#path}.lock`, fn, options);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    this.#statements.clear();
    this.db.close();
  }
}

/**
 * Checks that every table of the schema exists with exactly its columns, in order, with the SQL type
 * and NOT NULL of its spec, and that its unique indexes and triggers exist (fail closed: a file whose
 * tables are not this schema is `store_foreign`).
 */
function verifySchema(db: Database.Database): void {
  for (const table of TABLE_NAMES) {
    const spec = tableSpec(table);
    const info = db.prepare(`PRAGMA table_xinfo(${q(table)})`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    const columns = Object.entries(spec.columns);
    if (info.length !== columns.length) throw new NodeStoreError('store_foreign');
    columns.forEach(([name, c], i) => {
      const col = info[i];
      const type = c.kind === 'int' || c.kind === 'flag' ? 'INTEGER' : 'TEXT';
      const pk = spec.primaryKey.indexOf(name) + 1;
      const notnull = !c.nullable || pk > 0 ? 1 : 0;
      if (col?.name !== name || col.type !== type || col.notnull !== notnull || col.pk !== pk) {
        throw new NodeStoreError('store_foreign');
      }
    });
  }
  const names = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type IN ('index', 'trigger')")
      .pluck()
      .all() as string[],
  );
  for (const statement of createSchemaStatements()) {
    const match = /^CREATE (?:UNIQUE INDEX|TRIGGER) "([^"]+)"/.exec(statement);
    if (match !== null && !names.has(match[1] as string)) throw new NodeStoreError('store_foreign');
  }
}
