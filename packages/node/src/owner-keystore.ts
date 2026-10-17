// M1-8c: the OwnerKeyStore on keychain machines (04 §2.2 "Owner seed on keychain machines", D-67).
// The owner seed is stored only wrapped: one keychain item, service `agentlink`, account `owner`,
// whose value is the 90-byte `ALKO` v1 blob (04 §2.8) under the generated owner code (kind 1) or,
// after an explicit opt-in, a chosen owner passphrase (kind 2). It is unwrapped only inside one owner
// operation (owner-operation.ts), turned into the session's owner keys, and wiped.
//
// What this protects, and what it does not (04 §2.5, G-1 accepted for M1 by D-67): a same-user
// script that does not modify the installed package and does not read process memory cannot produce
// an owner signature without the owner code (owner-same-user.test.ts). Presence, not intent: a
// modified package, a memory read, a fake prompt, or offline guessing of an opted-in chosen
// passphrase all defeat it, and no software check on a same-user machine stops them.
//
// Everything secret is a Uint8Array wiped after use (04 §8.3, best effort). No error carries an
// input, a keychain message or key material (I-7).
import {
  CryptoInputError,
  KEY_LABELS,
  KeyStoreError,
  MASTER_SEED_LENGTH,
  OWNER_SESSION_DEFAULT_TTL_MS,
  OWNER_SESSION_MAX_TTL_MS,
  NOSTR_KIND_AUTH,
  NOSTR_KIND_SEAL,
  TAGS,
  canonicalize,
  decodeHex,
  encodeHex,
  encodeUtf8,
  equalBytes,
  formatFingerprint,
  nostrEventId,
  ownerFingerprint,
  parseJson,
  randomBytes,
  sha256,
  taggedHash,
  wipe,
  type Argon2idParams,
  type EpochOptions,
  type JsonObject,
  type NostrEvent,
  type OwnerKeyStore,
  type OwnerPresence,
  type OwnerPublicKeys,
  type OwnerSession,
  type SecretKind,
  type TypedData,
  type UnlockOptions,
  type UnsignedNostrEvent,
  type WrappedCek,
} from '@agentlink/crypto';
import {
  bip340PublicKey,
  bip340Sign,
  derivePublicKey,
  deriveSecretKey,
  newKeystoreKek,
  nip44ConversationKey,
  nip44DecryptWithKey,
  nip44EncryptWithKey,
  normalizeSecret,
  openOwnerSeed,
  openOwnerSeedWithoutCard,
  sealOwnerSeed,
  signEnvelopeHash,
  signTypedData,
  unwrapCek,
} from '@agentlink/crypto/keystore';
import { NodeKeyStoreError } from './errors.js';
import {
  KEYCHAIN_CALL_TIMEOUT_MS,
  assertEpoch,
  bytesCopy,
  eventSnapshot,
  guarded,
} from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';

/** The keychain account of the owner's wrapped seed (04 §2.2, D-67 (2)(d)). */
export const OWNER_ACCOUNT = 'owner';

/** `ALKO` v1 is exactly 90 bytes; byte 5 is `secretKind` (04 §2.8). */
const ALKO_LENGTH = 90;
const ALKO_KIND_OFFSET = 5;

/** A chosen owner passphrase has at least 12 Unicode code points after NFKC (D-66 (3), 04 §2.8). */
export const MIN_OWNER_PASSPHRASE_CODE_POINTS = 12;

export const ownerMissing = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_missing',
    "One step left, and you must do it yourself: run `agentlink owner init` in your own terminal. Don't let your AI run it or see the code it shows. It's what stops any AI, including your own, from approving its own actions.",
  );

const ownerMismatch = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_mismatch',
    "The owner set up on this computer isn't the owner this agent names, or its saved copy is damaged. `agentlink doctor` shows the owner fingerprint.",
  );

const presenceRejected = (): KeyStoreError =>
  new KeyStoreError('presence_rejected', 'owner keystore: presence was not accepted');

const presenceRequired = (): KeyStoreError =>
  new KeyStoreError('presence_required', 'owner keystore: a presence proof is required');

/** The short owner fingerprint of 11 §5.2, for example `7F3A·19C2`. Public. */
export function ownerFingerprintText(keys: OwnerPublicKeys): string {
  return formatFingerprint(
    ownerFingerprint(keys.ownerEvm, keys.ownerNostr, keys.ownerEnc),
    'short',
  );
}

