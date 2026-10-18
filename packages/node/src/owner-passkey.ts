// M1-8e: the localhost passkey (WebAuthn PRF) path of the OwnerKeyStore (04 §2.2, §2.3.1, §2.5;
// 08 §1; D-79, D-82; I-1, I-4).
//
// What it is (proposed, owner confirms at merge):
// - One passkey per OS user in M1b, registered for the RP ID `localhost` on the local approval page
//   (`http://localhost:<port>`, D-79), with `user.id` = the owner's x-only Nostr key (04 §2.3 step 2).
// - The owner seed is stored a second time, as an `ALKP` v1 blob (04 §2.3.1, D-82) under that
//   passkey's PRF output, in the keychain item service `agentlink`, account `owner-passkey`. The
//   `owner` item (`ALKO`, the owner code) is unchanged and stays the fallback. Several passkeys
//   (per-credential accounts) are a later extension.
// - Registering is its own owner operation: one entry of the owner code on the localhost page opens
//   the `ALKO` item, the seed is sealed under the PRF output, and the seed, the owner code and the
//   PRF output are wiped. It signs nothing (no SignedOwnerAction).
// - Unlocking: the page asks the authenticator with `allowCredentials = [credId]`, user verification
//   required, and sends the credential ID, the authenticator data, the user handle and the PRF
//   output. Before any unlock the server checks: the credential ID is the stored `credId`, the user
//   handle is the owner key, rpIdHash = SHA-256("localhost"), flags UP and UV set. The presence
//   proof is the successful `ALKP` decryption with the derived owner matching the card; the
//   assertion signature is not verified, because nothing relies on it beyond the PRF output.
//
// Threat note (04 §2.5, G-1 accepted for M1 by D-67): a WebAuthn RP ID has no port, so any page on
// any localhost port, including one a shell-capable agent starts, can ask for this passkey and, after
// the owner's gesture, get the same PRF output. The gesture is still the owner's; what the owner
// meant is not proven (presence, not intent). The PRF output for the fixed salt is a static key: a
// leaked PRF output opens the blob like a leaked owner code. The desktop app's native approval window
// and app-bound keystore (D-36, G-42) are the long-term mitigation.
// Registration does not prove a real authenticator (no attestation is checked): it is gated by the
// owner code, which already has the same power. Two concurrent registrations race between the read
// and the write; the read-back catches it and the owner code gates both. The other G-1 residuals (package
// modification, memory reads) apply unchanged.
//
// Everything secret is a Uint8Array wiped after use (04 §8.3, best effort). No error carries an
// input, a keychain message or key material (I-7).
import {
  CryptoInputError,
  KeyStoreError,
  equalBytes,
  encodeUtf8,
  readPasskeyBlobHeader,
  sha256,
  wipe,
  type OwnerPublicKeys,
  type PasskeyBlobHeader,
} from '@agentlink/crypto';
import { openOwnerSeed, openPasskeySeed, sealPasskeySeed } from '@agentlink/crypto/keystore';
import { NodeKeyStoreError } from './errors.js';
import { KEYCHAIN_CALL_TIMEOUT_MS, guarded } from './keychain-keystore.js';
import type { KeychainBackend } from './keychain.js';
import {
  OWNER_PASSKEY_ACCOUNT,
  ownerKeysCopy,
  ownerMissing,
  readOwnerItem,
  sameOwnerKeys,
} from './owner-keystore.js';

export { OWNER_PASSKEY_ACCOUNT };
/** 08 §1, D-79: the WebAuthn RP ID of the local approval page. */
export const PASSKEY_RP_ID = 'localhost';

const MAX_CREDENTIAL_ID = 1023;
/** rpIdHash (32) ‖ flags (1) ‖ signCount (4), then optional attested data and extensions. */
const MIN_AUTH_DATA = 37;
const MAX_AUTH_DATA = 1024;
/** WebAuthn user handles are at most 64 bytes; ours is the 32-byte owner key. */
const MAX_USER_HANDLE = 64;
const PRF_LENGTH = 32;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const MAX_OWNER_SECRET = 1024;
const ALKO_LENGTH = 90;

