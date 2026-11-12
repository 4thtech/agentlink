// 04 §2.3.4 (D-145 phase 2, DESK-D12a): the owner seed under a secret that a first-party presence
// helper of the desktop app releases after an OS gesture.
//   ALKH v1 = "ALKH" ‖ u8 version=1 ‖ u8 aead=1 ‖ u8 kind ‖ ownerNostr 32 B ‖ u16be credIdLen (1..1024)
//             ‖ credId ‖ u16be credPubLen ‖ credPub ‖ u8 challengeLen ‖ challenge ‖ nonce 12 B
//             ‖ AES-256-GCM(wrapKey, nonce, seed, AAD = header)
//   wrapKey = HKDF-SHA256(ikm = nativeSecret, salt = "", info, 32)
//   info    = "agentlink/v1/owner-native-wrap" ‖ u8 version ‖ u8 kind ‖ u16be credIdLen ‖ credId
//             ‖ SHA-256(credPub) ‖ SHA-256(challenge) ‖ ownerNostr
// kind 1 (macOS Secure Enclave): credPub and challenge are uncompressed P-256 points; the secret is
// the 32-byte X coordinate of ECDH(Secure Enclave key, challenge). kind 2 (Windows Hello): credPub is
// the credential's SubjectPublicKeyInfo, the challenge 32 bytes, the secret the RSASSA-PKCS1-v1_5 /
// SHA-256 signature over it (256, 384 or 512 bytes). The ECDH and the signature run only in the
// helpers; core never sees their private keys. The RSA signature is not verified here (the allowlist
// has no RSA, I-8): the AEAD tag refuses any other bytes.
// Everything a reader can check before decryption is checked before it, and every blob-level failure
// is the same `open_failed` error: a wrong or cancelled gesture, another credential, a tampered blob
// and a wrong owner are indistinguishable, and no plaintext byte is returned on failure.
// Strength (04 §2.3.4 "Honest strength"): while builds are unsigned this equals the PRF path.
import { p256 } from '@noble/curves/nist.js';
import { AES_GCM_NONCE_LENGTH, aes256GcmOpen, aes256GcmSeal } from './aes-gcm.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { sha256 } from './hash.js';
import { hkdfSha256 } from './hkdf.js';
import { KEY_LABELS, derivePublicKey } from './keys.js';
import { randomBytes } from './random.js';
import { wipe } from './wipe.js';

/** Kind 1: a macOS Secure Enclave P-256 key (`.biometryCurrentSet`), ECDH with the stored peer. */
export const NATIVE_PRESENCE_MACOS = 1;
/** Kind 2: a TPM-backed Windows Hello key credential, RSA PKCS#1 v1.5 / SHA-256 over the challenge. */
export const NATIVE_PRESENCE_WINDOWS = 2;
export type NativePresenceKind = typeof NATIVE_PRESENCE_MACOS | typeof NATIVE_PRESENCE_WINDOWS;

const MAGIC = [0x41, 0x4c, 0x4b, 0x48];
const VERSION = 1;
const AEAD_AES_256_GCM = 1;
const INFO_LABEL = 'agentlink/v1/owner-native-wrap';
const SEED_LENGTH = 32;
const OWNER_NOSTR_LENGTH = 32;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
const MAX_CREDENTIAL_ID = 1024;
const MAX_CREDENTIAL_PUBLIC_KEY = 2048;
const MAX_CREDENTIAL_NAME = 64;
const HELPER_RECORD_VERSION = 1;
const P256_POINT_LENGTH = 65;
const P256_SECRET_LENGTH = 32;
const WINDOWS_CHALLENGE_LENGTH = 32;
const RSA_SIGNATURE_LENGTHS: readonly number[] = [256, 384, 512];
/** magic ‖ version ‖ aead ‖ kind ‖ ownerNostr: 39 bytes before credIdLen. */
const OWNER_END = 39;
/** Blob = 104 + credIdLen + credPubLen + challengeLen (fixed fields, nonce, seed and tag). */
const FIXED_LENGTH = OWNER_END + 2 + 2 + 1 + AES_GCM_NONCE_LENGTH + SEED_LENGTH + TAG_LENGTH;
const P256_BASE = p256.Point.BASE.toBytes(false);

