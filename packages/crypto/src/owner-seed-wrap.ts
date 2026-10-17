// 04 §2.3 (D-82): the owner seed blobs of the browser console and the recovery kit.
//   ALKP v1 (§2.3.1), passkey PRF wrap:
//     "ALKP" ‖ u8 version=1 ‖ u8 aead=1 ‖ ownerNostr 32 B ‖ u16be credIdLen (1..1023) ‖ credId ‖ nonce 12 B
//     ‖ AES-256-GCM(wrapKey, nonce, seed, AAD = header)
//     wrapKey = HKDF-SHA256(ikm = PRF output, salt = "", info = "owner-seed-wrap", L = 32)
//   ALKR v1 (§2.3.2), recovery code wrap: the ALKO layout (04 §2.8) with magic "ALKR", secretKind 1
//     only, and kek = HKDF-SHA256(Argon2id(password(code, 1), salt, m, t, p, 32), "",
//     "agentlink/v1/owner-recovery-wrap", 32).
// Everything a reader can check before the KDF or decryption is checked before it. Every blob-level
// failure is the same `open_failed` error, so a wrong passkey or code, a tampered blob and a wrong
// owner are indistinguishable, and no plaintext byte is ever returned on failure. Both blobs may be
// published (the relay backup, the recovery kit), so neither takes a chosen passphrase.
import { argon2id, kdfInBounds, KEYSTORE_KDF_DEFAULTS, type Argon2idParams } from './argon2.js';
import { AES_GCM_NONCE_LENGTH, aes256GcmOpen, aes256GcmSeal } from './aes-gcm.js';
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { sha256 } from './hash.js';
import { hkdfSha256 } from './hkdf.js';
import { KEY_LABELS, derivePublicKey } from './keys.js';
import { randomBytes } from './random.js';
import { generateSecretCode, normalizeSecret, type SecretSource } from './secret-code.js';
import { wipe } from './wipe.js';

const PRF_SALT_LABEL = 'agentlink-owner-v1';
const PRF_WRAP_INFO = 'owner-seed-wrap';
const RECOVERY_INFO = 'agentlink/v1/owner-recovery-wrap';
const MAGIC_ALKP = [0x41, 0x4c, 0x4b, 0x50];
const MAGIC_ALKR = [0x41, 0x4c, 0x4b, 0x52];
const VERSION = 1;
const AEAD_AES_256_GCM = 1;
const KDF_ARGON2ID = 1;
const SECRET_KIND_CODE = 1;
const SEED_LENGTH = 32;
const PRF_OUTPUT_LENGTH = 32;
const OWNER_NOSTR_LENGTH = 32;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const MAX_CREDENTIAL_ID = 1023;
/** magic ‖ version ‖ aead ‖ ownerNostr ‖ credIdLen: 40 bytes before credId. */
const ALKP_FIXED = 40;
/** ALKP blob = 40 + credIdLen + 12 (nonce) + 32 (seed) + 16 (tag) = 100 + credIdLen. */
const ALKP_OVERHEAD = ALKP_FIXED + AES_GCM_NONCE_LENGTH + SEED_LENGTH + TAG_LENGTH;
/** ALKR header: magic ‖ version ‖ secretKind ‖ kdf ‖ m ‖ t ‖ p ‖ salt ‖ aead ‖ nonce = 42 bytes. */
const ALKR_HEADER = 42;
const ALKR_LENGTH = ALKR_HEADER + SEED_LENGTH + TAG_LENGTH;
const R = Object.freeze({ kind: 5, kdf: 6, m: 7, t: 11, p: 12, salt: 13, aead: 29, nonce: 30 });
const GROUP = 4;

const openFailed = (): CryptoInputError =>
  new CryptoInputError(
    'open_failed',
    'owner seed: cannot open (wrong passkey or code, another owner, or a damaged or foreign blob)',
  );

/** The public fields of an ALKP blob: who owns it and which passkey opens it. */
export interface PasskeyBlobHeader {
  /** 32-byte x-only owner Nostr key (= the passkey's user.id, 04 §2.3 step 2). */
  readonly ownerNostr: Uint8Array;
  /** The WebAuthn credential ID to request (`allowCredentials`), 1..1023 bytes. */
  readonly credentialId: Uint8Array;
}

/** What the caller knows about the owner, if anything (04 §2.3.1, §2.3.2 "expected owner"). */
export interface ExpectedOwnerNostr {
  /** 32-byte x-only owner Nostr key: the passkey's user.id, the backup's author or the card's. */
  readonly expectedOwnerNostr?: Uint8Array;
}

export interface RecoveryCodeSecret {
  readonly secret: Uint8Array;
  readonly source: SecretSource;
}

