// Deterministic test seam (M1-1c, M1-1f) and the in-memory KeyStore doubles (M1-1g): the same code
// supplied by the caller, plus raw primitives for published vectors. Only tests and the vector
// harness use it.
// - M1-1c: wrapCek and encryptPayload with a fixed HPKE ephemeral key or AES-GCM IV, and the raw
//   RFC 9180 suite (hpkeSealSequence, hpkeOpen with any info) for the published CFRG vectors.
// - M1-1f: sealKeystoreFile and sealOwnerSeed with a fixed nonce, Argon2id with a secret value (K)
//   and associated data (X) for the RFC 9106 vector, and pairingDigest for the `labels` vectors.
// - M1-1g: MemoryKeyStore and MemoryOwnerKeyStore, in-memory KeyStore doubles that hold a seed in
//   plain memory (below; IR-M1-1g-G2-1 M-2: one test seam, one policy entry).
//
// It never ships: this file is excluded from the build (tsconfig.json), so dist/ has no testing.js;
// package.json `exports` has no ./testing entry, so no consumer can resolve it; and the boundary
// guards allow `@agentlink/crypto/testing` only in test-vectors/, whose Vitest config maps it to this
// source file (tools/deps-check/policy.mjs RESTRICTED_ENTRY_POINTS). A fixed ephemeral key, nonce or
// IV in production would break HPKE and AES-GCM, so nothing outside tests may reach these functions.
import { argon2idRaw, type Argon2idParams } from './argon2.js';
import { bip340PublicKey, bip340Sign } from './bip340.js';
import { assertBytes, equalBytes } from './bytes.js';
import { decodeHex, encodeHex, encodeUtf8 } from './encoding.js';
import { signTypedData, type TypedData } from './eip712.js';
import { CryptoInputError } from './errors.js';
import { TAGS, sha256, taggedHash } from './hash.js';
import { unwrapCek as unwrapCekWithKey, type WrappedCek } from './hpke.js';
import { canonicalize, parseJson, type JsonObject } from './jcs.js';
import {
  KEY_LABELS,
  MASTER_SEED_LENGTH,
  MAX_KEY_EPOCH,
  derivePublicIdentity,
  derivePublicKey,
  deriveSecretKey,
  type PublicIdentity,
} from './keys.js';
import {
  KeyStoreError,
  OWNER_SESSION_DEFAULT_TTL_MS,
  OWNER_SESSION_MAX_TTL_MS,
  type EpochOptions,
  type KeyEpochControl,
  type KeyStore,
  type OwnerKeyStore,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
  type UnlockOptions,
} from './keystore-api.js';
import { nip44ConversationKey, nip44DecryptWithKey, nip44EncryptWithKey } from './nip44.js';
import {
  NOSTR_KIND_AUTH,
  NOSTR_KIND_SEAL,
  signNostrEvent,
  signedFields,
  type NostrEvent,
  type UnsignedNostrEvent,
} from './nostr-event.js';
import { wipe } from './wipe.js';

export { hpkeOpen, hpkeSealSequence, wrapCekWithEphemeralKey, type HpkeSealed } from './hpke.js';
export { encryptPayloadWithIv } from './aead.js';

export {
  sealKeystoreFileWithNonceUnsafe as sealKeystoreFileWithNonce,
  sealOwnerSeedWithNonceUnsafe as sealOwnerSeedWithNonce,
} from './keystore-file.js';

// IR-M1-1f-1 L-7: pairingDigest without the commitment check is not public; the `labels` vectors
// (the same input under both tags) reach it here.
export { pairingDigest } from './safety-code.js';

/** RFC 9106 Argon2id v1.3 with K and X (empty = none) and any output length from 4 to 1024. */
export function argon2idWithSecretAndAd(
  password: Uint8Array,
  salt: Uint8Array,
  params: Argon2idParams,
  extras: { readonly secret: Uint8Array; readonly ad: Uint8Array; readonly length: number },
): Promise<Uint8Array> {
  return argon2idRaw(password, salt, params, extras);
}