const openFailed = (): CryptoInputError =>
  new CryptoInputError(
    'open_failed',
    'owner seed: cannot open (no approval, another device credential, another owner, or a damaged or foreign blob)',
  );

/** The public fields of an ALKH blob: who owns it, which helper credential opens it, and how. */
export interface NativeBlobHeader {
  readonly kind: NativePresenceKind;
  /** 32-byte x-only owner Nostr key. */
  readonly ownerNostr: Uint8Array;
  /** The handle the helper is given: a Secure Enclave `dataRepresentation` or a credential name. */
  readonly credentialId: Uint8Array;
  /** Kind 1: the 65-byte uncompressed P-256 point; kind 2: the SubjectPublicKeyInfo (DER). */
  readonly credentialPublicKey: Uint8Array;
  /** Kind 1: the per-install peer point (65 bytes); kind 2: the 32-byte challenge. */
  readonly challenge: Uint8Array;
}

/** The credential fields a wrap key binds, plus the helper's secret. */
export interface NativeWrapKeyInput {
  readonly kind: NativePresenceKind;
  readonly nativeSecret: Uint8Array;
  readonly credentialId: Uint8Array;
  readonly credentialPublicKey: Uint8Array;
  readonly challenge: Uint8Array;
  readonly ownerNostr: Uint8Array;
}

/** What sealNativeSeed takes: the owner key in the header is derived from the seed. */
export interface NativeSealInput {
  readonly kind: NativePresenceKind;
  readonly nativeSecret: Uint8Array;
  readonly seed: Uint8Array;
  readonly credentialId: Uint8Array;
  readonly credentialPublicKey: Uint8Array;
  readonly challenge: Uint8Array;
}

/** What the caller knows, if anything: the card's owner, and this platform's kind. */
export interface ExpectedNativeBlob {
  readonly expectedOwnerNostr?: Uint8Array;
  readonly expectedKind?: NativePresenceKind;
}

const isKind = (kind: unknown): kind is NativePresenceKind =>
  kind === NATIVE_PRESENCE_MACOS || kind === NATIVE_PRESENCE_WINDOWS;

