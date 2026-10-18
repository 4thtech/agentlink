// AES-256-GCM for the ALKS and ALKO formats (04 §2.8: 32-byte key, 12-byte nonce, 16-byte tag, the
// whole header as additional data) and the ALF1 chunks (04 §4, M1-1d), which import the file key
// once per file (`importAes256GcmKey`) instead of once per chunk. It runs on WebCrypto, present in Node, browsers and workerd (04
// §2.8: "AES-256-GCM via WebCrypto or @noble/ciphers"); nothing here implements AES or GCM (I-8). The
// key enters a non-extractable CryptoKey whose internal copy cannot be wiped (see wipe.ts).
// Internal: not exported from any entry point.
import { CryptoInputError } from './errors.js';

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

export const AES_GCM_KEY_LENGTH = 32;
export const AES_GCM_NONCE_LENGTH = 12;
export const AES_GCM_TAG_LENGTH = 16;

function subtle(): AesGcmSubtle {
  const api = (globalThis as { crypto?: { subtle?: AesGcmSubtle } }).crypto?.subtle;
  if (api === undefined) throw new Error('aes-gcm: this runtime has no WebCrypto (crypto.subtle)');
  return api;
}

function assertSizes(key: Uint8Array, nonce: Uint8Array): void {
  if (key.length !== AES_GCM_KEY_LENGTH || nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new CryptoInputError(
      'invalid_length',
      'aes-gcm: key must be 32 bytes and nonce 12 bytes',
    );
  }
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== AES_GCM_NONCE_LENGTH) {
    throw new CryptoInputError('invalid_length', 'aes-gcm: nonce must be 12 bytes');
  }
}

const params = (nonce: Uint8Array, aad: Uint8Array): AesGcmParams => ({
  name: 'AES-GCM',
  iv: nonce,
  additionalData: aad,
  tagLength: 128,
});

/** A non-extractable WebCrypto AES-256-GCM key (opaque here). */
export interface Aes256GcmKey {
  readonly cryptoKey: unknown;
}

/** Imports a 32-byte key for both directions; the caller can wipe its bytes afterwards. */
export async function importAes256GcmKey(key: Uint8Array): Promise<Aes256GcmKey> {
  if (key.length !== AES_GCM_KEY_LENGTH) {
    throw new CryptoInputError('invalid_length', 'aes-gcm: key must be 32 bytes');
  }
  const cryptoKey = await subtle().importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return Object.freeze({ cryptoKey });
}

/** ciphertext ‖ 16-byte tag under an imported key. Never reuse a nonce under the same key. */
export async function aes256GcmSealWithKey(
  key: Aes256GcmKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertNonce(nonce);
  return new Uint8Array(await subtle().encrypt(params(nonce, aad), key.cryptoKey, plaintext));
}

/** The plaintext under an imported key, or `undefined` when authentication fails. */
export async function aes256GcmOpenWithKey(
  key: Aes256GcmKey,
  nonce: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array | undefined> {
  assertNonce(nonce);
  if (sealed.length < AES_GCM_TAG_LENGTH) return undefined;
  try {
    return new Uint8Array(await subtle().decrypt(params(nonce, aad), key.cryptoKey, sealed));
  } catch {
    return undefined;
  }
}

/** ciphertext ‖ 16-byte tag. Never reuse a nonce under the same key. */
export async function aes256GcmSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertSizes(key, nonce);
  const api = subtle();
  const cryptoKey = await api.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  return new Uint8Array(await api.encrypt(params(nonce, aad), cryptoKey, plaintext));
}

/** The plaintext, or `undefined` when authentication fails (any key, nonce, AAD or ct change). */
export async function aes256GcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array | undefined> {
  assertSizes(key, nonce);
  if (sealed.length < AES_GCM_TAG_LENGTH) return undefined;
  const api = subtle();
  const cryptoKey = await api.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await api.decrypt(params(nonce, aad), cryptoKey, sealed));
  } catch {
    return undefined;
  }
}
