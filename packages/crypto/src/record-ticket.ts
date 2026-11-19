// SEC-KEYSTORE-RECORD-GATE (D-156; 04 §3.1.1, 07 §3.5): the reservation ticket a KeyStore needs to
// sign an OCC v2 Record.

/** An opaque, single-use ticket for one Record, issued by KeyStore.issueRecordTicket. */
export interface RecordTicket {
  readonly kind: 'record-ticket';
}

/** The one fixed refusal of KeyStore.signRecord (I-7: it names no input). */
export const RECORD_TICKET_REFUSED = 'signRecord: the record has no valid reservation ticket';