function isP256Point(point: Uint8Array): boolean {
  if (point.length !== P256_POINT_LENGTH || point[0] !== 0x04) return false;
  try {
    p256.Point.fromBytes(point).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** A Windows Hello credential name: 1..64 printable ASCII bytes (DESK-D12b record v1). */
const isCredentialName = (id: Uint8Array): boolean =>
  id.length >= 1 && id.length <= MAX_CREDENTIAL_NAME && id.every((b) => b >= 0x21 && b <= 0x7e);

/** One DER TLV at `at`: its tag, where its value starts and ends; undefined when not strict DER. */
function derTlv(
  der: Uint8Array,
  at: number,
): { readonly tag: number; readonly start: number; readonly end: number } | undefined {
  if (at + 2 > der.length) return undefined;
  const tag = der[at] as number;
  const first = der[at + 1] as number;
  let length: number;
  let start: number;
  if (first < 0x80) {
    length = first;
    start = at + 2;
  } else if (first === 0x81 || first === 0x82) {
    const n = first - 0x80;
    if (at + 2 + n > der.length) return undefined;
    length =
      n === 1 ? (der[at + 2] as number) : ((der[at + 2] as number) << 8) | (der[at + 3] as number);
    // Minimal length encoding only (DER).
    if (length < 0x80 || (n === 2 && length < 0x100)) return undefined;
    start = at + 2 + n;
  } else {
    return undefined;
  }
  const end = start + length;
  return end > der.length ? undefined : { tag, start, end };
}

/** A positive DER INTEGER's magnitude length (no leading zero byte), or undefined. */
function derPositiveIntegerLength(der: Uint8Array, start: number, end: number): number | undefined {
  if (end <= start) return undefined;
  const lead = der[start] as number;
  if (lead >= 0x80) return undefined; // negative
  if (lead === 0) {
    if (end - start === 1 || (der[start + 1] as number) < 0x80) return undefined; // not minimal
    return end - start - 1;
  }
  return end - start;
}

/** AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }. */
const RSA_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/**
 * Fable review of DESK-D12a (low 3): the byte length of the modulus of an RSA SubjectPublicKeyInfo
 * (strict DER: rsaEncryption with NULL parameters, a positive modulus, a positive exponent of at most
 * 8 bytes, nothing after), when it is 256, 384 or 512 bytes (RSA-2048 to 4096); otherwise undefined.
 * The key is not used for any RSA operation (I-8): this only ties the signature length to the key.
 */
function rsaModulusLength(spki: Uint8Array): number | undefined {
  const outer = derTlv(spki, 0);
  if (outer?.tag !== 0x30 || outer.end !== spki.length) return undefined;
  const algEnd = outer.start + RSA_ALGORITHM.length;
  if (algEnd > spki.length || !RSA_ALGORITHM.every((b, i) => spki[outer.start + i] === b)) {
    return undefined;
  }
  const bits = derTlv(spki, algEnd);
  if (bits?.tag !== 0x03 || bits.end !== outer.end || spki[bits.start] !== 0x00) return undefined;
  const key = derTlv(spki, bits.start + 1);
  if (key?.tag !== 0x30 || key.end !== bits.end) return undefined;
  const modulus = derTlv(spki, key.start);
  if (modulus?.tag !== 0x02) return undefined;
  const exponent = derTlv(spki, modulus.end);
  if (exponent?.tag !== 0x02 || exponent.end !== key.end) return undefined;
  const n = derPositiveIntegerLength(spki, modulus.start, modulus.end);
  const e = derPositiveIntegerLength(spki, exponent.start, exponent.end);
  if (n === undefined || e === undefined || e > 8) return undefined;
  return RSA_SIGNATURE_LENGTHS.includes(n) ? n : undefined;
}

/** The kind's length and point rules for the credential and the challenge (04 §2.3.4). */
function credentialFits(
  kind: NativePresenceKind,
  credentialId: Uint8Array,
  publicKey: Uint8Array,
  challenge: Uint8Array,
): boolean {
  if (credentialId.length < 1 || credentialId.length > MAX_CREDENTIAL_ID) return false;
  if (kind === NATIVE_PRESENCE_MACOS) {
    // Fable review of DESK-D12a (low 1): the peer's X coordinate may be neither G's nor the
    // credential key's, so -G and -credPub are refused as well as G and credPub.
    return (
      isP256Point(publicKey) &&
      isP256Point(challenge) &&
      !equalBytes(challenge.subarray(1, 33), P256_BASE.subarray(1, 33)) &&
      !equalBytes(challenge.subarray(1, 33), publicKey.subarray(1, 33))
    );
  }
  return (
    isCredentialName(credentialId) &&
    publicKey.length >= 1 &&
    publicKey.length <= MAX_CREDENTIAL_PUBLIC_KEY &&
    rsaModulusLength(publicKey) !== undefined &&
    challenge.length === WINDOWS_CHALLENGE_LENGTH
  );
}

/**
 * A secret of the kind's length that is not all zero bytes. Kind 2: exactly the modulus length of
 * the credential key (Fable review of DESK-D12a, low 3).
 */
function secretFits(
  kind: NativePresenceKind,
  secret: Uint8Array,
  credentialPublicKey: Uint8Array,
): boolean {
  const lengthOk =
    kind === NATIVE_PRESENCE_MACOS
      ? secret.length === P256_SECRET_LENGTH
      : RSA_SIGNATURE_LENGTHS.includes(secret.length) &&
        secret.length === rsaModulusLength(credentialPublicKey);
  return lengthOk && secret.some((byte) => byte !== 0);
}

function ownerNostrOf(seed: Uint8Array): Uint8Array {
  const key = derivePublicKey(seed, KEY_LABELS.nostr, 0);
  if (key.label !== KEY_LABELS.nostr) throw new Error('unreachable');
  return key.publicKey;
}

const u16 = (n: number): Uint8Array => new Uint8Array([n >> 8, n & 0xff]);

/** The HKDF info of 04 §2.3.4; inputs already checked. */
function infoOf(input: Omit<NativeWrapKeyInput, 'nativeSecret'>): Uint8Array {
  return concatBytes(
    encodeUtf8(INFO_LABEL),
    new Uint8Array([VERSION, input.kind]),
    u16(input.credentialId.length),
    input.credentialId,
    sha256(input.credentialPublicKey),
    sha256(input.challenge),
    input.ownerNostr,
  );
}

function checkWrapKeyInput(input: NativeWrapKeyInput, what: string): void {
  if (typeof input !== 'object' || input === null) {
    throw new CryptoInputError('invalid_argument', `${what}: input must be an object`);
  }
  if (!isKind(input.kind)) {
    throw new CryptoInputError('invalid_argument', `${what}: kind must be 1 or 2`);
  }
  assertBytes(input.nativeSecret, `${what}: native secret`);
  assertBytes(input.credentialId, `${what}: credential ID`);
  assertBytes(input.credentialPublicKey, `${what}: credential public key`);
  assertBytes(input.challenge, `${what}: challenge`);
  assertBytes(input.ownerNostr, `${what}: owner key`);
  if (input.ownerNostr.length !== OWNER_NOSTR_LENGTH) {
    throw new CryptoInputError('invalid_length', `${what}: the owner key must be 32 bytes`);
  }
  if (!credentialFits(input.kind, input.credentialId, input.credentialPublicKey, input.challenge)) {
    throw new CryptoInputError(
      'invalid_argument',
      `${what}: the credential ID, public key or challenge does not fit the kind`,
    );
  }
  if (!secretFits(input.kind, input.nativeSecret, input.credentialPublicKey)) {
    throw new CryptoInputError(
      'invalid_length',
      `${what}: the native secret does not fit the kind`,
    );
  }
}

/**
 * 04 §2.3.4: wrapKey = HKDF-SHA256(ikm = nativeSecret, salt = "", info, 32), the info binding the
 * version, the kind, the credential ID, SHA-256 of the credential public key, SHA-256 of the
 * challenge and the owner key. Inputs are checked as for a seal and not modified; wipe the result.
 */
export function deriveNativeWrapKey(input: NativeWrapKeyInput): Uint8Array {
  checkWrapKeyInput(input, 'deriveNativeWrapKey');
  return hkdfSha256(input.nativeSecret, new Uint8Array(0), infoOf(input), KEY_LENGTH);
}

/** The ALKH header checks that need no secret; `undefined` when the blob is not a valid ALKH v1. */
function parseAlkh(blob: Uint8Array): { header: NativeBlobHeader; length: number } | undefined {
  if (blob.length < FIXED_LENGTH + 1) return undefined;
  if (!MAGIC.every((byte, i) => blob[i] === byte)) return undefined;
  if (blob[4] !== VERSION || blob[5] !== AEAD_AES_256_GCM) return undefined;
  const kind = blob[6];
  if (!isKind(kind)) return undefined;
  let offset = OWNER_END;
  const credLength = ((blob[offset] as number) << 8) | (blob[offset + 1] as number);
  if (credLength < 1 || credLength > MAX_CREDENTIAL_ID) return undefined;
  offset += 2 + credLength;
  if (blob.length < offset + 2) return undefined;
  const pubStart = offset + 2;
  const pubLength = ((blob[offset] as number) << 8) | (blob[offset + 1] as number);
  offset = pubStart + pubLength;
  if (blob.length < offset + 1) return undefined;
  const challengeLength = blob[offset] as number;
  const challengeStart = offset + 1;
  offset = challengeStart + challengeLength;
  if (blob.length !== FIXED_LENGTH + credLength + pubLength + challengeLength) return undefined;
  const credentialId = blob.slice(OWNER_END + 2, OWNER_END + 2 + credLength);
  const credentialPublicKey = blob.slice(pubStart, pubStart + pubLength);
  const challenge = blob.slice(challengeStart, offset);
  if (!credentialFits(kind, credentialId, credentialPublicKey, challenge)) return undefined;
  return {
    header: Object.freeze({
      kind,
      ownerNostr: blob.slice(7, OWNER_END),
      credentialId,
      credentialPublicKey,
      challenge,
    }),
    length: offset + AES_GCM_NONCE_LENGTH,
  };
}

/**
 * 04 §2.3.4: the public header of an ALKH v1 blob, read before the helper runs so the caller can
 * pass it the credential and challenge. Refuses anything that is not a well-formed ALKH v1 blob
 * (`open_failed`). Nothing here is secret; the fields are fresh copies.
 */
export function readNativeBlobHeader(blob: Uint8Array): NativeBlobHeader {
  assertBytes(blob, 'readNativeBlobHeader: blob');
  const parsed = parseAlkh(blob);
  if (parsed === undefined) throw openFailed();
  return parsed.header;
}

/** Seals with the given nonce. Only sealNativeSeed (fresh nonce) and the test seam call it. */
export async function sealNativeSeedWithNonceUnsafe(
  input: NativeSealInput,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  if (typeof input !== 'object' || input === null) {
    throw new CryptoInputError('invalid_argument', 'sealNativeSeed: input must be an object');
  }
  assertBytes(input.seed, 'sealNativeSeed: seed');
  assertBytes(nonce, 'sealNativeSeed: nonce');
  if (input.seed.length !== SEED_LENGTH) {
    throw new CryptoInputError('invalid_length', 'sealNativeSeed: the owner seed must be 32 bytes');
  }
  if (nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new CryptoInputError('invalid_length', 'sealNativeSeed: the nonce must be 12 bytes');
  }
  const keyInput: NativeWrapKeyInput = {
    kind: input.kind,
    nativeSecret: input.nativeSecret,
    credentialId: input.credentialId,
    credentialPublicKey: input.credentialPublicKey,
    challenge: input.challenge,
    ownerNostr: ownerNostrOf(input.seed),
  };
  const wrapKey = deriveNativeWrapKey(keyInput);
  try {
    const header = concatBytes(
      new Uint8Array([...MAGIC, VERSION, AEAD_AES_256_GCM, keyInput.kind]),
      keyInput.ownerNostr,
      u16(keyInput.credentialId.length),
      keyInput.credentialId,
      u16(keyInput.credentialPublicKey.length),
      keyInput.credentialPublicKey,
      new Uint8Array([keyInput.challenge.length]),
      keyInput.challenge,
      nonce,
    );
    return concatBytes(header, await aes256GcmSeal(wrapKey, nonce, input.seed, header));
  } finally {
    wipe(wrapKey);
  }
}

/**
 * 04 §2.3.4 `ALKH` v1: the 32-byte owner seed under the secret a presence helper released for the
 * credential and per-install challenge given, with a fresh random nonce. The header names the owner
 * key derived from the seed. Kind 1 refuses an off-curve point and a challenge equal to G or to the
 * credential key. The inputs are not modified; wipe the native secret and seed when done.
 */
export function sealNativeSeed(input: NativeSealInput): Promise<Uint8Array> {
  return sealNativeSeedWithNonceUnsafe(input, randomBytes(AES_GCM_NONCE_LENGTH));
}

function expectedOf(options: ExpectedNativeBlob | undefined) {
  if (options === undefined) return {};
  if (typeof options !== 'object' || options === null) {
    throw new CryptoInputError('invalid_argument', 'openNativeSeed: options must be an object');
  }
  const { expectedOwnerNostr: owner, expectedKind: kind } = options;
  if (owner !== undefined && (!(owner instanceof Uint8Array) || owner.length !== 32)) {
    throw new CryptoInputError(
      'invalid_argument',
      'openNativeSeed: the expected owner key must be 32 bytes',
    );
  }
  if (kind !== undefined && !isKind(kind)) {
    throw new CryptoInputError('invalid_argument', 'openNativeSeed: the expected kind is 1 or 2');
  }
  return { owner, kind };
}

/**
 * 04 §2.3.4: opens an ALKH v1 blob with the secret the helper released. Refused before decryption
 * (`open_failed`): a malformed or foreign header, a size that does not match, a point off P-256 or a
 * challenge equal to G or the credential key, a secret whose length does not fit the kind or that is
 * all zero, and a header owner or kind other than the expected ones when given. After decryption the
 * seed must derive the header owner key (04 §2.1, epoch 0), otherwise it is wiped and refused. The
 * secret is not modified; wipe it and the returned seed when done.
 */
export async function openNativeSeed(
  blob: Uint8Array,
  nativeSecret: Uint8Array,
  options?: ExpectedNativeBlob,
): Promise<Uint8Array> {
  assertBytes(blob, 'openNativeSeed: blob');
  assertBytes(nativeSecret, 'openNativeSeed: native secret');
  const expected = expectedOf(options);
  const parsed = parseAlkh(blob);
  if (parsed === undefined) throw openFailed();
  const { header, length } = parsed;
  if (!secretFits(header.kind, nativeSecret, header.credentialPublicKey)) throw openFailed();
  if (expected.owner !== undefined && !equalBytes(header.ownerNostr, expected.owner)) {
    throw openFailed();
  }
  if (expected.kind !== undefined && header.kind !== expected.kind) throw openFailed();
  const wrapKey = hkdfSha256(nativeSecret, new Uint8Array(0), infoOf(header), KEY_LENGTH);
  let seed: Uint8Array | undefined;
  try {
    seed = await aes256GcmOpen(
      wrapKey,
      blob.subarray(length - AES_GCM_NONCE_LENGTH, length),
      blob.subarray(length),
      blob.subarray(0, length),
    );
    if (seed === undefined || seed.length !== SEED_LENGTH) throw openFailed();
    if (!equalBytes(ownerNostrOf(seed), header.ownerNostr)) throw openFailed();
    const out = seed;
    seed = undefined;
    return out;
  } finally {
    wipe(wrapKey, seed);
  }
}

/** The credential fields of a helper record: what `create` made, and what the helper reads back. */
export interface NativeHelperCredential {
  readonly credentialId: Uint8Array;
  readonly credentialPublicKey: Uint8Array;
  readonly challenge: Uint8Array;
}

const badRecord = (): CryptoInputError =>
  new CryptoInputError('invalid_argument', 'native helper record: not a valid record v1');

/**
 * 04 §2.3.4 "Helper record": the DESK-D12b helper record v1 rebuilt from header fields, to give to
 * the helper on stdin. Kind 1: 01 ‖ u16be L ‖ SE key handle ‖ SE public key (65) ‖ peer key (65).
 * Kind 2: 01 ‖ u8 N ‖ credential name ‖ u16be S ‖ SubjectPublicKeyInfo ‖ challenge (32). The fields
 * must fit the kind. Nothing here is secret.
 */
export function encodeNativeHelperRecord(
  kind: NativePresenceKind,
  credential: NativeHelperCredential,
): Uint8Array {
  if (!isKind(kind) || typeof credential !== 'object' || credential === null) throw badRecord();
  const { credentialId, credentialPublicKey, challenge } = credential;
  assertBytes(credentialId, 'encodeNativeHelperRecord: credential ID');
  assertBytes(credentialPublicKey, 'encodeNativeHelperRecord: credential public key');
  assertBytes(challenge, 'encodeNativeHelperRecord: challenge');
  if (!credentialFits(kind, credentialId, credentialPublicKey, challenge)) throw badRecord();
  if (kind === NATIVE_PRESENCE_MACOS) {
    return concatBytes(
      new Uint8Array([HELPER_RECORD_VERSION]),
      u16(credentialId.length),
      credentialId,
      credentialPublicKey,
      challenge,
    );
  }
  return concatBytes(
    new Uint8Array([HELPER_RECORD_VERSION, credentialId.length]),
    credentialId,
    u16(credentialPublicKey.length),
    credentialPublicKey,
    challenge,
  );
}

/**
 * 04 §2.3.4 "Helper record": reads what the helper's `create` printed into the header fields that
 * sealNativeSeed takes. Refuses a record version other than 1, any size mismatch, and fields that do
 * not fit the kind (an off-curve point, G or the SE key as the peer, a name that is not 1..64
 * printable ASCII bytes). The fields are fresh copies.
 */
export function readNativeHelperRecord(
  kind: NativePresenceKind,
  record: Uint8Array,
): NativeHelperCredential {
  assertBytes(record, 'readNativeHelperRecord: record');
  if (!isKind(kind) || record.length < 4 || record[0] !== HELPER_RECORD_VERSION) throw badRecord();
  let fields: [Uint8Array, Uint8Array, Uint8Array];
  if (kind === NATIVE_PRESENCE_MACOS) {
    const n = ((record[1] as number) << 8) | (record[2] as number);
    if (record.length !== 3 + n + 2 * P256_POINT_LENGTH) throw badRecord();
    const pub = 3 + n;
    fields = [
      record.slice(3, pub),
      record.slice(pub, pub + P256_POINT_LENGTH),
      record.slice(pub + P256_POINT_LENGTH),
    ];
  } else {
    const n = record[1] as number;
    if (record.length < 4 + n) throw badRecord();
    const k = ((record[2 + n] as number) << 8) | (record[3 + n] as number);
    if (record.length !== 4 + n + k + WINDOWS_CHALLENGE_LENGTH) throw badRecord();
    fields = [record.slice(2, 2 + n), record.slice(4 + n, 4 + n + k), record.slice(4 + n + k)];
  }
  if (!credentialFits(kind, ...fields)) throw badRecord();
  const [credentialId, credentialPublicKey, challenge] = fields;
  return Object.freeze({ credentialId, credentialPublicKey, challenge });
}

/** What a helper's `create` printed, read by core (Fable review of DESK-D12a, low 2). */
export interface NativeCreateOutput {
  /** The record v1 exactly as printed (canonical: it equals the record rebuilt from its fields). */
  readonly record: Uint8Array;
  readonly credential: NativeHelperCredential;
  /**
   * Kind 2 only: the signature over the challenge that Windows `create` folds in (one prompt at
   * registration), which is the first native secret. Kind 1 `create` needs no gesture and has none.
   */
  readonly firstSecret?: Uint8Array;
}

/**
 * 04 §2.3.4 "Helper record": reads the bytes a helper's `create` printed. Kind 1: exactly a record
 * v1. Kind 2: record v1 ‖ u16be L ‖ L-byte signature, L the modulus length of the record's
 * SubjectPublicKeyInfo (256, 384 or 512) and the signature not all zero. Anything else, including
 * trailing bytes, is refused. The fields are fresh copies; `firstSecret` is secret and the caller
 * wipes it.
 */
export function readNativeCreateOutput(
  kind: NativePresenceKind,
  output: Uint8Array,
): NativeCreateOutput {
  assertBytes(output, 'readNativeCreateOutput: output');
  if (kind === NATIVE_PRESENCE_MACOS) {
    const credential = readNativeHelperRecord(kind, output);
    return Object.freeze({ record: output.slice(), credential });
  }
  if (
    kind !== NATIVE_PRESENCE_WINDOWS ||
    output.length < 4 ||
    output[0] !== HELPER_RECORD_VERSION
  ) {
    throw badRecord();
  }
  const n = output[1] as number;
  if (output.length < 4 + n) throw badRecord();
  const k = ((output[2 + n] as number) << 8) | (output[3 + n] as number);
  const recordEnd = 4 + n + k + WINDOWS_CHALLENGE_LENGTH;
  if (output.length < recordEnd + 2) throw badRecord();
  const record = output.slice(0, recordEnd);
  const credential = readNativeHelperRecord(kind, record);
  const l = ((output[recordEnd] as number) << 8) | (output[recordEnd + 1] as number);
  if (output.length !== recordEnd + 2 + l) throw badRecord();
  const firstSecret = output.slice(recordEnd + 2);
  if (!secretFits(kind, firstSecret, credential.credentialPublicKey)) {
    wipe(firstSecret);
    throw badRecord();
  }
  return Object.freeze({ record, credential, firstSecret });
}