// --- M1-1g: in-memory KeyStores ---------------------------------------------------------------
// In-memory KeyStore and OwnerKeyStore (M1-1g). NOT FOR PRODUCTION: for tests and development, and
// as the reference the real backends (keychain, file, Worker) are checked against.
//
// Why not for production: the seed sits in process memory for the store's whole life, and a
// MemoryOwnerKeyStore holds the owner seed next to the presence secret that "unlocks" it, so its
// presence check proves nothing against a process that can read that memory (04 §2.2, §2.5). Real
// owner backends keep the owner seed wrapped and unwrap it only with the presented secret.
//
// What it does guarantee: no method returns a seed or secret key; the seed lives in a private
// field; secret keys are derived per operation and wiped in `finally`; close() wipes the seed copy;
// owner sessions hold their own key copies, which lock, close and expiry wipe (04 §8.3, best effort).
//
// Caller-supplied objects are read once into a snapshot, and the snapshot is what is checked and
// used (IR-M1-1g-G2-1 M-1).

function copySeed(seed: unknown, what: string): Uint8Array {
  assertBytes(seed, what);
  if (seed.length !== MASTER_SEED_LENGTH) {
    throw new CryptoInputError('invalid_length', `${what} must be 32 bytes`);
  }
  return seed.slice();
}

function assertEpoch(epoch: unknown): asserts epoch is number {
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0 || epoch > MAX_KEY_EPOCH) {
    throw new CryptoInputError(
      'invalid_argument',
      'keystore: the epoch must be an integer from 0 to 2^32 - 1',
    );
  }
}

/** A peer's x-only Nostr key: exactly 64 lowercase hex characters (04 §2.4.1, NIP-01). */
function peerKey(peer: string): Uint8Array {
  return decodeHex(peer, { length: 32 });
}

/** 04 §3.1.1: BIP-340 over taggedHash("agentlink/envelope/v1", envelopeHash), 128 lowercase hex. */
function envelopeSig(secretKey: Uint8Array, envelopeHash: Uint8Array): string {
  assertBytes(envelopeHash, 'signEnvelopeHash: envelopeHash');
  // A plain copy of the real bytes: a subclass cannot report one length and sign another (M-1).
  const hash = new Uint8Array(envelopeHash);
  if (hash.length !== 32) {
    throw new CryptoInputError('invalid_length', 'signEnvelopeHash: envelopeHash must be 32 bytes');
  }
  return encodeHex(bip340Sign(secretKey, taggedHash(TAGS.envelope, hash)));
}

/** NIP-44 v2 under secretKey x peer; the conversation key is wiped afterwards. */
function withConversationKey<T>(
  secretKey: Uint8Array,
  peer: string,
  fn: (conversationKey: Uint8Array) => T,
): T {
  const conversationKey = nip44ConversationKey(secretKey, peerKey(peer));
  try {
    return fn(conversationKey);
  } finally {
    wipe(conversationKey);
  }
}

/** Runs `fn` with a freshly derived secret key and wipes the key afterwards. */
function withSecret<T>(
  seed: Uint8Array,
  label: (typeof KEY_LABELS)[keyof typeof KEY_LABELS],
  epoch: number,
  fn: (secretKey: Uint8Array) => T,
): T {
  const secretKey = deriveSecretKey(seed, label, epoch);
  try {
    return fn(secretKey);
  } finally {
    wipe(secretKey);
  }
}

/** The async form of withSecret: the key is wiped only after `fn` settles. */
async function withSecretAsync<T>(
  seed: Uint8Array,
  label: (typeof KEY_LABELS)[keyof typeof KEY_LABELS],
  epoch: number,
  fn: (secretKey: Uint8Array) => Promise<T>,
): Promise<T> {
  const secretKey = deriveSecretKey(seed, label, epoch);
  try {
    return await fn(secretKey);
  } finally {
    wipe(secretKey);
  }
}

