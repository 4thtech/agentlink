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
} from './identity.js';
export type { CardInput, SignedCard } from './card.js';
export {
  ContactBook,
  type CardUpdateInput,
  type ContactStatus,
  type ContactView,
  type InboundScreen,
  type InboundSender,
  type PairingState,
} from './contacts.js';
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
// For tests and development (07 §3.1): holds no secret, persists nothing.
export { MemoryStore, type MemoryStoreOptions } from './store/memory-store.js';