/** What the page sends after a WebAuthn ceremony (create or get). */
export interface PasskeyAssertion {
  /** The credential's raw ID, 1..1023 bytes. */
  readonly credentialId: Uint8Array;
  /** The authenticator data the authenticator returned. */
  readonly authenticatorData: Uint8Array;
  /** The user handle (= user.id, the owner's x-only Nostr key). */
  readonly userHandle: Uint8Array;
  /** The 32-byte PRF output for the owner's PRF salt; empty when the authenticator has no PRF. */
  readonly prfOutput: Uint8Array;
}

const presenceRequired = (): KeyStoreError =>
  new KeyStoreError('presence_required', 'owner keystore: a presence proof is required');
const presenceRejected = (): KeyStoreError =>
  new KeyStoreError('presence_rejected', 'owner keystore: presence was not accepted');

const passkeyExists = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_passkey_exists',
    'A passkey is already set up for approvals on this computer. Keep using it, or your owner code.',
  );

const passkeyUnsupported = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'passkey_unsupported',
    "This passkey can't protect approvals here. Keep using your owner code.",
  );

const passkeyDamaged = (): NodeKeyStoreError =>
  new NodeKeyStoreError(
    'owner_mismatch',
    'The saved passkey copy of your owner key is damaged. Use your owner code; `agentlink doctor` shows what is wrong.',
  );

function u16(value: number): Uint8Array {
  return new Uint8Array([value >> 8, value & 0xff]);
}

/** Fields, each prefixed by its 16-bit big-endian length, concatenated. */
function encodeFields(fields: readonly Uint8Array[]): Uint8Array {
  const total = fields.reduce((n, f) => n + 2 + f.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const field of fields) {
    if (field.length > 0xffff) throw presenceRequired();
    out.set(u16(field.length), at);
    out.set(field, at + 2);
    at += 2 + field.length;
  }
  return out;
}

/** Reads `count` such fields that fill `bytes` exactly; copies, never views. */
function decodeFields(bytes: Uint8Array, count: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  try {
    for (let i = 0; i < count; i += 1) {
      if (at + 2 > bytes.length) throw presenceRequired();
      const length = ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
      at += 2;
      if (at + length > bytes.length) throw presenceRequired();
      out.push(bytes.slice(at, at + length));
      at += length;
    }
    if (at !== bytes.length) throw presenceRequired();
    return out;
  } catch (error) {
    wipe(...out);
    throw error;
  }
}

/**
 * The binary body of a passkey presence: credential ID, authenticator data, user handle and PRF
 * output (empty when the authenticator has no PRF), each after its 16-bit big-endian length. The
 * page builds the same.
 */
export function encodePasskeyAssertion(assertion: PasskeyAssertion): Uint8Array {
  return encodeFields([
    assertion.credentialId,
    assertion.authenticatorData,
    assertion.userHandle,
    assertion.prfOutput,
  ]);
}

/**
 * Parses encodePasskeyAssertion's body into fresh copies (the caller wipes `bytes` and the PRF
 * output). Malformed or out-of-bounds fields are `presence_required`.
 */
export function parsePasskeyAssertion(bytes: Uint8Array): PasskeyAssertion {
  const [credentialId, authenticatorData, userHandle, prfOutput] = decodeFields(bytes, 4) as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  if (
    credentialId.length < 1 ||
    credentialId.length > MAX_CREDENTIAL_ID ||
    authenticatorData.length < MIN_AUTH_DATA ||
    authenticatorData.length > MAX_AUTH_DATA ||
    userHandle.length > MAX_USER_HANDLE ||
    (prfOutput.length !== 0 && prfOutput.length !== PRF_LENGTH)
  ) {
    wipe(prfOutput);
    throw presenceRequired();
  }
  return Object.freeze({ credentialId, authenticatorData, userHandle, prfOutput });
}

