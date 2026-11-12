// DESK-D12c (S2; D-145 phase 2; 04 §2.2 "Local, desktop app", §2.3.4, §2.5 "Desktop app owner
// presence"; D-68; I-1, I-4, I-7): native owner presence in core, over the desktop app's presence
// helper (owner-native-helper.ts; DESK-D12b).
//
// - The owner seed is stored once more as an `ALKH` v1 blob (04 §2.3.4) under the secret the helper
//   releases after the OS gesture, in the keychain item service `agentlink`, account `owner-native`.
//   The `owner` item (`ALKO`, the backup code) is unchanged and stays the fallback; `owner-passkey`
//   stays where it exists.
// - Registration is its own owner operation (registerOwnerNative): one entry of the backup code (or
//   one passkey gesture, checked by the caller) opens the seed, checked against the owner the card
//   names; the helper's `create` makes the credential and the per-install peer key or challenge; on
//   macOS `check` proves the key refuses without a gesture, then one `ecdh setup` releases the
//   secret; on Windows the one prompt of `create` already gave the signature. Core seals, stores,
//   reads back and opens the blob once with the same secret. The record stays in this process's
//   memory from `create` to the release and the seal (Fable review of DESK-D12b, M2): nothing is
//   written between them, so no other process can swap the peer key or challenge in that gap. No
//   `SignedOwnerAction` is made. A second registration is refused, never a replacement. At first-time
//   setup the held seed is stored the same way (storeOwnerNativeSeed), so a Windows Hello computer
//   needs the backup code only as the fallback.
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
import type { NativeHelper, NativeReason } from './owner-native-helper.js';
import {
  OWNER_NATIVE_ACCOUNT,
  OWNER_PASSKEY_ACCOUNT,
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
const keychainFailed = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'keychain_failed',
    `The system keychain refused the request. Unlock it and try again; \`${CLI_COMMAND} doctor\` shows what is wrong.`,
  );

export interface OwnerNativeOptions {
  readonly timeoutMs?: number;
}

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
  /** Why it is not registered for this owner although one exists: another owner's, or the other kind. */
  readonly reason?: 'other_owner';
}

