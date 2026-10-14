// @agentlink/core: AgentLinkClient, the Store and ApprovalChannel interfaces, identity and contacts
// (M1-7a). The key interfaces (KeyStore, OwnerKeyStore, OwnerSession) are in @agentlink/crypto (G-2).
export const packageName = '@agentlink/core';

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
export { renderContactName, restrictName } from './names.js';
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