function ownerNostrOf(seed: Uint8Array): Uint8Array {
  const key = derivePublicKey(seed, KEY_LABELS.nostr, 0);
  if (key.label !== KEY_LABELS.nostr) throw new Error('unreachable');
  return key.publicKey;
}

function assertSeed(seed: Uint8Array, what: string): void {
  assertBytes(seed, `${what}: seed`);
  if (seed.length !== SEED_LENGTH) {
    throw new CryptoInputError('invalid_length', `${what}: the owner seed must be 32 bytes`);
  }
}

function expectedOwnerOf(expected: ExpectedOwnerNostr | undefined, what: string) {
  if (expected === undefined) return undefined;
  if (typeof expected !== 'object' || expected === null) {
    throw new CryptoInputError('invalid_argument', `${what}: options must be an object`);
  }
  const owner = expected.expectedOwnerNostr;
  if (owner === undefined) return undefined;
  if (!(owner instanceof Uint8Array) || owner.length !== OWNER_NOSTR_LENGTH) {
    throw new CryptoInputError(
      'invalid_argument',
      `${what}: the expected owner key must be 32 bytes`,
    );
  }
  return owner;
}

/** 04 §2.3 step 3: the PRF input, sha256(utf8("agentlink-owner-v1")), as a fresh 32-byte copy. */
export function ownerPrfSalt(): Uint8Array {
  return sha256(encodeUtf8(PRF_SALT_LABEL));
}

/**
 * 04 §2.3 step 3: wrapKey = HKDF-SHA256(ikm = PRF output, salt = "", info = "owner-seed-wrap", 32).
 * The PRF output must be 32 bytes. The input is not modified; wipe the result when done.
 */
export function derivePrfWrapKey(prfOutput: Uint8Array): Uint8Array {
  assertBytes(prfOutput, 'derivePrfWrapKey: PRF output');
  if (prfOutput.length !== PRF_OUTPUT_LENGTH) {
    throw new CryptoInputError('invalid_length', 'derivePrfWrapKey: a PRF output is 32 bytes');
  }
  return hkdfSha256(prfOutput, new Uint8Array(0), encodeUtf8(PRF_WRAP_INFO), KEY_LENGTH);
}

/** The ALKP header checks that need no key; `undefined` when the blob is not a valid ALKP v1. */
function parseAlkp(blob: Uint8Array): { header: PasskeyBlobHeader; length: number } | undefined {
  if (blob.length < ALKP_OVERHEAD + 1) return undefined;
  if (!MAGIC_ALKP.every((byte, i) => blob[i] === byte)) return undefined;
  if (blob[4] !== VERSION || blob[5] !== AEAD_AES_256_GCM) return undefined;
  const credLength = ((blob[38] as number) << 8) | (blob[39] as number);
  if (credLength < 1 || credLength > MAX_CREDENTIAL_ID) return undefined;
  if (blob.length !== ALKP_OVERHEAD + credLength) return undefined;
  return {
    header: Object.freeze({
      ownerNostr: blob.slice(6, 6 + OWNER_NOSTR_LENGTH),
      credentialId: blob.slice(ALKP_FIXED, ALKP_FIXED + credLength),
    }),
    length: ALKP_FIXED + credLength + AES_GCM_NONCE_LENGTH,
  };
}

/**
 * 04 §2.3.1: the public header of an ALKP v1 blob (owner key and credential ID), read before any
 * passkey prompt so the caller can name the credential. Refuses anything that is not a well-formed
 * ALKP v1 blob (`open_failed`). Nothing here is secret.
 */
export function readPasskeyBlobHeader(blob: Uint8Array): PasskeyBlobHeader {
  assertBytes(blob, 'readPasskeyBlobHeader: blob');
  const parsed = parseAlkp(blob);
  if (parsed === undefined) throw openFailed();
  return parsed.header;
}

/** Seals with the given nonce. Only sealPasskeySeed (fresh nonce) and the test seam call it. */
export async function sealPasskeySeedWithNonceUnsafe(
  prfOutput: Uint8Array,
  nonce: Uint8Array,
  seed: Uint8Array,
  credentialId: Uint8Array,
): Promise<Uint8Array> {
  assertSeed(seed, 'sealPasskeySeed');
  assertBytes(nonce, 'sealPasskeySeed: nonce');
  assertBytes(credentialId, 'sealPasskeySeed: credential ID');
  if (nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new CryptoInputError('invalid_length', 'sealPasskeySeed: the nonce must be 12 bytes');
  }
  if (credentialId.length < 1 || credentialId.length > MAX_CREDENTIAL_ID) {
    throw new CryptoInputError(
      'invalid_length',
      'sealPasskeySeed: the credential ID must be 1 to 1023 bytes',
    );
  }
  const wrapKey = derivePrfWrapKey(prfOutput);
  try {
    const header = new Uint8Array(ALKP_FIXED + credentialId.length + AES_GCM_NONCE_LENGTH);
    header.set(MAGIC_ALKP, 0);
    header[4] = VERSION;
    header[5] = AEAD_AES_256_GCM;
    header.set(ownerNostrOf(seed), 6);
    header[38] = credentialId.length >> 8;
    header[39] = credentialId.length & 0xff;
    header.set(credentialId, ALKP_FIXED);
    header.set(nonce, ALKP_FIXED + credentialId.length);
    return concatBytes(header, await aes256GcmSeal(wrapKey, nonce, seed, header));
  } finally {
    wipe(wrapKey);
  }
}

