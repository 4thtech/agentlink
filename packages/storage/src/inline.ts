// Inline adapter (07 §5.3): ciphertext of at most 12 288 bytes (a 12 255-byte file, 04 §3.4)
// travels base64url inside the end-to-end-encrypted payload. No storage, no URL.
import { decodeBase64url, encodeBase64url } from '@4thtech-io/crypto';
import type { Logger } from '@4thtech-io/log';
import {
  checkFuture,
  checkSize,
  readExactly,
  sha256Hex,
  type PutOptions,
  type StorageAdapter,
  type StoredObject,
} from './adapter.js';
import { StorageError } from './errors.js';

export const INLINE_MAX_CIPHERTEXT_BYTES = 12_288;

export interface InlineAdapterOptions {
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface InlineAdapter extends StorageAdapter {
  readonly kind: 'inline';
  /** Decodes an inline object, checking its kind, size and SHA-256. */
  read(obj: StoredObject): Uint8Array;
}

export function createInlineAdapter(options: InlineAdapterOptions = {}): InlineAdapter {
  const now = options.now ?? (() => new Date());
  const log = options.logger?.child({ storage: 'inline' });

  return {
    kind: 'inline',

    async put(ciphertext, opts: PutOptions): Promise<StoredObject> {
      checkSize(opts.size, INLINE_MAX_CIPHERTEXT_BYTES);
      checkFuture(opts.expiresAt, now(), 'expiresAt');
      const bytes = await readExactly(ciphertext, opts.size);
      const obj = {
        kind: 'inline',
        locator: encodeBase64url(bytes),
        size: bytes.length,
        sha256: sha256Hex(bytes),
      };
      log?.debug('storage put', { size: obj.size });
      return obj;
    },

    async presignGet(): Promise<string> {
      log?.debug('storage presign refused: inline content travels in the payload');
      throw new StorageError('not_supported', 'inline objects have no download URL');
    },

    async delete(): Promise<void> {
      // Nothing is stored outside the payload.
    },

    read(obj: StoredObject): Uint8Array {
      if (obj.kind !== 'inline') {
        throw new StorageError('invalid_argument', 'not an inline object');
      }
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64url(obj.locator);
      } catch {
        throw new StorageError('invalid_argument', 'inline object is not valid base64url');
      }
      if (bytes.length !== obj.size || bytes.length > INLINE_MAX_CIPHERTEXT_BYTES) {
        throw new StorageError('size_mismatch', 'inline object size does not match');
      }
      if (sha256Hex(bytes) !== obj.sha256) {
        throw new StorageError('invalid_argument', 'inline object hash does not match');
      }
      return bytes;
    },
  };
}
