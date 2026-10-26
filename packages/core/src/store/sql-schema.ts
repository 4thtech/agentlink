// The SQLite form of the logical store schema (07 §3, §3.1–§3.5; TABLES), shared by the Node store
// (packages/node, M1-8b) and the Durable Object store (apps/cloud-agent, M2-3a), so both run exactly
// the same DDL (07 §3: "Durable Object uses the same schema"). Moved here unchanged from
// packages/node/src/sqlite-schema.ts (M2-3a); the Node store's pinned statement digests check that
// the text did not change. The keys, unique and partial unique constraints, enums, value types and
// row counts that MemoryStore enforces in code are enforced by SQLite itself (CHECK constraints,
// STRICT tables, unique indexes, triggers). Only standard SQLite: no application function, no pragma.
//
// Second layer (07 §3.7, IR-M1-7a-1 L-5): two of the core-enforced rules are also triggers:
// `revoked_agents` rows are never deleted, and a contact's status `revoked` is final.
//
// Pure text generation: nothing here opens a database or reads input. Every name comes from TABLES.
import { TABLES, TABLE_NAMES, type ColumnSpec, type TableName, type TableSpec } from './schema.js';

/** The largest `int` value (07 §3.1): 2^53 - 1. */
export const SQL_MAX_INT = Number.MAX_SAFE_INTEGER;

/** Quotes an identifier. Every name comes from TABLES, never from input. */
export const sqlIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const q = sqlIdent;
const lit = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export function sqlTableSpec(table: TableName): TableSpec {
  return (TABLES as Readonly<Record<string, TableSpec>>)[table] as TableSpec;
}

export function sqlColumnsOf(table: TableName): readonly string[] {
  return Object.keys(sqlTableSpec(table).columns);
}

/**
 * The SQL check of a USD amount (04 §2.4.1; @4thtech-io/types isUsdAmount):
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
      return `typeof(${c}) = 'integer' AND ${c} BETWEEN 0 AND ${SQL_MAX_INT}`;
    case 'flag':
      return `typeof(${c}) = 'integer' AND ${c} IN (0, 1)`;
    case 'usd':
      return usdCheck(c);
    case 'enum':
      return `typeof(${c}) = 'text' AND ${c} IN (${(spec.values ?? []).map(lit).join(', ')})`;
  }
}

/** One column definition with its type, NOT NULL and CHECK (07 §3.1 types). */
export function sqlColumnDef(
  table: TableName,
  column: string,
  spec: ColumnSpec,
  parent: TableSpec = sqlTableSpec(table),
): string {
  const type = spec.kind === 'int' || spec.kind === 'flag' ? 'INTEGER' : 'TEXT';
  const isKey = parent.primaryKey.includes(column);
  const check = columnCheck(column, spec);
  if (spec.nullable && !isKey) {
    return `${q(column)} ${type} CHECK (${q(column)} IS NULL OR (${check}))`;
  }
  return `${q(column)} ${type} NOT NULL CHECK (${check})`;
}

export const sqlUniqueIndexName = (table: TableName, index: number): string =>
  `${table}__unique_${index}`;
export const sqlMaxRowsTriggerName = (table: TableName): string => `${table}__max_rows`;
export const SQL_SECOND_LAYER_TRIGGERS = [
  'revoked_agents__never_deleted',
  'contacts__revoked_is_final',
] as const;

/**
 * The statements that create the schema of `tables` from an empty database. `specOf` gives each
 * table's spec (default: the current TABLES); a frozen migration passes its own snapshot.
 */
export function createSqlSchemaStatements(
  tables: readonly TableName[] = TABLE_NAMES,
  specOf: (table: TableName) => TableSpec = sqlTableSpec,
): readonly string[] {
  const out: string[] = [];
  for (const table of tables) {
    const spec = specOf(table);
    const defs = Object.entries(spec.columns).map(([column, c]) =>
      sqlColumnDef(table, column, c, spec),
    );
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
        `CREATE UNIQUE INDEX ${q(sqlUniqueIndexName(table, i))} ON ${q(table)} (${u.columns
          .map(q)
          .join(', ')})${where}`,
      );
    });
    if (spec.maxRows !== undefined) {
      out.push(
        `CREATE TRIGGER ${q(sqlMaxRowsTriggerName(table))} BEFORE INSERT ON ${q(table)} ` +
          `WHEN (SELECT count(*) FROM ${q(table)}) >= ${spec.maxRows} ` +
          `BEGIN SELECT RAISE(ABORT, 'row count'); END`,
      );
    }
  }
  if (tables.includes('revoked_agents')) {
    out.push(
      `CREATE TRIGGER ${q(SQL_SECOND_LAYER_TRIGGERS[0])} BEFORE DELETE ON "revoked_agents" ` +
        `BEGIN SELECT RAISE(ABORT, 'permanent'); END`,
    );
  }
  if (tables.includes('contacts')) {
    out.push(
      `CREATE TRIGGER ${q(SQL_SECOND_LAYER_TRIGGERS[1])} BEFORE UPDATE OF "status" ON "contacts" ` +
        `WHEN OLD."status" = 'revoked' AND NEW."status" IS NOT 'revoked' ` +
        `BEGIN SELECT RAISE(ABORT, 'final'); END`,
    );
  }
  return Object.freeze(out);
}
