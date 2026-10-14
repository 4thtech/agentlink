// @agentlink/transport-nostr: the Nostr Transport (07 §4). M1-5a adds the gift wrap and unwrap
// (04 §3.5, §3.1.1); M1-5b adds the relay pool, publish and outbox delivery (07 §4.2, §4.3); the
// subscription and sync follow in M1-5c.
export const packageName = '@agentlink/transport-nostr';

export { TransportError, type TransportErrorCode } from './errors.js';
export {
  AGENTLINK_TAG,
  ENVELOPE_MAX_BYTES,
  GIFT_WRAP_MAX_BACKDATE_SECONDS,
  NOSTR_KIND_RUMOR,
  randomPastTimestamp,
  unwrapGiftWrap,
  wrapEnvelope,
  type GiftWrap,
  type UnwrappedEnvelope,
  type WrapOptions,
  type WrappedEnvelope,
} from './gift-wrap.js';
export { isGloballyRoutable } from './relay-address.js';
export type {
  AddressCheck,
  HostResolver,
  Nip11Fetcher,
  RelayConnector,
  RelaySocket,
  RelaySocketHandlers,
  RelayTarget,
  Timers,
} from './relay-io.js';
export {
  CONNECT_TIMEOUT_MS,
  IDLE_CLOSE_MS,
  MAX_CONNECTIONS,
  MAX_FRAME_BYTES,
  MAX_RELAYS_PER_WRAP,
  MIN_ACKS,
  NIP11_MAX_BYTES,
  OK_TIMEOUT_MS,
  RelayPool,
  type FrameListener,
  type PublishOutcome,
  type RelayFailure,
  type RelayHealth,
  type RelayPoolOptions,
  type RelayPublishResult,
} from './relay-pool.js';
export {
  OUTBOX_GIVE_UP_SECONDS,
  OutboxWorker,
  type OutboxAttempt,
  type OutboxGiveUpReason,
  type OutboxPersistence,
  type OutboxRow,
  type OutboxSummary,
  type OutboxWorkerOptions,
} from './outbox.js';
