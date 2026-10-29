// M1-8b: the SQLite form of the logical store schema (07 §3, §3.1–§3.5; core's TABLES) and its forward
// migrations (07 §3.7). The DDL generator moved to @4thtech-io/core (store/sql-schema.ts, M2-3a) so
// the Durable Object store (apps/cloud-agent) runs exactly the same statements; it is re-exported
// here under its earlier names. The migrations below and their pinned digests (sqlite-store.test.ts)
// stay in this package.
import {
  SQL_MAX_INT,
  SQL_SECOND_LAYER_TRIGGERS,
  STORE_SCHEMA_VERSION,
  TABLE_NAMES,
  createSqlSchemaStatements,
  sqlColumnDef,
  sqlColumnsOf,
  sqlIdent,
  sqlMaxRowsTriggerName,
  sqlTableSpec,
  sqlUniqueIndexName,
  type ColumnSpec,
  type TableName,
  type TableSpec,
} from '@4thtech-io/core';

/** PRAGMA application_id of an AgentLink store ('ALST'), so a foreign SQLite file is refused. */
export const STORE_APPLICATION_ID = 0x414c5354;

/** The largest `int` value (07 §3.1): 2^53 - 1. */
export const MAX_INT = SQL_MAX_INT;

export interface StoreMigration {
  /** The schema version this migration produces; migrations run in order from the stored version. */
  readonly version: number;
  /** Statements run in one transaction, together with the version bump. */
  readonly statements: readonly string[];
}

/** Quotes an identifier. Every name comes from TABLES, never from input. */
export const q = sqlIdent;
export const tableSpec = sqlTableSpec;
export const columnsOf = sqlColumnsOf;
const columnDef = sqlColumnDef;
export const uniqueIndexName = sqlUniqueIndexName;
export const maxRowsTriggerName = sqlMaxRowsTriggerName;
export const SECOND_LAYER_TRIGGERS = SQL_SECOND_LAYER_TRIGGERS;

/**
 * The statements that create the schema of `tables` from an empty database. `specOf` gives each
 * table's spec (default: the current TABLES); a frozen migration passes its own snapshot.
 */
export const createSchemaStatements: (
  tables?: readonly TableName[],
  specOf?: (table: TableName) => TableSpec,
) => readonly string[] = createSqlSchemaStatements;

// --- Frozen snapshots ------------------------------------------------------------------------------

/** Tables added after version 1, and envelope columns added after version 1 (D-72, version 2). */
const V2_TABLES: readonly TableName[] = ['blocked_keys'];
const V2_ENVELOPE_COLUMNS: readonly string[] = ['refused_at', 'request_accepted_at'];
/** Tables added by version 3 (M1-7k-b): the publisher lease (07 §3.2) and staged retries (F08). */
const V3_TABLES: readonly TableName[] = ['publisher_lease', 'outbox_staged'];
/** Files columns added by version 4 (M1-1g-i): the `files.deleteAfter` snapshot. */
const V4_FILES_COLUMNS: readonly string[] = ['delete_after'];
/** Tables added by version 5 (M1-9i-a, D-115): the owner-signed own storage (07 §3.4). */
const V5_TABLES: readonly TableName[] = ['own_storage'];
/** Files columns added by version 6 (MSG-FILES-IO-b): the sealed name a fetched file was saved as. */
const V6_FILES_COLUMNS: readonly string[] = ['saved_name'];
/** Tables added by version 7 (U3-d, D-138): the signed local owner actions (07 §3.4). */
const V7_TABLES: readonly TableName[] = ['local_owner_actions'];
/** Contacts columns added by version 8 (W4-RENAME-REACHES-CONTACTS, D-141): the former name. */
const V8_CONTACTS_COLUMNS: readonly string[] = [
  'former_name',
  'name_changed_at',
  'name_change_seen',
];

/** A table's spec without the given columns: the frozen shape of an earlier version. */
function without(spec: TableSpec, columns: readonly string[]): TableSpec {
  return {
    ...spec,
    columns: Object.fromEntries(
      Object.entries(spec.columns).filter(([column]) => !columns.includes(column)),
    ),
  };
}

/**
 * The version 1 (G-9) schema: today's TABLES without what versions 2 to 6 added. Its statements
 * are pinned by digest in sqlite-store.test.ts, so this snapshot cannot drift.
 */