/** Frozen plain copies of the three owner public keys, with their lengths checked. */
export function ownerKeysCopy(keys: OwnerPublicKeys): OwnerPublicKeys {
  const fail = (): CryptoInputError =>
    new CryptoInputError(
      'invalid_argument',
      'owner keystore: the owner keys must be 20, 32 and 32 bytes',
    );
  if (typeof keys !== 'object' || keys === null) throw fail();
  const { ownerEvm, ownerNostr, ownerEnc } = keys;
  if (
    !(ownerEvm instanceof Uint8Array) ||
    ownerEvm.length !== 20 ||
    !(ownerNostr instanceof Uint8Array) ||
    ownerNostr.length !== 32 ||
    !(ownerEnc instanceof Uint8Array) ||
    ownerEnc.length !== 32
  ) {
    throw fail();
  }
  return Object.freeze({
    ownerEvm: new Uint8Array(ownerEvm),
    ownerNostr: new Uint8Array(ownerNostr),
    ownerEnc: new Uint8Array(ownerEnc),
  });
}

/** The owner public keys of a seed (epoch 0, 04 §2.1). */
function publicKeysOf(seed: Uint8Array): OwnerPublicKeys {
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
}

function sameOwner(a: OwnerPublicKeys, b: OwnerPublicKeys): boolean {
  return (
    equalBytes(a.ownerEvm, b.ownerEvm) &&
    equalBytes(a.ownerNostr, b.ownerNostr) &&
    equalBytes(a.ownerEnc, b.ownerEnc)
  );
}

/**
 * D-66 (3): refuses a chosen owner passphrase with fewer than 12 code points after NFKC, before any
 * KDF. Counted on normalizeSecret's output (UTF-8 bytes that are not continuation bytes), the rule
 * newKeystoreKek applies to `ALKS`. Moves into @agentlink/crypto with the M1-1f D-66 follow-up.
 * An input that fails kind-2 normalisation is refused the same way.
 */
export function assertOwnerPassphraseLength(secret: Uint8Array): void {
  let password: Uint8Array | undefined;
  try {
    password = normalizeSecret(secret, 2, 'prompt');
  } catch {
    throw secretRefused();
  }
  let n = 0;
  for (const byte of password) if ((byte & 0xc0) !== 0x80) n += 1;
  wipe(password);
  if (n < MIN_OWNER_PASSPHRASE_CODE_POINTS) throw secretRefused();
}

export const secretRefused = (): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_secret_refused', 'Use at least 12 characters.');

/** Reads the owner item, or null when there is none. The caller wipes the result. */
export async function readOwnerItem(
  keychain: KeychainBackend,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  return guarded(() => keychain.get(OWNER_ACCOUNT), timeoutMs);
}

/**
 * M1-9x: a store-only check for `doctor` and messages: true when the `owner` item exists on this
 * machine. It reads only the wrapped item (never a secret), asks for nothing and unlocks nothing;
 * the bytes are wiped at once.
 */