/**
 * Plain copies of a recipient entry and an envelope id, each field read once (M-1). Lengths and the
 * open itself are M1-1c's unwrapCek, which builds the HPKE info from the id.
 */
function entrySnapshot(
  wrapped: unknown,
  envelopeId: unknown,
): { wrapped: WrappedCek; envelopeId: Uint8Array } {
  if (typeof wrapped !== 'object' || wrapped === null) {
    throw new CryptoInputError('invalid_argument', 'unwrapCek: wrapped must be {enc, wk}');
  }
  const { enc, wk } = wrapped as Record<string, unknown>;
  assertBytes(enc, 'unwrapCek: enc');
  assertBytes(wk, 'unwrapCek: wk');
  assertBytes(envelopeId, 'unwrapCek: envelopeId');
  return {
    wrapped: { enc: new Uint8Array(enc), wk: new Uint8Array(wk) },
    envelopeId: new Uint8Array(envelopeId),
  };
}

/** Options for MemoryKeyStore. */
export interface MemoryKeyStoreOptions {
  /** The current key epoch (04 §2.6). Default 0. */
  readonly keyEpoch?: number;
}

/**
 * The owner-session guard of KeyEpochControl.advanceEpoch (M1-1g-d): a live OwnerSession is
 * required. It is a capability check (I-4), not proof of which owner holds it; core binds the
 * session to the agent's owner by having it sign the next card first (keystore-api.ts).
 */
function assertLiveSession(owner: unknown): void {
  if (
    typeof owner !== 'object' ||
    owner === null ||
    typeof (owner as { isActive?: unknown }).isActive !== 'function'
  ) {
    throw new KeyStoreError('presence_required', 'owner keystore: a presence proof is required');
  }
  if ((owner as OwnerSession).isActive() !== true) {
    throw new KeyStoreError('owner_locked', 'owner keystore: the owner session has ended');
  }
}

const epochConflict = (): KeyStoreError =>
  new KeyStoreError('epoch_conflict', 'keystore: the key epoch is not the expected one');
const epochUnavailable = (): KeyStoreError =>
  new KeyStoreError('epoch_unavailable', 'keystore: that key epoch is not available');

/**
 * A KeyStore over a 32-byte master seed held in memory. NOT FOR PRODUCTION (see the file header).
 * The constructor copies the seed; the caller may wipe its own buffer at once.
 *
 * It is also the reference KeyEpochControl (M1-1g-d): the epoch changes only in advanceEpoch, whose
 * check and set run in one synchronous step, so concurrent advances from one epoch cannot both win.
 * Being in memory, it has nothing to make durable; real backends must (keystore-api.ts).
 */
export class MemoryKeyStore implements KeyStore, KeyEpochControl {
  readonly #seed: Uint8Array;
  #keyEpoch: number;
  #closed = false;

  constructor(masterSeed: Uint8Array, options: MemoryKeyStoreOptions = {}) {
    const keyEpoch = options.keyEpoch ?? 0;
    assertEpoch(keyEpoch);
    this.#seed = copySeed(masterSeed, 'MemoryKeyStore: the master seed');
    this.#keyEpoch = keyEpoch;
  }

  #open(): Uint8Array {
    if (this.#closed) throw new KeyStoreError('keystore_closed', 'keystore: the store is closed');
    return this.#seed;
  }

  /** The epoch of a lookup or decryption: default current, never above it (04 §3.1.1). */
  #epochOf(options: EpochOptions | undefined): number {
    const epoch = options?.epoch ?? this.#keyEpoch;
    assertEpoch(epoch);
    if (epoch > this.#keyEpoch) throw epochUnavailable();
    return epoch;
  }

