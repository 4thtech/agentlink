// 04 §3.1 and §3.3 payload AEAD (M1-1c; key commitment M1-1l, G-46, D-66).
//
// - The CEK is never a cipher key. Two keys are derived from it with HKDF-SHA256 (empty salt, 32
//   bytes each): encKey (info "agentlink/v1/payload-key" ‖ id) is the AES-256-GCM key, and kc (info
//   "agentlink/v1/payload-commit" ‖ id) is the key commitment carried in `aead.kc`.
// - AES-256-GCM under encKey, a fresh 12-byte random IV, and as additional data the 32 bytes of
//   sha256(JCS({v, id, thread, from, createdAt, recipients})), so the header (recipient order and
//   createdAt included) is authenticated with the payload. `aead.ct` is ciphertext || 16-byte tag.
// - decryptPayload compares kc in constant time before any AES-GCM work; a kc mismatch and a failed
//   tag are the same `open_failed`. checkKeyCommitment is the separate check that lets the core
//   tell them apart (04 §3.1.1 step 5).
// - encKey and the derived kc are wiped after use; the caller owns and wipes the CEK.
//
// AES-GCM runs on WebCrypto (hardware AES where the platform has it; the same engine @hpke/core
// uses), reached only here (deps-check SUBTLE_ZONES). encKey enters a non-extractable CryptoKey,
// whose internal copy cannot be wiped (see wipe.ts). HKDF is @noble/hashes (hkdf.ts); nothing here
// implements a primitive (I-8).
import { assertBytes, concatBytes, equalBytes } from './bytes.js';
import { decodeBase64url, encodeBase64url, encodeUtf8 } from './encoding.js';
import {
  AEAD_ALG,
  AEAD_IV_LENGTH,
  CEK_LENGTH,
  ENVELOPE_ID_LENGTH,
  KEY_COMMITMENT_LENGTH,
  envelopeAad,
  parseEnvelopeHeader,
  parseSignedOrUnsignedEnvelope,
  type Envelope,
  type EnvelopeAead,
  type EnvelopeHeader,
  type UnsignedEnvelope,
} from './envelope.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';
import { randomBytes } from './random.js';
import { wipe } from './wipe.js';

/** 04 §3.3: the HKDF label of the payload key `encKey` (info = label ‖ id). */
export const PAYLOAD_KEY_LABEL = 'agentlink/v1/payload-key';
/** 04 §3.3: the HKDF label of the key commitment `kc` (info = label ‖ id). */
export const PAYLOAD_COMMIT_LABEL = 'agentlink/v1/payload-commit';

/** 04 §3.3: every derivation from the CEK uses an empty salt and gives 32 bytes. */
const EMPTY_SALT = new Uint8Array(0);
const DERIVED_LENGTH = 32;

interface AesGcmParams {
  readonly name: 'AES-GCM';
  readonly iv: Uint8Array;
  readonly additionalData: Uint8Array;
  readonly tagLength: 128;
}