function v1Spec(table: TableName): TableSpec {
  const spec = tableSpec(table);
  if (table === 'envelopes') return without(spec, V2_ENVELOPE_COLUMNS);
  if (table === 'files') return without(spec, [...V4_FILES_COLUMNS, ...V6_FILES_COLUMNS]);
  if (table === 'contacts') return without(spec, V8_CONTACTS_COLUMNS);
  return spec;
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
 * Version 4 (M1-1g-i): `files.delete_after`, the `files.deleteAfter` in effect when the file was
 * sent, appended. A row stored before version 4 keeps null: no value was recorded, so retention
 * keeps it until it expires and never deletes it on receipt (04 §4, I-9).
 */
function v4Statements(): readonly string[] {
  return addFilesColumns(V4_FILES_COLUMNS);
}

/** `ALTER TABLE "files" ADD COLUMN` for each column, as TABLES defines it (appended, in order). */
function addFilesColumns(columns: readonly string[]): readonly string[] {
  const files = tableSpec('files');
  return columns.map(
    (column) =>
      `ALTER TABLE "files" ADD COLUMN ${columnDef('files', column, files.columns[column] as ColumnSpec)}`,
  );
}

/**
 * Version 6 (MSG-FILES-IO-b): `files.saved_name`, the sealed single name fetchFile saved a received
 * file under, appended. Every existing row keeps null ("not saved yet"); nothing is rewritten. An
 * older build refuses a version 6 file (`store_too_new`), so the upgrade cannot be rolled back.
 */
function v6Statements(): readonly string[] {
  return addFilesColumns(V6_FILES_COLUMNS);
}

/**
 * Version 8 (W4-RENAME-REACHES-CONTACTS, D-141; 07 §3 "Former name"): `contacts.former_name`,
 * `name_changed_at` and `name_change_seen`, appended, all nullable. Every existing row keeps null:
 * no note is due (null reads as seen); nothing is rewritten.
 */
function v8Statements(): readonly string[] {
  const contacts = tableSpec('contacts');
  return V8_CONTACTS_COLUMNS.map(
    (column) =>
      `ALTER TABLE "contacts" ADD COLUMN ${columnDef('contacts', column, contacts.columns[column] as ColumnSpec)}`,
  );
}

/**
 * The forward migrations, oldest first; the last one's version is STORE_SCHEMA_VERSION. Version 1
 * is the G-9 schema, version 2 adds D-72's columns and table, version 3 adds the `publisher_lease`
 * and `outbox_staged` tables (M1-7k-b; new tables only, so existing rows are untouched), version 4
 * adds `files.delete_after` (M1-1g-i; a nullable column, null on existing rows), version 5 adds
 * `own_storage` (M1-9i-a, D-115; a new table with its one-row trigger, existing rows untouched), version
 * 6 adds `files.saved_name` (MSG-FILES-IO-b; a nullable sealed column, null on existing rows), version
 * 7 adds `local_owner_actions` (U3-d, D-138; a new table, existing rows untouched), version 8 adds the
 * contacts former-name columns (W4-RENAME-REACHES-CONTACTS, D-141; nullable, null on existing rows). A later
 * schema version appends a migration (ALTER TABLE, new tables) and never edits an earlier one;
 * sqlite-store.test.ts pins the digest of every version, so a TABLES change without a new migration
 * fails the build.
 */
export const MIGRATIONS: readonly StoreMigration[] = Object.freeze([
  Object.freeze({
    version: 1,
    statements: createSchemaStatements(
      TABLE_NAMES.filter(
        (t) =>
          !V2_TABLES.includes(t) &&
          !V3_TABLES.includes(t) &&
          !V5_TABLES.includes(t) &&
          !V7_TABLES.includes(t),
      ),
      v1Spec,
    ),
  }),
  Object.freeze({ version: 2, statements: Object.freeze(v2Statements()) }),
  Object.freeze({ version: 3, statements: createSchemaStatements(V3_TABLES) }),
  Object.freeze({ version: 4, statements: Object.freeze(v4Statements()) }),
  Object.freeze({ version: 5, statements: createSchemaStatements(V5_TABLES) }),
  Object.freeze({ version: 6, statements: Object.freeze(v6Statements()) }),
  Object.freeze({ version: 7, statements: createSchemaStatements(V7_TABLES) }),
  Object.freeze({ version: 8, statements: Object.freeze(v8Statements()) }),
]);

if (MIGRATIONS.at(-1)?.version !== STORE_SCHEMA_VERSION) {
  throw new Error('sqlite store: the migrations do not end at STORE_SCHEMA_VERSION');
}
