// The key interfaces of 03 §3 and 04 §3.1.1 (G-2): EnvelopeKeys, KeyStore, OwnerKeyStore and
// OwnerSession; 04 §2.5 owner presence; 04 §8.1 secret-key operations go through a KeyStore.
//
// G-2: the interfaces live in @agentlink/crypto, not core, so transport-nostr (which depends only on
// crypto) can take them without a dependency cycle. They are types only and hold no secret, so they
// are in the main entry. The in-memory implementations, which hold a seed, are in the test-only
// subpath @agentlink/crypto/testing. Backends: Node keychain and file (packages/node, M1-8a, M1-8f)
// and the self-host Worker (M2-3a).
//
// Contract for every implementation:
// - No method returns a private key or a seed. Signing, NIP-44 key agreement and the CEK unwrap
//   happen inside; callers get public keys, signatures, ciphertext, the plaintext they asked for, or
//   (unwrapCek) the one content key they wipe after use.
// - Signing and encryption always use the current key epoch. Only the decrypting methods and the
//   public-key lookup take an epoch; an epoch above the current one is `epoch_unavailable`.
// - No method signs an untagged digest, and none opens HPKE under a caller-chosen info.
// - Owner signatures exist only on an OwnerSession, and the only way to get one is
//   OwnerKeyStore.unlock(presence). A session is short-lived, and lock, close and expiry wipe its
//   key material.
// - Errors are fixed sentences that never contain an input (I-7).
import type { TypedData } from './eip712.js';
import type { WrappedCek } from './hpke.js';
import type { PublicIdentity } from './keys.js';
import type { JsonObject } from './jcs.js';
import type { NostrEvent, UnsignedNostrEvent } from './nostr-event.js';

/** Why a KeyStore refused an operation for its state, not its input. Stable strings. */
export type KeyStoreErrorCode =
  /** The store was closed and its secrets wiped. */
  | 'keystore_closed'
  /** The owner session expired, was closed, or the owner store was locked. Unlock again. */
  | 'owner_locked'
  /** unlock() got no presence proof of a known kind. */
  | 'presence_required'
  /** The presence proof did not unlock the owner key. */
  | 'presence_rejected'
  /** A key epoch above the store's current epoch. */
  | 'epoch_unavailable'
  /** This backend does not implement the operation yet; it fails closed. */
  | 'unsupported_operation'
  /**
   * A well-formed request this signer will not perform, such as an OwnerSession asked to sign a
   * Nostr kind other than 13 or 22242 (04 §3.1.1). A capability limit, not an input error.
   */
  | 'operation_not_allowed';

/** The error a KeyStore throws for its state. Input refusals stay CryptoInputError. */
export class KeyStoreError extends Error {
  readonly code: KeyStoreErrorCode;

  constructor(code: KeyStoreErrorCode, message: string) {
    super(message);
    this.name = 'KeyStoreError';
    this.code = code;
  }
}

/**
 * The key epoch for a decrypting method or the public-key lookup (04 §2.6, §3.1.1). Defaults to the
 * current epoch. Older epochs stay usable so history remains readable after rotation; an epoch above
 * the current one is refused (`epoch_unavailable`). Signing methods never take one.
 */
export interface EpochOptions {
  readonly epoch?: number;
}

/**
 * The secret-key operations that build and open envelopes (04 §3.1.1, 07 §4.1). The agent's KeyStore
 * and an owner's OwnerSession both implement it, so transport and core use one path for both.
 */
export interface EnvelopeKeys {
  /**
   * The envelope `sig` (04 §3.1.1): BIP-340 by the Nostr key over
   * taggedHash("agentlink/envelope/v1", envelopeHash), as 128 lowercase hex. `envelopeHash` is the
   * 32-byte sha256(JCS(envelope without sig)) of the parsed envelope (M1-1c). The tag is applied
   * here, so no caller gets a signature over an untagged digest.
   */
  signEnvelopeHash(envelopeHash: Uint8Array): Promise<string>;

  /**
   * Signs a Nostr event (NIP-01) with the Nostr key; sets pubkey, id and sig. Seals (kind 13) and
   * NIP-42 AUTH (kind 22242). An OwnerSession signs those two kinds only and refuses every other.
   */
  signNostr(event: UnsignedNostrEvent): Promise<NostrEvent>;

  /**
   * NIP-44 v2 to `peer` (64 lowercase hex x-only key) with the Nostr key; the conversation key is
   * derived and wiped inside. Returns the base64 payload.
   */
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;

  /** NIP-44 v2 from `peer`, with the Nostr key of `options.epoch` (default: current). */
  nip44Decrypt(peer: string, payload: string, options?: EpochOptions): Promise<string>;

  /**
   * Opens one recipient entry (04 §3.3) with the enc key of `options.epoch` (default: current) and
   * returns the 32-byte CEK, the one secret an EnvelopeKeys hands out: callers wipe it after the
   * payload AEAD. The HPKE info is built inside from the 16-byte `envelopeId`
   * ("agentlink/v1/cek" ‖ id), so this is never a general HPKE-open oracle (IR-M1-1c-1 F5).
   */
  unwrapCek(
    wrapped: WrappedCek,
    envelopeId: Uint8Array,
    options?: EpochOptions,
  ): Promise<Uint8Array>;
}

/**
 * The agent's KeyStore (03 §3, 04 §3.1.1). All keys are the agent's own, derived per 04 §2.1, at the
 * current `keyEpoch` for signing and encryption; the EVM key is always epoch 0. It never holds owner
 * keys and never opens an owner entry.
 */
