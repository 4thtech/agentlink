// M1-8b: the cipher of the local store's `enc` columns (07 §3, §3.1). AES-256-GCM under the store key
// with additional data bound to the table, the column and the row key, so a value copied into another
// row or column does not open; and the store's index key, HKDF-SHA256 of the store key, for keyed
// digests of low-entropy data (idempotency.request_digest, 07 §3.1, §3.3).
//
// Both keys enter non-extractable WebCrypto CryptoKeys once, when the cipher is created, so the cipher
// holds no raw key bytes for its lifetime; the caller wipes the store key it passed in, and the
// derived index key bytes are wiped here. AES-GCM, HMAC and HKDF are WebCrypto and @noble/hashes;
// nothing here implements a primitive (I-8). Only KeyStore backends reach this, through the
// restricted @agentlink/crypto/keystore entry, because it takes the store key.
//
// Sealed form: `v1.` + base64url(nonce (12 bytes) ‖ ciphertext ‖ tag (16 bytes)). The nonce is
// random per seal: under one store key, stay well below 2^32 seals (NIST SP 800-38D §8.3).
import { decodeBase64url, encodeBase64url, encodeHex, encodeUtf8, decodeUtf8 } from './encoding.js';
import { assertBytes, concatBytes } from './bytes.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';
import { canonicalizeToBytes } from './jcs.js';
import { randomBytes } from './random.js';
import { wipe } from './wipe.js';

/** The store key is 32 random bytes, kept in the keychain or the file KeyStore (07 §3, §9). */
export const STORE_KEY_LENGTH = 32;
/** The additional-data label of a sealed column value (07 §3.1). */
export const STORE_COLUMN_AAD_LABEL = 'agentlink/v1/store-column';
/** The HKDF info of the index key (07 §3.1, keyed digests). */
export const STORE_INDEX_KEY_INFO = 'agentlink/v1/store-index';

const SEALED_PREFIX = 'v1.';
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

/** Where a sealed value lives (core's SealContext): its table, its column and its row key. */
export interface StoreColumnContext {
  readonly table: string;
  readonly column: string;
  readonly rowKey: string;
}

/** Seals and opens `enc` column values and computes keyed digests under one store key. */
export interface StoreColumnCipher {
  /** The sealed form of `plaintext` for `context`. */
  seal(context: StoreColumnContext, plaintext: string): Promise<string>;
  /**
   * The plaintext of `sealed`, or `open_failed` for any value that does not open: another key,
   * another table, column or row, tampered or truncated bytes, an unknown version. Never empty text
   * in its place.
   */
  open(context: StoreColumnContext, sealed: string): Promise<string>;
  /** HMAC-SHA256 of `data` under the index key, as 64 lowercase hex (07 §3.1, §3.3). */
  indexDigest(data: Uint8Array): Promise<string>;
  /** Drops the keys; every later call fails. */
  close(): void;
}

interface AesGcmParams {
  readonly name: 'AES-GCM';
  readonly iv: Uint8Array;
  readonly additionalData: Uint8Array;
  readonly tagLength: 128;
}

