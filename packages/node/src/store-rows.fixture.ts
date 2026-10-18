// Test rows for the SQLite store tests (M1-8b). Not part of the build (tsconfig.json excludes
// *.fixture.ts). One valid row per table and index, generated from core's TABLES, with every `enc`
// column sealed through the given cipher and every other column in clear.
import {
  TABLES,
  rowKeyOf,
  type ColumnSpec,
  type Row,
  type Sealed,
  type StoreCipher,
  type StoreValue,
  type TableName,
  type TableSpec,
} from '@4thtech-io/core';

/** The canary every `enc` plaintext carries; no clear value contains it. */
export const CANARY = 'CANARYplain';

export const specOf = (table: TableName): TableSpec =>
  (TABLES as Readonly<Record<string, TableSpec>>)[table] as TableSpec;

/** Tables that hold a single row (maxRows 1). */
export const singleRow = (table: TableName): boolean => specOf(table).maxRows === 1;

function clearValue(table: TableName, column: string, c: ColumnSpec, i: number): StoreValue {
  switch (c.kind) {
    case 'id':
      return `${table}.${column}.${i}`;
    case 'text':
      return `t${i}`;
    case 'int':
      return 1_000 + i;
    case 'flag':
      return i % 2;
    case 'usd':
      return `${i}.5`;
    case 'json':
      return `{"n":${i}}`;
    case 'enum':
      return (c.values ?? [])[0] ?? '';
    case 'enc':
      return null;
  }
}

/** The plaintext of an `enc` column of row `i`. */
export const plaintextOf = (table: TableName, column: string, i: number): string =>
  `${CANARY}:${table}:${column}:${i}`;

/** A complete row of `table` with index `i`; `enc` columns sealed with `cipher`. */
export async function sampleRow<T extends TableName>(
  table: T,
  i: number,
  cipher: StoreCipher,
): Promise<Row<T>> {
  const spec = specOf(table);
  const row: Record<string, StoreValue> = {};
  for (const [column, c] of Object.entries(spec.columns)) {
    row[column] = clearValue(table, column, c, i);
  }
  const rowKey = rowKeyOf(spec.primaryKey.map((k) => row[k] ?? null));
  for (const [column, c] of Object.entries(spec.columns)) {
    if (c.kind !== 'enc') continue;
    row[column] = await cipher.seal({ table, column, rowKey }, plaintextOf(table, column, i));
  }
  return row as Row<T>;
}

/** The `enc` columns of a table. */
export const encColumns = (table: TableName): string[] =>
  Object.entries(specOf(table).columns)
    .filter(([, c]) => c.kind === 'enc')
    .map(([column]) => column);

export const sealed = (s: string): Sealed => s as Sealed;
