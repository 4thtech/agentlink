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

function columnDef(
  table: TableName,
  column: string,
  spec: ColumnSpec,
  parent: TableSpec = tableSpec(table),
): string {
  const type = spec.kind === 'int' || spec.kind === 'flag' ? 'INTEGER' : 'TEXT';
  const isKey = parent.primaryKey.includes(column);
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

/**
 * The statements that create the schema of `tables` from an empty database. `specOf` gives each
 * table's spec (default: the current TABLES); a frozen migration passes its own snapshot.
 */
export function createSchemaStatements(
  tables: readonly TableName[] = TABLE_NAMES,
  specOf: (table: TableName) => TableSpec = tableSpec,
): readonly string[] {
  const out: string[] = [];
  for (const table of tables) {
    const spec = specOf(table);
    const defs = Object.entries(spec.columns).map(([column, c]) =>
      columnDef(table, column, c, spec),
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

// --- Frozen snapshots ------------------------------------------------------------------------------

/** Tables added after version 1, and envelope columns added after version 1 (D-72, version 2). */
const V2_TABLES: readonly TableName[] = ['blocked_keys'];
const V2_ENVELOPE_COLUMNS: readonly string[] = ['refused_at', 'request_accepted_at'];
/** Tables added by version 3 (M1-7k-b): the publisher lease (07 §3.2) and staged retries (F08). */
const V3_TABLES: readonly TableName[] = ['publisher_lease', 'outbox_staged'];

/**
 * The version 1 (G-9) schema: today's TABLES without what versions 2 and 3 added. Its statements
 * are pinned by digest in sqlite-store.test.ts, so this snapshot cannot drift.
 */
function v1Spec(table: TableName): TableSpec {
  const spec = tableSpec(table);
  if (table !== 'envelopes') return spec;
  return {
    ...spec,
    columns: Object.fromEntries(
      Object.entries(spec.columns).filter(([column]) => !V2_ENVELOPE_COLUMNS.includes(column)),
    ),
  };
}

/**
 * Version 2 (D-72, M1-7e-2): `envelopes.refused_at` and `envelopes.request_accepted_at`, appended
 * (ALTER TABLE ADD COLUMN appends, which is also their place in TABLES), and the `blocked_keys`
 * table. A `refused` row stored before version 2 has a null refused_at: the core treats it as
 * expired, so it stops counting toward the requests-queue limits and is pruned on the next pass.
 */
function v2Statements(): readonly string[] {
  const envelopes = tableSpec('envelopes');
  return [
    ...V2_ENVELOPE_COLUMNS.map(
      (column) =>
        `ALTER TABLE "envelopes" ADD COLUMN ${columnDef(
          'envelopes',
          column,
          envelopes.columns[column] as ColumnSpec,
        )}`,
    ),
    ...createSchemaStatements(V2_TABLES),
  ];
}

/**
 * The forward migrations, oldest first; the last one's version is STORE_SCHEMA_VERSION. Version 1
 * is the G-9 schema, version 2 adds D-72's columns and table, version 3 adds the `publisher_lease`
 * and `outbox_staged` tables (M1-7k-b; new tables only, so existing rows are untouched). A later
 * schema version appends a migration (ALTER TABLE, new tables) and never edits an earlier one;
 * sqlite-store.test.ts pins the digest of every version, so a TABLES change without a new migration
 * fails the build.
 */
export const MIGRATIONS: readonly StoreMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    statements: createSchemaStatements(
      TABLE_NAMES.filter((t) => !V2_TABLES.includes(t) && !V3_TABLES.includes(t)),
      v1Spec,
    ),
  }),
  Object.freeze({ version: 2, statements: Object.freeze(v2Statements()) }),
  Object.freeze({ version: 3, statements: createSchemaStatements(V3_TABLES) }),
]);

if (MIGRATIONS.at(-1)?.version !== STORE_SCHEMA_VERSION) {
  throw new Error('sqlite store: the migrations do not end at STORE_SCHEMA_VERSION');
}