  previewEpoch(epoch: number): Promise<PublicIdentity> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      assertEpoch(epoch);
      if (epoch <= this.#keyEpoch) throw epochConflict();
      if (epoch !== this.#keyEpoch + 1) throw epochUnavailable();
      return derivePublicIdentity(seed, epoch);
    });
  }

  advanceEpoch(expected: number, owner: OwnerSession): Promise<PublicIdentity> {
    return Promise.resolve().then(() => {
      // One synchronous step from the check to the set: the compare-and-set is atomic.
      const seed = this.#open();
      assertEpoch(expected);
      assertLiveSession(owner);
      if (expected !== this.#keyEpoch) throw epochConflict();
      if (expected === MAX_KEY_EPOCH) throw epochUnavailable();
      const bundle = derivePublicIdentity(seed, expected + 1);
      this.#keyEpoch = expected + 1;
      return bundle;
    });
  }

  getPublicBundle(options?: EpochOptions): Promise<PublicIdentity> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      return derivePublicIdentity(seed, this.#epochOf(options));
    });
  }

  signNostr(event: UnsignedNostrEvent): Promise<NostrEvent> {
    return Promise.resolve().then(() =>
      withSecret(this.#open(), KEY_LABELS.nostr, this.#keyEpoch, (secretKey) =>
        signNostrEvent(secretKey, event),
      ),
    );
  }

  signEnvelopeHash(envelopeHash: Uint8Array): Promise<string> {
    return Promise.resolve().then(() =>
      withSecret(this.#open(), KEY_LABELS.nostr, this.#keyEpoch, (secretKey) =>
        envelopeSig(secretKey, envelopeHash),
      ),
    );
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      return withSecret(seed, KEY_LABELS.nostr, this.#keyEpoch, (secretKey) =>
        withConversationKey(secretKey, peer, (key) => nip44EncryptWithKey(key, plaintext)),
      );
    });
  }

  nip44Decrypt(peer: string, payload: string, options?: EpochOptions): Promise<string> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      const epoch = this.#epochOf(options);
      return withSecret(seed, KEY_LABELS.nostr, epoch, (secretKey) =>
        withConversationKey(secretKey, peer, (key) => nip44DecryptWithKey(key, payload)),
      );
    });
  }

  unwrapCek(
    wrapped: WrappedCek,
    envelopeId: Uint8Array,
    options?: EpochOptions,
  ): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      const epoch = this.#epochOf(options);
      const entry = entrySnapshot(wrapped, envelopeId);
      return withSecretAsync(seed, KEY_LABELS.enc, epoch, (secretKey) =>
        unwrapCekWithKey(secretKey, entry.wrapped, entry.envelopeId),
      );
    });
  }

  sign712(typedData: TypedData): Promise<string> {
    // The EVM key exists only at epoch 0 (04 §2.1), whatever the current key epoch.
    return Promise.resolve().then(() =>
      withSecret(this.#open(), KEY_LABELS.evm, 0, (secretKey) =>
        signTypedData(typedData, secretKey),
      ),
    );
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      wipe(this.#seed);
    }
    return Promise.resolve();
  }
}

// --- Owner -----------------------------------------------------------------------------------------

/**
 * The kind and secret bytes of a presence proof. A malformed proof is refused with
 * `presence_required`; with `wipeRefused`, any byte array it carries is wiped first, so a refused
 * secret does not linger either (IR-M1-1g-1 I-1).
 */
function presenceBytes(
  presence: unknown,
  wipeRefused: boolean,
): { kind: OwnerPresence['kind']; bytes: Uint8Array } {
  const required = (): KeyStoreError =>
    new KeyStoreError('presence_required', 'owner keystore: a presence proof is required');
  if (typeof presence !== 'object' || presence === null) throw required();
  const { kind, secret, prfOutput } = presence as Record<string, unknown>;
  if (kind === 'passphrase' && secret instanceof Uint8Array && secret.length > 0) {
    return { kind, bytes: secret };
  }
  if (kind === 'passkey-prf' && prfOutput instanceof Uint8Array && prfOutput.length === 32) {
    return { kind, bytes: prfOutput };
  }
  if (wipeRefused) {
    for (const value of [secret, prfOutput]) if (value instanceof Uint8Array) wipe(value);
  }
  throw required();
}

