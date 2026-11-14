// DESK-D12c (S2; D-145 phase 2; 04 §2.2 "Local, desktop app", §2.3.4, §2.5 "Desktop app owner
// presence"; D-68; I-1, I-4, I-7): native owner presence in core, over the desktop app's presence
// helper (owner-native-helper.ts; DESK-D12b).
//
// - The owner seed is stored once more as an `ALKH` v1 blob (04 §2.3.4) under the secret the helper
//   releases after the OS gesture, in the keychain item service `agentlink`, account `owner-native`.
//   The `owner` item (`ALKO`, the master code) is unchanged and stays the fallback; `owner-passkey`
//   stays where it exists.
// - Registration is its own owner operation (registerOwnerNative): one entry of the master code (or
//   one passkey gesture, checked by the caller) opens the seed, checked against the owner the card
//   names; the helper's `create` makes the credential and the per-install peer key or challenge; on
//   macOS `check` proves the key refuses without a gesture, then one `ecdh setup` releases the
//   secret; on Windows the one prompt of `create` already gave the signature. Core seals, stores,
//   reads back and opens the blob once with the same secret. The record stays in this process's
//   memory from `create` to the release and the seal (Fable review of DESK-D12b, M2): nothing is
//   written between them, so no other process can swap the peer key or challenge in that gap. No
//   `SignedOwnerAction` is made. A second registration is refused, never a replacement. At first-time
//   setup the held seed is stored the same way (storeOwnerNativeSeed), so a Windows Hello computer
//   needs the master code only as the fallback.
// - Presence (nativePresence): the record is rebuilt from the stored header (never stored apart from
//   the blob), the header must name this platform's kind and the expected owner before the helper
//   runs, then the helper runs once with a fixed reason. The released secret is handed to
//   OwnerKeyStore.unlock, which opens the blob for exactly one owner operation and wipes it (D-68:
//   one gesture is one owner operation). The reason is display-only (04 §2.3.4): a paid action's
//   statement is bound by the caller's signed flow (approval-server.ts pay confirm), not here.
//
// Threat note (04 §2.3.4 "Honest strength", §2.5 G-1): while builds are unsigned this equals the
// passkey PRF path. A same-user process can run the helper with the stored record and receive the
// secret after the owner's gesture; without the gesture it gets nothing (the helper refuses), and the
// blob alone opens with no guess. Binding the release to the signed app is phase 3.
//
// Everything secret is a Uint8Array wiped after use (04 §8.3, best effort). No error carries a
// secret, a record, a helper output or a keychain message (I-7).
import {
  CryptoInputError,
  KeyStoreError,
  NATIVE_PRESENCE_MACOS,
  encodeNativeHelperRecord,
  equalBytes,
  readNativeBlobHeader,
  readNativeCreateOutput,
  wipe,
  type NativeBlobHeader,
  type NativePresenceKind,
  type OwnerPresence,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import {
  openNativeSeed,
  openOwnerSeed,
  openPasskeySeed,
  sealNativeSeed,
} from '@4thtech-io/crypto/keystore';
import { CLI_COMMAND } from './cli-command.js';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import {
  NativeHelperError,
  isAborted,
  type NativeAvailability,
  type NativeHelper,
  type NativeReason,
  type NativeUnavailableReason,
} from './owner-native-helper.js';
import {
  OWNER_NATIVE_ACCOUNT,
  OWNER_NATIVE_REVOKED_ACCOUNT,
  OWNER_PASSKEY_ACCOUNT,
  nativeCredentialTag,
  nativeTagRevoked,
  ownerKeysCopy,
  ownerMissing,
  readOwnerItem,
  sameOwnerKeys,
  type OwnerItemRemoval,
} from './owner-keystore.js';

export { OWNER_NATIVE_ACCOUNT };

/** The native presence of OwnerKeyStore.unlock (`@4thtech-io/crypto` OwnerPresence). */
export type NativeOwnerPresence = Extract<OwnerPresence, { kind: 'native' }>;

const ALKO_LENGTH = 90;

const presenceRejected = (): KeyStoreError =>
  new KeyStoreError('presence_rejected', 'owner keystore: presence proof rejected');
const presenceRequired = (): KeyStoreError =>
  new KeyStoreError('presence_required', 'owner keystore: owner presence is required');
const nativeExists = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_native_exists',
    'Touch ID or Windows Hello is already turned on for approvals on this computer.',
  );