export async function ownerItemPresent(
  keychain: KeychainBackend,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<boolean> {
  const blob = await readOwnerItem(keychain, timeoutMs);
  if (blob === null) return false;
  wipe(blob);
  return true;
}

/**
 * M1-9x: the stored wrap's `secretKind` header byte (public header data), or null when there is no
 * `owner` item; `owner_mismatch` when the item is not a 90-byte `ALKO` v1 wrap of kind 1 or 2.
 */
export async function storedOwnerSecretKind(
  keychain: KeychainBackend,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<SecretKind | null> {
  const blob = await readOwnerItem(keychain, timeoutMs);
  if (blob === null) return null;
  const kind = blob.length === ALKO_LENGTH ? blob[ALKO_KIND_OFFSET] : undefined;
  wipe(blob);
  if (kind !== 1 && kind !== 2) throw ownerMismatch();
  return kind;
}

/** A fresh random owner seed and its public keys (04 §2.1). The caller wipes the seed. */
export function newOwnerSeed(): { readonly seed: Uint8Array; readonly keys: OwnerPublicKeys } {
  const seed = randomBytes(MASTER_SEED_LENGTH);
  try {
    return { seed, keys: publicKeysOf(seed) };
  } catch (error) {
    wipe(seed);
    throw error;
  }
}

export interface StoreOwnerSeedOptions {
  /** Argon2id parameters; default KEYSTORE_KDF_DEFAULTS. Tests use the 04 §2.8 floor. */
  readonly kdf?: Argon2idParams;
  readonly timeoutMs?: number;
}

/**
 * Wraps `seed` under `secret` in `ALKO` v1 and stores it as the `owner` item (04 §2.2). Never
 * overwrites: an existing item is `owner_exists` (the check and the write are not atomic in the OS
 * keychain API; two concurrent `owner init` runs are a known residual). A kind-2 secret must pass the
 * D-66 length rule. The stored value is read back and compared, and removed again if it differs.
 * `seed` and `secret` are not modified; the kek is wiped.
 */
export async function storeOwnerSeed(
  keychain: KeychainBackend,
  seed: Uint8Array,
  secret: { readonly secret: Uint8Array; readonly secretKind: SecretKind },
  options: StoreOwnerSeedOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  if (secret.secretKind === 2) assertOwnerPassphraseLength(secret.secret);
  const existing = await readOwnerItem(keychain, timeoutMs);
  if (existing !== null) {
    wipe(existing);
    throw new NodeKeyStoreError(
      'owner_exists',
      "This agent already has an owner. AgentLink won't replace it. To use an owner from another device, link it from that device.",
    );
  }
  const kek = await newKeystoreKek(
    'ALKO',
    { secret: secret.secret, secretKind: secret.secretKind, source: 'prompt' },
    options.kdf,
  );
  let blob: Uint8Array;
  try {
    blob = await sealOwnerSeed(kek, seed, { destination: 'local', fileKeystoreMachine: false });
  } finally {
    wipe(kek.kek);
  }
  await guarded(() => keychain.set(OWNER_ACCOUNT, blob), timeoutMs);
  const back = await readOwnerItem(keychain, timeoutMs);
  const same = back !== null && equalBytes(back, blob);
  if (back !== null) wipe(back);
  if (!same) {
    await guarded(() => keychain.delete(OWNER_ACCOUNT), timeoutMs).catch(() => false);
    throw new NodeKeyStoreError(
      'keychain_failed',
      'The system keychain refused the request. Unlock it and try again; `agentlink doctor` shows what is wrong.',
    );
  }
}

// --- Sessions -------------------------------------------------------------------------------------

/** The owner secret keys a session holds (epoch 0 only, 04 §3.1.1). */
interface SessionKeys {
  readonly nostr: Uint8Array;
  readonly evm: Uint8Array;
  readonly enc: Uint8Array;
}

/** The only Nostr kinds an owner session signs: the seal and NIP-42 AUTH (04 §3.1.1). */
const OWNER_SESSION_KINDS: readonly number[] = [NOSTR_KIND_SEAL, NOSTR_KIND_AUTH];

/** Module-private: only KeychainOwnerKeyStore.unlock constructs a session. */
const SESSION_TOKEN = Symbol('KeychainOwnerSession');

/** Every session a KeychainOwnerKeyStore issued, checked by identity (KeyEpochControl contract). */
const ISSUED_SESSIONS = new WeakMap<OwnerSession, KeychainOwnerKeyStore>();

/** True when `session` is a live session that `store` issued (for a paired KeyEpochControl). */
export function issuedBy(session: unknown, store: KeychainOwnerKeyStore): boolean {
  return (
    typeof session === 'object' &&
    session !== null &&
    ISSUED_SESSIONS.get(session as OwnerSession) === store
  );
}

const monotonicNow = (): number => performance.now();

class KeychainOwnerSession implements OwnerSession {
  readonly expiresAt: number;
  readonly #deadline: number;
  readonly #ownerNostrHex: string;
  #keys: SessionKeys | null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #onEnd: (session: KeychainOwnerSession) => void;

  constructor(
    token: symbol,
    keys: SessionKeys,
    ownerNostrHex: string,
    ttlMs: number,
    onEnd: (session: KeychainOwnerSession) => void,
  ) {
    if (token !== SESSION_TOKEN) throw presenceRequired();
    this.#keys = keys;
    this.#ownerNostrHex = ownerNostrHex;
    this.#onEnd = onEnd;
    this.expiresAt = Date.now() + ttlMs;
    this.#deadline = monotonicNow() + ttlMs;
    // Wiped at expiry even if never used again; unref so it never keeps Node alive.
    this.#timer = setTimeout(() => this.end(), ttlMs);
    this.#timer.unref();
  }

  isActive(): boolean {
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

  /** Owner keys have epoch 0 only (owner-key rotation is P2, 04 §2.6). */
  #epochOf(options: EpochOptions | undefined): void {
    const epoch = options?.epoch ?? 0;
    assertEpoch(epoch);
    if (epoch !== 0) {
      throw new KeyStoreError('epoch_unavailable', 'keystore: that key epoch is not available');
    }
  }

  /** A per-call copy of one key, so a lock or expiry mid-call cannot wipe it under the operation. */
  #with<T>(pick: (keys: SessionKeys) => Uint8Array, fn: (key: Uint8Array) => T): T {
    const key = pick(this.#active()).slice();
    try {
      return fn(key);
    } finally {
      wipe(key);
    }
  }

  signOwnerAction(body: JsonObject): Promise<string> {
    return Promise.resolve().then(() => {
      this.#active();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new CryptoInputError('invalid_argument', 'signOwnerAction: body must be an object');
      }
      // Canonicalise once, check v and owner on a parse of exactly those bytes, and sign them, so a
      // getter or Proxy cannot pass the check with one value and be signed with another.
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
      return this.#with(
        (k) => k.nostr,
        (key) => encodeHex(bip340Sign(key, digest)),
      );
    });
  }

  sign712(typedData: TypedData): Promise<string> {
    return Promise.resolve().then(() =>
      this.#with(
        (k) => k.evm,
        (key) => signTypedData(typedData, key),
      ),
    );
  }

  signEnvelopeHash(envelopeHash: Uint8Array): Promise<string> {
    return Promise.resolve().then(() => {
      const hash = bytesCopy(envelopeHash, 'signEnvelopeHash: envelopeHash');
      return this.#with(
        (k) => k.nostr,
        (key) => encodeHex(signEnvelopeHash(key, hash)),
      );
    });
  }

  signNostr(event: UnsignedNostrEvent): Promise<NostrEvent> {
    return Promise.resolve().then(() => {
      this.#active();
      // Seals and AUTH only (04 §3.1.1), checked on the frozen snapshot that is signed.
      const fields = eventSnapshot(event);
      if (!OWNER_SESSION_KINDS.includes(fields.kind)) {
        throw new KeyStoreError(
          'operation_not_allowed',
          'owner session: only seal (kind 13) and AUTH (kind 22242) events are signed',
        );
      }
      return this.#with(
        (k) => k.nostr,
        (key) => {
          const pubkey = encodeHex(bip340PublicKey(key));
          const id = nostrEventId(pubkey, fields);
          const sig = encodeHex(bip340Sign(key, decodeHex(id)));
          return Object.freeze({ ...fields, id, pubkey, sig });
        },
      );
    });
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return Promise.resolve().then(() => {
      const peerKey = decodeHex(peer, { length: 32 });
      return this.#with(
        (k) => k.nostr,
        (key) => {
          const conversation = nip44ConversationKey(key, peerKey);
          try {
            return nip44EncryptWithKey(conversation, plaintext);
          } finally {
            wipe(conversation);
          }
        },
      );
    });
  }

  nip44Decrypt(peer: string, payload: string, options?: EpochOptions): Promise<string> {
    return Promise.resolve().then(() => {
      this.#epochOf(options);
      const peerKey = decodeHex(peer, { length: 32 });
      return this.#with(
        (k) => k.nostr,
        (key) => {
          const conversation = nip44ConversationKey(key, peerKey);
          try {
            return nip44DecryptWithKey(conversation, payload);
          } finally {
            wipe(conversation);
          }
        },
      );
    });
  }

  unwrapCek(
    wrapped: WrappedCek,
    envelopeId: Uint8Array,
    options?: EpochOptions,
  ): Promise<Uint8Array> {
    return Promise.resolve().then(async () => {
      this.#epochOf(options);
      if (typeof wrapped !== 'object' || wrapped === null) {
        throw new CryptoInputError('invalid_argument', 'unwrapCek: wrapped must be {enc, wk}');
      }
      const { enc, wk } = wrapped as unknown as Record<string, unknown>;
      const entry = { enc: bytesCopy(enc, 'unwrapCek: enc'), wk: bytesCopy(wk, 'unwrapCek: wk') };
      const id = bytesCopy(envelopeId, 'unwrapCek: envelopeId');
      const key = this.#active().enc.slice();
      try {
        return await unwrapCek(key, entry, id);
      } finally {
        wipe(key);
      }
    });
  }

  close(): Promise<void> {
    this.end();
    return Promise.resolve();
  }

  /** Ends the session: wipes its keys and stops its timer. Idempotent. */
  end(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const keys = this.#keys;
    if (keys !== null) {
      this.#keys = null;
      try {
        wipe(keys.nostr, keys.evm, keys.enc);
      } finally {
        this.#onEnd(this);
      }
    }
  }
}