function assertTtl(ttlMs: unknown): asserts ttlMs is number {
  if (
    typeof ttlMs !== 'number' ||
    !Number.isInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > OWNER_SESSION_MAX_TTL_MS
  ) {
    throw new CryptoInputError(
      'invalid_argument',
      'owner keystore: ttlMs must be an integer from 1 to OWNER_SESSION_MAX_TTL_MS',
    );
  }
}

/** The timer functions every supported runtime has; the package compiles without DOM or Node types. */
interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const timers = globalThis as unknown as Timers;

/**
 * A monotonic clock in milliseconds (`performance.now`, present in Node, browsers and workerd), so a
 * system clock set back cannot extend a session (IR-M1-1g-1 L-1). Without it, fall back to the
 * wall clock, which the session checks anyway.
 */
function monotonicNow(): number {
  const performance = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

/** Module-private: only MemoryOwnerKeyStore.unlock can construct a session. */
const SESSION_TOKEN = Symbol('MemoryOwnerSession');

/** The owner secret keys a session holds (epoch 0 only, 04 §3.1.1). */
interface SessionKeys {
  readonly nostr: Uint8Array;
  readonly evm: Uint8Array;
  readonly enc: Uint8Array;
}

/** The only Nostr kinds an owner session signs: the seal and NIP-42 AUTH (04 §3.1.1). */
const OWNER_SESSION_KINDS: readonly number[] = [NOSTR_KIND_SEAL, NOSTR_KIND_AUTH];

class MemoryOwnerSession implements OwnerSession {
  readonly expiresAt: number;
  readonly #deadline: number;
  readonly #ownerNostrHex: string;
  #keys: SessionKeys | null;
  #timer: unknown;
  readonly #onEnd: (session: MemoryOwnerSession) => void;

  constructor(
    token: symbol,
    keys: SessionKeys,
    ownerNostrHex: string,
    ttlMs: number,
    onEnd: (session: MemoryOwnerSession) => void,
  ) {
    if (token !== SESSION_TOKEN) {
      throw new KeyStoreError('presence_required', 'owner keystore: a presence proof is required');
    }
    this.#keys = keys;
    this.#ownerNostrHex = ownerNostrHex;
    this.#onEnd = onEnd;
    this.expiresAt = Date.now() + ttlMs;
    this.#deadline = monotonicNow() + ttlMs;
    // Wipe at expiry even if the handle is never used again. unref: never keep Node alive for it.
    const timer = timers.setTimeout(() => {
      this.end();
    }, ttlMs);
    (timer as { unref?: () => void }).unref?.();
    this.#timer = timer;
  }

  isActive(): boolean {
    // Whichever clock says the session is over ends it: monotonic (authoritative) or wall clock.
    if (this.#keys !== null && (monotonicNow() >= this.#deadline || Date.now() >= this.expiresAt)) {
      this.end();
    }
    return this.#keys !== null;
  }

  #active(): SessionKeys {
    if (!this.isActive() || this.#keys === null) {
      throw new KeyStoreError('owner_locked', 'owner keystore: the owner session has ended');
    }
    return this.#keys;
  }

  /** Owner keys have epoch 0 only (owner-key rotation is P2, 04 §2.6, §3.1.1). */
  #epochOf(options: EpochOptions | undefined): number {
    const epoch = options?.epoch ?? 0;
    assertEpoch(epoch);
    if (epoch !== 0) {
      throw new KeyStoreError('epoch_unavailable', 'keystore: that key epoch is not available');
    }
    return epoch;
  }

  signOwnerAction(body: JsonObject): Promise<string> {
    return Promise.resolve().then(() => {
      const { nostr } = this.#active();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new CryptoInputError('invalid_argument', 'signOwnerAction: body must be an object');
      }
      // Canonicalise once, then check v and owner on a parse of those exact bytes and sign them,
      // so a getter or Proxy cannot pass the check with one value and be signed with another
      // (IR-M1-1g-G2-1 M-1, I-3).
      const text = canonicalize(body);
      const { v, owner } = parseJson(text) as Record<string, unknown>;
      if (v !== 1) {
        throw new CryptoInputError('invalid_argument', 'signOwnerAction: body.v must be 1');
      }
      if (owner !== this.#ownerNostrHex) {
        throw new CryptoInputError(
          'invalid_argument',
          'signOwnerAction: body.owner must be this owner key',
        );
      }
      const digest = taggedHash(TAGS.ownerAction, sha256(encodeUtf8(text)));
      return encodeHex(bip340Sign(nostr, digest));
    });
  }

  sign712(typedData: TypedData): Promise<string> {
    return Promise.resolve().then(() => signTypedData(typedData, this.#active().evm));
  }

  signEnvelopeHash(envelopeHash: Uint8Array): Promise<string> {
    return Promise.resolve().then(() => envelopeSig(this.#active().nostr, envelopeHash));
  }

  signNostr(event: UnsignedNostrEvent): Promise<NostrEvent> {
    return Promise.resolve().then(() => {
      const { nostr } = this.#active();
      // A session is a bearer handle, not a general owner signer: seals and AUTH only (04 §3.1.1).
      // The kind is checked on a frozen snapshot, and exactly that snapshot is signed, so a getter
      // or Proxy cannot pass the check with one kind and be signed with another (M-1).
      const fields = signedFields(event);
      if (!OWNER_SESSION_KINDS.includes(fields.kind)) {
        throw new KeyStoreError(
          'operation_not_allowed',
          'owner session: only seal (kind 13) and AUTH (kind 22242) events are signed',
        );
      }
      return signNostrEvent(nostr, fields);
    });
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return Promise.resolve().then(() =>
      withConversationKey(this.#active().nostr, peer, (key) => nip44EncryptWithKey(key, plaintext)),
    );
  }

  nip44Decrypt(peer: string, payload: string, options?: EpochOptions): Promise<string> {
    return Promise.resolve().then(() => {
      const { nostr } = this.#active();
      this.#epochOf(options);
      return withConversationKey(nostr, peer, (key) => nip44DecryptWithKey(key, payload));
    });
  }

  unwrapCek(
    wrapped: WrappedCek,
    envelopeId: Uint8Array,
    options?: EpochOptions,
  ): Promise<Uint8Array> {
    return Promise.resolve().then(async () => {
      const { enc } = this.#active();
      this.#epochOf(options);
      const entry = entrySnapshot(wrapped, envelopeId);
      // A per-call copy, so a lock or expiry during the open cannot wipe the key under it.
      const secretKey = enc.slice();
      try {
        return await unwrapCekWithKey(secretKey, entry.wrapped, entry.envelopeId);
      } finally {
        wipe(secretKey);
      }
    });
  }

  close(): Promise<void> {
    this.end();
    return Promise.resolve();
  }

  /** Ends the session: wipes its keys and stops its timer. Idempotent. */
  end(): void {
    if (this.#timer !== undefined) timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    const keys = this.#keys;
    if (keys !== null) {
      // The session ends even if a wipe fails (I-2); the failure is still reported.
      this.#keys = null;
      try {
        wipe(keys.nostr, keys.evm, keys.enc);
      } finally {
        this.#onEnd(this);
      }
    }
  }
}

/**
 * An OwnerKeyStore over an owner seed held in memory, unlocked by one configured presence proof.
 * NOT FOR PRODUCTION (see the file header): it models the contract (presence required, short-lived
 * sessions, wipe on lock) without the protection a wrapped owner seed gives. The constructor copies
 * the seed and the presence bytes.
 */
export class MemoryOwnerKeyStore implements OwnerKeyStore {
  readonly #seed: Uint8Array;
  readonly #presenceKind: OwnerPresence['kind'];
  readonly #presenceBytes: Uint8Array;
  readonly #sessions = new Set<MemoryOwnerSession>();
  /** Bumped by lock() and close(); an unlock started under an older value issues no session. */
  #generation = 0;
  #closed = false;

  constructor(ownerSeed: Uint8Array, presence: OwnerPresence) {
    const { kind, bytes } = presenceBytes(presence, false);
    this.#seed = copySeed(ownerSeed, 'MemoryOwnerKeyStore: the owner seed');
    this.#presenceKind = kind;
    this.#presenceBytes = bytes.slice();
  }

  #open(): Uint8Array {
    if (this.#closed) throw new KeyStoreError('keystore_closed', 'keystore: the store is closed');
    return this.#seed;
  }

  getPublicKeys(): Promise<OwnerPublicKeys> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      const evm = derivePublicKey(seed, KEY_LABELS.evm, 0);
      const nostr = derivePublicKey(seed, KEY_LABELS.nostr, 0);
      const enc = derivePublicKey(seed, KEY_LABELS.enc, 0);
      if (
        evm.label !== KEY_LABELS.evm ||
        nostr.label !== KEY_LABELS.nostr ||
        enc.label !== KEY_LABELS.enc
      ) {
        throw new Error('unreachable');
      }
      return Object.freeze({
        ownerEvm: evm.address,
        ownerNostr: nostr.publicKey,
        ownerEnc: enc.publicKey,
      });
    });
  }

  unlock(presence: OwnerPresence, options: UnlockOptions = {}): Promise<OwnerSession> {
    // Captured when the call is made: a lock() or close() before this resolves cancels it
    // (IR-M1-1g-1 L-2).
    const generation = this.#generation;
    return Promise.resolve().then(() => {
      const { kind, bytes } = presenceBytes(presence, true);
      try {
        const seed = this.#open();
        const ttlMs = options.ttlMs ?? OWNER_SESSION_DEFAULT_TTL_MS;
        assertTtl(ttlMs);
        if (kind !== this.#presenceKind || !equalBytes(bytes, this.#presenceBytes)) {
          throw new KeyStoreError('presence_rejected', 'owner keystore: presence was not accepted');
        }
        if (generation !== this.#generation) {
          throw new KeyStoreError('owner_locked', 'owner keystore: locked while unlocking');
        }
        // The session's own copies of the owner keys, epoch 0 (04 §3.1.1); it wipes them when it
        // ends. Until the session owns them, any failure wipes the keys derived so far (I-1).
        let nostr: Uint8Array | undefined;
        let evm: Uint8Array | undefined;
        let enc: Uint8Array | undefined;
        let session: MemoryOwnerSession;
        try {
          nostr = deriveSecretKey(seed, KEY_LABELS.nostr, 0);
          evm = deriveSecretKey(seed, KEY_LABELS.evm, 0);
          enc = deriveSecretKey(seed, KEY_LABELS.enc, 0);
          session = new MemoryOwnerSession(
            SESSION_TOKEN,
            { nostr, evm, enc },
            encodeHex(bip340PublicKey(nostr)),
            ttlMs,
            (ended) => this.#sessions.delete(ended),
          );
        } catch (error) {
          wipe(nostr, evm, enc);
          throw error;
        }
        this.#sessions.add(session);
        return session;
      } finally {
        // The presented secret is consumed whether or not it unlocked the store (04 §8.3).
        wipe(bytes);
      }
    });
  }

  /** Ends every open session, even if one fails to wipe; the first failure is rethrown (I-2). */
  #endAll(): void {
    this.#generation += 1;
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    let failure: unknown;
    for (const session of sessions) {
      try {
        session.end();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }

  // lock() and close() act synchronously, at the call, so they also cancel an unlock already in
  // flight (IR-M1-1g-1 L-2); a wipe failure is reported through the returned promise.
  lock(): Promise<void> {
    try {
      this.#endAll();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    try {
      this.#endAll();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error as Error);
    } finally {
      wipe(this.#seed, this.#presenceBytes);
    }
  }
}