/**
 * 04 §2.3.1 `ALKP` v1: the 32-byte owner seed under the PRF output of the passkey `credentialId`
 * (1..1023 bytes), with a fresh random nonce. The header names the owner key derived from the seed.
 * The blob is `100 + credentialId.length` bytes and may be stored in IndexedDB, published as the
 * relay backup or kept by the local agent (M1-8e). Wipe the PRF output when done.
 */
export function sealPasskeySeed(
  prfOutput: Uint8Array,
  seed: Uint8Array,
  credentialId: Uint8Array,
): Promise<Uint8Array> {
  return sealPasskeySeedWithNonceUnsafe(
    prfOutput,
    randomBytes(AES_GCM_NONCE_LENGTH),
    seed,
    credentialId,
  );
}

/**
 * 04 §2.3.1: opens an ALKP v1 blob with the passkey's PRF output. Refused before decryption
 * (`open_failed`): a malformed or foreign header, a size other than 100 + credIdLen, and a header
 * owner that differs from `expectedOwnerNostr` when given; a PRF output that is not 32 bytes is
 * refused too. After decryption the seed must derive the header owner key (04 §2.1, epoch 0),
 * otherwise it is wiped and refused. Wipe the returned seed when done.
 */
export async function openPasskeySeed(
  blob: Uint8Array,
  prfOutput: Uint8Array,
  options?: ExpectedOwnerNostr,
): Promise<Uint8Array> {
  assertBytes(blob, 'openPasskeySeed: blob');
  assertBytes(prfOutput, 'openPasskeySeed: PRF output');
  const expected = expectedOwnerOf(options, 'openPasskeySeed');
  const parsed = parseAlkp(blob);
  if (parsed === undefined || prfOutput.length !== PRF_OUTPUT_LENGTH) throw openFailed();
  const { header, length } = parsed;
  if (expected !== undefined && !equalBytes(header.ownerNostr, expected)) throw openFailed();
  const wrapKey = derivePrfWrapKey(prfOutput);
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

/**
 * A new recovery code (04 §2.3 step 5, §2.3.2): 15 CSPRNG bytes as 24 RFC 4648 base32 characters
 * with no bias, returned as ASCII bytes in six groups of four joined by `-` (29 bytes). Any spelling
 * of it (case, spaces, dashes) opens the blob (04 §2.8 password kind 1). Wipe it when done.
 */
export function generateRecoveryCode(): Uint8Array {
  const code = generateSecretCode();
  const groups = code.length / GROUP;
  const out = new Uint8Array(code.length + groups - 1);
  try {
    let o = 0;
    for (let g = 0; g < groups; g += 1) {
      if (g > 0) {
        out[o] = 0x2d; // '-'
        o += 1;
      }
      out.set(code.subarray(g * GROUP, (g + 1) * GROUP), o);
      o += GROUP;
    }
    return out;
  } finally {
    wipe(code);
  }
}

async function recoveryKek(
  code: Uint8Array,
  source: SecretSource,
  salt: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  const password = normalizeSecret(code, SECRET_KIND_CODE, source);
  let stretched: Uint8Array | undefined;
  try {
    stretched = await argon2id(password, salt, params);
    return hkdfSha256(stretched, new Uint8Array(0), encodeUtf8(RECOVERY_INFO), KEY_LENGTH);
  } finally {
    wipe(password, stretched);
  }
}

/** Seals with the given salt and nonce. Only sealRecoverySeed and the test seam call it. */
export async function sealRecoverySeedWithSaltAndNonceUnsafe(
  code: Uint8Array,
  salt: Uint8Array,
  nonce: Uint8Array,
  seed: Uint8Array,
  params: Argon2idParams,
): Promise<Uint8Array> {
  assertBytes(code, 'sealRecoverySeed: code');
  assertSeed(seed, 'sealRecoverySeed');
  assertBytes(salt, 'sealRecoverySeed: salt');
  assertBytes(nonce, 'sealRecoverySeed: nonce');
  if (salt.length !== SALT_LENGTH || nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new CryptoInputError(
      'invalid_length',
      'sealRecoverySeed: the salt must be 16 bytes and the nonce 12 bytes',
    );
  }
  if (typeof params !== 'object' || params === null || !kdfInBounds(params)) {
    throw new CryptoInputError(
      'invalid_argument',
      'sealRecoverySeed: KDF parameters must be within the 04 §2.8 floor and cap',
    );
  }
  const kek = await recoveryKek(code, 'prompt', salt, params);
  try {
    const header = new Uint8Array(ALKR_HEADER);
    header.set(MAGIC_ALKR, 0);
    header[4] = VERSION;
    header[R.kind] = SECRET_KIND_CODE;
    header[R.kdf] = KDF_ARGON2ID;
    new DataView(header.buffer).setUint32(R.m, params.memoryKiB, false);
    header[R.t] = params.iterations;
    header[R.p] = params.parallelism;
    header.set(salt, R.salt);
    header[R.aead] = AEAD_AES_256_GCM;
    header.set(nonce, R.nonce);
    return concatBytes(header, await aes256GcmSeal(kek, nonce, seed, header));
  } finally {
    wipe(kek);
  }
}

/**
 * 04 §2.3.2 `ALKR` v1: the 32-byte owner seed under a generated recovery code (see
 * generateRecoveryCode), with a fresh random salt and nonce, Argon2id at `params` (default
 * m = 64 MiB, t = 3, p = 1). A chosen passphrase is refused (`invalid_secret`): the blob may be
 * published, so only a 120-bit generated code may wrap it. The blob is exactly 90 bytes.
 */
export function sealRecoverySeed(
  code: Uint8Array,
  seed: Uint8Array,
  params: Argon2idParams = KEYSTORE_KDF_DEFAULTS,
): Promise<Uint8Array> {
  return sealRecoverySeedWithSaltAndNonceUnsafe(
    code,
    randomBytes(SALT_LENGTH),
    randomBytes(AES_GCM_NONCE_LENGTH),
    seed,
    params,
  );
}

/**
 * 04 §2.3.2: opens an ALKR v1 blob with the recovery code. Refused before the KDF (`open_failed`):
 * any size other than 90 bytes, a header that is not ALKR v1 with secretKind 1, and KDF parameters
 * outside the 04 §2.8 floor and cap; a code that is not 24 base32 characters is `invalid_secret`.
 * When `expectedOwnerNostr` is given, the seed must derive it (04 §2.1, epoch 0), otherwise it is
 * wiped and refused. Wipe the returned seed when done.
 */
export async function openRecoverySeed(
  blob: Uint8Array,
  secret: RecoveryCodeSecret,
  options?: ExpectedOwnerNostr,
): Promise<Uint8Array> {
  assertBytes(blob, 'openRecoverySeed: blob');
  if (typeof secret !== 'object' || secret === null) {
    throw new CryptoInputError('invalid_argument', 'openRecoverySeed: secret must be an object');
  }
  assertBytes(secret.secret, 'openRecoverySeed: code');
  const expected = expectedOwnerOf(options, 'openRecoverySeed');
  if (blob.length !== ALKR_LENGTH) throw openFailed();
  if (!MAGIC_ALKR.every((byte, i) => blob[i] === byte)) throw openFailed();
  if (
    blob[4] !== VERSION ||
    blob[R.kind] !== SECRET_KIND_CODE ||
    blob[R.kdf] !== KDF_ARGON2ID ||
    blob[R.aead] !== AEAD_AES_256_GCM
  ) {
    throw openFailed();
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const params = {
    memoryKiB: view.getUint32(R.m, false),
    iterations: blob[R.t] as number,
    parallelism: blob[R.p] as number,
  };
  if (!kdfInBounds(params)) throw openFailed();
  const kek = await recoveryKek(
    secret.secret,
    secret.source,
    blob.subarray(R.salt, R.salt + SALT_LENGTH),
    params,
  );
  let seed: Uint8Array | undefined;
  try {
    seed = await aes256GcmOpen(
      kek,
      blob.subarray(R.nonce, R.nonce + AES_GCM_NONCE_LENGTH),
      blob.subarray(ALKR_HEADER),
      blob.subarray(0, ALKR_HEADER),
    );
    if (seed === undefined || seed.length !== SEED_LENGTH) throw openFailed();
    if (expected !== undefined && !equalBytes(ownerNostrOf(seed), expected)) throw openFailed();
    const out = seed;
    seed = undefined;
    return out;
  } finally {
    wipe(kek, seed);
  }
}
