// SEC-KEYSTORE-RECORD-GATE (D-156; 04 §3.1.1, 07 §3.5): the reservation ticket a KeyStore needs to
// sign an OCC v2 Record.
//
// A Record commits the agent to a fee, so the KeyStore itself holds the gate: sign712 refuses every
// Record (sign712Snapshot), and signRecord signs one only with a ticket that this same store issued
// for exactly that Record. Core asks for the ticket inside the store transaction that reserved the
// Record's fee in the budget ledger (06 §3, 07 §3.5), and nowhere else.
//
// Every backend keeps one RecordTicketBook per store instance:
// - issue: the ticket is a fresh frozen object, bound to the EIP-712 digest of the checked snapshot
//   (domain and every field, so the chain, Notary, nonce, fee and deadline are all covered);
// - spend: by identity, never by shape, so a copy, a Proxy or another store's ticket is refused; the
//   ticket is removed before the digest is compared, so it signs at most once, and a try with
//   another Record spends it too.
// Tickets live only in memory and hold no secret; a closed store signs nothing. Errors are the one
// fixed sentence RECORD_TICKET_REFUSED (I-7).
import { encodeHex } from './encoding.js';
import { hashTypedData, type TypedData } from './eip712.js';
import { CryptoInputError } from './errors.js';

/** An opaque, single-use ticket for one Record, issued by KeyStore.issueRecordTicket. */
export interface RecordTicket {
  readonly kind: 'record-ticket';
}

/** The one fixed refusal of KeyStore.signRecord (I-7: it names no input). */
export const RECORD_TICKET_REFUSED = 'signRecord: the record has no valid reservation ticket';

const refused = (): CryptoInputError =>
  new CryptoInputError('record_ticket_refused', RECORD_TICKET_REFUSED);

const digestOf = (snapshot: TypedData): string => encodeHex(hashTypedData(snapshot).digest);

/** The live tickets of one KeyStore instance. Holds digests only, never a key. */
export class RecordTicketBook {
  readonly #live = new WeakMap<object, string>();

  /** A new ticket for the checked Record snapshot (recordSnapshot). */
  issue(snapshot: TypedData): RecordTicket {
    const ticket: RecordTicket = Object.freeze({ kind: 'record-ticket' as const });
    this.#live.set(ticket, digestOf(snapshot));
    return ticket;
  }

  /**
   * Spends `ticket` for the checked Record snapshot, or throws `record_ticket_refused`. A ticket this
   * book did not issue (or already spent) is refused without changing anything; an issued ticket is
   * spent first, then compared, so it never signs a second time or a second Record.
   */
  spend(ticket: unknown, snapshot: TypedData): void {
    if (typeof ticket !== 'object' || ticket === null) throw refused();
    const digest = this.#live.get(ticket);
    if (digest === undefined) throw refused();
    this.#live.delete(ticket);
    if (digest !== digestOf(snapshot)) throw refused();
  }
}
