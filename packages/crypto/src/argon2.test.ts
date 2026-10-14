// M1-1f: Argon2id v1.3 (RFC 9106) through @noble/hashes, the KDF of the owner passphrase wrap, the
// file KeyStore and the recovery code (04 §2.3, §2.8). The cross-runtime vectors are in
// test-vectors/owner-wrap; these tests pin the API rules.
import { describe, expect, it, vi } from 'vitest';
import { CryptoInputError, encodeHex, encodeUtf8, type Argon2idParams } from './index.js';
import { argon2id } from './keystore.js';
import { argon2idWithSecretAndAd } from './testing.js';

// Each test here runs Argon2id (m = 19 MiB) several times. On a loaded CI runner that can exceed
// Vitest's default 5 s per test, so this file allows 60 s. Assertions are unchanged.
vi.setConfig({ testTimeout: 60_000 });

const SMALL = { memoryKiB: 32, iterations: 3, parallelism: 4 } as const;
const FLOOR = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

async function refusedWith(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoInputError);
    expect((error as CryptoInputError).code).toBe(code);
    return;
  }
  throw new Error('expected a refusal');
}

describe('argon2id', () => {
  it('matches RFC 9106 §5.3 (secret and associated data through the test seam)', async () => {
    const out = await argon2idWithSecretAndAd(
      new Uint8Array(32).fill(0x01),
      new Uint8Array(16).fill(0x02),
      SMALL,
      { secret: new Uint8Array(8).fill(0x03), ad: new Uint8Array(12).fill(0x04), length: 32 },
    );
    expect(encodeHex(out)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  });

  it('is the same function with no secret and no associated data', async () => {
    const password = encodeUtf8('long phrase');
    const salt = new Uint8Array(16).fill(7);
    const plain = await argon2id(password, salt, FLOOR);
    const seam = await argon2idWithSecretAndAd(password, salt, FLOOR, {
      secret: new Uint8Array(0),
      ad: new Uint8Array(0),
      length: 32,
    });
    expect(plain).toEqual(seam);
    expect(plain.length).toBe(32);
  });

  // IR-M1-1f-1 L-1: the production export applies the 04 §2.8 floor and cap (the RFC 9106 test
  // parameters run only through the test seam).
  it('refuses parameters outside the 04 §2.8 floor and cap, before running', async () => {
    const password = encodeUtf8('long phrase');
    const salt = new Uint8Array(16);
    for (const params of [
      SMALL,
      { ...FLOOR, memoryKiB: 19455 },
      { ...FLOOR, memoryKiB: 262145 },
      { ...FLOOR, iterations: 1 },
      { ...FLOOR, iterations: 9 },
      { ...FLOOR, parallelism: 0 },
      { ...FLOOR, parallelism: 5 },
    ]) {
      await refusedWith(() => argon2id(password, salt, params), 'invalid_argument');
    }
  });

  it('the seam refuses parameters outside RFC 9106 or above the 256 MiB cap', async () => {
    const password = encodeUtf8('long phrase');
    const salt = new Uint8Array(16);
    const seam = (pw: Uint8Array, sa: Uint8Array, params: Argon2idParams) =>
      argon2idWithSecretAndAd(pw, sa, params, {
        secret: new Uint8Array(0),
        ad: new Uint8Array(0),
        length: 32,
      });
    for (const params of [
      { ...SMALL, memoryKiB: 31 },
      { ...SMALL, memoryKiB: 262145 },
      { ...SMALL, iterations: 0 },
      { ...SMALL, parallelism: 0 },
      { ...SMALL, iterations: 1.5 },
    ]) {
      await refusedWith(() => seam(password, salt, params), 'invalid_argument');
    }
    await refusedWith(() => seam(password, new Uint8Array(7), SMALL), 'invalid_argument');
    await refusedWith(() => argon2id(password, new Uint8Array(7), FLOOR), 'invalid_argument');
    await refusedWith(
      () => argon2id('x' as unknown as Uint8Array, salt, FLOOR),
      'invalid_argument',
    );
  });
});
