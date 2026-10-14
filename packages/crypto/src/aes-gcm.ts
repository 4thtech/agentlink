// AES-256-GCM for the ALKS and ALKO formats (04 §2.8): 32-byte key, 12-byte nonce, 16-byte tag, the
// whole header as additional data. It runs on WebCrypto, present in Node, browsers and workerd (04
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

const params = (nonce: Uint8Array, aad: Uint8Array): AesGcmParams => ({
  name: 'AES-GCM',
  iv: nonce,
  additionalData: aad,
  tagLength: 128,
});

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
