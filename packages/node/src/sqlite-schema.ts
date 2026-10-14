// M1-8b: the SQLite form of the logical store schema (07 §3, §3.1–§3.5; core's TABLES) and its forward
// migrations (07 §3.7). The DDL is generated from TABLES, so the keys, unique and partial unique
// constraints, enums, value types and row counts that core's MemoryStore enforces in code are enforced
// here by SQLite itself (CHECK constraints, STRICT tables, unique indexes, triggers). The statements
// use only standard SQLite, so the Durable Object's SQLite storage (M2-3a) can run the same schema.
//
// Second layer (07 §3.7, IR-M1-7a-1 L-5): two of the core-enforced rules are also triggers here:
// `revoked_agents` rows are never deleted, and a contact's status `revoked` is final.
import {
  STORE_SCHEMA_VERSION,
  TABLES,
  TABLE_NAMES,
  type ColumnSpec,
  type TableName,
  type TableSpec,
} from '@agentlink/core';

/** PRAGMA application_id of an AgentLink store ('ALST'), so a foreign SQLite file is refused. */
export const STORE_APPLICATION_ID = 0x414c5354;

/** The largest `int` value (07 §3.1): 2^53 - 1. */
export const MAX_INT = Number.MAX_SAFE_INTEGER;

export interface StoreMigration {
  /** The schema version this migration produces; migrations run in order from the stored version. */
  readonly version: number;
  /** Statements run in one transaction, together with the version bump. */
  readonly statements: readonly string[];
}

/** Quotes an identifier. Every name comes from TABLES, never from input. */
export const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const lit = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export function tableSpec(table: TableName): TableSpec {
  return (TABLES as Readonly<Record<string, TableSpec>>)[table] as TableSpec;
}

export function columnsOf(table: TableName): readonly string[] {
  return Object.keys(tableSpec(table).columns);
}

/**
 * The SQL check of a USD amount (04 §2.4.1; @agentlink/types isUsdAmount):
 * `^(0|[1-9][0-9]{0,8})(\.[0-9]{0,5}[1-9])?$`, written with GLOB and instr so that it needs no
 * application function.
 */
function usdCheck(c: string): string {
  const dot = `instr(${c}, '.')`;
  return [
    `typeof(${c}) = 'text'`,
    `AND ${c} <> ''`,
    `AND ${c} NOT GLOB '*[^0-9.]*'`,
    `AND (CASE WHEN ${dot} = 0`,
    `THEN length(${c}) <= 9 AND (${c} = '0' OR ${c} NOT GLOB '0*')`,
    `ELSE ${dot} BETWEEN 2 AND 10`,
    `AND instr(substr(${c}, ${dot} + 1), '.') = 0`,
    `AND length(${c}) - ${dot} BETWEEN 1 AND 6`,
    `AND ${c} NOT GLOB '*0'`,
    `AND (substr(${c}, 1, ${dot} - 1) = '0' OR ${c} NOT GLOB '0*')`,
    `END)`,
  ].join(' ');
}

function columnCheck(column: string, spec: ColumnSpec): string {
  const c = q(column);
  switch (spec.kind) {
    case 'id':
    case 'enc':
      return `typeof(${c}) = 'text' AND length(${c}) > 0`;
    case 'text':
    case 'json':
      return `typeof(${c}) = 'text'`;
    case 'int':
      return `typeof(${c}) = 'integer' AND ${c} BETWEEN 0 AND ${MAX_INT}`;
    case 'flag':
      return `typeof(${c}) = 'integer' AND ${c} IN (0, 1)`;
    case 'usd':
      return usdCheck(c);
    case 'enum':
      return `typeof(${c}) = 'text' AND ${c} IN (${(spec.values ?? []).map(lit).join(', ')})`;
  }
}

function columnDef(table: TableName, column: string, spec: ColumnSpec): string {
  const type = spec.kind === 'int' || spec.kind === 'flag' ? 'INTEGER' : 'TEXT';
  const isKey = tableSpec(table).primaryKey.includes(column);
  const check = columnCheck(column, spec);
  if (spec.nullable && !isKey) {
    return `${q(column)} ${type} CHECK (${q(column)} IS NULL OR (${check}))`;
  }
  return `${q(column)} ${type} NOT NULL CHECK (${check})`;
}

export const uniqueIndexName = (table: TableName, index: number): string =>
  `${table}__unique_${index}`;
export const maxRowsTriggerName = (table: TableName): string => `${table}__max_rows`;
export const SECOND_LAYER_TRIGGERS = [
  'revoked_agents__never_deleted',
  'contacts__revoked_is_final',
] as const;

/** The statements that create the schema of `tables` from an empty database. */
export function createSchemaStatements(
  tables: readonly TableName[] = TABLE_NAMES,
): readonly string[] {
  const out: string[] = [];
  for (const table of tables) {
    const spec = tableSpec(table);
    const defs = Object.entries(spec.columns).map(([column, c]) => columnDef(table, column, c));
    defs.push(`PRIMARY KEY (${spec.primaryKey.map(q).join(', ')})`);
    out.push(`CREATE TABLE ${q(table)} (\n  ${defs.join(',\n  ')}\n) STRICT`);
    (spec.unique ?? []).forEach((u, i) => {
      const where =
        u.where === undefined
          ? ''
          : ` WHERE ${Object.entries(u.where)
              .map(([column, value]) => `${q(column)} = ${lit(value)}`)
              .join(' AND ')}`;
      out.push(
        `CREATE UNIQUE INDEX ${q(uniqueIndexName(table, i))} ON ${q(table)} (${u.columns
          .map(q)
          .join(', ')})${where}`,
      );
    });
    if (spec.maxRows !== undefined) {
      out.push(
        `CREATE TRIGGER ${q(maxRowsTriggerName(table))} BEFORE INSERT ON ${q(table)} ` +
          `WHEN (SELECT count(*) FROM ${q(table)}) >= ${spec.maxRows} ` +
          `BEGIN SELECT RAISE(ABORT, 'row count'); END`,
      );
    }
  }
  if (tables.includes('revoked_agents')) {
    out.push(
      `CREATE TRIGGER ${q(SECOND_LAYER_TRIGGERS[0])} BEFORE DELETE ON "revoked_agents" ` +
        `BEGIN SELECT RAISE(ABORT, 'permanent'); END`,
    );
  }
  if (tables.includes('contacts')) {
    out.push(
      `CREATE TRIGGER ${q(SECOND_LAYER_TRIGGERS[1])} BEFORE UPDATE OF "status" ON "contacts" ` +
        `WHEN OLD."status" = 'revoked' AND NEW."status" IS NOT 'revoked' ` +
        `BEGIN SELECT RAISE(ABORT, 'final'); END`,
    );
  }
  return Object.freeze(out);
}

/**
 * The forward migrations, oldest first; the last one's version is STORE_SCHEMA_VERSION. Version 1
 * is the G-9 schema. A later schema version appends a migration (ALTER TABLE, new tables) and never
 * edits an earlier one: version 1 is generated from TABLES only while STORE_SCHEMA_VERSION is 1, and
 * sqlite-store.test.ts pins its digest so a TABLES change without a new migration fails the build.
 */
export const MIGRATIONS: readonly StoreMigration[] = Object.freeze([
  Object.freeze({ version: 1, statements: createSchemaStatements() }),
]);

if (MIGRATIONS.at(-1)?.version !== STORE_SCHEMA_VERSION) {
  throw new Error('sqlite store: the migrations do not end at STORE_SCHEMA_VERSION');
}
