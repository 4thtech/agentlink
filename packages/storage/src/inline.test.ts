// M1-6a: inline adapter (07 §5.3). Ciphertext of at most 12 288 bytes travels base64url in the payload.
import { describe, expect, it } from 'vitest';
import { encodeBase64url, encodeHex, sha256 } from '@4thtech-io/crypto';
import { INLINE_MAX_CIPHERTEXT_BYTES, StorageError, createInlineAdapter } from './index.js';
import { NOW, DAY_MS, bytes, streamOf } from './fake-s3.fixture.js';

const expiresAt = new Date(NOW.getTime() + DAY_MS);

describe('inline adapter', () => {
  it('has kind "inline" and a 12 288-byte limit (04 §3.4, 07 §5.3)', () => {
    expect(INLINE_MAX_CIPHERTEXT_BYTES).toBe(12_288);
    expect(createInlineAdapter().kind).toBe('inline');
  });

  it('stores the ciphertext as base64url in the locator with its SHA-256', async () => {
    const adapter = createInlineAdapter();
    const ct = bytes(1000, 3);
    const obj = await adapter.put(ct, { size: ct.length, expiresAt });
    expect(obj).toEqual({
      kind: 'inline',
      locator: encodeBase64url(ct),
      size: 1000,
      sha256: encodeHex(sha256(ct)),
    });
    expect(adapter.read(obj)).toEqual(ct);
  });

  it('accepts exactly the limit and refuses one byte more', async () => {
    const adapter = createInlineAdapter();
    const max = bytes(INLINE_MAX_CIPHERTEXT_BYTES);
    await expect(adapter.put(max, { size: max.length, expiresAt })).resolves.toMatchObject({
      size: INLINE_MAX_CIPHERTEXT_BYTES,
    });
    const over = bytes(INLINE_MAX_CIPHERTEXT_BYTES + 1);
    await expect(adapter.put(over, { size: over.length, expiresAt })).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('reads a stream and refuses a size mismatch', async () => {
    const adapter = createInlineAdapter();
    const obj = await adapter.put(streamOf(bytes(10), bytes(5)), { size: 15, expiresAt });
    expect(obj.size).toBe(15);
    await expect(
      adapter.put(streamOf(bytes(10), bytes(6)), { size: 15, expiresAt }),
    ).rejects.toMatchObject({ code: 'size_mismatch' });
    await expect(adapter.put(bytes(14), { size: 15, expiresAt })).rejects.toMatchObject({
      code: 'size_mismatch',
    });
  });

  it('refuses an empty object and invalid sizes', async () => {
    const adapter = createInlineAdapter();
    for (const size of [0, -1, 1.5, Number.NaN]) {
      await expect(adapter.put(bytes(1), { size, expiresAt })).rejects.toBeInstanceOf(StorageError);
    }
  });

  it('has no URL to presign: inline content travels in the payload', async () => {
    const adapter = createInlineAdapter();
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt });
    await expect(adapter.presignGet(obj, expiresAt)).rejects.toMatchObject({
      code: 'not_supported',
    });
  });

  it('delete is a no-op', async () => {
    const adapter = createInlineAdapter();
    const obj = await adapter.put(bytes(4), { size: 4, expiresAt });
    await expect(adapter.delete(obj)).resolves.toBeUndefined();
  });

  it('read refuses a tampered object (hash or size mismatch, wrong kind)', async () => {
    const adapter = createInlineAdapter();
    const obj = await adapter.put(bytes(8), { size: 8, expiresAt });
    expect(() => adapter.read({ ...obj, sha256: '00'.repeat(32) })).toThrow(StorageError);
    expect(() => adapter.read({ ...obj, size: 9 })).toThrow(StorageError);
    expect(() => adapter.read({ ...obj, kind: 's3' })).toThrow(StorageError);
    expect(() => adapter.read({ ...obj, locator: 'not base64url!' })).toThrow(StorageError);
  });
});
