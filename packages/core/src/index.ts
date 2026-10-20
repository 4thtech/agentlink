// @4thtech-io/core: AgentLinkClient, the Store and ApprovalChannel interfaces, identity and contacts
// (M1-7a). The key interfaces (KeyStore, OwnerKeyStore, OwnerSession) are in @4thtech-io/crypto (G-2).
export const packageName = '@4thtech-io/core';

export { AgentLinkClient, type AgentLinkClientOptions } from './client.js';
export type {
  ApprovalChannel,
  ApprovalChannelStatus,
  ApprovalRequest,
  ApprovalTicket,
} from './approval-channel.js';
export {
  IdentityService,
  type IdentityView,
  type InitIdentityInput,
  type RotateIdentityInput,
  type SendState,
} from './identity.js';
export type { CardInput, SignedCard, StoredCard } from './card.js';
export {
  ContactBook,
  type CardUpdateInput,
  type CompletePairingInput,
  type ContactCheckOutcome,
  type ContactStatus,
  type ContactView,
  type InboundCard,
  type InboundScreen,
  type InboundSender,
  type PairingCompletion,
  type PairingState,
  type PreparedCardUpdate,
  type PreparedCompletion,
  type PreparedStage,
  type ProofPackSigner,
  type StagePairingInput,
  type StagedPairing,
} from './contacts.js';
export {
  EnvelopeService,
  MAX_WRAP_CHECKS,
  PROCESS_BATCH,
  UNOPENED_TYPE,
  type BuildEnvelopeInput,
  type BuiltEnvelope,
  type EnvelopeDestination,
  type InboundOutcome,
  type InboundPairing,
  type InboundReason,
  type PairingHandler,
  type PairingOutcome,
  type InboundReport,
  type ReceiveInput,
  type ReceiveResult,
  type ReceiveStatus,
} from './envelopes.js';
// M1-7c: invites and pairing (04 §3.6, §3.6.1, D-69).
export {
  PairingService,
  type AcceptInviteInput,
  type AcceptInviteResult,
  type CreateInviteInput,
  type CreatedInvite,
  type OwnerSafetyCode,
  type PendingContact,
} from './pairing.js';
export {
  INVITE_INFLATE_SLICE_BYTES,
  INVITE_LINK_PREFIX,
  INVITE_MAX_JSON_BYTES,
  INVITE_MAX_PAYLOAD_CHARS,
  decodeInviteLink,
  encodeInviteLink,
} from './invite-link.js';
export {
  openPairingMessage,
  recomputeSafetyCode,
  verifyPairingTranscript,
  type OpenedPairingMessage,
  type PairingTranscript,
} from './safety-code.js';
// M1-7c-b: `contact.check` verification (04 §2.5.1, §3.6.1); applied by contacts.applyContactCheck.
export {
  checkContactCheckObject,
  storedContactCheckHolds,
  verifyContactCheck,
  type ContactCheckContext,
  type ContactCheckRefusal,
  type ContactCheckVerdict,
  type PairingDigestLookup,
} from './contact-check.js';
export { isRestrictedAlias, renderContactName, restrictName } from './names.js';
export {
  computeActionDigest,
  ownerActionHash,
  ownerActionSigningParts,
  parseOwnerActionText,
  verifyOwnerAction,
  verifyOwnerActionText,
  verifyStoredOwnerAction,
  type ApprovalRequestView,
  type ItemRefusal,
  type ItemRefusalReport,
  type OwnerActionCheckContext,
  type OwnerActionRefusal,
  type OwnerActionVerdict,
} from './owner-action.js';
export {
  OwnerActions,
  type ApprovalCheck,
  type ApprovalReading,
  type OwnerActionOutcome,
  type PolicyRecovery,
  type PolicyVersionMark,
  type ReceiptsKeptMark,
} from './owner-actions.js';
export {
  BUDGET_WINDOW_SECONDS,
  FAIL_CLOSED_CONTACTS,
  FAIL_CLOSED_LIMITS,
  POLICY_DEFAULTS_EFFECTIVE,
  budgetSpentMicros,
  evaluate,
  evaluateFileSend,
  evaluateProof,
  policyLimits,
  type BudgetEntryView,
  type BudgetLedgerView,
  type EffectivePolicy,
  type FileSendAction,
  type FileSendEvaluation,
  type FileSendRefusal,
  type FileStorage,
  type PolicyAction,
  type PolicyContext,
  type PolicyDecision,
  type PolicyDocument,
  type PolicyLimits,
  type PolicyProblem,
  type ProofAction,
  type ProofEvaluation,
  type ProofTrigger,
} from './policy-engine.js';
export {
  checkAndReserveProof,
  readBudgetLedger,
  releaseProofReservation,
  settleProofCharged,
  type ProofCheck,
  type ProofReservation,
  type ReleaseOutcome,
} from './budget.js';
export {
  AUTO_ACCEPT_USD_CURRENCIES,
  checkCommitmentBinding,
  commitmentParts,
  commitmentVoidedByPolicy,
  evaluateCommitment,
  isCommitmentAction,
  policyDocumentHash,
  recheckCommitmentGrant,
  type AutoAcceptMiss,
  type CommitmentBinding,
  type CommitmentBindingRefusal,
  type CommitmentVoidReason,
  type CommitmentEvaluation,
  type CommitmentFacts,
  type CommitmentGrant,
  type CommitmentPart,
  type GrantRecheck,
} from './commitments.js';
export {
  ApprovalService,
  feeContextFromQuote,
  type ApprovalAuthorization,
  type ApprovalRefusal,
  type ApprovalRequestInput,
  type ApprovalResume,
  type ApprovalState,
  type ApprovalUse,
  type CollectOutcome,
  type FeeQuote,
  type OpenApproval,
  type PendingApproval,
} from './approvals.js';
export {
  IdempotencyService,
  type IdempotencyKey,
  type IdempotencyRun,
  type IdempotencyStart,
  type PreparedEffect,
} from './idempotency.js';
// M1-7k: the send pipeline, the Transport adapter and the outbox over the Store (07 §2, §3.2, §4).
export {
  FILE_TOO_LARGE,
  PAYLOAD_TOO_LARGE,
  POLICY_DENIED,
  SEND_TOOL,
  USE_TERMS_TOOLS,
  type SendMessageInput,
  type SendMessageResult,
  type SendMessageType,
} from './send.js';
export {
  nostrTransport,
  type NostrTransportOptions,
  type Transport,
  type TransportDeps,
  type TransportFactory,
  type TransportSubscribeOptions,
  type TransportSyncOptions,
  type TransportUnsubscribe,
} from './transport.js';
export {
  OUTBOX_CLAIM_SECONDS,
  OUTBOX_STAGED_BATCH,
  OutboxService,
  type OutboxPeer,
  type OutboxRoute,
} from './outbox.js';
// M1-7k-b: the per-agent publisher lease (07 §3.2 `publisher_lease`; 06 §6).
export {
  PublisherLease,
  SUBSCRIPTIONS_LEASE,
  type PublisherLeaseOptions,
} from './publisher-lease.js';
export {
  ACK_KIND_RECEIVED,
  DeliveryAcks,
  MAX_ACKS_PER_PASS,
  ackPayload,
  type DeliveryAckStatus,
} from './acks.js';
export {
  CardUpdateSender,
  MAX_CARD_UPDATES_PER_PASS,
  type CardUpdateSendResult,
} from './card-update.js';
export {
  INBOX_PAGE_MAX_LIMIT,
  INBOX_TYPES,
  InboxService,
  PAGE_TYPES,
  type InboundPageItem,
  type InboxCounts,
  type InboxItem,
  type InboxPage,
  type InboxPageFile,
  type InboxPageItem,
  type InboxPageQuery,
  type InboxSender,
  type InboxTermsRef,
  type OutboundPageItem,
} from './inbox.js';
export {
  DEFAULT_SYNC_BUDGET_MS,
  MAX_SYNC_BUDGET_MS,
  StoreSyncPersistence,
  SyncService,
  type CatchUpResult,
  type FetchSummary,
  type InboxProcessed,
  type InboxSubscription,
  type SubscribeInboxOptions,
  type SyncInboxOptions,
  type SyncInboxResult,
} from './sync.js';
export { REQUESTS_FULL, RequestsQueue, queueRefusals, type RequestEntry } from './requests.js';
// M1-32: terms and one approval per agreement (D-55; 06 §2.2a, 04 §3.4, §3.4.2).
export {
  COMMITMENT_SCOPE_SECONDS,
  PROPOSE_TERMS_TOOL,
  RESPOND_TO_TERMS_TOOL,
  TermsService,
  termsChanges,
  type CommitmentCard,
  type DeferredReceipt,
  type KnownRecord,
  type NegotiationSummary,
  type OpenOffer,
  type ProposeTermsInput,
  type ProposeTermsResult,
  type ReceiptState,
  type RecordLookup,
  type RespondDecision,
  type RespondToTermsInput,
  type RespondToTermsResult,
  type TermsChange,
  type TermsCode,
  type TermsPending,
  type TermsRejected,
  type TermsSent,
} from './terms-flow.js';
// Proofs and receipts (M1-7g; 07 §2, §6.2, §8; 06 §2.4). No salt API: salts are drawn by the chain
// package's Record builder only (04 §5, D-61).
export type { ProofChain, ProofKit, ProofsPlatform } from './proofs/platform.js';
export {
  RECEIPT_DEADLINE_SECONDS,
  RECORD_DEADLINE_SECONDS,
  type AcknowledgeInput,
  type AcknowledgeResult,
  type ExportProofPackInput,
  type ExportProofPackResult,
  type NotarizeInput,
  type NotarizeResult,
  type ProofCode,
  type ProofFee,
  type ProofRejected,
  type ProofService,
  type ProofServiceDeps,
  type ProofView,
  type ResubmitSummary,
} from './proofs/service.js';
export {
  TERMS_PAYLOAD_TYPES,
  TermsInbound,
  admitInbound,
  rebuildNegotiations,
  replayOrder,
  type Negotiation,
  type TermsAdmission,
  type TermsInboundHook,
  type TermsInboundInput,
  type TermsRecord,
  type TermsSnapshot,
} from './terms-store.js';
export { type CommitmentPartRow } from './approvals.js';
export { CoreError, StoreConstraintError, StoreUsageError, type CoreErrorCode } from './errors.js';
export * from './constants.js';
export {
  SINGLETON_SLOT,
  TABLES,
  TABLE_NAMES,
  type ColumnKind,
  type ColumnName,
  type ColumnSpec,
  type ColumnValue,
  type PrimaryKey,
  type Row,
  type Sealed,
  type StoreValue,
  type TableName,
  type TableSpec,
  type Tables,
  type UniqueSpec,
} from './store/schema.js';
export {
  rowKeyOf,
  type Condition,
  type SealContext,
  type SelectOptions,
  type Store,
  type StoreCipher,
  type StoreTx,
  type Where,
} from './store/store.js';
// NOT FOR PRODUCTION (IR-M1-7a-1 L-6): for tests and development only. It persists nothing, so a
// restart would forget owner-action nonces, the seen-set and idempotency results. Moving it to a
// test-only subpath needs a boundary-policy change (S1): backlog M1-7a-b.
export { MemoryStore, type MemoryStoreOptions } from './store/memory-store.js';
// M1-15: pure security checks for files and downloads (04 §4). The platform halves (DNS-pinned
// fetch, realpath, exclusive inbox writes) are in @4thtech-io/node.
export {
  MAX_FETCH_REDIRECTS,
  MAX_FETCH_URL_LENGTH,
  checkFetchUrl,
  pickPublicAddress,
  resolveRedirect,
  type CheckedFetchUrl,
  type FetchUrlCheck,
  type FetchUrlRefusal,
} from './fetch-url.js';
export {
  FALLBACK_FILE_NAME,
  MAX_FILE_NAME_BYTES,
  sanitizeFileName,
  withNameSuffix,
} from './file-name.js';
export {
  decidePath,
  expandHome,
  isInsideFolder,
  parseAbsolutePath,
  protectedRoots,
  segmentsBelow,
  type InsideFolderOptions,
  type PathCheck,
  type PathDecisionInput,
  type PathFlavor,
  type PathRefusal,
} from './path-guard.js';
// M1-7f: files (04 §3.4, §4; 06 §2.3; 07 §5.6; D-84, D-85). The platform half (realpath, the SSRF-safe
// fetch and download, the inbox file operations) is supplied by @4thtech-io/node (M1-9d).
export type { DropConfig, FilesPlatform, InboxFolder, OutgoingFile } from './files/platform.js';
export type { FetchFileInput, FetchFileResult } from './files/incoming.js';
export type { FileEntry, FilesNeedsSetup, SentFile } from './files/outgoing.js';
export {
  measurePayload,
  planPacking,
  type PackingBase,
  type PackingFile,
  type PackingPlan,
} from './files/packing.js';
