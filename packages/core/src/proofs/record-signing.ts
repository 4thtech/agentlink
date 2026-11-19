// SEC-RECORD-ATOMIC (D-156; 06 §3; 07 §3.5): the only way the proof flow signs a Record. The fee
// is reserved first, in the store transaction that also stores the Record's row in state `signing`
// (no signature); that transaction issues a single-use ticket for the Record. The KeyStore signs
// only with a live ticket whose reservation is still held, and the signature is stored only in a
// second transaction that finds the same reservation still held. So a stored signature never
// exists without its reservation, and a reservation without a stored signature (a crash or a
// signer failure in between) stays reserved: it is released only once the Record can no longer
// land (its deadline passed and the chain shows no record), never earlier.
//
// SEC-KEYSTORE-RECORD-GATE (04 §3.1.1): the gate itself is in the KeyStore. The reserving
// transaction asks the KeyStore for a single-use ticket bound to the digest of exactly this Record
// (KeyStore.issueRecordTicket), and the KeyStore signs a Record only through signRecord with that
// ticket; sign712 refuses every Record. A ticket from here can therefore sign nothing but the Record
// whose fee that transaction reserved, and only once.
import type { BuiltRecord } from '@4thtech-io/chain';
import type { KeyStore, RecordTicket as KeyStoreTicket } from '@4thtech-io/crypto';
import type { Store, StoreTx } from '../store/store.js';

/** A Record row whose fee is reserved and whose signature is not stored yet. */
export const RECORD_SIGNING = 'signing';

/** Issued by `issueRecordTicket` inside the reserving transaction; one signature, then spent. */
export interface RecordTicket {
  readonly recordId: string;
  /** The KeyStore's own ticket for this Record's digest (SEC-KEYSTORE-RECORD-GATE). */
  readonly permit: KeyStoreTicket;
}

const issued = new WeakSet<RecordTicket>();

/** The reservation for this Record is held and its row waits for the signature. */
export function holdsReservation(tx: StoreTx, recordId: string): boolean {
  const entry = tx.select('budget_ledger', { record_id: recordId, state: 'reserved' })[0];
  if (entry === undefined) return false;
  return tx.get('proofs', { record_id: recordId })?.status === RECORD_SIGNING;
}

/**
 * Called inside the transaction that reserved the fee and stored the `signing` row. Undefined when
 * either is missing; the caller then aborts the transaction. Only then does the KeyStore issue its
 * ticket for `built` (synchronous, inside this transaction); a Record the KeyStore refuses throws,
 * which aborts the transaction, so nothing is reserved for it.
 */
export function issueRecordTicket(
  tx: StoreTx,
  keyStore: Pick<KeyStore, 'issueRecordTicket'>,
  built: BuiltRecord,
): RecordTicket | undefined {
  if (!holdsReservation(tx, built.recordId)) return undefined;
  const permit = keyStore.issueRecordTicket(built.typedData);
  const ticket: RecordTicket = Object.freeze({ recordId: built.recordId, permit });
  issued.add(ticket);
  return ticket;
}

/**
 * Signs `built` under its ticket and stores the signed item. Returns the stored `record_json`, or
 * undefined when the reservation no longer holds (before signing: nothing is signed; after: the
 * signature is dropped, never stored or submitted). A signer error propagates and leaves the
 * reservation held. A ticket that was not issued here, was already used, or names another Record
 * is refused before the signer is called.
 */
export async function signUnderReservation(input: {
  readonly store: Store;
  readonly ticket: RecordTicket;
  readonly built: BuiltRecord;
  /** Signs through KeyStore.signRecord with the KeyStore's ticket (`permit`). */
  readonly sign: (built: BuiltRecord, permit: KeyStoreTicket) => Promise<string>;
  /** Encodes the stored item from the signature. */
  readonly encode: (signature: string) => string;
}): Promise<string | undefined> {
  const { store, ticket, built } = input;
  if (!issued.has(ticket) || ticket.recordId !== built.recordId) {
    throw new Error('record signing refused: no reservation ticket');
  }
  issued.delete(ticket);
  const recordId = built.recordId;
  if (!(await store.transaction((tx) => holdsReservation(tx, recordId)))) return undefined;
  const signature = await input.sign(built, ticket.permit);
  const json = input.encode(signature);
  const stored = await store.transaction((tx) => {
    if (!holdsReservation(tx, recordId)) return false;
    tx.update(
      'proofs',
      { record_id: recordId, status: RECORD_SIGNING },
      { status: 'signed', record_json: json },
    );
    // A commitment's Record part (M1-9d-3) keeps the item as stored.
    tx.update('commitment_parts', { part: 'record', item_ref: recordId }, { item_json: json });
    return true;
  });
  return stored ? json : undefined;
}