export interface KeychainOwnerKeyStoreOptions {
  /** Limit for each keychain call in milliseconds. Default KEYCHAIN_CALL_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/**
 * The OwnerKeyStore over the `owner` keychain item (04 §2.2, §2.5). `expected` is the owner the
 * agent card names (ownerEvm, ownerNostr, ownerEnc): the unwrapped seed must derive exactly these
 * keys, so a planted `owner` item under another seed never unlocks (04 §2.8 "Expected owner").
 *
 * Internal to @agentlink/node: the package entry exposes only performOwnerOperation, which reads the
 * presence proof at a TTY prompt and closes the session when the operation ends (no unlock session
 * outlives one owner operation).
 */
export class KeychainOwnerKeyStore implements OwnerKeyStore {
  readonly #keychain: KeychainBackend;
  readonly #expected: OwnerPublicKeys;
  readonly #timeoutMs: number;
  readonly #sessions = new Set<KeychainOwnerSession>();
  /** Bumped by lock() and close(); an unlock started under an older value issues no session. */
  #generation = 0;
  #closed = false;

  private constructor(keychain: KeychainBackend, expected: OwnerPublicKeys, timeoutMs: number) {
    this.#keychain = keychain;
    this.#expected = expected;
    this.#timeoutMs = timeoutMs;
  }

