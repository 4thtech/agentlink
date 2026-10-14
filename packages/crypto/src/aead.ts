// 04 §3.1 payload AEAD (M1-1c): AES-256-GCM under the envelope's 32-byte CEK, a fresh 12-byte random
// IV, and as additional data the 32 bytes of sha256(JCS({v, id, thread, from, createdAt,
// recipients})), so the header (recipient order and createdAt included) is authenticated with the
// payload. `aead.ct` is ciphertext || 16-byte tag.
//
// AES-GCM runs on WebCrypto (hardware AES where the platform has it; the same engine @hpke/core
// uses), reached only here (deps-check SUBTLE_ZONES). The CEK enters a non-extractable CryptoKey,
// whose internal copy cannot be wiped (see wipe.ts).
import { assertBytes } from './bytes.js';
import { encodeBase64url, decodeBase64url } from './encoding.js';
import {
  AEAD_ALG,
  AEAD_IV_LENGTH,
  CEK_LENGTH,
  envelopeAad,
  parseEnvelopeHeader,
  parseSignedOrUnsignedEnvelope,
  type Envelope,
  type EnvelopeAead,
  type EnvelopeHeader,
  type UnsignedEnvelope,
} from './envelope.js';
import { CryptoInputError } from './errors.js';
import { randomBytes } from './random.js';

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

/** A fresh 32-byte CEK from the platform CSPRNG, one per envelope (04 §3.3). Wipe it when done. */
export function generateCek(): Uint8Array {
  return randomBytes(CEK_LENGTH);
}

/**
 * Encrypts under a given IV. encryptPayload calls it with a fresh random IV; the test seam calls it
 * with a fixed IV to reproduce vectors. Never reuse an IV under the same CEK.
 */
export async function encryptPayloadWithIv(
  header: EnvelopeHeader,
  cek: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<EnvelopeAead> {
  const aad = envelopeAad(parseEnvelopeHeader(header));
  assertLength(cek, CEK_LENGTH, 'encryptPayload: cek');
  assertLength(iv, AEAD_IV_LENGTH, 'encryptPayload: iv');
  assertBytes(plaintext, 'encryptPayload: plaintext');
  const api = subtle();
  const key = await api.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await api.encrypt(params(iv, aad), key, plaintext));
  return Object.freeze({ alg: AEAD_ALG, iv: encodeBase64url(iv), ct: encodeBase64url(ct) });
}

/**
 * 04 §3.1: encrypts the payload bytes for the envelope with this header (exactly its six fields,
 * parsed strictly) under `cek`, with a fresh random 12-byte IV, and returns the envelope's `aead`
 * member. Encrypt after every recipient's CEK wrap is in `recipients`: the AAD covers them. Inputs
 * are not modified.
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

/**
 * 04 §3.1: decrypts a signed or unsigned envelope's payload with `cek` (parsed strictly first).
 * Every authentication failure (another CEK, a changed header field, a tampered iv, ct or tag) is
 * the same `open_failed`. Does not check `sig`: verify the envelope before trusting its payload.
 * Wipe the plaintext when done if it is sensitive.
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
  const api = subtle();
  const key = await api.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await api.decrypt(params(iv, aad), key, ct));
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'OperationError') {
      throw new CryptoInputError('open_failed', 'aead: the payload could not be decrypted');
    }
    throw new Error('aead: this runtime could not run AES-256-GCM', { cause: error });
  }
}
