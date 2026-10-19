// The fixed Record kind for a payload (05 §3.1 kind mapping; G-13, D-86). A recipient checks it
// before signing a receipt, and a verifier with a disclosed content key checks it after 07 §8 step 6.
import { RECORD_KINDS, type Payload } from '@4thtech-io/types';

/** The kind the core sets for this payload, or null for a type that is never notarized. */
export function recordKindForPayload(payload: Payload): number | null {
  switch (payload.type) {
    case 'offer':
      return RECORD_KINDS.OFFER;
    case 'accept':
      return RECORD_KINDS.ACCEPT;
    case 'delivery':
      return RECORD_KINDS.DELIVERY;
    case 'note':
      return RECORD_KINDS.NOTE;
    case 'file':
      return RECORD_KINDS.FILE;
    case 'text':
    case 'request':
      return payload.files.length > 0 ? RECORD_KINDS.FILE : RECORD_KINDS.MESSAGE;
    case 'reject':
      return RECORD_KINDS.MESSAGE;
    default:
      // ack, handshake, handshake-ack, proof, approval, approval-request, policy, card-update,
      // revoke: NOT_NOTARIZABLE, so no record of any kind can carry them.
      return null;
  }
}