/** The part of WebCrypto's SubtleCrypto used here (the package has no DOM typings). */
interface AesGcmSubtle {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: 'AES-GCM',
    extractable: false,
    usages: readonly ('encrypt' | 'decrypt')[],
  ): Promise<unknown>;
  encrypt(params: AesGcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(params: AesGcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): AesGcmSubtle {
  const api = (globalThis as { crypto?: { subtle?: AesGcmSubtle } }).crypto?.subtle;
  if (api === undefined) throw new Error('aead: this runtime has no WebCrypto (crypto.subtle)');
  return api;
}

function assertLength(value: unknown, length: number, what: string): asserts value is Uint8Array {
  assertBytes(value, what);
  if (value.length !== length) {
    throw new CryptoInputError('invalid_length', `${what} must be ${length} bytes`);
  }
}

function params(iv: Uint8Array, additionalData: Uint8Array): AesGcmParams {
  return { name: 'AES-GCM', iv, additionalData, tagLength: 128 };
}

function deriveFromCek(cek: Uint8Array, envelopeId: Uint8Array, label: string): Uint8Array {
  assertLength(cek, CEK_LENGTH, `${label}: cek`);
  assertLength(envelopeId, ENVELOPE_ID_LENGTH, `${label}: envelopeId`);
  return hkdfSha256(cek, EMPTY_SALT, concatBytes(encodeUtf8(label), envelopeId), DERIVED_LENGTH);
}

/**
 * Test seam (04 §3.3): encKey = HKDF-SHA256(ikm = CEK, salt = empty, info =
 * utf8("agentlink/v1/payload-key") ‖ id, 32), `id` as its raw 16 bytes. The caller wipes it. Not
 * exported from any entry.
 */
export function derivePayloadKey(cek: Uint8Array, envelopeId: Uint8Array): Uint8Array {
  return deriveFromCek(cek, envelopeId, PAYLOAD_KEY_LABEL);
}

/**
 * Test seam (04 §3.3): kc = HKDF-SHA256(ikm = CEK, salt = empty, info =
 * utf8("agentlink/v1/payload-commit") ‖ id, 32), `id` as its raw 16 bytes. Not exported from any
 * entry: callers use checkKeyCommitment or decryptPayload.
 */
export function deriveKeyCommitment(cek: Uint8Array, envelopeId: Uint8Array): Uint8Array {
  return deriveFromCek(cek, envelopeId, PAYLOAD_COMMIT_LABEL);
}

/** The raw id of a parsed header (base64url of exactly 16 bytes, checked by the parser). */
function rawId(header: EnvelopeHeader): Uint8Array {
  return decodeBase64url(header.id, { length: ENVELOPE_ID_LENGTH });
}

/** A fresh 32-byte CEK from the platform CSPRNG, one per envelope (04 §3.3). Wipe it when done. */
export function generateCek(): Uint8Array {
  return randomBytes(CEK_LENGTH);
}

/**
 * Encrypts under a given IV. encryptPayload calls it with a fresh random IV; the test seam calls it
 * with a fixed IV to reproduce vectors. Never reuse an IV under the same CEK and id.
 */
export async function encryptPayloadWithIv(
  header: EnvelopeHeader,
  cek: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<EnvelopeAead> {
  const parsed = parseEnvelopeHeader(header);
  const aad = envelopeAad(parsed);
  assertLength(cek, CEK_LENGTH, 'encryptPayload: cek');
  assertLength(iv, AEAD_IV_LENGTH, 'encryptPayload: iv');
  assertBytes(plaintext, 'encryptPayload: plaintext');
  const id = rawId(parsed);
  const ivCopy = iv.slice();
  let encKey: Uint8Array | undefined;
  let kc: Uint8Array | undefined;
  try {
    encKey = derivePayloadKey(cek, id);
    kc = deriveKeyCommitment(cek, id);
    const api = subtle();
    const key = await api.importKey('raw', encKey, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await api.encrypt(params(ivCopy, aad), key, plaintext));
    return Object.freeze({
      alg: AEAD_ALG,
      iv: encodeBase64url(ivCopy),
      kc: encodeBase64url(kc),
      ct: encodeBase64url(ct),
    });
  } finally {
    wipe(encKey, kc);
  }
}

/**
 * 04 §3.1 and §3.3: encrypts the payload bytes for the envelope with this header (exactly its six
 * fields, parsed strictly) under the payload key derived from `cek`, with a fresh random 12-byte IV,
 * and returns the envelope's `aead` member {alg: "A256GCM-KC", iv, kc, ct}. Encrypt after every
 * recipient's CEK wrap is in `recipients`: the AAD covers them. Inputs are not modified.
 */
export async function encryptPayload(
  header: EnvelopeHeader,
  cek: Uint8Array,
  plaintext: Uint8Array,
): Promise<EnvelopeAead> {
  parseEnvelopeHeader(header);
  assertLength(cek, CEK_LENGTH, 'encryptPayload: cek');
  assertBytes(plaintext, 'encryptPayload: plaintext');
  return encryptPayloadWithIv(header, cek, randomBytes(AEAD_IV_LENGTH), plaintext);
}

/** Derives kc for the parsed envelope and compares it with `aead.kc` in constant time. */
function commitmentMatches(parsed: UnsignedEnvelope, cek: Uint8Array): boolean {
  const carried = decodeBase64url(parsed.aead.kc, { length: KEY_COMMITMENT_LENGTH });
  const derived = deriveKeyCommitment(cek, rawId(parsed));
  try {
    return equalBytes(derived, carried);
  } finally {
    wipe(derived);
  }
}

/**
 * 04 §3.3 (G-46, D-66): true when `aead.kc` is the key commitment of `cek` for this envelope's id
 * (compared in constant time), false otherwise. The envelope, signed or unsigned, is parsed
 * strictly first (`invalid_envelope`), and a CEK that is not 32 bytes is refused. It lets the core
 * tell a `kc` mismatch (the sender signed a commitment that its wrap for this agent does not carry)
 * from a failed AES-GCM tag, which decryptPayload reports as the same `open_failed` (04 §3.1.1
 * step 5). It decrypts nothing and does not check `sig`. The derived kc is wiped.
 */
export function checkKeyCommitment(
  envelope: UnsignedEnvelope | Envelope,
  cek: Uint8Array,
): boolean {
  const parsed = parseSignedOrUnsignedEnvelope(envelope);
  assertLength(cek, CEK_LENGTH, 'checkKeyCommitment: cek');
  return commitmentMatches(parsed, cek);
}

/**
 * 04 §3.1 and §3.3: decrypts a signed or unsigned envelope's payload with `cek` (parsed strictly
 * first). Step 1 derives kc from the CEK and compares it with `aead.kc` in constant time; on a
 * mismatch no AES-GCM runs. Step 2 derives encKey and opens AES-256-GCM. Step 3 wipes encKey and the
 * derived kc; the caller wipes the CEK. A kc mismatch and every authentication failure (another
 * CEK, a changed header field, a tampered iv, ct or tag) are the same `open_failed`; use
 * checkKeyCommitment to tell them apart. Does not check `sig`: verify envelopeHash and the signature
 * before trusting its payload (04 §3.1.1 steps 3 and 4; 07 §8). Wipe the plaintext when done if it
 * is sensitive.
 */
export async function decryptPayload(
  envelope: UnsignedEnvelope | Envelope,
  cek: Uint8Array,
): Promise<Uint8Array> {
  const parsed = parseSignedOrUnsignedEnvelope(envelope);
  assertLength(cek, CEK_LENGTH, 'decryptPayload: cek');
  const aad = envelopeAad(parsed);
  const iv = decodeBase64url(parsed.aead.iv, { length: AEAD_IV_LENGTH });
  const ct = decodeBase64url(parsed.aead.ct);
  if (!commitmentMatches(parsed, cek)) {
    throw new CryptoInputError('open_failed', 'aead: the payload could not be decrypted');
  }
  const encKey = derivePayloadKey(cek, rawId(parsed));
  try {
    const api = subtle();
    const key = await api.importKey('raw', encKey, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await api.decrypt(params(iv, aad), key, ct));
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'OperationError') {
      throw new CryptoInputError('open_failed', 'aead: the payload could not be decrypted');
    }
    throw new Error('aead: this runtime could not run AES-256-GCM', { cause: error });
  } finally {
    wipe(encKey);
  }
}
