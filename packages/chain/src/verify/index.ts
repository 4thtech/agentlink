// Proof-pack verification (07 §6.2, §8; M1-4d).
export { MAX_PROOF_PACK_BYTES } from './parse.js';
export { recordKindForPayload } from './kind.js';
export {
  PROOF_CONTENT_FAILURES,
  PROOF_NOTICES,
  PROOF_PACK_FAILURES,
  proofFailureMessage,
  proofNoticeMessage,
  type ProofContentFailure,
  type ProofNoticeCode,
  type ProofPackFailure,
} from './reasons.js';
export type { OwnerApprovalResult } from './approval.js';
export type { ReceiptTx } from './receipts.js';
export {
  verifyProofPack,
  type Finality,
  type ProofVerdict,
  type ProofContentResult,
  type ProofNotice,
  type ProofPackInvalid,
  type ProofPackResult,
  type ProofPackValid,
  type VerifiedReceipt,
  type VerifyChain,
  type VerifyProofPackOptions,
} from './verify.js';