const nativeMissing = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_native_missing',
    'Touch ID or Windows Hello is not turned on for approvals on this computer.',
  );
const keychainFailed = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keychain_failed',
    `The system keychain refused the request. Unlock it and try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
  );
/** DESK-NATIVE-DEBUG: the item read back is missing or not the bytes just written. */
const readBackDiffers = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keychain_failed',
    `The system keychain refused the request. Unlock it and try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
    'refused',
  );

/**
 * DESK-NATIVE-DEBUG: the fixed name of each step of turning native presence on, off or on again, in
 * order, for the one diagnostic line a failure writes (approval-server.ts). Never carries data.
 */
export type NativeStep =
  | 'already_on_check'
  | 'master_code'
  | 'remove_old'
  | 'helper_create'
  | 'create_output'
  | 'helper_check'
  | 'helper_ecdh'
  | 'seal'
  | 'keychain_write'
  | 'keychain_read_back'
  | 'open_once';

export interface OwnerNativeOptions {
  readonly timeoutMs?: number;
  /** DESK-NATIVE-DEBUG: called with each step's fixed name as it begins (diagnostics only). */
  readonly onStep?: (step: NativeStep) => void;
  /**
   * DESK-TOUCHID-FIX review (Fable M-1): the page cancelled or went away. Reaches every helper call
   * of turning it on (create, check, the setup gesture): the helper is stopped, nothing is stored.
   */
  readonly signal?: AbortSignal;
}

/** The fixed cancel of an aborted operation. */
const aborted = (): NativeHelperError => new NativeHelperError('cancelled', 'aborted');

/** DESK-TOUCHID-FIX review (Fable L-1): a write that timed out and did not settle in time either. */
const keychainUnsure = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keychain_failed',
    `The system keychain did not answer in time. Touch ID or Windows Hello may have been turned on; check the status. \`${CLI_COMMAND} doctor\` shows what is wrong.`,
    'unsure',
  );

/** Calls `onStep` with `step`; an exception in it changes nothing. */
function stepTo(options: OwnerNativeOptions, step: NativeStep): void {
  try {
    options.onStep?.(step);
  } catch {
    // Diagnostics never change the outcome.
  }
}

/** A helper output core cannot use: the helper's fault, never a wrong master code. */
const helperOutputBad = (): NativeHelperError => new NativeHelperError('error', 'bad_output');

/** The `owner-native` item's bytes, or null. Ciphertext and public header only; the caller wipes. */
function readItem(keychain: KeychainBackend, timeoutMs: number): Promise<Uint8Array | null> {
  return guarded(() => keychain.get(OWNER_NATIVE_ACCOUNT), timeoutMs);
}