  /** Opens the owner store; `owner_missing` when there is no `owner` item. No secret is read. */
  static async open(
    keychain: KeychainBackend,
    expected: OwnerPublicKeys,
    options: KeychainOwnerKeyStoreOptions = {},
  ): Promise<KeychainOwnerKeyStore> {
    const store = new KeychainOwnerKeyStore(
      keychain,
      ownerKeysCopy(expected),
      options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS,
    );
    await store.secretKind();
    return store;
  }

  #open(): void {
    if (this.#closed) throw new KeyStoreError('keystore_closed', 'keystore: the store is closed');
  }

  /** Reads the `owner` item; `owner_missing` without one, `owner_mismatch` when it is not 90 bytes. */
  async #blob(): Promise<Uint8Array> {
    this.#open();
    const blob = await readOwnerItem(this.#keychain, this.#timeoutMs);
    if (blob === null) throw ownerMissing();
    if (blob.length !== ALKO_LENGTH) {
      wipe(blob);
      throw ownerMismatch();
    }
    return blob;
  }

  /**
   * The stored wrap's `secretKind` header byte (1 owner code, 2 chosen passphrase), so the prompt
   * names the right secret. Public header data; the value is checked again, authenticated, on unlock.
   */
  async secretKind(): Promise<SecretKind> {
    const blob = await this.#blob();
    const kind = blob[ALKO_KIND_OFFSET];
    wipe(blob);
    if (kind !== 1 && kind !== 2) throw ownerMismatch();
    return kind;
  }

