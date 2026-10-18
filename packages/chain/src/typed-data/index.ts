// Record, Receipt and AgentCard builders and their signing through KeyStore.sign712 (07 §6.2).
// The deterministic `assembleRecord` stays inside builders.ts: callers get no way to pass a salt
// or a nonce (04 §5, D-61).
export {
  RECEIPT_TYPE,
  RECORD_KIND,
  agentCardTypedData,
  buildReceipt,
  buildRecord,
  signAgentCard,
  signReceipt,
  signRecord,
  type BuiltReceipt,
  type BuiltRecord,
  type ReceiptInput,
  type ReceiptType,
  type RecordInput,
  type RecordKind,
  type TypedDataSigner,
} from './builders.js';
