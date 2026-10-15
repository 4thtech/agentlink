// The Store interface (03 §3, 07 §3.7) and the StoreCipher that seals `enc` columns (07 §3.1).
//
// Contract every implementation keeps (07 §3.1, §3.7):
// - One logical schema (schema.ts) with its keys, unique constraints, enums, value types and row
//   counts, enforced by the store itself. A write that breaks one throws StoreConstraintError and
//   changes nothing.
// - `transaction(body)`: serializable and all-or-nothing across tables. The body is synchronous: no
//   network, no KeyStore call, no `await` and no `enc` encryption inside it (values are sealed before
//   and opened after). A body that returns a promise is refused and its writes are discarded. If the
//   body throws, nothing it wrote is kept. Nothing is visible to another transaction before commit.
// - `update` and `delete` report how many rows they changed, so a compare-and-set is an update whose
//   `where` holds the expected values and whose count the caller checks.
// - The store never reads a clock: the core passes `now` into every comparison (Where on times).
// - Forward migrations only: a store whose schema version is newer than the code refuses to open,
//   and is never downgraded (the core checks `schemaVersion`, client.ts).
// - Fail closed: a read error throws; it never comes back as an absent or empty row.
//
// Rules the core enforces inside its store transactions, not the schema (IR-M1-7a-1 L-5; a SQLite
// store may add triggers as a second layer):
// - an envelope ID is unique across `envelopes` and `held_envelopes` (07 §3.2; M1-7b);
// - per scope_key, at most one approved scope with a part still `unclaimed` (§3.5; M1-7e, M1-32);
// - `revoked_agents` rows are never deleted, and contact status `revoked` is final (§3.4; M1-7a for
//   contacts, M1-7d for the revoke path);
// - a contact's keys are not claimed by another card (contacts.ts, M1-7a);
// - pruning per table with its retention (§3.7) runs in its own transaction (M1-7b, M1-8b).
import type { ColumnName, PrimaryKey, Row, Sealed, StoreValue, TableName } from './schema.js';

/** A condition on one column. A bare value means equality; `null` matches only null. */
export type Condition<V> =
  | V
  | {
      readonly ne?: V;
      readonly lt?: V;
      readonly lte?: V;
      readonly gt?: V;
      readonly gte?: V;
      readonly in?: readonly V[];
    };

/** A conjunction of column conditions. An empty object matches every row. */
export type Where<T extends TableName> = {
  readonly [K in keyof Row<T>]?: Condition<Row<T>[K]>;
};

export interface SelectOptions<T extends TableName> {
  /** Sort keys in order; numbers compare numerically, text by code unit (bytes for ASCII ids). */
  readonly orderBy?: readonly (readonly [ColumnName<T>, 'asc' | 'desc'])[];
  readonly limit?: number;
}

/** The operations inside one transaction. Rows are returned frozen; a row is never a live view. */
export interface StoreTx {
  get<T extends TableName>(table: T, key: PrimaryKey<T>): Row<T> | undefined;
  select<T extends TableName>(table: T, where?: Where<T>, options?: SelectOptions<T>): Row<T>[];
  count<T extends TableName>(table: T, where?: Where<T>): number;
  /** Inserts one complete row. Throws StoreConstraintError on any schema violation. */
  insert<T extends TableName>(table: T, row: Row<T>): void;
  /** Sets `patch` on every row that matches; returns the number of rows changed. */
  update<T extends TableName>(table: T, where: Where<T>, patch: Partial<Row<T>>): number;
  /** Deletes every row that matches; returns the number of rows deleted. */
  delete<T extends TableName>(table: T, where: Where<T>): number;
}

export interface Store {
  /** The logical schema version of this store's data (07 §3.7). */
  readonly schemaVersion: number;
  /** Runs `body` as one serializable, all-or-nothing transaction (07 §3.1). */
  transaction<R>(body: (tx: StoreTx) => R): Promise<R>;
  close(): Promise<void>;
}

/** Where a sealed value lives: its AAD binds it to the table, the column and the row key (07 §3.1). */
export interface SealContext {
  readonly table: TableName;
  readonly column: string;
  /** rowKeyOf(...) of the row's primary key. */
  readonly rowKey: string;
}

/**
 * Seals and opens `enc` columns under the store key with AES-256-GCM through @agentlink/crypto (07
 * §3.1; the Node and Durable Object implementations land with M1-8b and M2-3a). `open` throws for a
 * value that does not open, including one copied from another row or column; it never returns an
 * empty string in its place.
 */
export interface StoreCipher {
  seal(context: SealContext, plaintext: string): Promise<Sealed>;
  open(context: SealContext, sealed: Sealed): Promise<string>;
  /**
   * HMAC-SHA256 of `data` under the store's index key, as 64 lowercase hex (07 §3.1 keyed digests;
   * `idempotency.request_digest`, §3.3). Optional in the interface: without it, idempotency fails
   * closed (M1-7e). The Node cipher (M1-8b) provides it.
   */
  indexDigest?(data: Uint8Array): Promise<string>;
}

/** The canonical row key for a SealContext: the primary-key values in key order, as JSON. */
export function rowKeyOf(values: readonly StoreValue[]): string {
  return JSON.stringify(values);
}
