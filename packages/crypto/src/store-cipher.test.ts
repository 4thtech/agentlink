// M1-8b (07 §3.1): the store's column cipher and index key.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { decodeBase64url, encodeBase64url, encodeHex, encodeUtf8 } from './encoding.js';
import { CryptoInputError } from './errors.js';
import { hkdfSha256 } from './hkdf.js';
import {
  STORE_INDEX_KEY_INFO,
  createStoreColumnCipher,
  type StoreColumnContext,
} from './store-cipher.js';

const keyOf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const ctx: StoreColumnContext = { table: 'contacts', column: 'name', rowKey: '["0xaa"]' };

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return error instanceof CryptoInputError ? error.code : 'other';
  }
  return undefined;
}

describe('createStoreColumnCipher', () => {
  it('round-trips text, including empty and non-ASCII text', async () => {
    const cipher = await createStoreColumnCipher(keyOf(1));
    for (const text of ['', 'Denis', 'Žiga 🎉', 'x'.repeat(10_000)]) {
      const sealed = await cipher.seal(ctx, text);
      expect(sealed.startsWith('v1.')).toBe(true);
      expect(sealed).not.toContain(text || 'never-empty');
      expect(await cipher.open(ctx, sealed)).toBe(text);
    }
  });

  it('uses a fresh nonce per seal', async () => {
    const cipher = await createStoreColumnCipher(keyOf(1));
    expect(await cipher.seal(ctx, 'same')).not.toBe(await cipher.seal(ctx, 'same'));
  });

  it('refuses another table, column or row key (AAD binding)', async () => {
    const cipher = await createStoreColumnCipher(keyOf(1));
    const sealed = await cipher.seal(ctx, 'secret name');
    for (const other of [
      { ...ctx, table: 'pairings' },
      { ...ctx, column: 'relays' },
      { ...ctx, rowKey: '["0xab"]' },
    ]) {
      expect(await codeOf(() => cipher.open(other, sealed))).toBe('open_failed');
    }
  });

  it('refuses another key, tampered, truncated and unversioned values with one code', async () => {
    const cipher = await createStoreColumnCipher(keyOf(1));
    const other = await createStoreColumnCipher(keyOf(2));
    const sealed = await cipher.seal(ctx, 'secret');
    expect(await codeOf(() => other.open(ctx, sealed))).toBe('open_failed');
    const bytes = decodeBase64url(sealed.slice(3));
    bytes[bytes.length - 1]! ^= 1;
    expect(await codeOf(() => cipher.open(ctx, `v1.${encodeBase64url(bytes)}`))).toBe(
      'open_failed',
    );
    for (const bad of [
      sealed.slice(0, 20),
      sealed.slice(3),
      `v2.${sealed.slice(3)}`,
      'v1.',
      'v1.!!!',
      '',
    ]) {
      expect(await codeOf(() => cipher.open(ctx, bad)), bad).toBe('open_failed');
    }
  });

  it('refuses a store key that is not 32 bytes and an empty context', async () => {
    expect(await codeOf(() => createStoreColumnCipher(new Uint8Array(31)))).toBe('invalid_length');
    const cipher = await createStoreColumnCipher(keyOf(1));
    expect(await codeOf(() => cipher.seal({ ...ctx, rowKey: '' }, 'x'))).toBe('invalid_argument');
  });

  it('computes the index digest as HMAC-SHA256 under HKDF(store key, store-index)', async () => {
    const key = keyOf(7);
    const cipher = await createStoreColumnCipher(key);
    const data = encodeUtf8('{"text":"hello"}');
    const indexKey = hkdfSha256(key, new Uint8Array(0), encodeUtf8(STORE_INDEX_KEY_INFO), 32);
    const digest = await cipher.indexDigest(data);
    expect(digest).toBe(encodeHex(hmac(sha256, indexKey, data)));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The index key is not the store key itself.
    expect(digest).not.toBe(encodeHex(hmac(sha256, key, data)));
  });

  it('does not keep the caller buffer: wiping it after creation leaves the cipher working', async () => {
    const key = keyOf(9);
    const cipher = await createStoreColumnCipher(key);
    const sealed = await cipher.seal(ctx, 'still opens');
    key.fill(0);
    expect(await cipher.open(ctx, sealed)).toBe('still opens');
  });

  it('fails every call after close', async () => {
    const cipher = await createStoreColumnCipher(keyOf(1));
    const sealed = await cipher.seal(ctx, 'x');
    cipher.close();
    expect(await codeOf(() => cipher.open(ctx, sealed))).toBe('invalid_argument');
    expect(await codeOf(() => cipher.seal(ctx, 'x'))).toBe('invalid_argument');
    expect(await codeOf(() => cipher.indexDigest(new Uint8Array(1)))).toBe('invalid_argument');
  });
});
