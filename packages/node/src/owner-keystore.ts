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
} from '@4thtech-io/crypto';
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
  openPasskeySeed,
  sealOwnerSeed,
  signEnvelopeHash,
  signTypedData,
  unwrapCek,
} from '@4thtech-io/crypto/keystore';
import { NodeKeyStoreError } from './errors.js';
import {
  KEYCHAIN_CALL_TIMEOUT_MS,
  assertEpoch,
  bytesCopy,
  eventSnapshot,
  guarded,
} from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import { CLI_COMMAND } from './cli-command.js';

/** The keychain account of the owner's wrapped seed (04 §2.2, D-67 (2)(d)). */
export const OWNER_ACCOUNT = 'owner';

/**
 * M1-8e: the keychain account of the owner seed wrapped under the localhost passkey's PRF output
 * (`ALKP` v1, 04 §2.3.1; proposed, owner confirms at merge). One per OS user in M1b.
 */
export const OWNER_PASSKEY_ACCOUNT = 'owner-passkey';

/** `ALKO` v1 is exactly 90 bytes; byte 5 is `secretKind` (04 §2.8). */
const ALKO_LENGTH = 90;
const ALKO_KIND_OFFSET = 5;

/** A chosen owner passphrase has at least 12 Unicode code points after NFKC (D-66 (3), 04 §2.8). */
export const MIN_OWNER_PASSPHRASE_CODE_POINTS = 12;

export const ownerMissing = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_missing',
    `One step left, and you must do it yourself: run \`${CLI_COMMAND} owner init\` in your own terminal. Don't let your AI run it or see the code it shows. It's what stops any AI, including your own, from approving its own actions.`,
  );

const ownerMismatch = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_mismatch',
    `The owner set up on this computer isn't the owner this agent names, or its saved copy is damaged. \`${CLI_COMMAND} doctor\` shows the owner fingerprint.`,
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

/** True when `seed` derives exactly the owner keys `owner` (04 §2.1, epoch 0). */
export function sameOwnerKeys(seed: Uint8Array, owner: OwnerPublicKeys): boolean {
  return sameOwner(publicKeysOf(seed), owner);
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
 * newKeystoreKek applies to `ALKS`. Moves into @4thtech-io/crypto with the M1-1f D-66 follow-up.
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
  /**
   * M1-11s-c: called with the sealed `ALKO` blob (ciphertext) before it is written, so a caller can
   * still roll back an item whose write or read-back failed (removeOwnerItemIfOurs).
   */
  readonly sealed?: (blob: Uint8Array) => void;
}

/**
 * Wraps `seed` under `secret` in `ALKO` v1 and stores it as the `owner` item (04 §2.2). Never
 * overwrites: an existing item is `owner_exists` (the check and the write are not atomic in the OS
 * keychain API; two concurrent `owner init` runs are a known residual). A kind-2 secret must pass the
 * D-66 length rule. The stored value is read back and compared; if it differs, it is not this run's
 * item, so it is left alone (IR-M1-8h-1 L2: never delete an item this run did not write) and the
 * call fails. Returns the stored `ALKO` blob (ciphertext), so a later rollback can check that the
 * item it removes is still this one (removeOwnerItemIfOurs). `seed` and `secret` are not modified;
 * the kek is wiped.
 */
