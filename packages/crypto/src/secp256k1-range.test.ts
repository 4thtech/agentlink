// IR-M1-1b-1 I-1: the secp256k1 secret-key range check uses its own hard-coded curve order, so it
// does not depend on the library it guards. Pinned here against @noble/curves and checked at the
// boundaries and on random inputs.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { describe, expect, it } from 'vitest';
import { decodeHex, encodeHex, randomBytes } from './index.js';
import { SECP256K1_ORDER_HEX, isSecp256k1SecretKey } from './secp256k1-range.js';

const N = BigInt('0x' + SECP256K1_ORDER_HEX);
const scalar = (value: bigint): Uint8Array => decodeHex(value.toString(16).padStart(64, '0'));

describe('isSecp256k1SecretKey', () => {
  it('uses the published secp256k1 order, equal to the library order', () => {
    expect(SECP256K1_ORDER_HEX).toBe(
      'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
    );
    expect(N).toBe(secp256k1.Point.Fn.ORDER);
  });

  it('accepts 1 <= k < n and refuses 0, n, anything above n and the wrong length', () => {
    for (const k of [1n, 2n, N - 1n, N - 256n, N >> 1n, 1n << 255n]) {
      expect(isSecp256k1SecretKey(scalar(k)), k.toString(16)).toBe(true);
    }
    for (const k of [0n, N, N + 1n, N + 256n, (1n << 256n) - 1n]) {
      expect(isSecp256k1SecretKey(scalar(k)), k.toString(16)).toBe(false);
    }
    expect(isSecp256k1SecretKey(new Uint8Array(31).fill(1))).toBe(false);
    expect(isSecp256k1SecretKey(new Uint8Array(33).fill(1))).toBe(false);
    expect(isSecp256k1SecretKey('01' as unknown as Uint8Array)).toBe(false);
  });

  it('agrees with the library on keys that differ from n in one byte', () => {
    const order = scalar(N);
    for (let i = 0; i < 32; i += 1) {
      for (const delta of [-1, 1]) {
        const k = Uint8Array.from(order);
        k[i] = ((k[i] as number) + delta) & 0xff;
        expect(isSecp256k1SecretKey(k), encodeHex(k)).toBe(secp256k1.utils.isValidSecretKey(k));
      }
    }
  });

  it('agrees with the library on random keys, including ones forced above n', () => {
    for (let i = 0; i < 2000; i += 1) {
      const k = randomBytes(32);
      if (i % 2 === 0) k.fill(0xff, 0, 16); // every second key is above n
      expect(isSecp256k1SecretKey(k)).toBe(secp256k1.utils.isValidSecretKey(k));
    }
  });
});
