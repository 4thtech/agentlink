// W4-SHORT-INVITE (04 §3.6.2, D-139): the `ALI1` v1 invite object and the two HKDF derivations.
// The derivations are cross-checked against @noble/hashes directly and the object against WebCrypto
// directly, so the format is pinned byte for byte (distinct info strings, AAD = header ‖ lookupId,
// u32be(n) ‖ P ‖ zero padding to 1 KiB). Every malformed object opens to `undefined`.
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import {
  SHORT_INVITE_MAX_OBJECT,
  SHORT_INVITE_MAX_PAYLOAD,
  encodeUtf8,
  generateShortInviteSecret,
  openShortInvite,
  sealShortInvite,
  shortInviteLookupId,
} from './index.js';

const K = new Uint8Array(32).map((_, i) => i + 1);
const subtle = globalThis.crypto.subtle;

async function rawOpen(key: Uint8Array, object: Uint8Array, lookupId: Uint8Array) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const aad = new Uint8Array([...object.subarray(0, 17), ...lookupId]);
  return new Uint8Array(
    await subtle.decrypt(
      { name: 'AES-GCM', iv: object.subarray(5, 17), additionalData: aad, tagLength: 128 },
      k,
      object.subarray(17),
    ),
  );
}

/** Seals arbitrary plaintext as an ALI1 object (for malformed-plaintext cases). */
async function rawSeal(plaintext: Uint8Array, header?: Uint8Array): Promise<Uint8Array> {
  const key = hkdf(sha256, K, new Uint8Array(0), encodeUtf8('agentlink/v1/short-invite/key'), 32);
  const lookupId = shortInviteLookupId(K);
  const h = header ?? new Uint8Array([0x41, 0x4c, 0x49, 0x31, 1, ...new Uint8Array(12).fill(7)]);
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(
    await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: h.subarray(5, 17),
        additionalData: new Uint8Array([...h, ...lookupId]),
        tagLength: 128,
      },
      k,
      plaintext,
    ),
  );
  return new Uint8Array([...h, ...ct]);
}

describe('short invite derivations (04 §3.6.2)', () => {
  it('lookupId and inviteKey are HKDF-SHA256 of K with distinct info strings', async () => {
    const id = shortInviteLookupId(K);
    expect(id).toEqual(
      hkdf(sha256, K, new Uint8Array(0), encodeUtf8('agentlink/v1/short-invite/id'), 16),
    );
    const key = hkdf(sha256, K, new Uint8Array(0), encodeUtf8('agentlink/v1/short-invite/key'), 32);
    const { lookupId, object } = await sealShortInvite(K, encodeUtf8('payload'));
    expect(lookupId).toEqual(id);
    // The object opens under the key derived independently, with AAD = header ‖ lookupId.
    const plaintext = await rawOpen(key, object, id);
    expect(plaintext.length).toBe(1024);
    expect(new DataView(plaintext.buffer).getUint32(0, false)).toBe(7);
    expect(plaintext.subarray(4, 11)).toEqual(encodeUtf8('payload'));
    expect(plaintext.subarray(11).every((b) => b === 0)).toBe(true);
    // The lookup ID is not a prefix of the key (distinct info strings).
    expect(key.subarray(0, 16)).not.toEqual(id);
  });

  it('refuses a secret that is not 32 bytes', () => {
    expect(() => shortInviteLookupId(new Uint8Array(31))).toThrow();
    expect(() => shortInviteLookupId(new Uint8Array(33))).toThrow();
  });

  it('a fresh secret is 32 random bytes, different each time', () => {
    const a = generateShortInviteSecret();
    const b = generateShortInviteSecret();
    expect(a.length).toBe(32);
    expect(a).not.toEqual(b);
  });
});