/** The registration body: the owner code (16-bit big-endian length first), then the assertion. */
export function encodePasskeyRegistration(
  ownerSecret: Uint8Array,
  assertion: PasskeyAssertion,
): Uint8Array {
  const body = encodePasskeyAssertion(assertion);
  try {
    const out = new Uint8Array(2 + ownerSecret.length + body.length);
    out.set(u16(ownerSecret.length), 0);
    out.set(ownerSecret, 2);
    out.set(body, 2 + ownerSecret.length);
    return out;
  } finally {
    wipe(body);
  }
}

/**
 * Splits a registration body into the owner code and the assertion (fresh copies; the caller wipes
 * `bytes`, the code and the PRF output). An empty owner code is `presence_required`.
 */
export function parsePasskeyRegistration(bytes: Uint8Array): {
  readonly ownerSecret: Uint8Array;
  readonly assertion: PasskeyAssertion;
} {
  if (bytes.length < 2) throw presenceRequired();
  const length = ((bytes[0] as number) << 8) | (bytes[1] as number);
  if (length === 0 || length > MAX_OWNER_SECRET || 2 + length > bytes.length) {
    throw presenceRequired();
  }
  const ownerSecret = bytes.slice(2, 2 + length);
  try {
    return { ownerSecret, assertion: parsePasskeyAssertion(bytes.subarray(2 + length)) };
  } catch (error) {
    wipe(ownerSecret);
    throw error;
  }
}

/** rpIdHash = SHA-256("localhost") and flags UP and UV set (proposed, owner confirms at merge). */
export function authenticatorDataOk(authenticatorData: Uint8Array): boolean {
  if (!(authenticatorData instanceof Uint8Array) || authenticatorData.length < MIN_AUTH_DATA) {
    return false;
  }
  const flags = authenticatorData[32] as number;
  return (
    equalBytes(authenticatorData.subarray(0, 32), sha256(encodeUtf8(PASSKEY_RP_ID))) &&
    (flags & FLAG_UP) !== 0 &&
    (flags & FLAG_UV) !== 0
  );
}

/** The checks on any assertion for this owner, before a PRF output is used. */
function assertionFitsOwner(assertion: PasskeyAssertion, owner: OwnerPublicKeys): boolean {
  return (
    authenticatorDataOk(assertion.authenticatorData) &&
    equalBytes(assertion.userHandle, owner.ownerNostr)
  );
}

/**
 * The public header of the `owner-passkey` item (credential ID and owner key), or null when there is
 * none; `owner_mismatch` when the item is not a well-formed `ALKP` v1 blob.
 */
