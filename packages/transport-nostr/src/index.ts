// @agentlink/transport-nostr: the Nostr Transport (07 §4). M1-5a adds the gift wrap and unwrap
// (04 §3.5, §3.1.1); the relay pool, publish and sync follow in M1-5b and M1-5c.
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