/** Whether native presence can be offered here, and whether it is turned on for `ownerNostr`. */
export async function nativePresenceStatus(
  keychain: KeychainBackend,
  helper: NativeHelper | undefined,
  ownerNostr: Uint8Array | undefined,
  options: OwnerNativeOptions = {},
): Promise<NativePresenceStatus> {
  if (helper === undefined) return { available: false, registered: false };
  const available = await helper.available().catch(() => false);
  const header = await readOwnerNativeHeader(keychain, options.timeoutMs).catch(() => null);
  if (header === null) return { available, registered: false };
  const ours =
    header.kind === helper.kind &&
    ownerNostr !== undefined &&
    equalBytes(header.ownerNostr, ownerNostr);
  return ours
    ? { available, registered: true }
    : { available, registered: false, reason: 'other_owner' };
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
  options: OwnerNativeOptions = {},
): Promise<NativeOwnerPresence> {
  const blob = await readItem(keychain, options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS);
  if (blob === null) throw presenceRejected();
  let record: Uint8Array;
  try {
    const header = readNativeBlobHeader(blob);
    if (header.kind !== helper.kind || !equalBytes(header.ownerNostr, ownerNostr)) {
      throw presenceRejected();
    }
    record = encodeNativeHelperRecord(header.kind, header);
  } catch (error) {
    if (error instanceof CryptoInputError) throw presenceRejected();
    throw error;
  } finally {
    wipe(blob);
  }
  const secret = await helper.release(record, reason);
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
  const existing = await readItem(keychain, timeoutMs);
  if (existing !== null) {
    wipe(existing);
    throw nativeExists();
  }
  const kind: NativePresenceKind = helper.kind;
  const printed = await helper.create();
  let secret: Uint8Array | undefined;
  let back: Uint8Array | null = null;
  let check: Uint8Array | undefined;
  let created: Uint8Array | undefined;
  try {
    // The record is read into the header fields here and rebuilt from them; it must be canonical.
    let parsed: ReturnType<typeof readNativeCreateOutput>;
    try {
      parsed = readNativeCreateOutput(kind, printed);
    } catch {
      throw presenceRejected();
    }
    created = parsed.record;
    const record = encodeNativeHelperRecord(kind, parsed.credential);
    if (!equalBytes(record, parsed.record)) throw presenceRejected();
    if (kind === NATIVE_PRESENCE_MACOS) {
      // The key must refuse without a gesture before the one gesture of registration.
      await helper.check(record);
      secret = await helper.release(record, 'setup');
    } else {
      secret = parsed.firstSecret;
    }
    if (secret === undefined) throw presenceRejected();
    const blob = await sealNativeSeed({
      kind,
      nativeSecret: secret,
      seed,
      credentialId: parsed.credential.credentialId,
      credentialPublicKey: parsed.credential.credentialPublicKey,
      challenge: parsed.credential.challenge,
    });
    options.sealed?.(blob);
    await guarded(() => keychain.set(OWNER_NATIVE_ACCOUNT, blob), timeoutMs);
    back = await readItem(keychain, timeoutMs);
    if (back === null || !equalBytes(back, blob)) throw keychainFailed();
    check = await openNativeSeed(back, secret, {
      expectedOwnerNostr: expected.ownerNostr,
      expectedKind: kind,
    });
    if (!equalBytes(check, seed)) throw keychainFailed();
    created = undefined;
    return blob;
  } catch (error) {
    if (created !== undefined && kind !== NATIVE_PRESENCE_MACOS) {
      await helper.remove(created).catch(() => undefined);
    }
    throw error;
  } finally {
    wipe(secret, back ?? undefined, check, printed);
  }
}

/**
 * Registers native presence for this owner: its own owner operation (04 §2.3.4 "Registration").
 * `presence` is the backup code (`passphrase`, opening the `owner` item) or the passkey's PRF output
 * (`passkey-prf`, opening `owner-passkey`; the caller has checked the assertion against the owner).
 * A native presence never registers (`presence_required`). Refuses before the helper runs when an
 * `owner-native` item exists (`owner_native_exists`), the presence is wrong (`presence_rejected`) or
 * no owner is set up (`owner_missing`). The presented bytes and the seed are wiped.
 */
export async function registerOwnerNative(
  keychain: KeychainBackend,
  helper: NativeHelper,
  expected: OwnerPublicKeys,
  presence: OwnerPresence,
  options: OwnerNativeOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const p = presence as Partial<Record<'kind', unknown> & Record<'secret' | 'prfOutput', unknown>>;
  const presented =
    p.kind === 'passphrase' ? p.secret : p.kind === 'passkey-prf' ? p.prfOutput : undefined;
  let item: Uint8Array | null = null;
  let seed: Uint8Array | undefined;
  try {
    const owner = ownerKeysCopy(expected);
    if (!(presented instanceof Uint8Array) || presented.length === 0) throw presenceRequired();
    const existing = await readItem(keychain, timeoutMs);
    if (existing !== null) {
      wipe(existing);
      throw nativeExists();
    }
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
    if (!sameOwnerKeys(seed, owner)) throw presenceRejected();
    await storeOwnerNativeSeed(keychain, helper, seed, owner, options);
  } finally {
    const secret = (presence as { secret?: unknown }).secret;
    const prf = (presence as { prfOutput?: unknown }).prfOutput;
    for (const value of [secret, prf]) if (value instanceof Uint8Array) wipe(value);
    wipe(item ?? undefined, seed);
  }
}

/**
 * Removes the `owner-native` item only while it is still exactly `blob` (as for `owner-passkey`).
 * Used to roll back a setup; turning native presence off is an owner operation of its own (later).
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