  getPublicKeys(): Promise<OwnerPublicKeys> {
    return Promise.resolve().then(() => {
      this.#open();
      return ownerKeysCopy(this.#expected);
    });
  }

  /**
   * 04 §2.5: unwraps the owner seed with the owner code or passphrase typed at the prompt, checks it
   * against the expected owner, derives the session's owner keys and wipes the seed. The presented
   * secret is wiped whether or not it unlocks. A passkey proof is M1-8e and is refused here.
   */
  async unlock(presence: OwnerPresence, options: UnlockOptions = {}): Promise<OwnerSession> {
    const generation = this.#generation;
    const secret = presenceSecret(presence);
    let blob: Uint8Array | undefined;
    let seed: Uint8Array | undefined;
    try {
      const ttlMs = options.ttlMs ?? OWNER_SESSION_DEFAULT_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > OWNER_SESSION_MAX_TTL_MS) {
        throw new CryptoInputError(
          'invalid_argument',
          'owner keystore: ttlMs must be an integer from 1 to OWNER_SESSION_MAX_TTL_MS',
        );
      }
      blob = await this.#blob();
      try {
        seed = await openOwnerSeed(
          blob,
          { secret, source: 'prompt' },
          { ownerEvm: this.#expected.ownerEvm, ownerNostr: this.#expected.ownerNostr },
          { fileKeystoreMachine: false },
        );
      } catch (error) {
        // A wrong secret, a damaged item and a foreign owner are one answer (04 §2.8 tests).
        if (error instanceof CryptoInputError) throw presenceRejected();
        throw error;
      }
      if (!sameOwner(publicKeysOf(seed), this.#expected)) throw presenceRejected();
      if (this.#closed || generation !== this.#generation) {
        throw new KeyStoreError('owner_locked', 'owner keystore: locked while unlocking');
      }
      return this.#issue(seed, ttlMs);
    } finally {
      // The presented secret, the blob and the seed never outlive this call (04 §8.3).
      wipe(secret, blob, seed);
    }
  }

  /** Derives the session's owner keys from `seed` (not modified; the caller wipes it). */
  #issue(seed: Uint8Array, ttlMs: number): OwnerSession {
    let nostr: Uint8Array | undefined;
    let evm: Uint8Array | undefined;
    let enc: Uint8Array | undefined;
    let session: KeychainOwnerSession;
    try {
      nostr = deriveSecretKey(seed, KEY_LABELS.nostr, 0);
      evm = deriveSecretKey(seed, KEY_LABELS.evm, 0);
      enc = deriveSecretKey(seed, KEY_LABELS.enc, 0);
      session = new KeychainOwnerSession(
        SESSION_TOKEN,
        { nostr, evm, enc },
        encodeHex(this.#expected.ownerNostr),
        ttlMs,
        (ended) => this.#sessions.delete(ended),
      );
    } catch (error) {
      wipe(nostr, evm, enc);
      throw error;
    }
    this.#sessions.add(session);
    ISSUED_SESSIONS.set(session, this);
    return session;
  }

  /**
   * M1-9x (04 §2.8 "Adding an agent to the existing owner"): unlocks the `owner` item when no local
   * agent card names the owner, so there is no expected owner to check against. The owner keys are
   * taken from the item itself: the seed the owner code (or opted-in passphrase) unwraps derives
   * them, and the returned store expects exactly those keys from then on. The authenticated
   * decryption under the typed secret is the only check, so the caller MUST show the owner
   * fingerprint and have the owner confirm it before the session signs anything.
   *
   * `owner_missing` without an item, `owner_mismatch` when it is not 90 bytes, `presence_rejected`
   * for a wrong secret or a damaged item (one answer, 04 §2.8). The presented secret, the blob and
   * the seed are wiped whether or not it unlocks.
   */
  static async unlockWithoutCard(
    keychain: KeychainBackend,
    presence: OwnerPresence,
    options: UnlockOptions & KeychainOwnerKeyStoreOptions = {},
  ): Promise<{
    readonly store: KeychainOwnerKeyStore;
    readonly session: OwnerSession;
    readonly owner: OwnerPublicKeys;
  }> {
    const secret = presenceSecret(presence);
    let blob: Uint8Array | null = null;
    let seed: Uint8Array | undefined;
    try {
      const ttlMs = options.ttlMs ?? OWNER_SESSION_DEFAULT_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > OWNER_SESSION_MAX_TTL_MS) {
        throw new CryptoInputError(
          'invalid_argument',
          'owner keystore: ttlMs must be an integer from 1 to OWNER_SESSION_MAX_TTL_MS',
        );
      }
      const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
      blob = await readOwnerItem(keychain, timeoutMs);
      if (blob === null) throw ownerMissing();
      if (blob.length !== ALKO_LENGTH) throw ownerMismatch();
      try {
        seed = await openOwnerSeedWithoutCard(
          blob,
          { secret, source: 'prompt' },
          { fileKeystoreMachine: false },
        );
      } catch (error) {
        if (error instanceof CryptoInputError) throw presenceRejected();
        throw error;
      }
      const owner = publicKeysOf(seed);
      const store = new KeychainOwnerKeyStore(keychain, ownerKeysCopy(owner), timeoutMs);
      const session = store.#issue(seed, ttlMs);
      return Object.freeze({ store, session, owner: ownerKeysCopy(owner) });
    } finally {
      wipe(secret, blob, seed);
    }
  }

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
    return this.lock();
  }
}

/**
 * The owner secret of a presence proof. Anything but a non-empty passphrase proof is
 * `presence_required`, and any bytes it carried are wiped; the passkey PRF path is M1-8e.
 */
function presenceSecret(presence: unknown): Uint8Array {
  if (typeof presence !== 'object' || presence === null) throw presenceRequired();
  const { kind, secret, prfOutput } = presence as Record<string, unknown>;
  if (kind === 'passphrase' && secret instanceof Uint8Array && secret.length > 0) return secret;
  for (const value of [secret, prfOutput]) if (value instanceof Uint8Array) wipe(value);
  throw presenceRequired();
}