/** The public header of the stored `owner-native` item; null when there is none or it is not ALKH. */
export async function readOwnerNativeHeader(
  keychain: KeychainBackend,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<NativeBlobHeader | null> {
  const blob = await readItem(keychain, timeoutMs);
  if (blob === null) return null;
  try {
    return readNativeBlobHeader(blob);
  } catch {
    return null;
  } finally {
    wipe(blob);
  }
}

export interface NativePresenceStatus {
  /** This computer's helper is here and Touch ID / Windows Hello is set up. */
  readonly available: boolean;
  /** An `owner-native` item for this platform and this owner exists. */
  readonly registered: boolean;
  /**
   * Why it cannot be used: another owner's or the other platform's item (`other_owner`), an item that
   * does not read as ALKH or was revoked (`damaged`), or a key the helper says is no longer valid,
   * e.g. after a fingerprint change (`reregister`). The last two are fixed by turning it on again.
   */
  readonly reason?: 'other_owner' | 'damaged' | 'reregister';
  /**
   * WIN-HELLO-NATIVE: why it is not available (only when `available` is false and the helper is
   * here): Windows Hello / Touch ID not set up, no secure hardware (TPM / Secure Enclave), unknown.
   * The page then offers the master code with plain set-up text, never a WebAuthn security key.
   */
  readonly unavailable?: NativeUnavailableReason;
}

/** Whether native presence can be offered here, and whether it is turned on for `ownerNostr`. */
export async function nativePresenceStatus(
  keychain: KeychainBackend,
  helper: NativeHelper | undefined,
  ownerNostr: Uint8Array | undefined,
  options: OwnerNativeOptions = {},
): Promise<NativePresenceStatus> {
  if (helper === undefined) return { available: false, registered: false };
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const availability = await helper
    .availability()
    .catch((): NativeAvailability => ({ available: false, reason: 'unknown' }));
  const available = availability.available;
  const why = availability.available ? {} : { unavailable: availability.reason };
  const blob = await readItem(keychain, timeoutMs).catch(() => null);
  if (blob === null) return { available, registered: false, ...why };
  let header: NativeBlobHeader;
  try {
    header = readNativeBlobHeader(blob);
  } catch {
    return { available, registered: false, reason: 'damaged', ...why };
  } finally {
    wipe(blob);
  }
  const ours =
    header.kind === helper.kind &&
    ownerNostr !== undefined &&
    equalBytes(header.ownerNostr, ownerNostr);
  if (!ours) return { available, registered: false, reason: 'other_owner', ...why };
  const revoked = await guarded(() => keychain.get(OWNER_NATIVE_REVOKED_ACCOUNT), timeoutMs).catch(
    () => null,
  );
  if (nativeTagRevoked(revoked, nativeCredentialTag(header))) {
    return { available, registered: false, reason: 'damaged', ...why };
  }
  // No prompt: the helper's `check` only asks whether the key is still valid.
  const valid = await helper
    .check(encodeNativeHelperRecord(header.kind, header))
    .then(() => true)
    .catch(
      (error: unknown) => !(error instanceof NativeHelperError && error.state === 'reregister'),
    );
  return valid
    ? { available, registered: true, ...why }
    : { available, registered: true, reason: 'reregister', ...why };
}

/**
 * One native presence for one owner operation: reads the `owner-native` header, refuses (before the
 * helper runs, `presence_rejected`) a missing or malformed item, another kind than this platform's
 * and another owner than `ownerNostr`, rebuilds the record from the header and runs the helper once
 * with `reason`. A refused gesture rejects with NativeHelperError (its fixed state) and no bytes.
 * The returned secret is wiped by the unlock it is given to; the caller wipes it if it is not used.
 */
export async function nativePresence(
  keychain: KeychainBackend,
  helper: NativeHelper,
  ownerNostr: Uint8Array,
  reason: NativeReason,
  options: OwnerNativeOptions & { readonly signal?: AbortSignal } = {},
): Promise<NativeOwnerPresence> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const blob = await readItem(keychain, timeoutMs);
  if (blob === null) throw presenceRejected();
  let record: Uint8Array;
  try {
    const header = readNativeBlobHeader(blob);
    if (header.kind !== helper.kind || !equalBytes(header.ownerNostr, ownerNostr)) {
      throw presenceRejected();
    }
    const revoked = await guarded(() => keychain.get(OWNER_NATIVE_REVOKED_ACCOUNT), timeoutMs);
    if (nativeTagRevoked(revoked, nativeCredentialTag(header))) throw presenceRejected();
    record = encodeNativeHelperRecord(header.kind, header);
  } catch (error) {
    if (error instanceof CryptoInputError) throw presenceRejected();
    throw error;
  } finally {
    wipe(blob);
  }
  if (options.signal?.aborted === true) throw new NativeHelperError('cancelled');
  const secret = await helper.release(record, reason, options.signal);
  // Fable review L1: a touch that arrives after the operation was abandoned approves nothing.
  if (isAborted(options.signal)) {
    wipe(secret);
    throw new NativeHelperError('cancelled');
  }
  return Object.freeze({ kind: 'native', nativeKind: helper.kind, secret });
}

/**
 * Stores `seed`, which must derive `owner`, as the `owner-native` item for a new helper credential
 * (04 §2.3.4 "Registration", steps after presence): refuses an existing item (`owner_native_exists`,
 * before the helper runs); `create`; on macOS `check`, then one `ecdh setup`; on Windows the
 * signature `create` folded in; seal, store, read back, open once with the same secret and compare.
 * The record is held in memory throughout and nothing is written before the seal. Returns the stored
 * blob (ciphertext) for removeOwnerNativeItemIfOurs. On failure after a Windows `create` the new
 * credential is deleted (best effort). `seed` is not modified; the caller wipes it.
 */