export async function storeOwnerSeed(
  keychain: KeychainBackend,
  seed: Uint8Array,
  secret: { readonly secret: Uint8Array; readonly secretKind: SecretKind },
  options: StoreOwnerSeedOptions = {},
): Promise<Uint8Array> {
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
  options.sealed?.(blob);
  await guarded(() => keychain.set(OWNER_ACCOUNT, blob), timeoutMs);
  const back = await readOwnerItem(keychain, timeoutMs);
  const same = back !== null && equalBytes(back, blob);
  if (back !== null) wipe(back);
  if (!same) {
    // Whatever is there now is not the item this run wrote (another run's, or none): never deleted.
    throw new NodeKeyStoreError(
      'keychain_failed',
      `The system keychain refused the request. Unlock it and try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
    );
  }
  return blob;
}

/** What removeOwnerItemIfOurs found. */
export type OwnerItemRemoval = 'removed' | 'absent' | 'other' | 'failed';

/**
 * IR-M1-8h-1 L2: removes the `owner` item only when it is still exactly `blob`, the item this run
 * stored. `absent`: there is no item (nothing to remove); `other`: the item is not this run's (for
 * example a concurrent `owner init`) and is kept; `failed`: the keychain refused the delete. The read
 * and the delete are not atomic in the OS keychain API (the same residual as storeOwnerSeed).
 */
export async function removeOwnerItemIfOurs(
  keychain: KeychainBackend,
  blob: Uint8Array,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<OwnerItemRemoval> {
  let current: Uint8Array | null;
  try {
    current = await readOwnerItem(keychain, timeoutMs);
  } catch {
    return 'failed';
  }
  if (current === null) return 'absent';
  const ours = equalBytes(current, blob);
  wipe(current);
  if (!ours) return 'other';
  const removed = await guarded(() => keychain.delete(OWNER_ACCOUNT), timeoutMs).catch(() => false);
  return removed ? 'removed' : 'failed';
}

// --- Changing the owner code (M1-9z) -------------------------------------------------------------

/**
 * M1-9z (04 §2.8 "Changing the owner code"): the keychain account that holds the re-wrapped owner
 * seed while `owner change-code` verifies it, before it replaces the `owner` item. It only ever holds
 * an `ALKO` v1 blob (ciphertext) and is removed once the change has finished or failed.
 */
export const OWNER_NEXT_ACCOUNT = 'owner-next';

/** The owner item opened with the current secret: the seed (caller wipes it), its keys, the blob. */
export interface OpenedOwnerItem {
  readonly seed: Uint8Array;
  readonly owner: OwnerPublicKeys;
  /** The `owner` item as it was read (ciphertext), to check it is unchanged before replacing it. */
  readonly blob: Uint8Array;
}

/**
 * M1-9z: opens the `owner` item (or, with `account`, the staged `owner-next` item of an unfinished
 * change) with the owner secret typed at the prompt. With `expected`
 * (the owner the local cards name), the seed must derive exactly those keys; without, the keys come
 * from the seed. `owner_missing` without an item, `owner_mismatch` for a size other than 90 bytes,
 * `presence_rejected` for a wrong secret, a damaged item or another owner (one answer, 04 §2.8).
 * The presented secret is wiped whether or not it opens.
 */
export async function openOwnerItem(
  keychain: KeychainBackend,
  presence: OwnerPresence,
  expected: OwnerPublicKeys | undefined,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
  account: typeof OWNER_ACCOUNT | typeof OWNER_NEXT_ACCOUNT = OWNER_ACCOUNT,
): Promise<OpenedOwnerItem> {
  const secret = presenceSecret(presence);
  let blob: Uint8Array | null = null;
  let seed: Uint8Array | undefined;
  try {
    const want = expected === undefined ? undefined : ownerKeysCopy(expected);
    blob = await guarded(() => keychain.get(account), timeoutMs);
    if (blob === null) throw ownerMissing();
    if (blob.length !== ALKO_LENGTH) throw ownerMismatch();
    try {
      seed =
        want === undefined
          ? await openOwnerSeedWithoutCard(
              blob,
              { secret, source: 'prompt' },
              { fileKeystoreMachine: false },
            )
          : await openOwnerSeed(
              blob,
              { secret, source: 'prompt' },
              { ownerEvm: want.ownerEvm, ownerNostr: want.ownerNostr },
              { fileKeystoreMachine: false },
            );
    } catch (error) {
      if (error instanceof CryptoInputError) throw presenceRejected();
      throw error;
    }
    const owner = publicKeysOf(seed);
    if (want !== undefined && !sameOwner(owner, want)) throw presenceRejected();
    const opened = Object.freeze({ seed, owner: ownerKeysCopy(owner), blob });
    seed = undefined;
    blob = null;
    return opened;
  } finally {
    wipe(secret, blob, seed);
  }
}

const changeFailedUnchanged = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keychain_failed',
    `The system keychain refused the request, so your owner code wasn't changed. Your current owner code still works. Unlock the keychain and run \`${CLI_COMMAND} owner change-code\` again.`,
  );

/**
 * M1-9z (04 §2.8 "Changing the owner code"): re-wraps `seed` under the new generated owner code and
 * replaces the `owner` item without ever losing the seed:
 *
 * 1. seal a fresh `ALKO` v1 blob (new salt and nonce) under `secret` and write it to the staging
 *    account `owner-next`;
 * 2. read it back, require the same bytes, and open the read-back bytes with `secret`: they must
 *    derive exactly `owner`;
 * 3. require the `owner` item to still be `oldBlob` (no concurrent change);
 * 4. write the new blob as the `owner` item and require it to read back exactly;
 * 5. remove the staging item.
 *
 * Any failure before step 4 leaves the `owner` item untouched (the current code keeps working) and
 * removes the staging item. If step 4 fails and the `owner` item still reads as `oldBlob`, the
 * staging item is removed and the current code keeps working. If the `owner` item reads as neither,
 * the staging item (the seed under the new code) is kept so nothing is lost. `seed`, `secret` and
 * `oldBlob` are not modified; the kek and every read-back are wiped.
 */
export async function replaceOwnerWrap(
  keychain: KeychainBackend,
  seed: Uint8Array,
  owner: OwnerPublicKeys,
  oldBlob: Uint8Array,
  secret: Uint8Array,
  options: StoreOwnerSeedOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const want = ownerKeysCopy(owner);
  const kek = await newKeystoreKek(
    'ALKO',
    { secret, secretKind: 1, source: 'prompt' },
    options.kdf,
  );
  let blob: Uint8Array;
  try {
    blob = await sealOwnerSeed(kek, seed, { destination: 'local', fileKeystoreMachine: false });
  } finally {
    wipe(kek.kek);
  }
  const dropStaging = async (): Promise<void> => {
    await guarded(() => keychain.delete(OWNER_NEXT_ACCOUNT), timeoutMs).catch(() => false);
  };

  // Steps 1 to 3: nothing below touches the `owner` item.
  try {
    await guarded(() => keychain.set(OWNER_NEXT_ACCOUNT, blob), timeoutMs);
    const staged = await guarded(() => keychain.get(OWNER_NEXT_ACCOUNT), timeoutMs);
    const sameBytes = staged !== null && equalBytes(staged, blob);
    let check: Uint8Array | undefined;
    try {
      if (!sameBytes || staged === null) throw changeFailedUnchanged();
      check = await openOwnerSeedWithoutCard(
        staged,
        { secret, source: 'prompt' },
        { fileKeystoreMachine: false },
      ).catch(() => {
        throw changeFailedUnchanged();
      });
      if (!sameOwner(publicKeysOf(check), want)) throw changeFailedUnchanged();
    } finally {
      wipe(staged, check);
    }
    const current = await readOwnerItem(keychain, timeoutMs);
    const unchanged = current !== null && equalBytes(current, oldBlob);
    if (current !== null) wipe(current);
    if (!unchanged) {
      throw new NodeKeyStoreError(
        'owner_mismatch',
        `The owner key on this computer changed while you were changing its code, so nothing was changed. Run \`${CLI_COMMAND} doctor\` in your own terminal.`,
      );
    }
  } catch (error) {
    await dropStaging();
    if (error instanceof NodeKeyStoreError) throw error;
    throw changeFailedUnchanged();
  }

  // Step 4: replace the owner item.
  try {
    await guarded(() => keychain.set(OWNER_ACCOUNT, blob), timeoutMs);
  } catch {
    // Decided below from what the keychain now holds.
  }
  const after = await readOwnerItem(keychain, timeoutMs).catch(() => null);
  const stillOld = after !== null && equalBytes(after, oldBlob);
  const replaced = after !== null && equalBytes(after, blob);
  if (after !== null) wipe(after);
  if (replaced) {
    await dropStaging();
    return;
  }
  if (stillOld) {
    await dropStaging();
    throw changeFailedUnchanged();
  }
  // Neither the old nor the new wrap: keep the staging item, which holds the seed under the new code.
  throw new NodeKeyStoreError(
    'keychain_failed',
    `The system keychain didn't confirm the change. Keep both your current and your new owner code, and run \`${CLI_COMMAND} owner change-code\` again in your own terminal: it finishes or cleans up this change.`,
  );
}

const restoreOwnerFailed = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keychain_failed',
    "The system keychain refused the request, so the owner key wasn't restored. Nothing was changed; unlock the keychain and run the restore again.",
  );

/**
 * M1-9i-c (04 §2.3.3 restore step 6, §2.8 "Changing the owner code"): stores a restored owner seed as
 * the `owner` item under `secret` (a new generated owner code, kind 1) with the `owner-next` write,
 * read-back and open protocol, and never overwrites:
 *
 * 1. refuse (`item_exists`) while an `owner`, `owner-next` or `owner-passkey` item exists;
 * 2. seal a fresh `ALKO` v1 blob under `secret`, write it to `owner-next`, read it back, require the
 *    same bytes, and open the read-back bytes with `secret`: they must derive `expectedOwnerNostr`;
 * 3. require the `owner` item to still be absent, write the blob as `owner` and read it back;
 * 4. remove `owner-next`.
 *
 * Any failure removes `owner-next` (the kit still holds the seed) and leaves no `owner` item this
 * run wrote. `seed` and `secret` are not modified; the kek and every read-back are wiped.
 */
export async function storeRestoredOwnerSeed(
  keychain: KeychainBackend,
  seed: Uint8Array,
  expectedOwnerNostr: Uint8Array,
  secret: Uint8Array,
  options: StoreOwnerSeedOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  for (const account of [OWNER_ACCOUNT, OWNER_NEXT_ACCOUNT, OWNER_PASSKEY_ACCOUNT]) {
    const existing = await guarded(() => keychain.get(account), timeoutMs);
    if (existing !== null) {
      wipe(existing);
      throw new KeyStoreError('item_exists', 'owner keystore: an owner item already exists');
    }
  }
  const kek = await newKeystoreKek(
    'ALKO',
    { secret, secretKind: 1, source: 'prompt' },
    options.kdf,
  );
  let blob: Uint8Array;
  try {
    blob = await sealOwnerSeed(kek, seed, { destination: 'local', fileKeystoreMachine: false });
  } finally {
    wipe(kek.kek);
  }
  let staged = false;
  try {
    staged = true;
    await guarded(() => keychain.set(OWNER_NEXT_ACCOUNT, blob), timeoutMs);
    const back = await guarded(() => keychain.get(OWNER_NEXT_ACCOUNT), timeoutMs);
    let check: Uint8Array | undefined;
    try {
      if (back === null || !equalBytes(back, blob)) throw restoreOwnerFailed();
      check = await openOwnerSeedWithoutCard(
        back,
        { secret, source: 'prompt' },
        { fileKeystoreMachine: false },
      ).catch(() => {
        throw restoreOwnerFailed();
      });
      if (!equalBytes(publicKeysOf(check).ownerNostr, expectedOwnerNostr)) {
        throw restoreOwnerFailed();
      }
    } finally {
      wipe(back, check);
    }
    const current = await readOwnerItem(keychain, timeoutMs);
    if (current !== null) {
      wipe(current);
      throw new KeyStoreError('item_exists', 'owner keystore: an owner item already exists');
    }
    try {
      await guarded(() => keychain.set(OWNER_ACCOUNT, blob), timeoutMs);
    } catch {
      // Decided below from what the keychain now holds.
    }
    const after = await readOwnerItem(keychain, timeoutMs).catch(() => null);
    const ownerWritten = after !== null && equalBytes(after, blob);
    if (after !== null) wipe(after);
    if (!ownerWritten) throw restoreOwnerFailed();
  } catch (error) {
    if (error instanceof KeyStoreError || error instanceof NodeKeyStoreError) throw error;
    throw restoreOwnerFailed();
  } finally {
    if (staged) {
      await guarded(() => keychain.delete(OWNER_NEXT_ACCOUNT), timeoutMs).catch(() => false);
    }
    wipe(blob);
  }
}

/**
 * M1-9z: the staged `owner-next` item of an unfinished owner-code change, or null. Ciphertext only;
 * the caller wipes it.
 */
export async function readStagedOwnerItem(
  keychain: KeychainBackend,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  return guarded(() => keychain.get(OWNER_NEXT_ACCOUNT), timeoutMs);
}

/**
 * M1-9z: removes the staged `owner-next` item only while it is still exactly `staged` (the bytes the
 * caller read). Callers do this only after the `owner` item opened with the owner's secret (or was
 * just replaced by `staged`), so the seed is safe in the `owner` item. False when the item changed
 * or the keychain refused; nothing is removed then.
 */
export async function removeStagedOwnerItem(
  keychain: KeychainBackend,
  staged: Uint8Array,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<boolean> {
  const current = await readStagedOwnerItem(keychain, timeoutMs).catch(() => null);
  const same = current !== null && equalBytes(current, staged);
  if (current !== null) wipe(current);
  if (!same) return false;
  return guarded(() => keychain.delete(OWNER_NEXT_ACCOUNT), timeoutMs).catch(() => false);
}

/**
 * M1-9z: finishes an unfinished owner-code change. `staged` is the `owner-next` blob the owner just
 * opened with the new code (to the expected owner, when one is known); `ownerSeen` is the `owner`
 * item as read when the command started (null when there was none). The `owner` item must still be
 * `ownerSeen`; it is then replaced by `staged` and read back, and only after an exact read-back is
 * `owner-next` removed. On any failure `owner-next` is kept, so the seed is never lost.
 */
export async function promoteStagedOwnerWrap(
  keychain: KeychainBackend,
  staged: Uint8Array,
  ownerSeen: Uint8Array | null,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<void> {
  const before = await readOwnerItem(keychain, timeoutMs);
  const unchanged =
    before === null ? ownerSeen === null : ownerSeen !== null && equalBytes(before, ownerSeen);
  if (before !== null) wipe(before);
  if (!unchanged) {
    throw new NodeKeyStoreError(
      'owner_mismatch',
      `The owner key on this computer changed while you were finishing the owner code change, so nothing was changed. Run \`${CLI_COMMAND} owner change-code\` again in your own terminal.`,
    );
  }
  try {
    await guarded(() => keychain.set(OWNER_ACCOUNT, staged), timeoutMs);
  } catch {
    // Decided below from what the keychain now holds.
  }
  const after = await readOwnerItem(keychain, timeoutMs).catch(() => null);
  const replaced = after !== null && equalBytes(after, staged);
  if (after !== null) wipe(after);
  if (!replaced) {
    throw new NodeKeyStoreError(
      'keychain_failed',
      `The system keychain refused the request, so the owner code change isn't finished yet. Keep both your current and your new owner code, unlock the keychain and run \`${CLI_COMMAND} owner change-code\` again.`,
    );
  }
  await removeStagedOwnerItem(keychain, staged, timeoutMs);
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

/**
 * M1-9i-c (04 §2.3.3 "Export: who sees the seeds"): a copy of the owner seed for the sessions that
 * unlockForExport issued, and only those, so the paired KeyExportControl can seal it into a recovery
 * kit inside this package. Module-private: no session method, field or reference reaches it. The copy
 * is wiped when the session ends (expiry, close, lock or store close).
 */
const SESSION_SEEDS = new WeakMap<OwnerSession, Uint8Array>();

/**
 * M1-9i-c: what the export control may do with `session`: `foreign` for anything `store` did not
 * issue (a look-alike, a Proxy, another store's session), `ended` once it ended, `no_seed` for a
 * genuine session without the export capability, else `ok` with a copy of the seed (wipe it).
 */
export function exportSeedOf(
  session: unknown,
  store: KeychainOwnerKeyStore,
):
  | { readonly status: 'foreign' | 'ended' | 'no_seed' }
  | { readonly status: 'ok'; readonly seed: Uint8Array } {
  if (!issuedBy(session, store)) return { status: 'foreign' };
  const genuine = session as OwnerSession;
  if (!genuine.isActive()) return { status: 'ended' };
  const seed = SESSION_SEEDS.get(genuine);
  if (seed === undefined) return { status: 'no_seed' };
  return { status: 'ok', seed: seed.slice() };
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
 * Internal to @4thtech-io/node: the package entry exposes only performOwnerOperation, which reads the
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
   * 04 §2.5: unwraps the owner seed with the owner code or passphrase typed at the prompt (the
   * `owner` item, `ALKO`), or with the localhost passkey's PRF output after the owner's gesture
   * (M1-8e: the `owner-passkey` item, `ALKP` v1, 04 §2.3.1), checks it against the expected owner,
   * derives the session's owner keys and wipes the seed. The presented secret or PRF output is wiped
   * whether or not it unlocks. A wrong passkey, a missing or tampered `owner-passkey` item, another
   * owner and a blob of another type are one answer, `presence_rejected`. The caller has checked the
   * assertion (credential ID, user handle, rpIdHash, UP and UV) before it hands the PRF output here.
   */
  unlock(presence: OwnerPresence, options: UnlockOptions = {}): Promise<OwnerSession> {
    return this.#unlock(presence, options, false);
  }

  /**
   * M1-9i-c: unlock() for `agentlink backup export` † only. The same presence proof and checks; the
   * session also lets this store's KeyExportControl read a copy of the owner seed (04 §2.3.3 "Export:
   * who sees the seeds"), which is wiped when the session ends. Never offered to the agent path.
   */
  unlockForExport(presence: OwnerPresence, options: UnlockOptions = {}): Promise<OwnerSession> {
    return this.#unlock(presence, options, true);
  }

  async #unlock(
    presence: OwnerPresence,
    options: UnlockOptions,
    keepSeed: boolean,
  ): Promise<OwnerSession> {
    const generation = this.#generation;
    const proof = presenceProof(presence);
    let blob: Uint8Array | null | undefined;
    let seed: Uint8Array | undefined;
    try {
      const ttlMs = options.ttlMs ?? OWNER_SESSION_DEFAULT_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > OWNER_SESSION_MAX_TTL_MS) {
        throw new CryptoInputError(
          'invalid_argument',
          'owner keystore: ttlMs must be an integer from 1 to OWNER_SESSION_MAX_TTL_MS',
        );
      }
      if (proof.kind === 'passphrase') {
        blob = await this.#blob();
        try {
          seed = await openOwnerSeed(
            blob,
            { secret: proof.bytes, source: 'prompt' },
            { ownerEvm: this.#expected.ownerEvm, ownerNostr: this.#expected.ownerNostr },
            { fileKeystoreMachine: false },
          );
        } catch (error) {
          // A wrong secret, a damaged item and a foreign owner are one answer (04 §2.8 tests).
          if (error instanceof CryptoInputError) throw presenceRejected();
          throw error;
        }
      } else {
        this.#open();
        blob = await guarded(() => this.#keychain.get(OWNER_PASSKEY_ACCOUNT), this.#timeoutMs);
        if (blob === null) throw presenceRejected();
        try {
          seed = await openPasskeySeed(blob, proof.bytes, {
            expectedOwnerNostr: this.#expected.ownerNostr,
          });
        } catch (error) {
          // A wrong passkey, a tampered blob, another owner or type: one answer (04 §2.3.1).
          if (error instanceof CryptoInputError) throw presenceRejected();
          throw error;
        }
      }
      if (!sameOwner(publicKeysOf(seed), this.#expected)) throw presenceRejected();
      if (this.#closed || generation !== this.#generation) {
        throw new KeyStoreError('owner_locked', 'owner keystore: locked while unlocking');
      }
      return this.#issue(seed, ttlMs, keepSeed);
    } finally {
      // The presented secret, the blob and the seed never outlive this call (04 §8.3).
      wipe(proof.bytes, blob ?? undefined, seed);
    }
  }

  /** Derives the session's owner keys from `seed` (not modified; the caller wipes it). */
  #issue(seed: Uint8Array, ttlMs: number, keepSeed = false): OwnerSession {
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
        (ended) => {
          this.#sessions.delete(ended);
          const kept = SESSION_SEEDS.get(ended);
          SESSION_SEEDS.delete(ended);
          if (kept !== undefined) wipe(kept);
        },
      );
    } catch (error) {
      wipe(nostr, evm, enc);
      throw error;
    }
    this.#sessions.add(session);
    ISSUED_SESSIONS.set(session, this);
    if (keepSeed) SESSION_SEEDS.set(session, seed.slice());
    return session;
  }

  /**
   * M1-9x (04 §2.8 "Adding an agent to the existing owner"): unlocks the `owner` item when no local
   * agent card names the owner, so there is no expected owner to check against. The owner keys are
   * taken from the item itself: the seed the owner code (or opted-in passphrase) unwraps derives
   * them, and the returned store expects exactly those keys from then on. The authenticated
   * decryption under the typed secret is the only check, so `confirm` (which MUST show the owner
   * fingerprint and ask the owner) runs before the session is issued; false returns null and
   * issues nothing. The seed is held only until the answer and wiped either way.
   *
   * `owner_missing` without an item, `owner_mismatch` when it is not 90 bytes, `presence_rejected`
   * for a wrong secret or a damaged item (one answer, 04 §2.8). The presented secret, the blob and
   * the seed are wiped whether or not it unlocks.
   */
  static async unlockWithoutCard(
    keychain: KeychainBackend,
    presence: OwnerPresence,
    confirm: (owner: OwnerPublicKeys) => Promise<boolean>,
    options: UnlockOptions & KeychainOwnerKeyStoreOptions = {},
  ): Promise<{
    readonly store: KeychainOwnerKeyStore;
    readonly session: OwnerSession;
    readonly owner: OwnerPublicKeys;
  } | null> {
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
      // The owner confirms the derived fingerprint before any session exists, so the session's
      // TTL starts only after the answer (IR-M1-9x-1 L-2). Declining issues nothing.
      if (!(await confirm(ownerKeysCopy(owner)))) return null;
      const store = new KeychainOwnerKeyStore(keychain, ownerKeysCopy(owner), timeoutMs);
      const session = store.#issue(seed, ttlMs);
      return Object.freeze({ store, session, owner: ownerKeysCopy(owner) });
    } finally {
      wipe(secret, blob, seed);
    }
  }

  /**
   * HOTFIX-045-REMOVE (04 §2.5 "Removing an agent", Try again after step 6): unlocks the stored
   * owner when no agent card is open and only the owner's Nostr key is known, from a signed
   * `agent.revoke` the caller has verified (the owner's revoked list). The same presence as unlock:
   * the owner code or passphrase on the `owner` item, or the localhost passkey's PRF output on the
   * `owner-passkey` item (the caller has checked the assertion against `ownerNostr`). The seed must
   * derive exactly `ownerNostr`; the other owner keys are derived from that seed, and the returned
   * store expects exactly those keys from then on. A wrong secret, a damaged item and another owner
   * are one answer, `presence_rejected`; `owner_missing` without an `owner` item. The presented
   * bytes, the blob and the seed are wiped whether or not it unlocks.
   */
  static async unlockForOwnerNostr(
    keychain: KeychainBackend,
    ownerNostr: Uint8Array,
    presence: OwnerPresence,
    options: UnlockOptions & KeychainOwnerKeyStoreOptions = {},
  ): Promise<{
    readonly store: KeychainOwnerKeyStore;
    readonly session: OwnerSession;
    readonly owner: OwnerPublicKeys;
  }> {
    const proof = presenceProof(presence);
    let blob: Uint8Array | null = null;
    let seed: Uint8Array | undefined;
    try {
      if (!(ownerNostr instanceof Uint8Array) || ownerNostr.length !== 32) {
        throw new CryptoInputError(
          'invalid_argument',
          'owner keystore: ownerNostr must be 32 bytes',
        );
      }
      const ttlMs = options.ttlMs ?? OWNER_SESSION_DEFAULT_TTL_MS;
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > OWNER_SESSION_MAX_TTL_MS) {
        throw new CryptoInputError(
          'invalid_argument',
          'owner keystore: ttlMs must be an integer from 1 to OWNER_SESSION_MAX_TTL_MS',
        );
      }
      const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
      if (proof.kind === 'passphrase') {
        blob = await readOwnerItem(keychain, timeoutMs);
        if (blob === null) throw ownerMissing();
        if (blob.length !== ALKO_LENGTH) throw ownerMismatch();
        try {
          seed = await openOwnerSeedWithoutCard(
            blob,
            { secret: proof.bytes, source: 'prompt' },
            { fileKeystoreMachine: false },
          );
        } catch (error) {
          if (error instanceof CryptoInputError) throw presenceRejected();
          throw error;
        }
      } else {
        blob = await guarded(() => keychain.get(OWNER_PASSKEY_ACCOUNT), timeoutMs);
        if (blob === null) throw presenceRejected();
        try {
          seed = await openPasskeySeed(blob, proof.bytes, { expectedOwnerNostr: ownerNostr });
        } catch (error) {
          if (error instanceof CryptoInputError) throw presenceRejected();
          throw error;
        }
      }
      const owner = publicKeysOf(seed);
      // The owner the signed entry names, and no other (the derivation binds the other two keys).
      if (!equalBytes(owner.ownerNostr, ownerNostr)) throw presenceRejected();
      const store = new KeychainOwnerKeyStore(keychain, ownerKeysCopy(owner), timeoutMs);
      const session = store.#issue(seed, ttlMs);
      return Object.freeze({ store, session, owner: ownerKeysCopy(owner) });
    } finally {
      wipe(proof.bytes, blob ?? undefined, seed);
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
 * The bytes of a presence proof for unlock: a non-empty passphrase, or a 32-byte passkey PRF output
 * (M1-8e). Anything else is `presence_required`, and any bytes it carried are wiped.
 */
function presenceProof(presence: unknown): {
  readonly kind: 'passphrase' | 'passkey-prf';
  readonly bytes: Uint8Array;
} {
  if (typeof presence !== 'object' || presence === null) throw presenceRequired();
  const { kind, secret, prfOutput } = presence as Record<string, unknown>;
  if (kind === 'passphrase' && secret instanceof Uint8Array && secret.length > 0) {
    if (prfOutput instanceof Uint8Array) wipe(prfOutput);
    return { kind, bytes: secret };
  }
  if (kind === 'passkey-prf' && prfOutput instanceof Uint8Array && prfOutput.length === 32) {
    if (secret instanceof Uint8Array) wipe(secret);
    return { kind, bytes: prfOutput };
  }
  for (const value of [secret, prfOutput]) if (value instanceof Uint8Array) wipe(value);
  throw presenceRequired();
}

/**
 * The owner secret of a passphrase presence proof (owner add-agent without a card stays code-only).
 * Anything else is `presence_required`, and any bytes it carried are wiped.
 */
function presenceSecret(presence: unknown): Uint8Array {
  if (typeof presence !== 'object' || presence === null) throw presenceRequired();
  const { kind, secret, prfOutput } = presence as Record<string, unknown>;
  if (kind === 'passphrase' && secret instanceof Uint8Array && secret.length > 0) return secret;
  for (const value of [secret, prfOutput]) if (value instanceof Uint8Array) wipe(value);
  throw presenceRequired();
}