export interface KeyStore extends EnvelopeKeys {
  /** The agent's public identity (04 §2.4 card fields, agentId, kid) at `options.epoch`. */
  getPublicBundle(options?: EpochOptions): Promise<PublicIdentity>;

  /**
   * EIP-712 signature by the agent EVM key (records, receipts, `cardAgentSig`), in the canonical
   * ECDSA form of 04 §2.4.1: `0x` + 130 lowercase hex.
   */
  sign712(typedData: TypedData): Promise<string>;

  /** Wipes what the store holds in memory; every later call fails with `keystore_closed`. */
  close(): Promise<void>;
}

/**
 * A proof of owner presence (04 §2.5): what unlocks the owner key. It carries the secret that
 * unwraps the owner seed, so a process without the owner's input cannot make one that works.
 * The store wipes the bytes it is given, whether or not they unlock it, malformed proofs included.
 *
 * Real backends (M1-8a, M1-8c, M1-8f) collect presence themselves, at an interactive prompt or a
 * native or passkey dialog the agent does not control, and never accept it from an environment
 * variable, a file or agent-reachable code (D-54, IR-M1-1g-1 I-4). This type is the hand-off from
 * that prompt to the store, not an argument for MCP tools or other agent-facing code.
 */
export type OwnerPresence =
  /** The owner passphrase or generated owner code, typed at a prompt the agent does not control. */
  | { readonly kind: 'passphrase'; readonly secret: Uint8Array }
  /** The 32-byte WebAuthn PRF output of the owner passkey (04 §2.3), after the owner's gesture. */
  | { readonly kind: 'passkey-prf'; readonly prfOutput: Uint8Array };

/** The owner's public keys (04 §2.4 card fields). Public; available without presence. */
export interface OwnerPublicKeys {
  /** 20-byte EVM address. */
  readonly ownerEvm: Uint8Array;
  /** 32-byte BIP-340 x-only key. */
  readonly ownerNostr: Uint8Array;
  /** 32-byte X25519 key. */
  readonly ownerEnc: Uint8Array;
}

/** Options for OwnerKeyStore.unlock. */
export interface UnlockOptions {
  /** Session lifetime in milliseconds, 1 to OWNER_SESSION_MAX_TTL_MS. Default 60 s. */
  readonly ttlMs?: number;
}

/** Default owner-session lifetime (proposed: the local UI and the CLI sign within seconds). */
export const OWNER_SESSION_DEFAULT_TTL_MS = 60_000;
/** Longest owner-session lifetime a caller may ask for (proposed). */
export const OWNER_SESSION_MAX_TTL_MS = 300_000;

/**
 * The owner key store (04 §2.5). It signs nothing itself: owner signatures come only from an
 * OwnerSession, and unlock(presence) is the only way to get one. lock() and close() also cancel
 * an unlock that is still in flight: it fails with `owner_locked` instead of returning a session.
 */
export interface OwnerKeyStore {
  /** The owner's public keys. No presence needed. */
  getPublicKeys(): Promise<OwnerPublicKeys>;

  /**
   * Checks the presence proof and returns a short-lived session. Refuses a missing or malformed
   * proof (`presence_required`) and one that does not unlock the key (`presence_rejected`).
   */
  unlock(presence: OwnerPresence, options?: UnlockOptions): Promise<OwnerSession>;

  /** Ends every open session and wipes its key material. The store can be unlocked again. */
  lock(): Promise<void>;

  /** Locks, wipes everything the store holds, and refuses every later call. */
  close(): Promise<void>;
}

/**
 * A short-lived owner handle from OwnerKeyStore.unlock (04 §2.5, §3.1.1). After expiry, close() or the
 * store's lock() or close(), every method fails with `owner_locked`.
 *
 * As EnvelopeKeys it signs and opens the owner channel with the owner Nostr and enc keys: the
 * envelope `sig` and the seal of `approval`, `policy` and `revoke` (in the same gesture as the
 * SignedOwnerAction they carry), NIP-42 AUTH to DM relays, and reading the owner's copies. The owner
 * keys have epoch 0 only (owner-key rotation is P2): any other epoch is `epoch_unavailable`.
 * signNostr signs kinds 13 and 22242 only.
 *
 * A session is a bearer handle: whatever holds it can sign owner actions until it ends. The CLI and
 * the local UI keep it inside the owner flow and never pass it to MCP tools or other agent-reachable
 * code (I-4; IR-M1-1g-1 I-5).
 *
 * Expiry is enforced on a monotonic clock (`performance.now`) and on the wall clock, whichever ends
 * the session first, so setting the system clock back never extends a session (IR-M1-1g-1 L-1).
 */
export interface OwnerSession extends EnvelopeKeys {
  /** When the session ends, in milliseconds since the epoch (Date.now clock). For display only. */
  readonly expiresAt: number;

  /** True until the session expires or is closed or locked. */
  isActive(): boolean;

  /**
   * 04 §2.5.1: BIP-340 by the owner Nostr key over
   * taggedHash("agentlink/owner-action/v1", sha256(JCS(body))), as 128 lowercase hex. `body` is an
   * OwnerAction with `v` = 1 and `owner` equal to this owner's Nostr key (64 lowercase hex). Its
   * strict schema is @agentlink/types (M1-2a, M1-2b); verification is core (M1-7d).
   */
  signOwnerAction(body: JsonObject): Promise<string>;

  /**
   * EIP-712 by the owner EVM key: AgentCard `cardSig` (M1-1e), Registration (M1-1j). Canonical ECDSA,
   * `0x` + 130 lowercase hex (04 §2.4.1).
   */
  sign712(typedData: TypedData): Promise<string>;

  /** Ends this session now and wipes its key material. */
  close(): Promise<void>;
}
