// M1-8a: the agent KeyStore backed by the OS keychain (04 §2.2, §3.1.1; 07 §9). The seed is read
// from the keychain for each operation, checked against the agent ID (04 §2.9), used and wiped
// (04 §8.3, best effort): the store holds no seed between calls. Signing and encryption use the
// current epoch; only lookups and decryption take one. Owner keys are never here (04 §2.5).
import {
  CryptoInputError,
  KEY_LABELS,
  KeyStoreError,
  MASTER_SEED_LENGTH,
  MAX_KEY_EPOCH,
  decodeHex,
  decodeHex0x,
  encodeHex,
  equalBytes,
  nostrEventId,
  randomBytes,
  wipe,
  type EpochOptions,
  type KeyLabel,
  type KeyStore,
  type NostrEvent,
  type PublicIdentity,
  type TypedData,
  type UnsignedNostrEvent,
  type WrappedCek,
} from '@agentlink/crypto';
import {
  bip340PublicKey,
  bip340Sign,
  deriveAgentId,
  derivePublicIdentity,
  deriveSecretKey,
  nip44ConversationKey,
  nip44DecryptWithKey,
  nip44EncryptWithKey,
  signEnvelopeHash,
  signTypedData,
  unwrapCek,
} from '@agentlink/crypto/keystore';
import { NodeKeyStoreError } from './errors.js';
import {
  assertAgentId,
  keychainAccount,
  type KeyStoreBackendKind,
  type KeychainBackend,
  type KeychainItem,
} from './keychain.js';

const keychainFailed = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keychain_failed',
    'The system keychain refused the request. Unlock it and try again; `agentlink doctor` shows what is wrong.',
  );

const identityMissing = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'identity_missing',
    "This agent's identity is not in the system keychain. Restore it from a backup or check the agent name; AgentLink never creates a new identity in its place.",
  );

const identityMismatch = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'identity_mismatch',
    "The keychain item for this agent belongs to a different agent. Restore this agent's item from a backup; `agentlink doctor` shows the expected agent ID.",
  );

/** Every keychain call, with native errors replaced by a fixed sentence (I-7). */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw keychainFailed();
  }
}

function assertEpoch(epoch: unknown): asserts epoch is number {
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0 || epoch > MAX_KEY_EPOCH) {
    throw new CryptoInputError(
      'invalid_argument',
      'keystore: the epoch must be an integer from 0 to 2^32 - 1',
    );
  }
}

/** A plain copy of caller bytes, read once (IR-M1-1g-G2-1 M-1). Lengths are checked by the callee. */
function bytesCopy(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new CryptoInputError('invalid_argument', `${what} must be a Uint8Array`);
  }
  return new Uint8Array(value);
}

/** A frozen plain copy of the four signed NIP-01 fields, each read once; validated when signed. */
function eventSnapshot(event: unknown): UnsignedNostrEvent {
  if (typeof event !== 'object' || event === null) {
    throw new CryptoInputError('invalid_argument', 'nostr event: must be an object');
  }
  const { kind, created_at: createdAt, tags, content } = event as Record<string, unknown>;
  const copied: unknown = Array.isArray(tags)
    ? Object.freeze(
        tags.map((tag: unknown) => (Array.isArray(tag) ? Object.freeze([...tag]) : tag)),
      )
    : tags;
  return Object.freeze({
    kind,
    created_at: createdAt,
    tags: copied,
    content,
  }) as UnsignedNostrEvent;
}

/** Runs `fn` with a freshly derived secret key and wipes the key when `fn` settles. */
async function withSecret<T>(
  seed: Uint8Array,
  label: KeyLabel,
  epoch: number,
  fn: (secretKey: Uint8Array) => T | Promise<T>,
): Promise<T> {
  const secretKey = deriveSecretKey(seed, label, epoch);
  try {
    return await fn(secretKey);
  } finally {
    wipe(secretKey);
  }
}

/** True when `seed` is a 32-byte seed whose EVM address is `agentId`, compared as bytes (04 §2.9). */
function derivesAgent(seed: Uint8Array, agentId: string): boolean {
  if (seed.length !== MASTER_SEED_LENGTH) return false;
  return equalBytes(
    decodeHex0x(deriveAgentId(seed), { length: 20 }),
    decodeHex0x(agentId, { length: 20 }),
  );
}

