// Proof-pack verification (07 §6.2, §8; M1-4d).
export { MAX_PROOF_PACK_BYTES } from './parse.js';
export { recordKindForPayload } from './kind.js';
export {
  PROOF_CONTENT_FAILURES,
  PROOF_PACK_FAILURES,
  proofFailureMessage,
  type ProofContentFailure,
  type ProofPackFailure,
} from './reasons.js';
export {
  verifyProofPack,
  type ProofContentResult,
  type ProofPackInvalid,
  type ProofPackResult,
  type ProofPackValid,
  type VerifiedReceipt,
  type VerifyChain,
  type VerifyProofPackOptions,
} from './verify.js';
