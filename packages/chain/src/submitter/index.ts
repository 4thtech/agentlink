// The submitter (07 §7; M1-10a): the wire format both sides parse, the local signature check, the
// Worker's chain port (simulation, the gas-key wallet, inclusion) and the client with failover.
export {
  SUBMIT_STATUSES,
  SUBMITTER_MAX_ITEMS,
  SUBMITTER_MAX_SIGNATURE_BYTES,
  isSubmitErrorCode,
  isSubmitSignature,
  isTxHash,
  parseHealthResponse,
  parseStatusResponse,
  parseSubmitRequest,
  parseSubmitResponse,
  submitRequestBody,
  type HealthResponse,
  type StatusResponse,
  type SubmitItem,
  type SubmitItemResult,
  type SubmitKind,
  type SubmitRequest,
  type SubmitResponse,
  type SubmitStatus,
} from './wire.js';
export { itemSignatureMatches } from './signature.js';
export { SUBMITTER_RPC_METHODS } from './rpc.js';
export {
  batchCalldata,
  createSubmitterChain,
  type BatchSimulation,
  type ItemSimulation,
  type SubmitterChain,
  type SendOptions,
  type SubmitterChainOptions,
  type TxInclusion,
} from './port.js';
export {
  MAX_SUBMITTER_URLS,
  SubmitterError,
  createSubmitterClient,
  type SubmitterClient,
  type SubmitterClientOptions,
  type SubmitterErrorCode,
} from './client.js';
export {
  createProofSubmitter,
  readInclusion,
  replacementAllowed,
  type ProofOutcome,
  type ProofSubmitter,
  type ProofSubmitterOptions,
  type ProofVia,
} from './notarize.js';