export interface KeychainKeyStoreOptions {
  /** The current key epoch (04 §2.6), as recorded in the agent's `identity` row. Default 0. */
  readonly keyEpoch?: number;
}

export class KeychainKeyStore implements KeyStore {
  readonly #keychain: KeychainBackend;
  readonly #agentId: string;
  readonly #keyEpoch: number;
  #closed = false;

  private constructor(keychain: KeychainBackend, agentId: string, keyEpoch: number) {
    this.#keychain = keychain;
    this.#agentId = agentId;
    this.#keyEpoch = keyEpoch;
  }

  /**
   * Opens the agent recorded as `agentId`: reads its seed once to check that it derives `agentId`
   * (04 §2.9), then wipes it. A missing or foreign item is an error with a fix, never a new identity.
   */
  static async open(
    keychain: KeychainBackend,
    agentId: string,
    options: KeychainKeyStoreOptions = {},
  ): Promise<KeychainKeyStore> {
    assertAgentId(agentId);
    const keyEpoch = options.keyEpoch ?? 0;
    assertEpoch(keyEpoch);
    const store = new KeychainKeyStore(keychain, agentId, keyEpoch);
    await store.#withSeed(() => undefined);
    return store;
  }

  /** Reads one item of this agent, or throws `identity_missing`. The caller wipes the result. */
  async #read(item: KeychainItem): Promise<Uint8Array> {
    if (this.#closed) throw new KeyStoreError('keystore_closed', 'keystore: the store is closed');
    const value = await guarded(() => this.#keychain.get(keychainAccount(this.#agentId, item)));
    if (value === null) throw identityMissing();
    if (this.#closed) {
      wipe(value);
      throw new KeyStoreError('keystore_closed', 'keystore: the store is closed');
    }
    return value;
  }

  /** Loads the seed, checks it against the agent ID, runs `fn` and wipes the seed. */
  async #withSeed<T>(fn: (seed: Uint8Array) => T | Promise<T>): Promise<T> {
    const seed = await this.#read('seed');
    try {
      if (!derivesAgent(seed, this.#agentId)) throw identityMismatch();
      return await fn(seed);
    } finally {
      wipe(seed);
    }
  }

  /** The epoch of a lookup or decryption: default current, never above it (04 §3.1.1). */
  #epochOf(options: EpochOptions | undefined): number {
    const epoch = options?.epoch ?? this.#keyEpoch;
    assertEpoch(epoch);
    if (epoch > this.#keyEpoch) {
      throw new KeyStoreError('epoch_unavailable', 'keystore: that key epoch is not available');
    }
    return epoch;
  }

  async getPublicBundle(options?: EpochOptions): Promise<PublicIdentity> {
    const epoch = this.#epochOf(options);
    return this.#withSeed((seed) => derivePublicIdentity(seed, epoch));
  }

  async signNostr(event: UnsignedNostrEvent): Promise<NostrEvent> {
    const fields = eventSnapshot(event);
    return this.#withSeed((seed) =>
      withSecret(seed, KEY_LABELS.nostr, this.#keyEpoch, (secretKey) => {
        const pubkey = encodeHex(bip340PublicKey(secretKey));
        const id = nostrEventId(pubkey, fields);
        const sig = encodeHex(bip340Sign(secretKey, decodeHex(id)));
        return Object.freeze({ ...fields, id, pubkey, sig });
      }),
    );
  }

  async signEnvelopeHash(envelopeHash: Uint8Array): Promise<string> {
    const hash = bytesCopy(envelopeHash, 'signEnvelopeHash: envelopeHash');
    return this.#withSeed((seed) =>
      withSecret(seed, KEY_LABELS.nostr, this.#keyEpoch, (secretKey) =>
        encodeHex(signEnvelopeHash(secretKey, hash)),
      ),
    );
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    const peerKey = decodeHex(peer, { length: 32 });
    return this.#withSeed((seed) =>
      withSecret(seed, KEY_LABELS.nostr, this.#keyEpoch, (secretKey) => {
        const key = nip44ConversationKey(secretKey, peerKey);
        try {
          return nip44EncryptWithKey(key, plaintext);
        } finally {
          wipe(key);
        }
      }),
    );
  }

  async nip44Decrypt(peer: string, payload: string, options?: EpochOptions): Promise<string> {
    const epoch = this.#epochOf(options);
    const peerKey = decodeHex(peer, { length: 32 });
    return this.#withSeed((seed) =>
      withSecret(seed, KEY_LABELS.nostr, epoch, (secretKey) => {
        const key = nip44ConversationKey(secretKey, peerKey);
        try {
          return nip44DecryptWithKey(key, payload);
        } finally {
          wipe(key);
        }
      }),
    );
  }

  async unwrapCek(
    wrapped: WrappedCek,
    envelopeId: Uint8Array,
    options?: EpochOptions,
  ): Promise<Uint8Array> {
    const epoch = this.#epochOf(options);
    if (typeof wrapped !== 'object' || wrapped === null) {
      throw new CryptoInputError('invalid_argument', 'unwrapCek: wrapped must be {enc, wk}');
    }
    const { enc, wk } = wrapped as unknown as Record<string, unknown>;
    const entry = { enc: bytesCopy(enc, 'unwrapCek: enc'), wk: bytesCopy(wk, 'unwrapCek: wk') };
    const id = bytesCopy(envelopeId, 'unwrapCek: envelopeId');
    return this.#withSeed((seed) =>
      withSecret(seed, KEY_LABELS.enc, epoch, (secretKey) => unwrapCek(secretKey, entry, id)),
    );
  }

  async sign712(typedData: TypedData): Promise<string> {
    // The EVM key exists only at epoch 0 (04 §2.1), whatever the current key epoch.
    return this.#withSeed((seed) =>
      withSecret(seed, KEY_LABELS.evm, 0, (secretKey) => signTypedData(typedData, secretKey)),
    );
  }

  /**
   * The store key of the encrypted SQLite columns (07 §3), for the Store (M1-8b). It is read for
   * this call only and wiped when `fn` settles; `fn` must not keep it.
   */
  async withStoreKey<T>(fn: (storeKey: Uint8Array) => T | Promise<T>): Promise<T> {
    const key = await this.#read('store-key');
    try {
      if (key.length !== 32) throw identityMismatch();
      return await fn(key);
    } finally {
      wipe(key);
    }
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}

