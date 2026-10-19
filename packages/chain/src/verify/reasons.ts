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
  'signer_mismatch',
  'kind_mismatch',
  'envelope_hash_mismatch',
  'commitment_mismatch',
  'record_mismatch',
  'signature_invalid',
  'recipient_mismatch',
  'receipt_not_on_chain',
  'receipt_mismatch',
] as const);
export type ProofPackFailure = (typeof PROOF_PACK_FAILURES)[number];

/**
 * Why a disclosed content key proves no content (07 §8 steps 1 to 6, then the D-86 kind check). The
 * record and its receipts still verify on their own.
 */
export const PROOF_CONTENT_FAILURES = Object.freeze([
  'envelope_invalid',
  'envelope_hash_mismatch',
  'envelope_signature_invalid',
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
  signer_mismatch: 'The record on the proof network was made by someone else.',
  kind_mismatch: 'The record type does not match.',
  envelope_hash_mismatch: 'The message fingerprint does not match the record.',
  commitment_mismatch: 'The recipient in the proof does not match the record.',
  record_mismatch: 'The record details in the proof do not match the recorded ones.',
  signature_invalid: 'The signature on the record is not valid for its signer.',
  recipient_mismatch: 'The disclosed recipient does not match the record.',
  receipt_not_on_chain: 'The proof lists a receipt that was never recorded.',
  receipt_mismatch: 'A receipt time in the proof does not match the recorded one.',
  envelope_invalid: 'The included message is not in the expected format.',
  envelope_signature_invalid: 'The included message is not signed by its sender.',
  key_commitment_mismatch: 'The shared content key is not the key this message was sealed with.',
  decrypt_failed: 'The included message could not be opened with the shared key.',
  payload_invalid: 'The opened message is not in the expected format.',
});

/** The fixed plain-language text for a failure code. */
export function proofFailureMessage(code: ProofPackFailure | ProofContentFailure): string {
  return MESSAGES[code];
}
