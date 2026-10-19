// Fixed failure codes and their plain-language text (07 §8; 11 §5). A proof pack is untrusted input
// (I-5): a result names what failed by code and fixed text only, never a value from the pack, an RPC
// URL or server text (I-7).

/** Why a pack, or its record, does not verify. The pack proves nothing. */
export const PROOF_PACK_FAILURES = Object.freeze([
  'pack_too_large',
  'malformed_pack',
  'unsupported_pack',
  'invalid_kind',
  'envelope_missing',
  'content_key_invalid',
  'unsupported_chain',
  'notary_mismatch',
  'record_id_mismatch',
  'chain_unavailable',
  'record_not_found',
  'malformed_record',
  'signer_mismatch',
  'kind_mismatch',
  'envelope_hash_mismatch',
  'commitment_mismatch',
  'record_mismatch',
  'signature_invalid',
  'card_invalid',
  'card_expired',
  'card_pop_invalid',
  'recipient_mismatch',
  'receipt_not_on_chain',
  'receipt_mismatch',
  'owner_approval_invalid',
] as const);
export type ProofPackFailure = (typeof PROOF_PACK_FAILURES)[number];

/**
 * Why a disclosed content key proves no content (07 §8 steps 1 to 6, then the D-86 kind check), or
 * why it is not attributed to the record signer (M1-4d-b, M1-4d-d): `sender_mismatch` when the
 * signer's card names another sender, `sender_not_bound` when the pack carries no card, and
 * `card_pop_missing` when the card names the sender but the pack carries no proof that the card's
 * agent keys signed it (or the signer is a contract account, D-102). The record and its receipts
 * still verify on their own.
 */
export const PROOF_CONTENT_FAILURES = Object.freeze([
  'envelope_invalid',
  'envelope_hash_mismatch',
  'envelope_signature_invalid',
  'sender_mismatch',
  'sender_not_bound',
  'card_pop_missing',
  'key_commitment_mismatch',
  'decrypt_failed',
  'payload_invalid',
  'kind_mismatch',
] as const);
export type ProofContentFailure = (typeof PROOF_CONTENT_FAILURES)[number];

const MESSAGES: Readonly<Record<ProofPackFailure | ProofContentFailure, string>> = Object.freeze({
  pack_too_large: 'The proof file is too large to check.',
  malformed_pack: 'The proof file is not in the expected format.',
  unsupported_pack: 'This kind or version of proof file is not supported.',
  invalid_kind: 'The proof names a record type that does not exist.',
  envelope_missing: 'The proof shares a content key without the message it opens.',
  content_key_invalid: 'The shared content key has the wrong length.',
  unsupported_chain: 'The proof is from a network this version does not support.',
  notary_mismatch: 'The proof names a different proof contract than the official one.',
  record_id_mismatch: 'The record ID in the proof does not match the record.',
  chain_unavailable: 'The proof network could not be reached. Try again later.',
  record_not_found: 'No such record exists on the proof network.',
  malformed_record: 'The proof network returned a record that cannot be read.',
  signer_mismatch: 'The record on the proof network was made by someone else.',
  kind_mismatch: 'The record type does not match.',
  envelope_hash_mismatch: 'The message fingerprint does not match the record.',
  commitment_mismatch: 'The recipient in the proof does not match the record.',
  record_mismatch: 'The record details in the proof do not match the recorded ones.',
  signature_invalid: 'The signature on the record is not valid for its signer.',
  card_invalid: 'The agent profile in the proof is not signed by its owner.',
  card_expired: 'The agent profile had expired when the record was made.',
  card_pop_invalid: "The agent profile in the proof is not confirmed by the agent's own keys.",
  recipient_mismatch: 'The disclosed recipient does not match the record.',
  receipt_not_on_chain: 'The proof lists a receipt that was never recorded.',
  receipt_mismatch: 'A receipt time in the proof does not match the recorded one.',
  owner_approval_invalid: 'The owner approval in the proof is not valid for this record.',
  envelope_invalid: 'The included message is not in the expected format.',
  envelope_signature_invalid: 'The included message is not signed by its sender.',
  sender_mismatch:
    'The included message was sent by someone other than the agent that made the record.',
  sender_not_bound:
    'The included message opens, but nothing in the proof shows that the agent that made the record sent it.',
  card_pop_missing:
    'The included message opens, but the proof does not confirm that the agent that made the record sent it.',
  key_commitment_mismatch: 'The shared content key is not the key this message was sealed with.',
  decrypt_failed: 'The included message could not be opened with the shared key.',
  payload_invalid: 'The opened message is not in the expected format.',
});

/** The fixed plain-language text for a failure code. */
export function proofFailureMessage(code: ProofPackFailure | ProofContentFailure): string {
  return MESSAGES[code];
}

/**
 * Non-fatal findings (M1-4d-c): the pack still verifies and its verdict is unchanged.
 * - `signer_no_longer_confirms` (D-96): the record signer is a contract account (ERC-1271) whose
 *   `isValidSignature` does not accept the pack's signature now; the Notary checked it when it
 *   stored the record (05 §3.2), and the account's rules may have changed since.
 * - `receipt_tx_mismatch`: a receipt's `txHash` names a transaction whose receipt does not show the
 *   Notary recording that receipt. The receipt itself stands on `getRecord` (05 §3.3); the hash is
 *   not reported.
 */
export const PROOF_NOTICES = Object.freeze([
  'signer_no_longer_confirms',
  'receipt_tx_mismatch',
] as const);
export type ProofNoticeCode = (typeof PROOF_NOTICES)[number];

const NOTICE_MESSAGES: Readonly<Record<ProofNoticeCode, string>> = Object.freeze({
  // Fixed wording of D-96 (11 §5).
  signer_no_longer_confirms:
    "The signer's account no longer confirms this record. The proof network checked it when the record was made.",
  receipt_tx_mismatch:
    "The proof's link for a receipt does not lead to that receipt. The receipt itself is on the proof network.",
});

/** The fixed plain-language text for a notice code. */
export function proofNoticeMessage(code: ProofNoticeCode): string {
  return NOTICE_MESSAGES[code];
}