/**
 * 04 §2.2, §2.9: creates a new agent in the keychain (a random seed under `<agentId>` and a random
 * store key under `<agentId>:store-key`) and returns its agent ID for the caller to record with the
 * backend `keychain` (07 §9.1). Existing items are never overwritten. On any failure both items are
 * removed, so nothing half-made remains. No file is written.
 */
export async function createKeychainAgent(keychain: KeychainBackend): Promise<string> {
  const seed = randomBytes(MASTER_SEED_LENGTH);
  const storeKey = randomBytes(32);
  try {
    const agentId = deriveAgentId(seed);
    const accounts = [keychainAccount(agentId, 'seed'), keychainAccount(agentId, 'store-key')];
    for (const account of accounts) {
      const existing = await guarded(() => keychain.get(account));
      if (existing !== null) {
        wipe(existing);
        throw new NodeKeyStoreError(
          'identity_exists',
          'An agent with this identity is already in the system keychain. AgentLink never replaces it.',
        );
      }
    }
    try {
      await guarded(() => keychain.set(accounts[0] as string, seed));
      await guarded(() => keychain.set(accounts[1] as string, storeKey));
      await (await KeychainKeyStore.open(keychain, agentId)).close();
    } catch (error) {
      for (const account of accounts) await keychain.delete(account).catch(() => false);
      throw error;
    }
    return agentId;
  } finally {
    wipe(seed, storeKey);
  }
}

/**
 * Opens an agent with the backend recorded at `init` and nothing else (07 §9.1): no fallback, no
 * switch and no new identity when the other backend appears or the recorded one fails.
 */
export async function openRecordedKeyStore(
  backend: KeyStoreBackendKind,
  agentId: string,
  backends: { readonly keychain: KeychainBackend },
  options: KeychainKeyStoreOptions = {},
): Promise<KeyStore> {
  if (backend === 'keychain') return KeychainKeyStore.open(backends.keychain, agentId, options);
  throw new NodeKeyStoreError(
    'backend_unavailable',
    "This agent's identity is kept in a passphrase-locked file, which this version of AgentLink can't open yet. Update AgentLink.",
  );
}
