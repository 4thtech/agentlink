/**
 * Why the transport refused an envelope or an inbound event. Stable strings: callers branch on
 * `code`, never on the message.
 */
export type TransportErrorCode =
  /** A bad argument that is not an envelope or an event (for example a clock value). */
  | 'invalid_argument'
  /** Send: the envelope fails the strict v1 parser (M1-1c). Receive: the rumor content does. */
  | 'invalid_envelope'
  /** The envelope (rumor `content`) is over 24 576 bytes of UTF-8 (04 §3.1.1), checked before parsing. */
  | 'envelope_too_large'
  /** A recipient list that is empty, has more than 8 distinct keys, or a key that is not a BIP-340 key. */
  | 'invalid_recipient'
  /** The seal key is not `envelope.from` (04 §3.5): on send the keys are not the sender's. */
  | 'sender_mismatch'
  /** The gift wrap is not a well-formed, validly signed kind 1059 event. */
  | 'invalid_gift_wrap'
  /** NIP-44 decryption of the gift wrap or of the seal failed. */
  | 'decrypt_failed'
  /** The seal is not a well-formed, validly signed kind 13 event with no tags. */
  | 'invalid_seal'
  /** The rumor is not a well-formed unsigned kind 14 event whose id is its NIP-01 id. */
  | 'invalid_rumor'
  /** The rumor key is not the seal key (NIP-59). */
  | 'rumor_mismatch'
  /** The rumor has no `["agentlink", "1"]` tag. */
  | 'missing_agentlink_tag';

/**
 * The one error type the transport throws for an envelope or event it refuses.
 *
 * I-7: the message is a fixed sentence. It never contains the input or any part of it (keys,
 * ciphertext, envelope fields, event ids), and no cause is attached, because errors reach logs and
 * tool results. KeyStore state errors (KeyStoreError) pass through unchanged.
 */
export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}