export async function storeOwnerNativeSeed(
  keychain: KeychainBackend,
  helper: NativeHelper,
  seed: Uint8Array,
  owner: OwnerPublicKeys,
  options: OwnerNativeOptions & { readonly sealed?: (blob: Uint8Array) => void } = {},
): Promise<Uint8Array> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const expected = ownerKeysCopy(owner);
  if (!(seed instanceof Uint8Array) || !sameOwnerKeys(seed, expected)) throw presenceRejected();
  stepTo(options, 'already_on_check');
  const existing = await readItem(keychain, timeoutMs);
  if (existing !== null) {
    wipe(existing);
    throw nativeExists();
  }
  const kind: NativePresenceKind = helper.kind;
  const signal = options.signal;
  if (isAborted(signal)) throw aborted();
  stepTo(options, 'helper_create');
  const printed = await helper.create(signal);
  let secret: Uint8Array | undefined;
  let back: Uint8Array | null = null;
  let check: Uint8Array | undefined;
  let created: Uint8Array | undefined;
  /** DESK-NATIVE-DEBUG: the blob once written; removed again when a later step fails. */
  let written: Uint8Array | undefined;
  /** DESK-TOUCHID-FIX review (Fable L-1): the write itself, which may settle after its timeout. */
  let writing: Promise<unknown> | undefined;
  try {
    if (isAborted(signal)) throw aborted();
    // The record is read into the header fields here and rebuilt from them; it must be canonical.
    // DESK-NATIVE-DEBUG: an output core cannot use is the helper's fault (`error`), never a wrong
    // master code: it must not show "that master code did not work" or count as a wrong code.
    stepTo(options, 'create_output');
    let parsed: ReturnType<typeof readNativeCreateOutput>;
    try {
      parsed = readNativeCreateOutput(kind, printed);
    } catch {
      throw helperOutputBad();
    }
    created = parsed.record;
    const record = encodeNativeHelperRecord(kind, parsed.credential);
    if (!equalBytes(record, parsed.record)) throw helperOutputBad();
    if (kind === NATIVE_PRESENCE_MACOS) {
      // The key must refuse without a gesture before the one gesture of registration.
      stepTo(options, 'helper_check');
      await helper.check(record, signal);
      if (isAborted(signal)) throw aborted();
      stepTo(options, 'helper_ecdh');
      secret = await helper.release(record, 'setup', signal);
    } else {
      secret = parsed.firstSecret;
    }
    if (secret === undefined) throw helperOutputBad();
    // A touch that arrives after the cancel turns nothing on.
    if (isAborted(signal)) throw aborted();
    stepTo(options, 'seal');
    const blob = await sealNativeSeed({
      kind,
      nativeSecret: secret,
      seed,
      credentialId: parsed.credential.credentialId,
      credentialPublicKey: parsed.credential.credentialPublicKey,
      challenge: parsed.credential.challenge,
    });
    options.sealed?.(blob);
    stepTo(options, 'keychain_write');
    written = blob;
    const write = keychain.set(OWNER_NATIVE_ACCOUNT, blob);
    writing = write.catch(() => undefined);
    await guarded(() => write, timeoutMs);
    stepTo(options, 'keychain_read_back');
    back = await readItem(keychain, timeoutMs);
    if (back === null || !equalBytes(back, blob)) throw readBackDiffers();
    stepTo(options, 'open_once');
    check = await openNativeSeed(back, secret, {
      expectedOwnerNostr: expected.ownerNostr,
      expectedKind: kind,
    });
    if (!equalBytes(check, seed)) throw keychainFailed();
    created = undefined;
    written = undefined;
    return blob;
  } catch (error) {
    // DESK-NATIVE-DEBUG: a write whose read-back or open failed (or that timed out but may still
    // land) must not leave an item behind: the next try would answer "already on" while the status
    // says off. Removed only while it is still exactly our bytes (best effort).
    if (written !== undefined) {
      // DESK-TOUCHID-FIX review (Fable L-1): a write that timed out may still land after this
      // rollback. Wait for it to settle (as long again) before removing; if it never settles, say
      // that it may have been turned on instead of "nothing changed".
      let settled = true;
      if (writing !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        settled = await Promise.race([
          writing.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        clearTimeout(timer);
      }
      await removeOwnerNativeItemIfOurs(keychain, written, timeoutMs).catch(() => undefined);
      // Unsure: the Windows credential is kept (the item may still name it).
      if (!settled) throw keychainUnsure();
    }
    if (created !== undefined && kind !== NATIVE_PRESENCE_MACOS) {
      await helper.remove(created).catch(() => undefined);
    }
    throw error;
  } finally {
    wipe(secret, back ?? undefined, check, printed);
  }
}

/**
 * Opens the owner seed for an owner operation of native presence itself (register, turn off,
 * replace): `presence` is the master code (`passphrase`, the `owner` item) or the passkey's PRF output
 * (`passkey-prf`, `owner-passkey`; the caller has checked the assertion). A native presence is never
 * accepted for these (`presence_required`): a captured native secret cannot turn itself back on. The
 * presented bytes are wiped; the caller wipes the seed.
 */
async function openSeedForNativeOp(
  keychain: KeychainBackend,
  owner: OwnerPublicKeys,
  presence: OwnerPresence,
  timeoutMs: number,
): Promise<Uint8Array> {
  const p = presence as Partial<Record<'kind', unknown> & Record<'secret' | 'prfOutput', unknown>>;
  const presented =
    p.kind === 'passphrase' ? p.secret : p.kind === 'passkey-prf' ? p.prfOutput : undefined;
  let item: Uint8Array | null = null;
  try {
    if (!(presented instanceof Uint8Array) || presented.length === 0) throw presenceRequired();
    let seed: Uint8Array;
    if (p.kind === 'passphrase') {
      item = await readOwnerItem(keychain, timeoutMs);
      if (item === null) throw ownerMissing();
      if (item.length !== ALKO_LENGTH) throw presenceRejected();
      try {
        seed = await openOwnerSeed(
          item,
          { secret: presented, source: 'prompt' },
          { ownerEvm: owner.ownerEvm, ownerNostr: owner.ownerNostr },
          { fileKeystoreMachine: false },
        );
      } catch (error) {
        if (error instanceof CryptoInputError) throw presenceRejected();
        throw error;
      }
    } else {
      item = await guarded(() => keychain.get(OWNER_PASSKEY_ACCOUNT), timeoutMs);
      if (item === null) throw presenceRejected();
      try {
        seed = await openPasskeySeed(item, presented, { expectedOwnerNostr: owner.ownerNostr });
      } catch (error) {
        if (error instanceof CryptoInputError) throw presenceRejected();
        throw error;
      }
    }
    if (!sameOwnerKeys(seed, owner)) {
      wipe(seed);
      throw presenceRejected();
    }
    return seed;
  } finally {
    const secret = (presence as { secret?: unknown }).secret;
    const prf = (presence as { prfOutput?: unknown }).prfOutput;
    for (const value of [secret, prf]) if (value instanceof Uint8Array) wipe(value);
    wipe(item ?? undefined);
  }
}

/**
 * Registers native presence for this owner: its own owner operation (04 §2.3.4 "Registration").
 * `presence` is the master code or the passkey (openSeedForNativeOp); a native presence never
 * registers (`presence_required`). Refuses before the helper runs when an `owner-native` item exists
 * (`owner_native_exists`), the presence is wrong (`presence_rejected`) or no owner is set up
 * (`owner_missing`). The presented bytes and the seed are wiped.
 */
export async function registerOwnerNative(
  keychain: KeychainBackend,
  helper: NativeHelper,
  expected: OwnerPublicKeys,
  presence: OwnerPresence,
  options: OwnerNativeOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const owner = ownerKeysCopy(expected);
  stepTo(options, 'already_on_check');
  const existing = await readItem(keychain, timeoutMs).catch((error: unknown) => {
    wipePresence(presence);
    throw error;
  });
  if (existing !== null) {
    wipe(existing);
    wipePresence(presence);
    throw nativeExists();
  }
  stepTo(options, 'master_code');
  const seed = await openSeedForNativeOp(keychain, owner, presence, timeoutMs);
  try {
    await storeOwnerNativeSeed(keychain, helper, seed, owner, options);
  } finally {
    wipe(seed);
  }
}

function wipePresence(presence: OwnerPresence): void {
  for (const value of [
    (presence as { secret?: unknown }).secret,
    (presence as { prfOutput?: unknown }).prfOutput,
  ]) {
    if (value instanceof Uint8Array) wipe(value);
  }
}

/** Adds the stored blob's credential to the revoked list (Fable review M1); a damaged blob adds none. */
async function revokeStored(
  keychain: KeychainBackend,
  blob: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array | undefined> {
  let header: NativeBlobHeader;
  try {
    header = readNativeBlobHeader(blob);
  } catch {
    return undefined;
  }
  const tag = nativeCredentialTag(header);
  const list = await guarded(() => keychain.get(OWNER_NATIVE_REVOKED_ACCOUNT), timeoutMs);
  if (!nativeTagRevoked(list, tag)) {
    const next = new Uint8Array((list?.length ?? 0) + 32);
    if (list !== null) next.set(list, 0);
    next.set(tag, list?.length ?? 0);
    await guarded(() => keychain.set(OWNER_NATIVE_REVOKED_ACCOUNT, next), timeoutMs);
  }
  // The record, for the Windows helper to delete its credential (best effort).
  return header.kind === NATIVE_PRESENCE_MACOS
    ? undefined
    : encodeNativeHelperRecord(header.kind, header);
}

/**
 * Fable review M1: turns native presence OFF, its own owner operation (the master code or the
 * passkey; never native itself). Opens the seed to prove presence, revokes the stored credential
 * (an old blob written back is never opened again) and deletes the `owner-native` item only while it
 * is still the one read. Windows also deletes the Hello credential (best effort). `owner_native_missing`
 * when none is stored. The presented bytes are wiped.
 */
export async function turnOffOwnerNative(
  keychain: KeychainBackend,
  helper: NativeHelper | undefined,
  expected: OwnerPublicKeys,
  presence: OwnerPresence,
  options: OwnerNativeOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const owner = ownerKeysCopy(expected);
  stepTo(options, 'master_code');
  const seed = await openSeedForNativeOp(keychain, owner, presence, timeoutMs);
  wipe(seed);
  stepTo(options, 'remove_old');
  const blob = await readItem(keychain, timeoutMs);
  if (blob === null) throw nativeMissing();
  try {
    const record = await revokeStored(keychain, blob, timeoutMs);
    const removed = await removeOwnerNativeItemIfOurs(keychain, blob, timeoutMs);
    if (removed === 'failed' || removed === 'other') throw keychainFailed();
    if (record !== undefined && helper !== undefined) {
      await helper.remove(record).catch(() => undefined);
    }
  } finally {
    wipe(blob);
  }
}

/**
 * Fable review M1: turns native presence on AGAIN after a biometry change (or a damaged item), its own
 * owner operation (the master code or the passkey; never native itself): the old credential is
 * revoked and its item removed, then a new one is registered exactly as registerOwnerNative does
 * (one gesture). Without a stored item it is a plain registration.
 */
export async function replaceOwnerNative(
  keychain: KeychainBackend,
  helper: NativeHelper,
  expected: OwnerPublicKeys,
  presence: OwnerPresence,
  options: OwnerNativeOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const owner = ownerKeysCopy(expected);
  stepTo(options, 'master_code');
  const seed = await openSeedForNativeOp(keychain, owner, presence, timeoutMs);
  try {
    stepTo(options, 'remove_old');
    const old = await readItem(keychain, timeoutMs);
    if (old !== null) {
      try {
        const record = await revokeStored(keychain, old, timeoutMs);
        const removed = await removeOwnerNativeItemIfOurs(keychain, old, timeoutMs);
        if (removed === 'failed' || removed === 'other') throw keychainFailed();
        if (record !== undefined) await helper.remove(record).catch(() => undefined);
      } finally {
        wipe(old);
      }
    }
    await storeOwnerNativeSeed(keychain, helper, seed, owner, options);
  } finally {
    wipe(seed);
  }
}

/**
 * Removes the `owner-native` item only while it is still exactly `blob` (as for `owner-passkey`).
 * Used to roll back a setup and by turnOffOwnerNative / replaceOwnerNative.
 */
export async function removeOwnerNativeItemIfOurs(
  keychain: KeychainBackend,
  blob: Uint8Array,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<OwnerItemRemoval> {
  let current: Uint8Array | null;
  try {
    current = await readItem(keychain, timeoutMs);
  } catch {
    return 'failed';
  }
  if (current === null) return 'absent';
  const ours = equalBytes(current, blob);
  wipe(current);
  if (!ours) return 'other';
  const removed = await guarded(() => keychain.delete(OWNER_NATIVE_ACCOUNT), timeoutMs).catch(
    () => false,
  );
  return removed ? 'removed' : 'failed';
}
