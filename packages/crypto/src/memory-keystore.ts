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
// owner sessions hold their own key copy, which lock, close and expiry wipe (04 §8.3, best effort).
import { bip340PublicKey, bip340Sign } from './bip340.js';
import { assertBytes, equalBytes } from './bytes.js';
import { decodeHex, encodeHex } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { TAGS, sha256, taggedHash } from './hash.js';
import { canonicalizeToBytes, type JsonObject } from './jcs.js';
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
  type DecryptOptions,
  type Eip712TypedData,
  type HpkeWrappedKey,
  type KeyStore,
  type OwnerKeyStore,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
  type UnlockOptions,
} from './keystore-api.js';
import { nip44ConversationKey, nip44DecryptWithKey, nip44EncryptWithKey } from './nip44.js';
import { signNostrEvent, type NostrEvent, type UnsignedNostrEvent } from './nostr-event.js';
import { wipe } from './wipe.js';

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

function unsupported(card: string): never {
  throw new KeyStoreError(
    'unsupported_operation',
    `keystore: this operation is not implemented yet (${card})`,
  );
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

/** Options for MemoryKeyStore. */
export interface MemoryKeyStoreOptions {
  /** The current key epoch (04 §2.6). Default 0. */
  readonly keyEpoch?: number;
}

/**
 * A KeyStore over a 32-byte master seed held in memory. NOT FOR PRODUCTION (see the file header).
 * The constructor copies the seed; the caller may wipe its own buffer at once.
 */
export class MemoryKeyStore implements KeyStore {
  readonly #seed: Uint8Array;
  readonly #keyEpoch: number;
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

  #decryptEpoch(options: DecryptOptions | undefined): number {
    const epoch = options?.epoch ?? this.#keyEpoch;
    assertEpoch(epoch);
    if (epoch > this.#keyEpoch) {
      throw new KeyStoreError('epoch_unavailable', 'keystore: that key epoch is not available');
    }
    return epoch;
  }

  getPublicBundle(): Promise<PublicIdentity> {
    return Promise.resolve().then(() => derivePublicIdentity(this.#open(), this.#keyEpoch));
  }

  signNostr(event: UnsignedNostrEvent): Promise<NostrEvent> {
    return Promise.resolve().then(() =>
      withSecret(this.#open(), KEY_LABELS.nostr, this.#keyEpoch, (secretKey) =>
        signNostrEvent(secretKey, event),
      ),
    );
  }

  signEnvelopeHash(envelopeHash: Uint8Array): Promise<string> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      assertBytes(envelopeHash, 'signEnvelopeHash: envelopeHash');
      if (envelopeHash.length !== 32) {
        throw new CryptoInputError(
          'invalid_length',
          'signEnvelopeHash: envelopeHash must be 32 bytes',
        );
      }
      const digest = taggedHash(TAGS.envelope, envelopeHash);
      return withSecret(seed, KEY_LABELS.nostr, this.#keyEpoch, (secretKey) =>
        encodeHex(bip340Sign(secretKey, digest)),
      );
    });
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      const peerPublicKey = peerKey(peer);
      return withSecret(seed, KEY_LABELS.nostr, this.#keyEpoch, (secretKey) => {
        const conversationKey = nip44ConversationKey(secretKey, peerPublicKey);
        try {
          return nip44EncryptWithKey(conversationKey, plaintext);
        } finally {
          wipe(conversationKey);
        }
      });
    });
  }

  nip44Decrypt(peer: string, payload: string, options?: DecryptOptions): Promise<string> {
    return Promise.resolve().then(() => {
      const seed = this.#open();
      const epoch = this.#decryptEpoch(options);
      const peerPublicKey = peerKey(peer);
      return withSecret(seed, KEY_LABELS.nostr, epoch, (secretKey) => {
        const conversationKey = nip44ConversationKey(secretKey, peerPublicKey);
        try {
          return nip44DecryptWithKey(conversationKey, payload);
        } finally {
          wipe(conversationKey);
        }
      });
    });
  }

  sign712(typedData: Eip712TypedData): Promise<string> {
    void typedData;
    return Promise.resolve().then(() => {
      this.#open();
      return unsupported('EIP-712 hashing, M1-1e');
    });
  }

  hpkeOpen(
    wrapped: HpkeWrappedKey,
    info: Uint8Array,
    options?: DecryptOptions,
  ): Promise<Uint8Array> {
    void wrapped;
    void info;
    return Promise.resolve().then(() => {
      this.#open();
      this.#decryptEpoch(options);
      return unsupported('HPKE, M1-1c');
    });
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

function presenceBytes(presence: unknown): { kind: OwnerPresence['kind']; bytes: Uint8Array } {
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

/** Module-private: only MemoryOwnerKeyStore.unlock can construct a session. */
const SESSION_TOKEN = Symbol('MemoryOwnerSession');

class MemoryOwnerSession implements OwnerSession {
  readonly expiresAt: number;
  readonly #ownerNostrHex: string;
  #nostrSecret: Uint8Array | null;
  #timer: unknown;
  readonly #onEnd: (session: MemoryOwnerSession) => void;

  constructor(
    token: symbol,
    nostrSecret: Uint8Array,
    ownerNostrHex: string,
    ttlMs: number,
    onEnd: (session: MemoryOwnerSession) => void,
  ) {
    if (token !== SESSION_TOKEN) {
      throw new KeyStoreError('presence_required', 'owner keystore: a presence proof is required');
    }
    this.#nostrSecret = nostrSecret;
    this.#ownerNostrHex = ownerNostrHex;
    this.#onEnd = onEnd;
    this.expiresAt = Date.now() + ttlMs;
    // Wipe at expiry even if the handle is never used again. unref: never keep Node alive for it.
    const timer = timers.setTimeout(() => {
      this.end();
    }, ttlMs);
    (timer as { unref?: () => void }).unref?.();
    this.#timer = timer;
  }

  isActive(): boolean {
    if (this.#nostrSecret !== null && Date.now() >= this.expiresAt) this.end();
    return this.#nostrSecret !== null;
  }

  #secret(): Uint8Array {
    if (!this.isActive() || this.#nostrSecret === null) {
      throw new KeyStoreError('owner_locked', 'owner keystore: the owner session has ended');
    }
    return this.#nostrSecret;
  }

  signOwnerAction(body: JsonObject): Promise<string> {
    return Promise.resolve().then(() => {
      const secretKey = this.#secret();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new CryptoInputError('invalid_argument', 'signOwnerAction: body must be an object');
      }
      const { v, owner } = body as Record<string, unknown>;
      if (v !== 1) {
        throw new CryptoInputError('invalid_argument', 'signOwnerAction: body.v must be 1');
      }
      if (owner !== this.#ownerNostrHex) {
        throw new CryptoInputError(
          'invalid_argument',
          'signOwnerAction: body.owner must be this owner key',
        );
      }
      const digest = taggedHash(TAGS.ownerAction, sha256(canonicalizeToBytes(body)));
      return encodeHex(bip340Sign(secretKey, digest));
    });
  }

  sign712(typedData: Eip712TypedData): Promise<string> {
    void typedData;
    return Promise.resolve().then(() => {
      this.#secret();
      return unsupported('EIP-712 hashing, M1-1e');
    });
  }

  close(): Promise<void> {
    this.end();
    return Promise.resolve();
  }

  /** Ends the session: wipes its key and stops its timer. Idempotent. */
  end(): void {
    if (this.#timer !== undefined) timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#nostrSecret !== null) {
      wipe(this.#nostrSecret);
      this.#nostrSecret = null;
      this.#onEnd(this);
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
  #closed = false;

  constructor(ownerSeed: Uint8Array, presence: OwnerPresence) {
    const { kind, bytes } = presenceBytes(presence);
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
    return Promise.resolve().then(() => {
      const { kind, bytes } = presenceBytes(presence);
      try {
        const seed = this.#open();
        const ttlMs = options.ttlMs ?? OWNER_SESSION_DEFAULT_TTL_MS;
        assertTtl(ttlMs);
        if (kind !== this.#presenceKind || !equalBytes(bytes, this.#presenceBytes)) {
          throw new KeyStoreError('presence_rejected', 'owner keystore: presence was not accepted');
        }
        const nostrSecret = deriveSecretKey(seed, KEY_LABELS.nostr, 0);
        const session = new MemoryOwnerSession(
          SESSION_TOKEN,
          nostrSecret,
          encodeHex(bip340PublicKey(nostrSecret)),
          ttlMs,
          (ended) => this.#sessions.delete(ended),
        );
        this.#sessions.add(session);
        return session;
      } finally {
        // The presented secret is consumed whether or not it unlocked the store (04 §8.3).
        wipe(bytes);
      }
    });
  }

  lock(): Promise<void> {
    for (const session of [...this.#sessions]) session.end();
    this.#sessions.clear();
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.#closed) {
      for (const session of [...this.#sessions]) session.end();
      this.#sessions.clear();
      this.#closed = true;
      wipe(this.#seed, this.#presenceBytes);
    }
    return Promise.resolve();
  }
}