describe('ALI1 v1 objects', () => {
  it('round-trips P; the header is ALI1, version 1, a fresh 12-byte nonce', async () => {
    const p = encodeUtf8('x'.repeat(2000));
    const one = await sealShortInvite(K, p);
    const two = await sealShortInvite(K, p);
    expect([...one.object.subarray(0, 5)]).toEqual([0x41, 0x4c, 0x49, 0x31, 1]);
    expect(one.object.subarray(5, 17)).not.toEqual(two.object.subarray(5, 17));
    // 4 + 2000 → padded to 3 072; object = 17 + 3 072 + 16.
    expect(one.object.length).toBe(17 + 3072 + 16);
    expect(await openShortInvite(K, one.object)).toEqual(p);
  });

  it('pads to 1 KiB; the largest payload gives exactly the 17 441-byte maximum', async () => {
    expect((await sealShortInvite(K, new Uint8Array(1))).object.length).toBe(17 + 1024 + 16);
    expect((await sealShortInvite(K, new Uint8Array(1020))).object.length).toBe(17 + 1024 + 16);
    expect((await sealShortInvite(K, new Uint8Array(1021))).object.length).toBe(17 + 2048 + 16);
    const max = await sealShortInvite(K, new Uint8Array(SHORT_INVITE_MAX_PAYLOAD).fill(1));
    expect(max.object.length).toBe(SHORT_INVITE_MAX_OBJECT);
    expect(await openShortInvite(K, max.object)).toEqual(
      new Uint8Array(SHORT_INVITE_MAX_PAYLOAD).fill(1),
    );
  });

  it('refuses to seal an empty or oversized payload', async () => {
    await expect(sealShortInvite(K, new Uint8Array(0))).rejects.toThrow();
    await expect(sealShortInvite(K, new Uint8Array(SHORT_INVITE_MAX_PAYLOAD + 1))).rejects.toThrow();
  });

  it('another secret, another lookupId (AAD), a changed header or byte all fail closed', async () => {
    const { object } = await sealShortInvite(K, encodeUtf8('hello'));
    const other = new Uint8Array(32).fill(9);
    expect(await openShortInvite(other, object)).toBeUndefined();
    for (const at of [0, 4, 5, 16, 17, 100, object.length - 1]) {
      const bad = object.slice();
      bad[at] = (bad[at] ?? 0) ^ 1;
      expect(await openShortInvite(K, bad)).toBeUndefined();
    }
    expect(await openShortInvite(K, object.subarray(0, object.length - 1))).toBeUndefined();
    expect(await openShortInvite(K, new Uint8Array(32))).toBeUndefined();
    expect(await openShortInvite(K, new Uint8Array(SHORT_INVITE_MAX_OBJECT + 1))).toBeUndefined();
  });

  it('refuses n = 0, n > 16 384, n beyond the plaintext and non-zero padding', async () => {
    const pt = (n: number, len: number, fill = 0): Uint8Array => {
      const b = new Uint8Array(len).fill(fill);
      new DataView(b.buffer).setUint32(0, n, false);
      return b;
    };
    const good = pt(3, 1024);
    good.set([1, 2, 3], 4);
    expect(await openShortInvite(K, await rawSeal(good))).toEqual(new Uint8Array([1, 2, 3]));
    expect(await openShortInvite(K, await rawSeal(pt(0, 1024)))).toBeUndefined();
    expect(await openShortInvite(K, await rawSeal(pt(16_385, 17_408)))).toBeUndefined();
    expect(await openShortInvite(K, await rawSeal(pt(1021, 1024)))).toBeUndefined();
    const padded = pt(3, 1024);
    padded[1023] = 1;
    expect(await openShortInvite(K, await rawSeal(padded))).toBeUndefined();
    // Another version under the right key and AAD is still refused.
    const v2 = new Uint8Array([0x41, 0x4c, 0x49, 0x31, 2, ...new Uint8Array(12)]);
    expect(await openShortInvite(K, await rawSeal(good, v2))).toBeUndefined();
  });
});