export async function readOwnerPasskeyHeader(
  keychain: KeychainBackend,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<PasskeyBlobHeader | null> {
  const blob = await guarded(() => keychain.get(OWNER_PASSKEY_ACCOUNT), timeoutMs);
  if (blob === null) return null;
  try {
    return readPasskeyBlobHeader(blob);
  } catch {
    throw passkeyDamaged();
  } finally {
    wipe(blob);
  }
}

/** Reads the `owner-passkey` item, or null. The caller wipes the result. */
export function readOwnerPasskeyItem(
  keychain: KeychainBackend,
  timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS,
): Promise<Uint8Array | null> {
  return guarded(() => keychain.get(OWNER_PASSKEY_ACCOUNT), timeoutMs);
}

/**
 * Checks a decision's assertion against the stored passkey and the owner, before the PRF output is
 * used to unlock (04 §2.3.1): the credential ID is the header `credId`, the header owner and the
 * user handle are the owner the card names, rpIdHash is SHA-256("localhost"), and UP and UV are set.
 * `presence_rejected` otherwise. Nothing is wiped here.
 */
export function assertPasskeyAssertion(
  header: PasskeyBlobHeader,
  owner: OwnerPublicKeys,
  assertion: PasskeyAssertion,
): void {
  if (
    assertion.prfOutput.length !== PRF_LENGTH ||
    !equalBytes(assertion.credentialId, header.credentialId) ||
    !equalBytes(header.ownerNostr, owner.ownerNostr) ||
    !assertionFitsOwner(assertion, owner)
  ) {
    throw presenceRejected();
  }
}

export interface RegisterOwnerPasskeyOptions {
  readonly timeoutMs?: number;
}

/**
 * Registers the localhost passkey: one owner operation (proposed, owner confirms at merge). Checks
 * the assertion (PRF output present, else `passkey_unsupported`; rpIdHash, UP, UV and user handle,
 * else `presence_rejected`), refuses when a passkey is already set up (`owner_passkey_exists`), opens
 * the `owner` item with the owner code (`presence_rejected` for a wrong code or another owner), seals
 * the seed as `ALKP` v1 under the PRF output for this credential, stores it as `owner-passkey`, reads
 * it back and opens it once with the same PRF output. The owner code, the PRF output and the seed are
 * wiped whatever happens; the `owner` item is never written.
 */
export async function registerOwnerPasskey(
  keychain: KeychainBackend,
  expected: OwnerPublicKeys,
  ownerSecret: Uint8Array,
  assertion: PasskeyAssertion,
  options: RegisterOwnerPasskeyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYCHAIN_CALL_TIMEOUT_MS;
  const prf = assertion.prfOutput;
  let alko: Uint8Array | null = null;
  let seed: Uint8Array | undefined;
  let blob: Uint8Array | undefined;
  let back: Uint8Array | null = null;
  let check: Uint8Array | undefined;
  try {
    const owner = ownerKeysCopy(expected);
    if (!(ownerSecret instanceof Uint8Array) || ownerSecret.length === 0) throw presenceRequired();
    if (!(prf instanceof Uint8Array) || prf.length !== PRF_LENGTH) throw passkeyUnsupported();
    const credentialId = assertion.credentialId;
    if (
      !(credentialId instanceof Uint8Array) ||
      credentialId.length < 1 ||
      credentialId.length > MAX_CREDENTIAL_ID ||
      !assertionFitsOwner(assertion, owner)
    ) {
      throw presenceRejected();
    }
    const existing = await readOwnerPasskeyItem(keychain, timeoutMs);
    if (existing !== null) {
      wipe(existing);
      throw passkeyExists();
    }
    alko = await readOwnerItem(keychain, timeoutMs);
    if (alko === null) throw ownerMissing();
    if (alko.length !== ALKO_LENGTH) throw presenceRejected();
    try {
      seed = await openOwnerSeed(
        alko,
        { secret: ownerSecret, source: 'prompt' },
        { ownerEvm: owner.ownerEvm, ownerNostr: owner.ownerNostr },
        { fileKeystoreMachine: false },
      );
    } catch (error) {
      // A wrong code, a damaged item and a foreign owner are one answer (04 §2.8 tests).
      if (error instanceof CryptoInputError) throw presenceRejected();
      throw error;
    }
    if (!sameOwnerKeys(seed, owner)) throw presenceRejected();
    blob = await sealPasskeySeed(prf, seed, credentialId);
    const sealed = blob;
    await guarded(() => keychain.set(OWNER_PASSKEY_ACCOUNT, sealed), timeoutMs);
    back = await readOwnerPasskeyItem(keychain, timeoutMs);
    if (back === null || !equalBytes(back, blob)) {
      // Not this run's item (another run's, or none): never deleted.
      throw new NodeKeyStoreError(
        'keychain_failed',
        'The system keychain refused the request. Unlock it and try again; `agentlink doctor` shows what is wrong.',
      );
    }
    // The stored blob opens with this passkey's PRF output to this owner.
    check = await openPasskeySeed(back, prf, { expectedOwnerNostr: owner.ownerNostr });
  } finally {
    wipe(ownerSecret, prf, alko, seed, back, check);
  }
}