/** The part of WebCrypto's SubtleCrypto used here (the package has no DOM typings). */
interface StoreSubtle {
  importKey(
    format: 'raw',
    keyData: Uint8Array,
    algorithm: 'AES-GCM' | { readonly name: 'HMAC'; readonly hash: 'SHA-256' },
    extractable: false,
    usages: readonly ('encrypt' | 'decrypt' | 'sign')[],
  ): Promise<unknown>;
  encrypt(params: AesGcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(params: AesGcmParams, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

function subtle(): StoreSubtle {
  const api = (globalThis as { crypto?: { subtle?: StoreSubtle } }).crypto?.subtle;
  if (api === undefined)
    throw new Error('store cipher: this runtime has no WebCrypto (crypto.subtle)');
  return api;
}

const openFailed = (): CryptoInputError =>
  new CryptoInputError('open_failed', 'store cipher: the value does not open');

function assertContext(context: StoreColumnContext): void {
  if (
    typeof context !== 'object' ||
    context === null ||
    typeof context.table !== 'string' ||
    typeof context.column !== 'string' ||
    typeof context.rowKey !== 'string' ||
    context.table.length === 0 ||
    context.column.length === 0 ||
    context.rowKey.length === 0
  ) {
    throw new CryptoInputError(
      'invalid_argument',
      'store cipher: the context needs a table, a column and a row key',
    );
  }
}

/** The additional data: JCS of [label, table, column, rowKey], so no two contexts collide. */
function aadOf(context: StoreColumnContext): Uint8Array {
  return canonicalizeToBytes([
    STORE_COLUMN_AAD_LABEL,
    context.table,
    context.column,
    context.rowKey,
  ]);
}

/**
 * Creates the cipher of one store from its 32-byte store key. The key is imported, not kept: the
 * caller still owns `storeKey` and wipes it when this resolves.
 */
export async function createStoreColumnCipher(storeKey: Uint8Array): Promise<StoreColumnCipher> {
  assertBytes(storeKey, 'createStoreColumnCipher: storeKey');
  if (storeKey.length !== STORE_KEY_LENGTH) {
    throw new CryptoInputError(
      'invalid_length',
      'createStoreColumnCipher: the store key must be 32 bytes',
    );
  }
  const api = subtle();
  const indexKeyBytes = hkdfSha256(
    storeKey,
    new Uint8Array(0),
    encodeUtf8(STORE_INDEX_KEY_INFO),
    32,
  );
  let aesKey: unknown;
  let hmacKey: unknown;
  try {
    aesKey = await api.importKey('raw', storeKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    hmacKey = await api.importKey('raw', indexKeyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
  } finally {
    wipe(indexKeyBytes);
  }
  let closed = false;
  const keys = (): { readonly aes: unknown; readonly hmac: unknown } => {
    if (closed)
      throw new CryptoInputError('invalid_argument', 'store cipher: the cipher is closed');
    return { aes: aesKey, hmac: hmacKey };
  };

  return Object.freeze({
    async seal(context: StoreColumnContext, plaintext: string): Promise<string> {
      assertContext(context);
      if (typeof plaintext !== 'string') {
        throw new CryptoInputError('invalid_argument', 'store cipher: the plaintext must be text');
      }
      const { aes } = keys();
      const nonce = randomBytes(NONCE_LENGTH);
      const data = encodeUtf8(plaintext);
      try {
        const sealed = new Uint8Array(
          await api.encrypt(
            { name: 'AES-GCM', iv: nonce, additionalData: aadOf(context), tagLength: 128 },
            aes,
            data,
          ),
        );
        return SEALED_PREFIX + encodeBase64url(concatBytes(nonce, sealed));
      } finally {
        wipe(data);
      }
    },

    async open(context: StoreColumnContext, sealed: string): Promise<string> {
      assertContext(context);
      const { aes } = keys();
      if (typeof sealed !== 'string' || !sealed.startsWith(SEALED_PREFIX)) throw openFailed();
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64url(sealed.slice(SEALED_PREFIX.length));
      } catch {
        throw openFailed();
      }
      if (bytes.length < NONCE_LENGTH + TAG_LENGTH) throw openFailed();
      let plain: Uint8Array;
      try {
        plain = new Uint8Array(
          await api.decrypt(
            {
              name: 'AES-GCM',
              iv: bytes.subarray(0, NONCE_LENGTH),
              additionalData: aadOf(context),
              tagLength: 128,
            },
            aes,
            bytes.subarray(NONCE_LENGTH),
          ),
        );
      } catch {
        throw openFailed();
      }
      try {
        return decodeUtf8(plain);
      } catch {
        throw openFailed();
      } finally {
        wipe(plain);
      }
    },

    async indexDigest(data: Uint8Array): Promise<string> {
      assertBytes(data, 'store cipher: indexDigest data');
      const { hmac } = keys();
      return encodeHex(new Uint8Array(await api.sign('HMAC', hmac, data)));
    },

    close(): void {
      closed = true;
      aesKey = undefined;
      hmacKey = undefined;
    },
  });
}
